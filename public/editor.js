import {api,fetchBlob,get,getIndex,normalize,save,saveBlob,status,terms} from './store.js';
import {acquirePdf,canvasFor,compressImage,exportPdf,originalUrl,renderReadablePage,thumbnail,toBlob,withPdf} from './documents.js';
import {actionMenu,button,download,esc,iconButton,input,modal,select,shortDate,toast} from './ui.js';

const papers=[['blank','Blank Page'],['lined','Lined Page'],['grid','Grid Page'],['dotted','Dotted Page'],['image','Image Page'],['note','Note Page']];
const primaryTools=[['navigate','Read','book'],['pen','Pen','pen'],['highlighter','Highlighter','marker'],['eraser','Eraser','erase'],['lasso','Select','lasso']];
const images=new Map();
const annotationKey = (item,page)=>'annotation:'+item+':'+page;
export const scene = (item,page)=>get(annotationKey(item,page),{objects:[]}).objects;
const numberOr = (value, fallback)=>Number(value)||fallback;
const clamp=(value,lo,hi)=>Math.max(lo,Math.min(hi,value));
const defaultRatio=.7273;

async function imageFor(id) {
  if (!images.has(id)) {
    images.set(id,fetchBlob(id).then(blob=>createImageBitmap(blob)).catch(error=>{images.delete(id);throw error;}));
    if (images.size > 60) {
      const first=images.keys().next().value;
      images.get(first).then(bitmap=>bitmap.close()).catch(()=>{});
      images.delete(first);
    }
  }
  return images.get(id);
}

function bounds(object) {
  if (object.points) {
    const xs=object.points.map(point=>point.x);
    const ys=object.points.map(point=>point.y);
    return {x:Math.min(...xs),y:Math.min(...ys),w:Math.max(...xs)-Math.min(...xs),h:Math.max(...ys)-Math.min(...ys)};
  }
  return {x:object.x,y:object.y,w:object.w || .17,h:object.h || .04};
}
function overlaps(one,two,pad=0) {
  return one.x-pad<=two.x+two.w && one.x+one.w+pad>=two.x && one.y-pad<=two.y+two.h && one.y+one.h+pad>=two.y;
}

function renderStroke(ctx,object,w,h) {
  const points=object.points;
  ctx.lineCap='round';
  ctx.lineJoin='round';
  ctx.globalAlpha=object.type==='highlighter'?.27:1;
  if (!points?.length) return;
  if (object.type==='highlighter' || object.nib!=='pressure') {
    ctx.lineWidth=object.width*w/800;
    ctx.beginPath();
    ctx.moveTo(points[0].x*w,points[0].y*h);
    for (const pt of points.slice(1)) ctx.lineTo(pt.x*w,pt.y*h);
    if (points.length===1) ctx.lineTo(points[0].x*w+.1,points[0].y*h+.1);
    ctx.stroke();
    return;
  }
  for (let i=0;i<points.length;i++) {
    const from=points[Math.max(i-1,0)];
    const to=points[i];
    ctx.lineWidth=object.width*w/800*Math.max(.35,to.p||.5)*1.7;
    ctx.beginPath();
    ctx.moveTo(from.x*w,from.y*h);
    ctx.lineTo(to.x*w+.01,to.y*h);
    ctx.stroke();
  }
}

function linesFor(ctx,text,max) {
  return text.split('\n').flatMap(line=>{
    const result=[];
    let next='';
    for (const word of line.split(' ')) {
      if (next && ctx.measureText(next+' '+word).width>max) {result.push(next);next='';}
      next+=(next?' ':'')+word;
    }
    result.push(next);
    return result;
  });
}
function drawText(ctx,object,w,h) {
  const size=(object.size||22)*w/800;
  ctx.font=(object.style==='italic'?'italic ':'')+(object.style==='bold'?'700 ':'500 ')+size+'px Alexandria,sans-serif';
  ctx.textBaseline='top';
  ctx.textAlign=object.direction==='rtl'?'right':'left';
  const max=(object.w || .62)*w;
  const text=object.style==='list'?object.text.split('\n').map(line=>'• '+line).join('\n'):object.text;
  const x=object.x*w+(object.direction==='rtl'?max:0);
  for (const [index,line] of linesFor(ctx,text,max).entries()) ctx.fillText(line,x,object.y*h+index*size*1.35,max);
  if (object.url) {
    const y=object.y*h+size*1.2;
    ctx.lineWidth=1;
    ctx.beginPath();
    ctx.moveTo(object.x*w,y);
    ctx.lineTo(object.x*w+Math.min(max,ctx.measureText(text).width),y);
    ctx.stroke();
  }
}

async function paint(canvas, objects, selected=[], searchBoxes=[],selectionState={}) {
  const w=canvas.width,h=canvas.height;
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,w,h);
  for (const box of searchBoxes) {
    ctx.fillStyle='#ffd20070';
    ctx.fillRect(box.x*w,box.y*h,box.w*w,box.h*h);
  }
  const assets = await Promise.all(objects.map(async object=>object.type==='image' ? imageFor(object.blob).catch(()=>null) : null));
  for (const [index,object] of objects.entries()) {
    ctx.save();
    ctx.strokeStyle=ctx.fillStyle=object.color||'#141414';
    const {x,y}=object;
    if (object.type==='pen'||object.type==='highlighter') renderStroke(ctx,object,w,h);
    else if (object.type==='text') drawText(ctx,object,w,h);
    else if (object.type==='shape') {
      ctx.lineWidth=(object.width||3)*w/800;
      const width=object.w*w,height=object.h*h;
      ctx.beginPath();
      if (object.shape==='ellipse') ctx.ellipse(x*w+width/2,y*h+height/2,Math.abs(width/2),Math.abs(height/2),0,0,Math.PI*2);
      else if (object.shape==='line') {ctx.moveTo(x*w,y*h);ctx.lineTo(x*w+width,y*h+height);}
      else ctx.rect(x*w,y*h,width,height);
      ctx.stroke();
    } else if (object.type==='image' && assets[index]) {
      const asset=assets[index];
      const width=object.w*w,height=object.h*h;
      const crop=object.crop || [0,0,1,1];
      ctx.translate(x*w+width/2,y*h+height/2);
      ctx.rotate((object.rotate||0)*Math.PI/180);
      const visible=asset.width*crop[2]/(asset.height*crop[3]);
      const imageWidth=Math.min(width,height*visible),imageHeight=imageWidth/visible;
      ctx.drawImage(asset,asset.width*crop[0],asset.height*crop[1],asset.width*crop[2],asset.height*crop[3],-imageWidth/2,-imageHeight/2,imageWidth,imageHeight);
      if (object.caption) {
        ctx.font='600 '+Math.max(11,w*.021)+'px Alexandria,sans-serif';
        ctx.fillText(object.caption,-width/2,height/2+w*.023,width);
      }
    }
    ctx.restore();
    if (selected.includes(object.id)) {
      const box=bounds(object);
      const crop=object.type==='image'&&selectionState.crop?(object.crop||[0,0,1,1]):null;
      const shown=crop?{x:box.x+crop[0]*box.w,y:box.y+crop[1]*box.h,w:crop[2]*box.w,h:crop[3]*box.h}:box;
      ctx.strokeStyle='#3968cc';
      ctx.lineWidth=2;
      ctx.setLineDash([5,4]);
      ctx.strokeRect(shown.x*w-3,shown.y*h-3,shown.w*w+6,shown.h*h+6);
      ctx.setLineDash([]);
      ctx.fillStyle='#fff';
      ctx.strokeStyle='#3968cc';
      const handles=[[shown.x,shown.y],[shown.x+shown.w,shown.y],[shown.x,shown.y+shown.h],[shown.x+shown.w,shown.y+shown.h]];
      for(const [hx,hy] of handles){ctx.beginPath();ctx.arc(hx*w,hy*h,7,0,Math.PI*2);ctx.fill();ctx.stroke();}
      if(object.type==='image'&&!selectionState.crop){
        const rx=(box.x+box.w/2)*w,ry=(box.y-.034)*h;
        ctx.beginPath();ctx.moveTo((box.x+box.w/2)*w,box.y*h);ctx.lineTo(rx,ry);ctx.stroke();
        ctx.beginPath();ctx.arc(rx,ry,7,0,Math.PI*2);ctx.fill();ctx.stroke();
      }
    }
  }
}

