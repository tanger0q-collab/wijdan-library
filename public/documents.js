import {api,cachedBlob,fetchBlob,get,save,saveBlob,saveIndex} from './store.js';

let pdfModule;
let pdfLib;
let tess;
const pdfs = new Map();
const compatibleFiles = new Set();
const compatibleDocs = new WeakSet();
const compactCanvas = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);
const maxBufferedPdf = 24 * 1024 * 1024;
const thumbJobs = new Map();
let indexWork = Promise.resolve();
const indexControls=new Map();
const imageTypes = new Set(['image/jpeg','image/png','image/webp','image/gif','image/avif']);
export const PDF = 'application/pdf';

export async function pdfjs() {
  pdfModule ||= import('/vendor/pdf.mjs').then(lib=>{
    lib.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker.mjs';
    return lib;
  }).catch(error=>{pdfModule=null;throw error;});
  return pdfModule;
}

export function script(path, value) {
  if (globalThis[value]) return Promise.resolve(globalThis[value]);
  return new Promise((resolve,reject)=>{
    const elem=document.createElement('script');
    elem.src=path;
    elem.onload=()=>resolve(globalThis[value]);
    elem.onerror=()=>reject(new Error(value+' could not load.'));
    document.head.append(elem);
  });
}

async function loadPdf(item, compatibility) {
  const lib=await pdfjs();
  const local=await cachedBlob(item.blob);
  const useBytes=compatibility && navigator.onLine && item.size>0 && item.size<=maxBufferedPdf;
  let buffered=local;
  if(useBytes) {
    try {buffered=await (await api('blob/'+item.blob,{raw:true})).blob();}
    catch(error){if(!local)throw error;}
  }
  const source=buffered
    ? {data:new Uint8Array(await buffered.arrayBuffer())}
    : {url:'/api/blob/'+item.blob,rangeChunkSize:256*1024,disableAutoFetch:true,disableStream:true};
  const gentle=compatibility||compactCanvas;
  const task=lib.getDocument({...source,cMapUrl:'/vendor/cmaps/',cMapPacked:true,
    standardFontDataUrl:'/vendor/standard_fonts/',wasmUrl:'/vendor/wasm/',isEvalSupported:false,enableXfa:false,
    ...(gentle?{isOffscreenCanvasSupported:false,isImageDecoderSupported:false,canvasMaxAreaInBytes:20*1024*1024}:{}),
    ...(compatibility?{useWasm:false}:{})});
  try {
    const doc=await task.promise;
    if(compatibility)compatibleDocs.add(doc);
    return doc;
  } catch(error){
    await task.destroy().catch(()=>{});
    throw error;
  }
}

// Reader, indexer and thumbnail jobs can share the same proxy until the last
// user releases it. Only unused documents can be evicted.
function trimPdfCache() {
  for(const [key,entry] of pdfs) {
    if(pdfs.size<=2)break;
    if(entry.users)continue;
    pdfs.delete(key);
    entry.promise.then(doc=>doc.destroy()).catch(()=>{});
  }
}
async function leasePdf(item,compatibility) {
  const key=item.blob+(compatibility?':compatibility':':normal');
  let entry=pdfs.get(key);
  if(entry)pdfs.delete(key);
  else entry={users:0,promise:loadPdf(item,compatibility).catch(error=>{
    pdfs.delete(key);
    throw error;
  })};
  pdfs.set(key,entry);
  entry.users++;
  trimPdfCache();
  const doc=await entry.promise;
  let released=false;
  return {doc,release(){
    if(released)return;
    released=true;
    entry.users--;
    trimPdfCache();
  }};
}

export async function acquirePdf(item,tryCompatibility=false) {
  if(!tryCompatibility&&!compatibleFiles.has(item.blob)){
    try{return await leasePdf(item,false);}
    catch(error){if(error.name==='PasswordException')throw error;}
  }
  const lease=await leasePdf(item,true);
  compatibleFiles.add(item.blob);
  return lease;
}

export async function withPdf(item,work) {
  const lease=await acquirePdf(item);
  try{return await work(lease.doc);}
  finally{lease.release();}
}

export async function renderReadablePage(item,doc,number,canvas,width,density=1) {
  if(compatibleDocs.has(doc))return renderPage(doc,number,canvas,width,1,1900);
  if(!compatibleFiles.has(item.blob)){
    try{return await renderPage(doc,number,canvas,width,compactCanvas?Math.min(1.25,density):density,compactCanvas?2200:3000);}
    catch(error){if(!canvas.isConnected&&canvas.classList.contains('base'))throw error;}
  }
  const lease=await acquirePdf(item,true);
  try{return await renderPage(lease.doc,number,canvas,width,1,1900);}
  finally{lease.release();}
}

export async function renderPage(doc,pageNumber,canvas,width,density=1,maxSide=3000) {
  const page = await doc.getPage(pageNumber);
  const unit = page.getViewport({scale:1});
  const scale = Math.min((width*density)/unit.width,maxSide/Math.max(unit.width,unit.height));
  const viewport = page.getViewport({scale});
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const canvasContext = canvas.getContext('2d');
  if(!canvasContext)throw new Error('Canvas unavailable');
  await page.render({canvas,canvasContext,viewport}).promise;
  return {page,viewport};
}

export const toBlob = (canvas,type='image/webp',quality=.86)=>new Promise((resolve,reject)=>
  canvas.toBlob(blob=>blob ? resolve(blob) : reject(new Error('Image could not be saved.')),type,quality));
export const canvasFor = ()=>document.createElement('canvas');

export async function compressImage(file,max=2100) {
  if (!imageTypes.has(file.type)) throw new Error('Choose a JPG, PNG, WebP, GIF or AVIF image.');
  const image = await createImageBitmap(file);
  const factor = Math.min(1,max/Math.max(image.width,image.height));
  if (factor === 1 && file.size < 1_500_000) {image.close();return file;}
  const canvas = canvasFor();
  canvas.width = Math.round(image.width*factor);
  canvas.height = Math.round(image.height*factor);
  canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
  image.close();
  return toBlob(canvas);
}

export async function thumbnail(item,page=1) {
  if (page===1 && item.thumb) return item.thumb;
  const key = item.id+':'+page;
  if (thumbJobs.has(key)) return thumbJobs.get(key);
  const task = (async ()=>{
    if (item.type === 'image') return item.blob;
    if (item.type !== 'pdf') return null;
    const canvas=canvasFor();
    await withPdf(item,doc=>renderReadablePage(item,doc,page,canvas,320));
    const blob=await toBlob(canvas);
    return saveBlob(blob,{local:true});
  })().catch(error=>{thumbJobs.delete(key);throw error;});
  thumbJobs.set(key,task);
  if (thumbJobs.size>60) thumbJobs.delete(thumbJobs.keys().next().value);
  return task;
}

async function createRecognizer(langs,report) {
  tess ||= script('/vendor/tesseract.js','Tesseract');
  const lib=await tess;
  return lib.createWorker(langs,1,{
    workerPath:'/vendor/tesseract-worker.js',
    corePath:'/vendor/ocr',
    langPath:'/vendor/ocr',
    logger:event=>{if (event.status==='recognizing text') report(Math.round(event.progress*100));},
  });
}

async function recognize(input,worker) {
    const {data}=await worker.recognize(input,{}, {text:true,blocks:true});
    const anchors=(data.blocks||[]).flatMap(block=>block.paragraphs.flatMap(paragraph=>paragraph.lines.flatMap(line=>line.words))).map(word=>{
      const {x0,y0,x1,y1}=word.bbox;
      return [word.text,x0/input.width,y0/input.height,(x1-x0)/input.width,(y1-y0)/input.height];
    });
    return {text:data.text,anchors};
}

export const pauseIndex=id=>{const control=indexControls.get(id);if(control)control.paused=true;};
export const resumeIndex=id=>{const control=indexControls.get(id);if(control){control.paused=false;control.release?.();}};
export const cancelIndex=id=>{const control=indexControls.get(id);if(control){control.cancelled=true;control.paused=false;control.release?.();}};
async function indexCheckpoint(control){
  if(control.cancelled)return false;
  while(control.paused&&!control.cancelled)await new Promise(resolve=>{control.release=resolve;});
  control.release=null;
  return !control.cancelled;
}