function moveObjects(objects,ids,dx,dy) {
  return objects.map(object=>{
    if (!ids.includes(object.id)||object.locked) return object;
    if (object.points) return {...object,points:object.points.map(pt=>({...pt,x:clamp(pt.x+dx,0,1),y:clamp(pt.y+dy,0,1)}))};
    return {...object,x:clamp(object.x+dx,0,.97),y:clamp(object.y+dy,0,.97)};
  });
}

function buildSpecs(item,pdf) {
  const authored=item.pagesAdded || [];
  if (item.type==='note') return authored.length?authored:[{key:'page-one',paper:'blank',ratio:defaultRatio}];
  if (item.type==='image') return [{key:'p1',paper:'image',blob:item.blob,ratio:item.ratio || defaultRatio}];
  if (item.order) {
    const added=new Map(authored.map(spec=>[spec.key,spec]));
    const ordered=item.order.map(key=>added.get(key) || (/^p\d+$/.test(key) ? {key,number:Number(key.slice(1)),ratio:defaultRatio} : null)).filter(Boolean);
    if (ordered.length) return ordered;
  }
  return Array.from({length:pdf.numPages},(_,i)=>({key:'p'+(i+1),number:i+1,ratio:defaultRatio})).concat(authored);
}
export async function itemPages(item) {
  return item.type==='pdf'?withPdf(item,doc=>buildSpecs(item,doc)):buildSpecs(item,null);
}

export async function previewFor(item,pageKey) {
  if (item.type==='image') return item.blob;
  if (item.type==='pdf' && (!pageKey || /^p\d+$/.test(pageKey))) {
    const page=pageKey?Number(pageKey.slice(1)):1;
    const objects=pageKey?scene(item.id,pageKey).filter(object=>object.type!=='bookmark'):[];
    if (!objects.length) return thumbnail(item,page);
    const background=canvasFor();
    await withPdf(item,doc=>renderReadablePage(item,doc,page,background,550));
    const top=canvasFor();
    top.width=background.width;
    top.height=background.height;
    await paint(top,objects);
    background.getContext('2d').drawImage(top,0,0);
    return toBlob(background);
  }
  if (item.thumb && !pageKey) return item.thumb;
  const specs=await itemPages(item);
  const spec=specs.find(spec=>spec.key===pageKey)||specs[0];
  const canvas=await createPageExport(item,spec);
  return canvas ? toBlob(canvas) : null;
}

async function createPageExport(item,spec) {
  const objects=scene(item.id,spec.key).filter(object=>object.type!=='bookmark');
  if (spec.number && !objects.length) return null;
  const canvas=canvasFor();
  canvas.width=1100;
  canvas.height=Math.round(canvas.width/(spec.ratio || defaultRatio));
  if (spec.number) {
    await paint(canvas,objects);
    return canvas;
  }
  const overlay=canvasFor();
  overlay.width=canvas.width;
  overlay.height=canvas.height;
  await paint(overlay,objects);
  const ctx=canvas.getContext('2d');
  ctx.fillStyle='#fff';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  const step=28;
  ctx.strokeStyle='#d4d8df';
  ctx.fillStyle='#babec7';
  ctx.lineWidth=1;
  if (['lined','grid'].includes(spec.paper)) for(let y=step;y<canvas.height;y+=step){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(canvas.width,y);ctx.stroke();}
  if(spec.paper==='grid') for(let x=step;x<canvas.width;x+=step){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,canvas.height);ctx.stroke();}
  if(spec.paper==='dotted') for(let x=step;x<canvas.width;x+=step) for(let y=step;y<canvas.height;y+=step) ctx.fillRect(x,y,2,2);
  if(spec.blob){
    const image=await imageFor(spec.blob);
    const ratio=Math.min(canvas.width/image.width,canvas.height/image.height);
    const width=image.width*ratio,height=image.height*ratio;
    ctx.drawImage(image,(canvas.width-width)/2,(canvas.height-height)/2,width,height);
  }
  ctx.drawImage(overlay,0,0);
  return canvas;
}

export async function renderExport(item) {
  const specs=await itemPages(item);
  return exportPdf(item,specs,spec=>createPageExport(item,spec));
}
export function saveExport(item,blob) {
  download(blob,item.name.replace(/\.pdf$/i,'')+(item.type==='pdf'?' - Annotated':'')+'.pdf');
}