export function indexDocument(id, settings, notify=()=>{}, {allowOcr=false}={}) {
  const job = indexWork.catch(()=>{}).then(async ()=>{
    let item=get(id);
    if (!item || item.deleted || !['pdf','image'].includes(item.type)) return;
    const control={paused:false,cancelled:false,release:null};
    indexControls.set(id,control);
    let ocrWorker=null;
    const update=async patch=>{
      item={...get(id),...patch,indexTouched:Date.now()};
      await save(id,'item',item);
      notify();
    };
    try {
      const resume=Number(item.indexCursor)||0;
      await update({indexState:'Processing',indexProgress:resume?item.indexProgress:0});
      let required=Boolean(item.indexNeedsOCR);
      const langs=settings.ocrLanguages || 'eng+ara';
      if (item.type==='pdf') {
        await withPdf(item,async doc=>{
          const thumb=await thumbnail(item).catch(()=>null);
          await update({pages:doc.numPages,thumb:thumb || item.thumb});
          for (let page=resume+1;page<=doc.numPages;page++) {
            if (get(id)?.deleted||!(await indexCheckpoint(control))){await update({indexState:'Cancelled',indexCursor:page-1});return;}
            const content=await (await doc.getPage(page)).getTextContent();
            let value=content.items.map(item=>item.str || '').join(' ').trim();
            let source='pdf';
            let anchors=[];
            if (value.replace(/[^\p{L}\p{N}]/gu,'').length < 6) {
              if (settings.ocr === false||!allowOcr) required=true;
              else {
                await update({indexState:'OCR Processing',indexProgress:Math.round((page-1)/doc.numPages*100)});
                const canvas=canvasFor();
                await renderReadablePage(item,doc,page,canvas,1600);
                ocrWorker ||= await createRecognizer(langs,percent=>notify('OCR page '+page+' · '+percent+'%'));
                const result=await recognize(canvas,ocrWorker);
                value=result.text;
                anchors=result.anchors;
                source='ocr';
              }
            }
            if (value) await saveIndex(id,page,value,source,anchors);
            if (page % 4===0 || source==='ocr' || page===doc.numPages) await update({indexState:'Processing',indexCursor:page,indexNeedsOCR:required,indexProgress:Math.round(page/doc.numPages*100)});
          }
        });
      } else if (settings.ocr===false||!allowOcr) required=true;
      else {
        if(!(await indexCheckpoint(control))){await update({indexState:'Cancelled'});return;}
        await update({indexState:'OCR Processing'});
        const blob=await fetchBlob(item.blob);
        const bitmap=await createImageBitmap(blob);
        const canvas=canvasFor();
        const factor=Math.min(1,1800/Math.max(bitmap.width,bitmap.height));
        canvas.width=Math.round(bitmap.width*factor);
        canvas.height=Math.round(bitmap.height*factor);
        canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
        bitmap.close();
        await update({ratio:canvas.width/canvas.height});
        ocrWorker ||= await createRecognizer(langs,percent=>notify('OCR · '+percent+'%'));
        const {text,anchors}=await recognize(canvas,ocrWorker);
        if (text.trim()) await saveIndex(id,1,text,'image',anchors);
      }
      await update({indexState:required?'OCR Required':'Ready to Search',indexProgress:100,indexCursor:0,indexNeedsOCR:required,indexError:null});
    } catch (error) {
      await update({indexState:'Failed',indexError:error.message});
      throw error;
    } finally {
      await ocrWorker?.terminate().catch(()=>{});
      indexControls.delete(id);
    }
  });
  indexWork=job;
  return job;
}

export const originalUrl = item=>'/api/blob/'+encodeURIComponent(item.blob);

export function downloadOriginal(item) {
  return fetchBlob(item.blob);
}

export async function exportPdf(item,pages,paint) {
  pdfLib ||= script('/vendor/pdf-lib.js','PDFLib');
  const {PDFDocument}=await pdfLib;
  const output=await PDFDocument.create();
  let original;
  if (item.type==='pdf') original=await PDFDocument.load(await (await fetchBlob(item.blob)).arrayBuffer(),{updateMetadata:false});
  const compose=async display=>{
    for (const spec of pages) {
      const transparent=await paint(spec);
      let page;
      if (spec.number) {
        const [copy]=await output.copyPages(original,[spec.number-1]);
        page=output.addPage(copy);
        if (transparent) {
          const img=await output.embedPng(await (await toBlob(transparent,'image/png')).arrayBuffer());
          const shown=(await display.getPage(spec.number)).getViewport({scale:1});
          const size=page.getSize();
          const rotation=((page.getRotation().angle%360)+360)%360;
          if (rotation) {
            const raster=canvasFor();
            await renderReadablePage(item,display,spec.number,raster,Math.min(1600,shown.width*2));
            raster.getContext('2d').drawImage(transparent,0,0,raster.width,raster.height);
            output.removePage(output.getPageCount()-1);
            page=output.addPage([shown.width,shown.height]);
            const combined=await output.embedPng(await (await toBlob(raster,'image/png')).arrayBuffer());
            page.drawImage(combined,{x:0,y:0,width:shown.width,height:shown.height});
          } else page.drawImage(img,{x:0,y:0,width:size.width,height:size.height});
        }
      } else {
        const ratio=spec.ratio || (transparent ? transparent.width/transparent.height : .727);
        page=output.addPage([612,612/ratio]);
        if (transparent) {
          const img=await output.embedPng(await (await toBlob(transparent,'image/png')).arrayBuffer());
          page.drawImage(img,{x:0,y:0,width:page.getWidth(),height:page.getHeight()});
        }
      }
    }
  };
  if(original)await withPdf(item,compose);
  else await compose(null);
  output.setTitle(item.name);
  return new Blob([await output.save()],{type:PDF});
}

export function countMatches(value, words) {
  const lower=value.toLowerCase();
  let count=0;
  for (const word of words) count+=lower.split(word).length-1;
  return count;
}