export async function mountEditor(host,item,options) {
  const prefs=options.prefs;
  let doc, specs, documentLease;
  let mode=prefs.readerMode||'single';
  let zoom=1;
  let selectedIndex=0;
  let pen='navigate';
  let nib='pressure';
  let color=prefs.penColor||'#1c50a0';
  let size=3;
  let eraserMode='stroke';
  let pendingImage=null;
  let cropMode=false;
  let panelPinned=false;
  let picked=[];
  let job=null;
  let pageObserver;
  let panelObserver;
  let toastSearch=null;
  let restorePending=options.resume;
  let searchBoxes=[];
  let saving=Promise.resolve();
  let dwell;
  let writing=false;
  let touchScroll=null;
  let disposed=false;
  let dirty=false;
  let restored=false;
  const undo=new Map(),redo=new Map(),canvases=new Map();
  const sceneDraft=new Map();
  const pendingPages=new Set();
  const scope=new AbortController();
  const current=()=>specs[selectedIndex];
  const target=()=>current()?.key;

  host.innerHTML='<section class="editor-shell reader-shell" id="main"><header class="editor-header">'+
    iconButton('back','Back','reader-back')+'<h1 dir="auto">'+esc(item.name)+'</h1><span class="meta reader-status" role="status">'+esc(status())+'</span>'+
    iconButton('search','Search in document','reader-search')+iconButton('more','Reader options','reader-menu')+'</header>'+
    '<div class="reader-navigation" aria-label="Page navigation"></div><div class="reader-context" aria-label="Tool options" hidden></div>'+
    '<div class="reader-body"><aside class="page-panel" aria-label="Pages" hidden></aside><div class="reader-scroll" tabindex="0" aria-label="Document pages"><div class="reader-pages"><p role="status">Loading…</p></div></div></div>'+
    '<div class="editor-toolbar" role="toolbar" aria-label="Reading and annotation tools"></div></section>';
  const shell=host.querySelector('.reader-shell');
  const toolbar=shell.querySelector('.editor-toolbar');
  const navigation=shell.querySelector('.reader-navigation');
  const contextTools=shell.querySelector('.reader-context');
  const scroll=shell.querySelector('.reader-scroll');
  const pages=shell.querySelector('.reader-pages');
  const panel=shell.querySelector('.page-panel');
  const state=shell.querySelector('.reader-status');
  const act=(label,symbol,event,attrs)=>iconButton(symbol,label,event,attrs);

  function renderNavigation(){
    navigation.innerHTML=act('Page thumbnails','pages','pages','aria-expanded="'+(!panel.hidden)+'"')+
      act('Previous page','back','prev',selectedIndex===0?'disabled':'')+
      button('Page '+(selectedIndex+1)+' / '+specs.length,'page-jump',{variant:'quiet reader-page'})+
      act('Next page','next','next',selectedIndex===specs.length-1?'disabled':'')+
      button(Math.round(zoom*100)+'%','zoom-menu',{variant:'quiet reader-zoom',attrs:'aria-label="Zoom '+Math.round(zoom*100)+' percent"'});
  }
  function renderMainTools(){
    toolbar.innerHTML=primaryTools.map(([name,label,symbol])=>button(label,'draw-'+name,{symbol,variant:'reader-tool',attrs:'aria-pressed="'+(pen===name)+'"'})).join('')+
      button('Add','reader-add',{symbol:'plus',variant:'reader-tool'});
  }
  function renderContextTools(){
    const history=act('Undo','undo','undo',(undo.get(target())?.length?'':'disabled'))+act('Redo','redo','redo',(redo.get(target())?.length?'':'disabled'));
    let markup='';
    if(['pen','highlighter'].includes(pen)) markup='<label class="tool-color"><span>Color</span><input type="color" class="pen-color" value="'+esc(color)+'"></label><label class="tool-width"><span>Width</span><input type="range" class="pen-size" min="1" max="25" value="'+size+'"></label>'+
      (pen==='pen'?'<label class="tool-nib"><span>Tip</span><select class="book-input nib" aria-label="Pen tip"><option value="pressure">Pressure</option><option value="round">Round</option><option value="fine">Fineliner</option></select></label>':'')+history;
    else if(pen==='eraser') markup=button('Stroke','eraser-mode',{variant:'subtle',attrs:'data-mode="stroke" aria-pressed="'+(eraserMode==='stroke')+'"'})+button('Object','eraser-mode',{variant:'subtle',attrs:'data-mode="object" aria-pressed="'+(eraserMode==='object')+'"'})+history;
    else if(pen==='lasso'&&picked.length===1){
      const selected=objects().find(object=>object.id===picked[0]);
      if(selected?.type==='image') markup=button(cropMode?'Finish Crop':'Crop','object-crop',{symbol:'crop',variant:'subtle',attrs:'aria-pressed="'+cropMode+'"'})+button('Rotate','object-rotate',{symbol:'rotate',variant:'subtle'})+button('Back','object-back',{variant:'subtle'})+button('Front','object-front',{variant:'subtle'})+button('Caption','object-caption',{variant:'subtle'})+button('Delete','object-delete',{variant:'subtle'});
      else if(selected) markup=button('Edit','object-edit',{variant:'subtle'})+button('Back','object-back',{variant:'subtle'})+button('Front','object-front',{variant:'subtle'})+button('Delete','object-delete',{variant:'subtle'});
    }
    contextTools.innerHTML=markup;
    contextTools.hidden=!markup;
    const tip=contextTools.querySelector('.nib');
    if(tip)tip.value=nib;
  }
  function renderTools(){renderNavigation();renderMainTools();renderContextTools();}
  function updateTools() {
    renderNavigation();
    renderMainTools();
    renderContextTools();
  }
  const objects=(key=target())=>sceneDraft.get(key) || scene(item.id,key);
  function redraw(key=target(),draft=null){
    const info=canvases.get(key);
    if (!info?.ready) return;
    return paint(info.ink,draft||objects(key),key===target()?picked:[],key===target()?searchBoxes:[],{crop:cropMode});
  }
  function stage() {
    const range=canvases.get(target())?.shell;
    return range ? clamp((scroll.getBoundingClientRect().top-range.getBoundingClientRect().top)/range.offsetHeight,0,1) : 0;
  }
  function studied() {
    if (disposed||item.type==='folder') return;
    dirty=true;
    clearTimeout(dwell);
    const data={id:item.id,pageKey:target(),page:selectedIndex+1,total:specs.length,zoom,scroll:stage(),scrollX:scroll.scrollLeft,mode,time:Date.now()};
    saving=saving.catch(()=>{}).then(()=>save('resume','resume',data));
    saving.catch(error=>toast(error.message));
    return saving;
  }
  function recordView() {
    if (dirty) studied();
  }
  function setPage(index, mark=true) {
    const next=clamp(index,0,specs.length-1);
    if (next===selectedIndex) return;
    selectedIndex=next;
    picked=[];
    searchBoxes=[];
    toastSearch?.remove();
    toastSearch=null;
    for (const [key,info] of canvases) info.shell.dataset.focused=String(key===target());
    updateTools();
    panel.querySelector('[aria-current=true]')?.removeAttribute('aria-current');
    panel.querySelector('[data-page="'+next+'"]')?.setAttribute('aria-current','true');
    if (mark && item.type!=='note') studied();
  }
  function jump(index,mark=true) {
    index=clamp(index,0,specs.length-1);
    writing=true;
    setPage(index,mark);
    if (mode!=='continuous') renderSheets();
    else canvases.get(target())?.shell.scrollIntoView({block:'start',inline:'nearest'});
    writing=false;
  }

  function commit(list,key=target(),history=true){
    const before=structuredClone(objects(key));
    if (history) {
      const stack=undo.get(key)||[];
      stack.push(before);
      undo.set(key,stack.slice(-50));
      redo.set(key,[]);
    }
    sceneDraft.set(key,list);
    redraw(key);
    if (key===target()) updateTools();
    const data={item:item.id,page:key,objects:list,edited:Date.now()};
    saving=saving.catch(()=>{}).then(async()=>{
      await save(annotationKey(item.id,key),'annotation',data);
      const fresh=get(item.id);
      if (fresh?.type==='note' && Date.now()-(fresh.edited||0)>1500) await save(item.id,'item',{...fresh,edited:Date.now()});
    });
    saving.catch(error=>toast(error.message));
    if (item.type!=='note') studied();
    return saving;
  }

  function sizePage(info,spec) {
    const gross=scroll.clientWidth || innerWidth;
    const sideMode=mode==='two';
    const cssWidth=Math.round(Math.max(128,Math.min(820,(gross-36-(sideMode?18:0))/(sideMode?2:1)))*zoom);
    info.shell.style.width=cssWidth+'px';
    info.shell.style.height=Math.round(cssWidth/(spec.ratio||defaultRatio))+'px';
    return cssWidth;
  }

  function pdfRecovery(retry,index) {
    const original=item.type==='pdf'&&item.blob
      ? '<a class="button subtle" href="'+esc(originalUrl(item))+'" target="_blank" rel="noopener">Open Original</a>' : '';
    return '<div class="page-recovery" role="alert"><h2>Couldn’t display '+(index===undefined?'this file':'page '+(index+1))+'</h2>'+
      '<div class="row wrap">'+button('Retry',retry,{variant:'accent',attrs:index===undefined?'':'data-page="'+index+'"'})+original+'</div></div>';
  }

  function queuePage(info,spec) {
    const task=compose(info,spec);
    pendingPages.add(task);
    task.finally(()=>pendingPages.delete(task));
    return task;
  }

  function releasePixels(info) {
    if(info.url)URL.revokeObjectURL(info.url);
    if(info.ready && !info.loading){
      if(info.base instanceof HTMLCanvasElement)info.base.width=info.base.height=1;
      info.ink.width=info.ink.height=1;
    }
  }

  async function compose(info,spec){
    if (info.ready||info.loading) return;
    info.loading=true;
    const failure=info.shell.querySelector('.page-recovery');
    if(failure)failure.setAttribute('aria-busy','true');
    try {
      if (spec.number) {
        const width=sizePage(info,spec);
        const {viewport}=await renderReadablePage(item,doc,spec.number,info.base,width,Math.min(2,devicePixelRatio||1));
        spec.ratio=viewport.width/viewport.height;
        sizePage(info,spec);
      } else if (spec.blob) {
        const blob=await fetchBlob(spec.blob);
        if (!info.shell.isConnected) return;
        info.url=URL.createObjectURL(blob);
        info.base.src=info.url;
      }
      if (!info.shell.isConnected || disposed) return;
      const height=info.shell.clientHeight||Math.ceil(info.shell.clientWidth/(spec.ratio||defaultRatio));
      const cssWidth=Math.max(1,info.shell.clientWidth);
      const density=Math.min(1.5,devicePixelRatio||1,1800/cssWidth,2400/Math.max(height,1));
      info.ink.width=Math.max(1,Math.ceil(cssWidth*density));
      info.ink.height=Math.max(1,Math.round(height*density));
      info.ready=true;
      try{await redraw(spec.key);}
      catch(error){console.warn('Reader annotations could not be painted',error.name,error.message);}
      failure?.remove();
      info.shell.classList.remove('failed');
    } catch (error) {
      info.ready=false;
      if(!info.shell.isConnected||disposed)return;
      failure?.remove();
      const index=Number(info.shell.dataset.index);
      info.shell.classList.add('failed');
      info.shell.insertAdjacentHTML('beforeend',pdfRecovery('retry-page',index));
      console.warn('Reader page could not be rendered',error.name,error.message);
    } finally {info.loading=false;}
  }

  async function makeThumb(button,spec) {
    if (button.querySelector('img')) return;
    try {
      const id=spec.number?await thumbnail(item,spec.number):spec.blob;
      if (!id||!button.isConnected) return;
      const url=URL.createObjectURL(await fetchBlob(id));
      const image=document.createElement('img');
      image.alt='';
      image.onload=image.onerror=()=>URL.revokeObjectURL(url);
      image.src=url;
      button.prepend(image);
    } catch {}
  }
  function paintPanel() {
    panel.innerHTML='<header class="page-panel-head"><strong>Pages</strong>'+iconButton('pin','Pin pages','pin-pages','aria-pressed="'+panelPinned+'"')+iconButton('close','Close pages','close-pages')+'</header><div class="page-panel-list">'+
      specs.map((spec,index)=>'<button type="button" data-action="jump" data-page="'+index+'" '+(index===selectedIndex?'aria-current="true"':'')+'>Page '+(index+1)+'</button>').join('')+'</div>';
    panelObserver?.disconnect();
    if (panel.hidden) return;
    panelObserver=new IntersectionObserver(items=>{
      for (const entry of items) if (entry.isIntersecting) {
        panelObserver.unobserve(entry.target);
        makeThumb(entry.target,specs[Number(entry.target.dataset.page)]);
      }
    },{root:panel,rootMargin:'100px 0px'});
    for(const button of panel.querySelectorAll('[data-page]')) panelObserver.observe(button);
  }

  function renderSheets(){
    pageObserver?.disconnect();
    for(const info of canvases.values()) releasePixels(info);
    canvases.clear();
    pages.replaceChildren();
    pages.classList.toggle('two',mode==='two');
    const indices=mode==='continuous'?specs.map((_,i)=>i):mode==='two'?[selectedIndex,selectedIndex+1].filter(i=>i<specs.length):[selectedIndex];
    for (const index of indices) {
      const spec=specs[index];
      const container=document.createElement('div');
      container.className='sheet '+(spec.paper||'')+' '+(prefs.paperAppearance||'original');
      container.dataset.index=index;
      container.dataset.focused=String(index===selectedIndex);
      container.setAttribute('aria-label','Page '+(index+1));
      let base;
      if (spec.number||spec.blob) {
        base=spec.number?canvasFor():new Image();
        base.className=spec.number?'base':'base image-base';
        if (base instanceof HTMLImageElement) base.alt='';
        else base.width=base.height=1;
        container.append(base);
      }
      const ink=canvasFor();
      ink.width=ink.height=1;
      ink.className='ink'+(pen==='navigate'?'':' annotate');
      ink.setAttribute('aria-label','Annotations on page '+(index+1));
      container.append(ink);
      pages.append(container);
      const info={shell:container,base,ink};
      canvases.set(spec.key,info);
      sizePage(info,spec);
      bindCanvas(ink,index);
      if (mode!=='continuous') queuePage(info,spec);
    }
    if(mode==='continuous'){
      pageObserver=new IntersectionObserver(items=>{
        for (const entry of items) {
          const spec=specs[Number(entry.target.dataset.index)];
          const info=canvases.get(spec.key);
          if (entry.isIntersecting) queuePage(info,spec);
          else if (info.ready && spec.key!==target()) {
            if (info.base instanceof HTMLCanvasElement) info.base.width=1;
            if (info.url) {
              URL.revokeObjectURL(info.url);
              info.base.removeAttribute('src');
              info.url=null;
            }
            info.ink.width=1;
            info.ready=false;
          }
        }
      },{root:scroll,rootMargin:'500px 0px'});
      for (const info of canvases.values()) pageObserver.observe(info.shell);
      canvases.get(target())?.shell.scrollIntoView({block:'start',inline:'nearest'});
    }
    if (restorePending) requestAnimationFrame(()=>{
      let info=canvases.get(target());
      if (mode==='continuous'&&info) scroll.scrollTop+=info.shell.getBoundingClientRect().top-scroll.getBoundingClientRect().top;
      scroll.scrollTop+=(restorePending?.scroll||0)*(info?.shell.offsetHeight||1);
      scroll.scrollLeft=restorePending?.scrollX||0;
      restorePending=null;
      restored=true;
    });
  }

  function point(event,canvas){
    const rect=canvas.getBoundingClientRect();
    return {x:clamp((event.clientX-rect.x)/rect.width,0,1),y:clamp((event.clientY-rect.y)/rect.height,0,1),p:event.pressure};
  }
  const near=(a,b,r=.027)=>Math.hypot(a.x-b.x,a.y-b.y)<=r;
  function objectAt(key,at){
    return [...objects(key)].reverse().find(object=>object.type!=='bookmark'&&overlaps(bounds(object),{...at,w:0,h:0},.012));
  }
  function selectionGesture(object,at){
    if(!object||object.locked)return null;
    const box=bounds(object);
    if(object.type==='image'&&cropMode){
      const crop=object.crop||[0,0,1,1];
      const frame={x:box.x+crop[0]*box.w,y:box.y+crop[1]*box.h,w:crop[2]*box.w,h:crop[3]*box.h};
      const corners=[['nw',{x:frame.x,y:frame.y}],['ne',{x:frame.x+frame.w,y:frame.y}],['sw',{x:frame.x,y:frame.y+frame.h}],['se',{x:frame.x+frame.w,y:frame.y+frame.h}]];
      const hit=corners.find(([,corner])=>near(at,corner));
      return hit?{transform:'crop',corner:hit[0],object}:null;
    }
    if(object.type==='image'&&near(at,{x:box.x+box.w/2,y:box.y-.034}))return {transform:'rotate',object};
    if(near(at,{x:box.x+box.w,y:box.y+box.h}))return {transform:'resize',object};
    return overlaps(box,{...at,w:0,h:0},.01)?{transform:'move',object}:null;
  }
  function transformedSelection(gesture,at){
    const object=gesture.object;
    if(gesture.transform==='move')return moveObjects(objects(gesture.key),[object.id],at.x-gesture.start.x,at.y-gesture.start.y);
    let next=object;
    if(gesture.transform==='resize')next={...object,w:clamp(at.x-object.x,.06,1-object.x),h:clamp(at.y-object.y,.05,1-object.y)};
    if(gesture.transform==='rotate'){
      const cx=object.x+object.w/2,cy=object.y+object.h/2;
      next={...object,rotate:Math.round(Math.atan2(at.y-cy,at.x-cx)*180/Math.PI+90)};
    }
    if(gesture.transform==='crop'){
      const crop=[...(object.crop||[0,0,1,1])];
      const px=clamp((at.x-object.x)/object.w,0,1),py=clamp((at.y-object.y)/object.h,0,1);
      if(gesture.corner.includes('w')){const right=crop[0]+crop[2];crop[0]=Math.min(px,right-.05);crop[2]=right-crop[0];}
      else crop[2]=Math.max(.05,px-crop[0]);
      if(gesture.corner.includes('n')){const bottom=crop[1]+crop[3];crop[1]=Math.min(py,bottom-.05);crop[3]=bottom-crop[1];}
      else crop[3]=Math.max(.05,py-crop[1]);
      next={...object,crop};
    }
    return objects(gesture.key).map(entry=>entry.id===object.id?next:entry);
  }
  function bindCanvas(canvas,index){
    canvas.onpointerdown = event=>{
      if (!canvases.get(specs[index].key)?.ready || event.button>0 || job || !event.isPrimary) return;
      if (prefs.penOnly && event.pointerType==='touch'&&pen!=='navigate') {
        touchScroll={id:event.pointerId,x:event.clientX,y:event.clientY,left:scroll.scrollLeft,top:scroll.scrollTop};
        canvas.setPointerCapture(event.pointerId);
        return;
      }
      if (event.pointerType==='touch'&&event.width>72&&pen!=='navigate') return;
      setPage(index,false);
      if (pen==='navigate') return;
      event.preventDefault();
      const start=point(event,canvas);
      if(pen==='text'){
        pen='navigate';renderTools();addText(start,target()).catch(error=>toast(error.message));return;
      }
      if(pen==='image'){
        const file=pendingImage;pendingImage=null;pen='navigate';renderTools();
        if(file)placeImage(file,start,target()).catch(error=>toast(error.message));
        return;
      }
      if(pen==='lasso'){
        const selected=objects().find(object=>picked.includes(object.id));
        const transform=selectionGesture(selected,start);
        if(transform){job={...transform,index,key:target(),start,end:start,pointer:event.pointerId,canvas};canvas.setPointerCapture(event.pointerId);return;}
        const hit=objectAt(target(),start);
        if(hit){picked=[hit.id];cropMode=false;redraw();renderContextTools();return;}
      }
      job={index,key:target(),tool:pen,start,end:start,points:[start],pointer:event.pointerId,canvas};
      canvas.setPointerCapture(event.pointerId);
    };
    canvas.onpointermove = event=>{
      if (touchScroll?.id===event.pointerId) {
        scroll.scrollTop=touchScroll.top+touchScroll.y-event.clientY;
        scroll.scrollLeft=touchScroll.left+touchScroll.x-event.clientX;
        return;
      }
      if (job?.pointer!==event.pointerId) return;
      job.end=point(event,canvas);
      if(job.transform)redraw(job.key,transformedSelection(job,job.end));
      else if (['pen','highlighter'].includes(job.tool)) {
        const last=job.points.at(-1);
        if (Math.hypot(last.x-job.end.x,last.y-job.end.y)>.0012) job.points.push(job.end);
        redraw(job.key,[...objects(job.key),{type:job.tool,points:job.points,color,width:job.tool==='highlighter'?Math.max(13,size*3):size,nib}]);
      } else if (job.tool==='eraser'||job.tool==='lasso') job.points.push(job.end);
    };
    canvas.onpointercancel = event=>{
      if (touchScroll?.id===event.pointerId) touchScroll=null;
      if (job?.pointer!==event.pointerId) return;
      const key=job.key;
      job=null;
      redraw(key);
    };
    canvas.onpointerup = event=>{
      if (touchScroll?.id===event.pointerId) touchScroll=null;
      if (job?.pointer!==event.pointerId) return;
      const currentJob=job;
      job=null;
      applyGesture(currentJob).catch(error=>toast(error.message));
    };
  }

  async function applyGesture(gesture) {
    const {key,start,end,tool}=gesture;
    const list=objects(key);
    if(gesture.transform)await commit(transformedSelection(gesture,end),key);
    else if (['pen','highlighter'].includes(tool)) {
      const stroke={id:crypto.randomUUID(),type:tool,points:gesture.points,color:tool==='highlighter'&&color===(prefs.penColor||'#1c50a0')?(prefs.highlightColor||'#ffd200'):color,width:tool==='highlighter'?Math.max(13,size*3):nib==='fine'?Math.min(2,size):size,nib};
      await commit([...list,stroke],key);
    } else if (tool==='eraser') {
      const next=list.filter(object=>object.locked||object.type==='bookmark'||(eraserMode==='stroke'&&!['pen','highlighter'].includes(object.type))||!gesture.points.some(pt=>overlaps(bounds(object),{...pt,w:0,h:0},.017)));
      if(next.length!==list.length) await commit(next,key);
    } else if (tool==='lasso') {
      const box={x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),w:Math.abs(end.x-start.x),h:Math.abs(end.y-start.y)};
      picked=list.filter(object=>object.type!=='bookmark'&&overlaps(bounds(object),box,.018)).map(object=>object.id);
      await redraw(key);renderContextTools();
    } else if (tool==='text') await addText(start,key);
    else if (tool==='image') await addImage(start,key);
    else if (tool==='shape') {
      const choice=await modal('Shape',select('Shape','shape',[['rectangle','Rectangle'],['ellipse','Ellipse'],['line','Line']],'rectangle'));
      if(choice) await commit([...list,{id:crypto.randomUUID(),type:'shape',shape:choice.shape,color,width:size,x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),w:Math.max(.08,Math.abs(end.x-start.x)),h:Math.max(.055,Math.abs(end.y-start.y))}],key);
    }
  }

  async function addText(at,key,existing=null){
    const markup='<label class="field">Text<textarea name="text" dir="auto" maxlength="8000" required>'+esc(existing?.text||'')+'</textarea></label>'+
      select('Formatting','style',[['plain','Normal'],['bold','Bold'],['italic','Italic'],['list','Bulleted list']],existing?.style||'plain')+
      select('Direction','direction',[['auto','Auto'],['ltr','Left to right'],['rtl','Right to left']],existing?.direction||'auto')+
      '<label class="field">Link (optional)<input name="url" type="url" value="'+esc(existing?.url||'')+'"></label><label class="field">Size<input name="size" type="number" min="12" max="56" value="'+(existing?.size||22)+'"></label>';
    const form=await modal('Typed Note',markup,{confirm:'Save'});
    if(!form) return;
    const item={id:existing?.id||crypto.randomUUID(),type:'text',x:at.x,y:at.y,w:Math.min(.66,1-at.x),h:.11,color,text:form.text,style:form.style,direction:form.direction==='auto'?(/[\u0600-\u06ff]/.test(form.text)?'rtl':'ltr'):form.direction,size:Number(form.size),url:/^https?:\/\//i.test(form.url)?form.url:''};
    const list=objects(key);
    await commit(existing?list.map(object=>object.id===item.id?item:object):[...list,item],key);
  }

  async function chooseImage(){
    const ask=await modal('Insert Image',select('Source','source',[['gallery','Gallery'],['camera','Camera'],['clipboard','Clipboard'],['files','Files']],'gallery'),{confirm:'Choose'});
    if (!ask) return null;
    if(ask.source==='clipboard') {
      if (!navigator.clipboard?.read) throw new Error('Clipboard access is unavailable. Paste the image in the editor or use Files.');
      const items=await navigator.clipboard.read();
      for(const item of items){
        const type=item.types.find(type=>type.startsWith('image/'));
        if(type) return item.getType(type);
      }
      throw new Error('The clipboard has no image.');
    }
    const field=document.createElement('input');
    field.type='file';
    field.accept='image/*';
    if (ask.source==='camera') field.capture='environment';
    return new Promise(resolve=>{field.onchange=()=>resolve(field.files[0]);field.oncancel=()=>resolve(null);field.click();});
  }
  async function placeImage(file,at,key){
    const original=await compressImage(file);
    const blob=await saveBlob(original,{local:true});
    const list=objects(key);
    const item={id:crypto.randomUUID(),type:'image',blob,x:Math.min(.75,at.x),y:Math.min(.76,at.y),w:.24,h:.22,rotate:0,crop:[0,0,1,1],locked:false};
    await commit([...list,item],key);
  }
  async function addImage(at,key){
    const file=await chooseImage();
    if(file) await placeImage(file,at,key);
  }

  async function objectMenu(object,key) {
    const choices=[['keep','Keep selection'],['copy','Copy'],['delete','Delete'],['back','Send backward'],['front','Bring forward'],['review','Review Later']];
    if(object.type==='image') choices.push(['edit','Position, size, rotation, crop and caption'],['lock',object.locked?'Unlock image':'Lock image']);
    if(object.type==='text') {
      choices.push(['edit','Edit text']);
      if(object.url) choices.push(['link','Open link']);
    }
    const picked=await modal(object.type==='image'?'Image':'Selected item',select('Action','action',choices,'keep'),{confirm:'Apply'});
    if(!picked||picked.action==='keep') return;
    const list=objects(key);
    const index=list.findIndex(entry=>entry.id===object.id);
    if(picked.action==='review') return options.review(item,key,object);
    if(picked.action==='link') {window.open(object.url,'_blank','noopener,noreferrer');return;}
    if(picked.action==='edit'&&object.type==='text') return addText(object,key,object);
    if(picked.action==='edit'&&object.type==='image') {
      if(object.locked) return toast('Unlock the image to edit it.');
      const crop=object.crop||[0,0,1,1];
      const numeric=(label,key,value,min,max)=>'<label class="field">'+label+'<input name="'+key+'" type="number" min="'+min+'" max="'+max+'" value="'+value+'" required></label>';
      const form=await modal('Image adjustments',numeric('Left (%)','x',Math.round(object.x*100),0,98)+numeric('Top (%)','y',Math.round(object.y*100),0,98)+
        numeric('Width (%)','w',Math.round(object.w*100),4,100)+numeric('Height (%)','h',Math.round(object.h*100),4,100)+numeric('Rotation (°)','rotate',object.rotate,-360,360)+
        numeric('Crop left (%)','cx',Math.round(crop[0]*100),0,90)+numeric('Crop top (%)','cy',Math.round(crop[1]*100),0,90)+
        numeric('Crop width (%)','cw',Math.round(crop[2]*100),5,100)+numeric('Crop height (%)','ch',Math.round(crop[3]*100),5,100)+
        '<label class="field">Caption<input name="caption" maxlength="150" value="'+esc(object.caption||'')+'"></label>',{confirm:'Save'});
      if(!form) return;
      const x=Number(form.cx)/100,y=Number(form.cy)/100;
      const value={...object,x:Number(form.x)/100,y:Number(form.y)/100,w:Number(form.w)/100,h:Number(form.h)/100,rotate:Number(form.rotate),caption:form.caption,crop:[x,y,Math.min(1-x,Number(form.cw)/100),Math.min(1-y,Number(form.ch)/100)]};
      return commit(list.map(entry=>entry.id===object.id?value:entry),key);
    }
    if(object.locked&&picked.action==='delete') return toast('Unlock the image to delete it.');
    if(picked.action==='lock') return commit(list.map(entry=>entry.id===object.id?{...entry,locked:!entry.locked}:entry),key);
    if(picked.action==='delete') return commit(list.filter(entry=>entry.id!==object.id),key);
    if(picked.action==='copy') return commit([...list,{...moveObjects([object],[object.id],.025,.02)[0],id:crypto.randomUUID(),locked:false}],key);
    const next=[...list];
    next.splice(index,1);
    next.splice(clamp(index+(picked.action==='front'?1:-1),0,next.length),0,object);
    return commit(next,key);
  }

  async function addPage() {
    const form=await modal('Add Page',select('Page type','paper',papers,'blank')+select('Position','position',[['before','Before Current Page'],['after','After Current Page'],['end','End of File']],'after'),{confirm:'Add'});
    if(!form) return;
    let blob;
    let ratio=defaultRatio;
    let copied=[];
    if(form.paper==='image'){
      const file=await chooseImage();
      if(!file) return;
      const image=await createImageBitmap(file);
      ratio=image.width/image.height;
      image.close();
      blob=await saveBlob(await compressImage(file),{local:true});
    }
    if(form.paper==='note') {
      const notes=options.noteOptions();
      if(!notes.length){toast('Create a notebook page first.');return;}
      const selected=await modal('Choose Note Page',select('Note','note',notes),{confirm:'Add'});
      if(!selected) return;
      const note=get(selected.note);
      const orig=(await itemPages(note))[0];
      copied=scene(note.id,orig.key);
      form.paper=orig.paper;
      ratio=orig.ratio;
    }
    const spec={key:crypto.randomUUID(),paper:form.paper,ratio,blob};
    const order=specs.map(spec=>spec.key);
    const index=form.position==='end'?order.length:selectedIndex+(form.position==='after'?1:0);
    order.splice(index,0,spec.key);
    const latest=get(item.id);
    item={...latest,pagesAdded:[...(latest.pagesAdded||specs.filter(spec=>!spec.number)),spec],order,edited:Date.now()};
    if(item.type==='note') item.pagesAdded=order.map(key=>item.pagesAdded.find(spec=>spec.key===key));
    await save(item.id,'item',item);
    if(copied.length) await commit(copied,spec.key,false);
    specs=buildSpecs(item,doc);
    selectedIndex=index;
    renderTools();renderSheets();paintPanel();
    if(item.type!=='note') studied();
  }

  async function managePage(){
    const spec=current();
    if(spec.number){toast('Original PDF pages are preserved. Select an added page to manage it.');return;}
    const choose=await modal('Manage Page',select('Action','action',[
      ['earlier','Move earlier'],['later','Move later'],['position','Move to position'],['paper','Change paper'],['duplicate','Duplicate'],['notebook','Save copy in Notes'],['delete','Delete'],
    ],'position'),{confirm:'Continue'});
    if(!choose) return;
    if(choose.action==='notebook') return options.copyPage(item,spec,objects());
    const list=[...specs];
    let next=selectedIndex;
    let duplicate;
    if(choose.action==='delete'){
      if(list.length<=1) return toast('Keep at least one page.');
      if(!(await modal('Delete this page?','<p>The previous version is saved in Version History.</p>',{confirm:'Delete'}))) return;
      list.splice(selectedIndex,1);
      next=Math.min(selectedIndex,list.length-1);
    } else if(choose.action==='paper'){
      const form=await modal('Paper',select('Background','paper',papers.slice(0,4),spec.paper),{confirm:'Apply'});
      if(!form) return;
      list[selectedIndex]={...spec,paper:form.paper};
    } else if(choose.action==='duplicate'){
      duplicate={...spec,key:crypto.randomUUID()};
      next=selectedIndex+1;
      list.splice(next,0,duplicate);
    } else {
      if(choose.action==='position'){
        const form=await modal('Move Page','<label class="field">Position<input type="number" min="1" max="'+list.length+'" name="position" value="'+(selectedIndex+1)+'" required></label>',{confirm:'Move'});
        if(!form) return;
        next=Number(form.position)-1;
      } else next=clamp(selectedIndex+(choose.action==='earlier'?-1:1),0,list.length-1);
      list.splice(selectedIndex,1);
      list.splice(next,0,spec);
    }
    item={...get(item.id),pagesAdded:list.filter(page=>!page.number),order:list.map(page=>page.key),edited:Date.now()};
    await save(item.id,'item',item);
    if(duplicate) await commit(objects(spec.key),duplicate.key,false);
    specs=buildSpecs(item,doc);
    selectedIndex=next;
    renderTools();renderSheets();paintPanel();
  }

  function seek(position) {
    if (!position) return;
    requestAnimationFrame(()=>{
      if (disposed) return;
      const page=canvases.get(target())?.shell;
      if(!page)return;
      const rect=page.getBoundingClientRect();
      const viewport=scroll.getBoundingClientRect();
      scroll.scrollTop+=rect.top+position.y*rect.height-viewport.top-Math.min(100,viewport.height/5);
      if(zoom>1)scroll.scrollLeft+=rect.left+position.x*rect.width-viewport.left-28;
    });
  }

  async function highlight(itemSpec,query) {
    if (!query?.trim()) return;
    const docPage=itemSpec.number ? await doc.getPage(itemSpec.number) : null;
    const words=terms(query);
    const matches=value=>words.some(word=>normalize(value).includes(word));
    if(docPage){
      const viewport=docPage.getViewport({scale:1});
      const list=(await docPage.getTextContent()).items.filter(value=>value.str);
      searchBoxes=list.filter(value=>matches(value.str)).map(value=>{
        const [x,y]=viewport.convertToViewportPoint(value.transform[4],value.transform[5]);
        return {x:x/viewport.width,y:(y-value.height)/viewport.height,w:value.width/viewport.width,h:Math.max(.012,value.height/viewport.height)};
      });
    }
    if(!searchBoxes.length){
      const page=itemSpec.number||1;
      const result=await getIndex(item.id,page) || await api('index/'+item.id+'/'+page).catch(()=>null);
      searchBoxes=(result?.anchors||[]).filter(([value])=>matches(value)).map(([,x,y,w,h])=>({x,y,w,h}));
    }
    await redraw();
    seek(searchBoxes[0]);
    setTimeout(()=>{searchBoxes=[];redraw();},5000);
  }

  async function documentSearch(){
    if(!doc) return;
    const form=await modal('Search in Document',input('Find text','query'),{confirm:'Search'});
    if(!form) return;
    let hits=[];
    try {hits=(await api('search?'+new URLSearchParams({q:form.query}))).results.filter(hit=>hit.id===item.id);}
    catch {}
    if(!hits.length){
      const lower=form.query.toLowerCase();
      for(let number=1;number<=doc.numPages;number++){
        const content=(await(await doc.getPage(number)).getTextContent()).items.map(item=>item.str||'').join(' ');
        const start=content.toLowerCase().indexOf(lower);
        if(start!==-1) hits.push({page:number,snippet:content.slice(Math.max(0,start-34),start+form.query.length+45)});
      }
    }
    if(!hits.length) {toast('No search results');return;}
    const find=await modal('Search Results',select('Match','page',hits.map(hit=>[String(hit.page),'Page '+hit.page+' — '+hit.snippet.slice(0,100)]),String(hits[0].page)),{confirm:'Open'});
    if(find){
      jump(specs.findIndex(spec=>spec.number===Number(find.page)));
      await highlight(current(),form.query);
    }
  }

  async function jumpMenu(){
    const form=await modal('Go to Page','<label class="field"><span>Page</span><input name="page" type="number" min="1" max="'+specs.length+'" value="'+(selectedIndex+1)+'" inputmode="numeric" required></label>',{confirm:'Go'});
    if(form)jump(Number(form.page)-1);
  }

  async function zoomMenu(){
    const choice=await actionMenu('Zoom',[{items:[['zoom-75','75%'],['zoom-100','100%'],['zoom-125','125%'],['zoom-150','150%'],['zoom-fit','Fit Page']]}]);
    if(!choice)return;
    zoom=choice==='zoom-fit'?1:Number(choice.slice(5))/100;
    renderTools();renderSheets();recordView();
  }

  async function readerAdd(){
    const choice=await actionMenu('Add',[{items:[
      ['typed-note','Typed Note','text'],['insert-image','Image','image'],['insert-shape','Shape','shape'],['add-page','Add Page','pages'],
    ]}]);
    if(choice==='typed-note'){
      pen='text';renderTools();toast('Tap the page to place the note.');return;
    }
    if(choice==='insert-image'){
      const file=await chooseImage();
      if(file){pendingImage=file;pen='image';renderTools();toast('Tap the page to place the image.');}
      return;
    }
    if(choice==='insert-shape'){
      pen='shape';renderTools();toast('Drag on the page to draw the shape.');return;
    }
    if(choice==='add-page')return addPage();
  }

  async function changeSelected(action){
    const object=objects().find(entry=>picked.includes(entry.id));
    if(!object)return;
    const list=objects();
    const index=list.findIndex(entry=>entry.id===object.id);
    if(action==='object-delete'){
      picked=[];cropMode=false;
      return commit(list.filter(entry=>entry.id!==object.id));
    }
    if(action==='object-edit'&&object.type==='text')return addText(object,target(),object);
    if(action==='object-crop'){
      cropMode=!cropMode;redraw();renderContextTools();return;
    }
    if(action==='object-rotate')return commit(list.map(entry=>entry.id===object.id?{...entry,rotate:(entry.rotate||0)+90}:entry));
    if(action==='object-caption'){
      const form=await modal('Caption','<label class="field"><span>Caption</span><input name="caption" maxlength="150" value="'+esc(object.caption||'')+'"></label>',{confirm:'Save'});
      if(form)return commit(list.map(entry=>entry.id===object.id?{...entry,caption:form.caption}:entry));
      return;
    }
    if(action==='object-front'||action==='object-back'){
      const next=[...list];
      next.splice(index,1);
      next.splice(action==='object-front'?next.length:0,0,object);
      return commit(next);
    }
  }

  async function readerMenu(){
    const study=[['bookmark','Add or remove bookmark','bookmark'],['review','Review Later','clock']];
    if(doc)study.unshift(['find','Search in Document','search'],['bookmarks','Bookmarks','bookmark']);
    const view=[['layout','Reading View','pages'],['full','Full Screen','monitor']];
    const file=[['export','Export PDF','download'],['history','Version History','clock']];
    if(item.blob)file.push(['download','Download Original','download']);
    if(typeof window.print === 'function')file.push(['print','Print','file']);
    if(!current().number)file.push(['page','Manage Page','pages']);
    const choice=await actionMenu('Reader Options',[
      {label:'Study',items:study},{label:'View',items:view},{label:'File',items:file},
      {label:'Safety',items:[['close-reader','Close Reader','close']]},
    ]);
    if(!choice) return;
    if(choice==='find') return documentSearch();
    if(choice==='page') return managePage();
    if(choice==='history') return options.history(item.id,current().number?null:annotationKey(item.id,target()));
    if(choice==='review') return options.review(item,target());
    if(choice==='bookmark')return handle('bookmark');
    if(choice==='close-reader')return handle('reader-back');
    if(choice==='bookmarks'){
      const bookmarks=specs.flatMap((spec,index)=>objects(spec.key).some(obj=>obj.type==='bookmark')?[[String(index),'Page '+(index+1)]]:[]);
      if(!bookmarks.length) return toast('No bookmarks yet.');
      const pick=await modal('Bookmarks',select('Page','page',bookmarks,bookmarks[0][0]),{confirm:'Open'});
      if(pick) jump(Number(pick.page));
      return;
    }
    if(choice==='layout'){
      const form=await modal('Reading view',select('View','mode',[['continuous','Continuous Scroll'],['single','Single Page'],['two','Two Page View']],mode),{confirm:'Apply'});
      if(form){mode=form.mode;renderSheets();recordView();}
      return;
    }
    if(choice==='full') {
      if (document.fullscreenElement) return document.exitFullscreen();
      if (shell.requestFullscreen) return shell.requestFullscreen();
      return toast('Full Screen is unavailable in this browser.');
    }
    if(choice==='download'){
      download(await fetchBlob(item.blob),item.name);
      return;
    }
    toast('Preparing PDF…');
    await saving.catch(()=>{});
    const blob=await renderExport(item);
    if(choice==='print'){
      const url=URL.createObjectURL(blob);
      const frame=document.createElement('iframe');
      frame.className='print-frame';
      frame.src=url;
      frame.onload=()=>{try{frame.contentWindow.print();}catch{toast('Open the exported PDF to print.');download(blob,item.name);}};
      document.body.append(frame);
      setTimeout(()=>{frame.remove();URL.revokeObjectURL(url);},60_000);
    } else {saveExport(item,blob);toast('PDF ready',1500);}
  }

  async function handle(action,event){
    if(action==='reader-back'){await saving;return options.back();}
    if(action==='reader-search')return documentSearch();
    if(action==='reader-add')return readerAdd();
    if(action==='reader-menu') return specs ? readerMenu() : null;
    if(action==='retry-page'){
      const spec=specs[Number(event.dataset.page)];
      const info=canvases.get(spec?.key);
      if(info&&!info.loading)return queuePage(info,spec);
      return;
    }
    if(action==='pages'){
      panel.hidden=!panel.hidden;
      if(!panel.hidden) paintPanel();
      renderNavigation();
      renderSheets();
      return;
    }
    if(action==='close-pages'){panel.hidden=true;renderNavigation();renderSheets();return;}
    if(action==='pin-pages'){panelPinned=!panelPinned;panel.dataset.pinned=String(panelPinned);return;}
    if(action==='page-jump')return jumpMenu();
    if(action==='zoom-menu')return zoomMenu();
    if(action==='jump') return jump(Number(event.closest('button').dataset.page));
    if(action==='prev'||action==='next') return jump(selectedIndex+(action==='next'?1:-1));
    if(action.startsWith('zoom-')){
      zoom=action==='zoom-reset'?1:clamp(zoom+(action==='zoom-in'?.2:-.2),.55,3);
      renderTools();renderSheets();recordView();
      return;
    }
    if(action.startsWith('draw-')){
      pen=action.slice(5);
      cropMode=false;picked=[];
      for(const info of canvases.values()) info.ink.classList.toggle('annotate',pen!=='navigate');
      renderTools();
      return;
    }
    if(action==='eraser-mode'){eraserMode=event.dataset.mode;renderContextTools();return;}
    if(action.startsWith('object-'))return changeSelected(action);
    if(action==='undo'||action==='redo'){
      const [from,to]=action==='undo'?[undo,redo]:[redo,undo];
      const value=from.get(target())?.pop();
      if(!value) return;
      const stack=to.get(target())||[];
      stack.push(structuredClone(objects()));
      to.set(target(),stack);
      return commit(value,target(),false);
    }
    if(action==='bookmark'){
      const list=objects();
      const exists=list.some(object=>object.type==='bookmark');
      return commit(exists?list.filter(object=>object.type!=='bookmark'):[...list,{id:crypto.randomUUID(),type:'bookmark'}]);
    }
    if(action==='new-page') return addPage();
  }

  try {
    if(item.type==='pdf'){
      documentLease=await acquirePdf(item,options.compatibility);
      doc=documentLease.doc;
    }
    specs=buildSpecs(item,doc);
    if(disposed) return;
    const instance=options.resume||{};
    const requested=options.pageKey||instance.pageKey;
    if(requested) selectedIndex=Math.max(0,specs.findIndex(spec=>spec.key===requested));
    zoom=clamp(numberOr(instance.zoom,1),.55,3);
    mode=instance.mode||mode;
    renderTools();renderSheets();paintPanel();
    if(options.query) await highlight(current(),options.query);
    if(options.object) {
      const object=objects().find(entry=>entry.id===options.object);
      if(object && object.type!=='bookmark') {
        picked=[object.id];
        seek(bounds(object));
        await redraw();
        setTimeout(()=>{picked=[];redraw();},5000);
      }
    }
    if(item.type!=='note' && item.pages!==(doc?.numPages||1)) save(item.id,'item',{...get(item.id),pages:doc?.numPages||1}).catch(()=>{});
    if(item.type!=='note'){
      options.opened(item);
      dwell=setTimeout(()=>{if(document.visibilityState==='visible') studied();},20_000);
    }
  } catch(error){
    pages.innerHTML=pdfRecovery('retry-reader');
    const menu=shell.querySelector('[data-action=reader-menu]');
    if(menu&&!specs)menu.hidden=true;
    console.warn('Reader could not open the document',error.name,error.message);
  }

  shell.addEventListener('click',event=>{
    const control=event.target.closest('[data-action]');
    if(!control) return;
    if(control.dataset.action==='retry-reader') return options.retry({compatibility:true});
    Promise.resolve(handle(control.dataset.action,control)).catch(error=>toast(error.message));
  },{signal:scope.signal});
  shell.addEventListener('change',event=>{
    if(event.target.matches('.page-number')) jump(Number(event.target.value)-1);
    if(event.target.matches('.pen-color')) color=event.target.value;
    if(event.target.matches('.pen-size')) size=Number(event.target.value);
    if(event.target.matches('.nib')) nib=event.target.value;
  },{signal:scope.signal});
  scroll.addEventListener('scroll',()=>{
    if(mode!=='continuous'||writing||(!restored&&restorePending)||job) return;
    const rect=scroll.getBoundingClientRect();
    const index=[...canvases.values()].findIndex(info=>info.shell.getBoundingClientRect().bottom>rect.top+80);
    if(index!==-1) setPage(index);
  },{passive:true,signal:scope.signal});
  window.addEventListener('paste',event=>{
    if(document.querySelector('dialog').open || !specs?.length) return;
    const image=[...event.clipboardData.items].find(item=>item.type.startsWith('image/'));
    if(image){event.preventDefault();placeImage(image.getAsFile(),{x:.2,y:.22},target()).catch(error=>toast(error.message));}
  },{signal:scope.signal});
  let resize;
  window.addEventListener('resize',()=>{
    clearTimeout(resize);
    resize=setTimeout(()=>{if(!disposed&&specs) renderSheets();},250);
  },{signal:scope.signal});
  window.addEventListener('keydown',event=>{
    if(document.querySelector('dialog').open || event.target.matches('input,textarea,select')) return;
    const key=event.key.toLowerCase();
    if((event.metaKey||event.ctrlKey)&&(key==='z'||key==='y')){
      event.preventDefault();
      handle(event.shiftKey||key==='y'?'redo':'undo',event.target);
    }
  },{signal:scope.signal});
  return {
    phase(value){state.textContent=value;},
    async close(){
      if(dirty&&specs) studied();
      disposed=true;
      clearTimeout(dwell);
      clearTimeout(resize);
      scope.abort();
      pageObserver?.disconnect();
      panelObserver?.disconnect();
      for(const info of canvases.values()) releasePixels(info);
      Promise.allSettled(pendingPages).then(()=>documentLease?.release());
      await saving;
    },
  };
}
