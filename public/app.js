import * as db from './store.js';
import {PDF,cancelIndex,compressImage,countMatches,downloadOriginal,indexDocument,pauseIndex,resumeIndex} from './documents.js';
import {itemPages,mountEditor,previewFor,renderExport,saveExport,scene} from './editor.js';
import {actionMenu,button,download,esc,icon,iconButton,input,modal,select,setTheme,shortBytes,shortDate,toast} from './ui.js';

const host=document.querySelector('#app');
const upload=document.querySelector('#upload');
const nav=[['study','Current Study','book'],['library','Library','folder'],['notes','Notes','note'],['settings','Settings','gear']];
const librarySections=['All Files','Folders','Recent','Archived'];
const noteSections=['Pages','From Files','Review Later'];
const filters=['PDF','Images','References','Contains Notes','Pinned','Available Offline'];
const ownerMode=location.pathname==='/owner';
const defaults={theme:'light',textScale:'1',density:'normal',contrast:false,reduce:false,readerMode:'single',paperAppearance:'original',defaultPen:'navigate',penColor:'#1c50a0',highlightColor:'#ffd200',toolbar:'top',hand:'right',penOnly:false,autosave:true,confirmDelete:true,ocr:true,ocrLanguages:'eng+ara'};
const loc={main:'study',library:'All Files',notes:'Pages',filter:'',folder:null,layout:'grid',sort:'recent',selecting:false,selected:new Set(),query:'',answer:false,limit:60};
const positions=new Map();
const shelfSelection=new Map();
const shelfOffsets=new Map();
const offlineIds=new Set();
const indexJobs=new Set();
const allItems=()=>db.byKind('item').map(record=>record.data).filter(item=>!item.purged);
const live=()=>allItems().filter(item=>!item.deleted);
const folders=()=>live().filter(item=>item.type==='folder'&&!item.archived);
const allowedFolder=(item,folder)=>item?.type!=='folder'||(folder!==item.id&&!isInside(folder,item.id));
const pins=()=>db.get('pins',{items:[]}).items;
const visiblePins=()=>pins().map(id=>db.get(id)).filter(item=>item&&!item.deleted&&!item.archived);
const annotations=()=>db.byKind('annotation').map(record=>record.data);
const reviews=()=>db.byKind('review').map(record=>record.data).filter(item=>!item.removed);
const prefs=()=>({...defaults,...db.get('prefs',{})});
const stamp=()=>Date.now();
const folderName=id=>db.get(id)?.name || 'Library';
let role=null;
let editor=null;
let ownerData=null;
let report='';
let activeSearch=0;
let thumbnailObserver;
let syncTimer;
let liveTheme=null;
let storedBytes=null;

function isInside(folder,ancestor){
  const visited=new Set();
  while(folder&&!visited.has(folder)){
    if(folder===ancestor)return true;
    visited.add(folder);
    folder=db.get(folder)?.folder;
  }
  return false;
}
function remember(){
  if(editor) return;
  positions.set(loc.main,{y:window.scrollY,rail:host.querySelector('.pinned-rail')?.scrollLeft||0});
  for(const rail of host.querySelectorAll('.library-spines'))shelfOffsets.set(rail.dataset.shelf,rail.scrollLeft);
}
function restorePosition(){
  const pos=positions.get(loc.main);
  requestAnimationFrame(()=>{
    window.scrollTo(0,pos?.y||0);
    const rail=host.querySelector('.pinned-rail');
    if(rail) rail.scrollLeft=pos?.rail||0;
    for(const shelf of host.querySelectorAll('.library-spines'))shelf.scrollLeft=shelfOffsets.get(shelf.dataset.shelf)||0;
  });
}
function applyAppearance(value=prefs()){
  setTheme(liveTheme||value.theme);
  const root=document.documentElement;
  root.style.setProperty('--scale',value.textScale);
  root.style.setProperty('--space',value.density==='compact'?'.82':value.density==='comfortable'?'1.18':'1');
  root.dataset.reduce=String(value.reduce);
  root.dataset.contrast=String(value.contrast);
  root.dir=value.direction==='rtl'?'rtl':'ltr';
}
async function changePrefs(patch){await db.save('prefs','prefs',{...prefs(),...patch});applyAppearance();redraw();}
function statusHtml(){
  const phase=report||db.status();
  return '<button class="status-chip" data-action="sync" data-phase="'+esc(phase)+'" title="Sync status">'+esc(phase)+'</button>';
}
const dataId=id=>'data-id="'+esc(id)+'"';
const typeIcon=type=>({pdf:'file',image:'image',folder:'folder',note:'note'}[type]||'file');
function thumb(item,hero=false,pageKey=''){
  return '<div class="'+(hero?'paper-face':'thumb')+'" data-thumb="'+esc(item.id)+'" data-page-key="'+esc(pageKey)+'">'+(hero?'':icon(typeIcon(item.type),27))+'</div>';
}
function subLabel(item){
  return (item.type==='pdf'?(item.pages ? item.pages+' page'+(item.pages===1?'':'s') : 'PDF'):item.type==='note'?'Note Page':item.type==='folder'?'Folder':'Image')+' · '+folderName(item.folder);
}
function card(item,selection=false){
  return '<article class="file-card" data-card="'+esc(item.id)+'">'+(selection?'<input type="checkbox" class="file-select" '+dataId(item.id)+' aria-label="Select '+esc(item.name)+'" '+(loc.selected.has(item.id)?'checked':'')+'>':'')+thumb(item)+'<div class="card-info"><h3 dir="auto">'+esc(item.name)+'</h3><small dir="auto">'+esc(subLabel(item))+'</small><div class="row wrap">'+button('Open','open',{variant:'accent',attrs:dataId(item.id)})+iconButton('more','Options for '+item.name,'item-menu',dataId(item.id))+'</div></div></article>';
}
function mainNav(){
  return '<nav class="dock" aria-label="Main sections">'+nav.map(([id,label,symbol])=>'<button type="button" data-action="nav" data-view="'+id+'" '+(id===loc.main?'aria-current="page"':'')+'>'+icon(symbol)+'<span>'+label+'</span></button>').join('')+'</nav>';
}
function header(){
  const withSearch=['study','library','notes'].includes(loc.main);
  const add=loc.main==='library'
    ? iconButton('plus','Add','add')+iconButton('more','Library options','library-options')
    : loc.main==='notes' ? button('New Page','new-note',{symbol:'plus',variant:'add'}) : button('Add','add',{symbol:'plus',variant:'add'});
  return '<header class="top"><div class="wordmark">Wijdan</div><div class="top-actions">'+(withSearch?
    '<form class="search" role="search" data-open="'+Boolean(loc.query)+'"><button type="button" data-action="expand-search" aria-label="Search">'+icon('search',22)+'</button><input name="query" type="search" aria-label="Search library" placeholder="Search" value="'+esc(loc.query)+'" autocomplete="off" dir="auto"></form>'+add:'')+'</div></header>';
}
const title=word=>'<h1 class="section-title">'+word+'</h1>';
const empty=(label,add='')=>'<div class="empty"><h2>'+esc(label)+'</h2>'+add+'</div>';

function study(){
  const last=db.get('resume');
  const item=last&&db.get(last.id);
  const percent=last?Math.min(100,Math.max(0,Math.round(100*last.page/Math.max(last.total,1)))):0;
  const available=item&&!item.deleted&&!item.archived;
  return title('Current Study')+'<section class="hero" aria-label="Resume Study"><div class="hero-paper" aria-hidden="true">'+(available?thumb(item,true,last.pageKey):'<div class="paper-face"></div>')+'<span class="clip"></span></div><div class="hero-text"><h2>Resume Study</h2>'+
    (available?'<h3 dir="auto">'+esc(item.name)+'</h3><span class="meta row">'+icon('folder',17)+' '+esc(folderName(item.folder))+'</span><div class="hero-progress"><div class="row between"><span>Page '+last.page+' of '+last.total+'</span><span>'+percent+'%</span></div><progress max="100" value="'+percent+'" aria-label="Reading progress"></progress></div><span class="meta row">'+icon('clock',17)+' '+esc(shortDate(last.time))+'</span>'+button('Resume','resume',{variant:'accent',attrs:dataId(item.id)}):
      '<span class="meta">No study session yet</span>'+button('Open Library','nav',{variant:'accent',attrs:'data-view="library"'}))+
    '</div></section><section><div class="section-head row between"><h2>Pinned Items</h2>'+ (visiblePins().length?button('Manage','manage-pins',{variant:'subtle'}):'')+'</div>'+
    (visiblePins().length?'<div class="pinned-rail" tabindex="0" aria-label="Pinned items">'+visiblePins().map(item=>card(item)).join('')+'</div>':empty('No pinned items'))+'</section>';
}
function tabs(values,selected,action){
  return '<div class="segmented" role="tablist" aria-label="Views">'+values.map(value=>'<button class="switch-section" role="tab" data-action="'+action+'" data-value="'+esc(value)+'" aria-selected="'+(selected===value)+'" tabindex="'+(selected===value?'0':'-1')+'" type="button">'+esc(value)+'</button>').join('')+'</div>';
}
function matchesFilter(item){
  if(loc.filter==='PDF')return item.type==='pdf';
  if(loc.filter==='Images')return item.type==='image';
  if(loc.filter==='References')return item.reference;
  if(loc.filter==='Pinned')return pins().includes(item.id);
  if(loc.filter==='Available Offline')return offlineIds.has(item.blob);
  if(loc.filter==='Contains Notes')return annotations().some(note=>note.item===item.id&&note.objects.some(object=>object.type!=='bookmark'));
  return true;
}
function ordered(items){
  const result=[...items];
  if(loc.sort==='name')return result.sort((a,b)=>a.name.localeCompare(b.name));
  if(loc.sort==='oldest')return result.sort((a,b)=>a.created-b.created);
  return result.sort((a,b)=>(b.lastOpened||b.edited||b.created)-(a.lastOpened||a.edited||a.created));
}
function row(item,selection=true){
  const note=annotations().some(anno=>anno.item===item.id&&anno.objects.some(object=>object.type!=='bookmark'));
  const state=item.indexState;
  return '<article class="file-row">'+thumb(item)+'<div><button type="button" class="item-name" data-action="open" '+dataId(item.id)+' dir="auto">'+esc(item.name)+'</button><div class="file-meta meta" dir="auto">'+
    '<span>'+esc(subLabel(item))+'</span>'+(item.lastOpened?'<span>Opened '+esc(shortDate(item.lastOpened))+'</span>':'')+
    (item.type==='note'?'<span>Edited '+esc(shortDate(item.edited))+'</span>':'')+
    (note?'<span>Contains Notes</span>':'')+'<span>'+esc(db.isPending(item.id)?(navigator.onLine?'Saving':'Offline'):'Saved')+'</span>'+(pins().includes(item.id)?'<span>Pinned</span>':'')+
    (offlineIds.has(item.blob)?'<span>Available Offline</span>':'')+(state?'<span>'+esc(state)+(item.indexProgress!==undefined&&state==='Processing'?' '+item.indexProgress+'%':'')+'</span>':'')+'</div></div><div class="row">'+
    (['Processing','OCR Processing','Paused'].includes(state)?'<div class="row index-controls">'+(state==='Paused'?iconButton('next','Resume processing','index-resume',dataId(item.id)):iconButton('pause','Pause processing','index-pause',dataId(item.id)))+iconButton('close','Cancel processing','index-cancel',dataId(item.id))+'</div>':'')+
    (selection?'<input type="checkbox" class="file-select" '+dataId(item.id)+' aria-label="Select '+esc(item.name)+'" '+(loc.selected.has(item.id)?'checked':'')+'>':'')+
    iconButton('more','Options for '+item.name,'item-menu',dataId(item.id))+'</div></article>';
}
function displayFileName(item) {
  const stem=item.name.replace(/\.(?:pdf|png|jpe?g|webp|gif|avif)$/i,'');
  return stem.replace(/_/g,' ').replace(/(?:\s+\p{N}{5,})+$/u,'').trim()||stem;
}

function libraryShelf(key,label,items,folder=null) {
  const preferred=shelfSelection.get(key);
  const selected=items.find(item=>item.id===preferred)||items[0];
  const heading=folder
    ? '<div class="row between shelf-heading"><h2 dir="auto">'+esc(label)+'</h2>'+iconButton('next','Open folder '+label,'open',dataId(folder.id))+'</div>'
    : '<h2 class="shelf-heading" dir="auto">'+esc(label)+'</h2>';
  if(!selected) return '<section class="library-shelf">'+heading+'<div class="empty-shelf"><span>No files</span></div></section>';
  const short=esc(displayFileName(selected));
  const selectedId=dataId(selected.id);
  const spineButtons=items.map(item=>{
    const name=esc(displayFileName(item));
    return '<button type="button" class="shelf-book" data-action="shelf-select" data-shelf="'+esc(key)+'" '+dataId(item.id)+' aria-label="'+esc(item.name)+'" title="'+esc(item.name)+'" aria-pressed="'+(item.id===selected.id)+'">'+
      '<span class="shelf-spine" aria-hidden="true"><span dir="auto">'+name+'</span></span><span class="shelf-name"><span dir="auto">'+name+'</span></span></button>';
  }).join('');
  const cover='<div class="shelf-preview"><button type="button" class="shelf-open" data-action="open" '+selectedId+' aria-label="Open '+esc(selected.name)+'" title="'+esc(selected.name)+'">'+
    '<span class="shelf-cover"><span class="shelf-paper" data-thumb="'+esc(selected.id)+'" aria-hidden="true"><span dir="auto">'+short+'</span></span></span><span class="shelf-open-label">Open</span></button>'+
    iconButton('more','Options for '+selected.name,'item-menu',selectedId)+'</div>';
  return '<section class="library-shelf">'+heading+'<div class="shelf-body"><div class="library-spines" data-shelf="'+esc(key)+'" aria-label="'+esc(label)+' files">'+spineButtons+'</div>'+cover+'<span class="shelf-plank" aria-hidden="true"></span></div></section>';
}

function libraryShelves(items,activeFolders) {
  const scope=loc.folder||null;
  const validFolders=new Set(activeFolders.map(folder=>folder.id));
  const direct=ordered(items.filter(item=>scope?item.folder===scope:!validFolders.has(item.folder)));
  const groups=new Map();
  for(const item of ordered(items)) {
    if(!groups.has(item.folder))groups.set(item.folder,[]);
    groups.get(item.folder).push(item);
  }
  const childFolders=ordered(activeFolders.filter(folder=>(folder.folder||null)===scope));
  const shelves=childFolders.slice(0,loc.limit).map(folder=>libraryShelf(folder.id,folder.name,(groups.get(folder.id)||[]).slice(0,12),folder));
  if(direct.length)shelves.unshift(libraryShelf(scope||'files',scope?'Files in '+folderName(scope):'Files',direct.slice(0,loc.limit)));
  if(!shelves.length)return empty('No files here',button('Add File','upload',{variant:'accent',symbol:'plus'}));
  return '<div class="library-shelves">'+shelves.join('')+'</div>'+
    (direct.length>loc.limit||childFolders.length>loc.limit?button('Show more','show-more',{variant:'subtle'}):'');
}

function libraryControls(){
  const activeFilters=(loc.filter?1:0)+(loc.sort!=='recent'?1:0);
  const views=[['grid','grid','Grid'],['list','list','List'],['shelves','shelves','Shelves']];
  return '<div class="library-controls"><div class="library-browse" role="tablist" aria-label="Browse library">'+librarySections.map(value=>
    '<button type="button" role="tab" data-action="library-tab" data-value="'+esc(value)+'" aria-selected="'+(loc.library===value)+'">'+esc(value)+'</button>').join('')+'</div><div class="library-tools">'+
    '<div class="view-switch" role="group" aria-label="Library view">'+views.map(([value,symbol,label])=>iconButton(symbol,label,'library-view','data-value="'+value+'" aria-pressed="'+(loc.layout===value)+'"')).join('')+'</div>'+
    button('Filter & Sort'+(activeFilters?' ('+activeFilters+')':''),'library-filters',{symbol:'more',variant:activeFilters?'accent':'subtle'})+'</div></div>';
}

function library(){
  const archived=loc.library==='Archived';
  const active=live().filter(item=>item.type!=='note'&&Boolean(item.archived)===archived);
  const activeFolders=active.filter(item=>item.type==='folder');
  const breadcrumb=loc.folder?'<div class="row library-path">'+iconButton('back','Back to parent folder','folder-up')+'<h2 dir="auto">'+esc(folderName(loc.folder))+'</h2></div>':'';
  const activeView=loc.filter||loc.library!=='All Files';
  const selection=loc.selecting?'<div class="row between wrap library-selection">'+button('Done','select-mode',{variant:'subtle'})+
    '<div class="row" id="bulk" '+(loc.selected.size?'':'hidden')+'>'+button('Manage selected','bulk',{variant:'accent'})+'</div></div>':'';
  const scope=activeView?'<div class="row library-path"><span class="meta">'+esc(loc.filter||loc.library)+'</span>'+button('Clear','library-reset',{variant:'quiet'})+'</div>':'';
  const head=title('Library')+libraryControls()+breadcrumb+scope+selection;
  if(!activeView&&!loc.selecting&&loc.layout==='shelves')return head+libraryShelves(active.filter(item=>item.type!=='folder'),activeFolders);
  let items=active;
  if(loc.folder) items=items.filter(item=>item.folder===loc.folder);
  else if(loc.library==='Recent')items=items.filter(item=>item.lastOpened);
  else if(loc.library==='Folders')items=items.filter(item=>item.type==='folder'&&!item.folder);
  else if(!loc.filter&&!archived)items=items.filter(item=>item.type!=='folder'||!item.folder);
  items=ordered(items.filter(matchesFilter));
  const isGrid=loc.layout==='grid'&&!loc.selecting;
  return head+(items.length?'<div class="tile-list '+(isGrid?'grid':'list')+'">'+items.slice(0,loc.limit).map(item=>isGrid?card(item):row(item,loc.selecting)).join('')+'</div>':
    empty(archived?'No archived files':'No files here',archived?'':button('Add File','upload',{variant:'accent',symbol:'plus'})))+
    (items.length>loc.limit?button('Show more','show-more',{variant:'subtle'}):'');
}

async function libraryOptions(){
  const items=[[loc.selecting?'exit-select':'select',loc.selecting?'Exit Selection':'Select','check'],['find-sources','Find in Sources','search'],['new-folder','New Folder','folder']];
  if(loc.folder)items.push(['folder-actions','Folder Options','more']);
  const result=await actionMenu('Library Options',[{items}]);
  if(result==='select'||result==='exit-select')return runAction('select-mode',document.createElement('button'));
  if(result==='find-sources')return runAction('ask',document.createElement('button'));
  if(result==='new-folder')return createFolder();
  if(result==='folder-actions')return fileMenu(db.get(loc.folder));
}

async function libraryFilters(){
  const result=await modal('Filter & Sort',select('File type','filter',[['','All types'],...filters.map(value=>[value,value])],loc.filter)+
    select('Sort','sort',[['recent','Recent'],['name','Name'],['oldest','Oldest']],loc.sort),{confirm:'Apply'});
  if(!result)return;
  loc.filter=result.filter;loc.sort=result.sort;loc.limit=60;redraw();
}

const annoTypes={pen:'Handwritten Note',highlighter:'Highlight',text:'Typed Note',image:'Inserted Image',bookmark:'Bookmark',shape:'Shape'};
function fromFiles(){
  const result=[];
  for(const anno of annotations()){
    const source=db.get(anno.item);
    if(!source||source.deleted||source.type==='note')continue;
    for(const object of anno.objects) result.push({id:source.id,page:anno.page,type:annoTypes[object.type]||'Annotation',name:source.name,preview:object.text||object.caption||'',object:object.id,blob:object.blob});
  }
  for(const source of live().filter(item=>item.type==='pdf')) for(const added of source.pagesAdded||[]) result.push({id:source.id,page:added.key,type:'Added Page',name:source.name,preview:'',blob:added.blob});
  return result;
}
function pageNumber(hint) {
  const item=db.get(hint.id);
  if(item?.order){
    const at=item.order.indexOf(hint.page);
    if(at!==-1)return at+1;
  }
  return hint.page?.startsWith('p') && /^p\d+$/.test(hint.page)?Number(hint.page.slice(1)):null;
}
function noteRow(item){
  return '<article class="results-hit"><strong dir="auto">'+esc(item.type)+'</strong><div class="meta" dir="auto">'+esc(item.name)+(pageNumber(item)?' · Page '+pageNumber(item):'')+'</div>'+
    (item.preview?'<p dir="auto">'+esc(item.preview.slice(0,170))+'</p>':'')+
    (item.blob?'<div class="thumb" data-direct-blob="'+esc(item.blob)+'"></div>':'')+
    '<div class="row wrap">'+button('Open Source','source',{variant:'accent',attrs:dataId(item.id)+' data-page="'+esc(item.page||'')+'" data-object="'+esc(item.object||'')+'"'})+
    (item.reviewId ? button(item.reviewed?'Mark unreviewed':'Mark as Reviewed','reviewed',{variant:'subtle',attrs:'data-review="'+item.reviewId+'"'})+
      button('Remove from Review','remove-review',{variant:'subtle',attrs:'data-review="'+item.reviewId+'"'}) : '')+'</div>'+
    (item.reviewed?'<small>Reviewed '+esc(shortDate(item.reviewed))+'</small>':'')+'</article>';
}
function notePageRow(item){
  const exceptional=(pins().includes(item.id)?'<span>Pinned</span>':'')+(db.isPending(item.id)?'<span>Not synced</span>':'');
  return '<article class="file-row note-page-row">'+thumb(item)+'<div><button type="button" class="item-name" data-action="open" '+dataId(item.id)+' dir="auto">'+esc(item.name)+'</button><div class="file-meta meta" dir="auto"><span>Edited '+esc(shortDate(item.edited||item.created))+'</span><span>'+esc(folderName(item.folder))+'</span>'+exceptional+'</div></div>'+iconButton('more','Options for '+item.name,'item-menu',dataId(item.id))+'</article>';
}
function notes(){
  let contents;
  if(loc.notes==='Pages'){
    const items=ordered(live().filter(item=>!item.archived && (item.type==='note'||item.type==='folder'&&item.area==='notes') && (!loc.folder||item.folder===loc.folder)));
    contents=(loc.folder?'<div class="row">'+iconButton('back','Parent folder','folder-up')+'<h2 dir="auto">'+esc(folderName(loc.folder))+'</h2></div>':'')+'<div class="row wrap">'+button('New Folder','new-folder',{variant:'subtle',symbol:'folder'})+button('Archive','notes-archive',{variant:'subtle'})+
      '<label class="row">Sort <select class="library-sort book-input" aria-label="Sort notes"><option value="recent" '+(loc.sort==='recent'?'selected':'')+'>Recent</option><option value="name" '+(loc.sort==='name'?'selected':'')+'>Name</option><option value="oldest" '+(loc.sort==='oldest'?'selected':'')+'>Oldest</option></select></label></div>'+
      (items.length?items.slice(0,loc.limit).map(notePageRow).join(''):empty('No notebook pages',button('New Page','new-note',{symbol:'plus',variant:'accent'})))+
      (items.length>loc.limit?button('Show more','show-more',{variant:'subtle'}):'');
  } else if(loc.notes==='From Files'){
    const items=fromFiles();
    contents=items.length?'<div class="surface">'+items.slice(0,loc.limit).map(noteRow).join('')+'</div>':empty('No notes from files');
  } else if(loc.notes==='Review Later'){
    const items=reviews().map(review=>({...review,name:db.get(review.id)?.name||'Missing File'}));
    contents=items.length?'<div class="surface">'+items.slice(0,loc.limit).map(noteRow).join('')+'</div>':empty('Nothing to review yet');
  } else {
    const items=live().filter(item=>item.type==='note'&&item.archived);
      contents=items.length?items.map(notePageRow).join(''):empty('No archived notes');
  }
  return title('My Notebook')+tabs(noteSections,loc.notes,'notes-tab')+'<div class="stack">'+contents+'</div>';
}

const option=(label,key,options,value)=>'<div class="setting-row">'+select(label,key,options,value)+'</div>';
const toggle=(label,key,value)=>'<label class="setting-row"><strong>'+esc(label)+'</strong><input class="preference" type="checkbox" name="'+key+'" '+(value?'checked':'')+'></label>';
const group=(label,markup)=>'<section class="setting-group"><h2>'+label+'</h2>'+markup+'</section>';
function settings(){
  const value=prefs();
  const files=live();
  const indexed=files.filter(item=>item.indexState==='Ready to Search').length;
  const failed=files.filter(item=>item.indexState==='Failed');
  return title('Settings')+'<div class="stack">'+
    group('Appearance','<div class="theme-choice">'+[['light','Light','sun'],['dark','Dark','moon'],['system','System','monitor']].map(([id,label,symbol])=>button(label,'theme',{symbol,variant:'subtle',attrs:'data-value="'+id+'" aria-pressed="'+((liveTheme||value.theme)===id)+'"'})).join('')+'</div>'+
      '<div class="row wrap">'+button('Apply','theme-apply',{variant:'accent'})+button('Reset','theme-reset',{variant:'subtle'})+'</div>'+
      option('Text Size','textScale',[['.9','Small'],['1','Default'],['1.15','Large'],['1.3','Extra large']],value.textScale)+
      option('Display Density','density',[['compact','Compact'],['normal','Default'],['comfortable','Comfortable']],value.density)+
      toggle('High Contrast','contrast',value.contrast)+toggle('Reduce Motion','reduce',value.reduce))+
    group('Reader',option('Reading view','readerMode',[['continuous','Continuous Scroll'],['single','Single Page'],['two','Two Page']],value.readerMode)+
      option('Page appearance','paperAppearance',[['original','Original'],['warm','Warm'],['dim','Dim']],value.paperAppearance)+
      option('Page Direction','direction',[['ltr','Left to right'],['rtl','Right to left']],value.direction||'ltr'))+
    group('Writing',option('Preferred Annotation Tool','defaultPen',[['navigate','Read'],['pen','Pen'],['highlighter','Highlighter']],value.defaultPen)+
      '<label class="setting-row">Default Pen <input class="preference" type="color" name="penColor" value="'+esc(value.penColor)+'"></label><label class="setting-row">Default Highlighter <input class="preference" type="color" name="highlightColor" value="'+esc(value.highlightColor)+'"></label>'+
      option('Toolbar Position','toolbar',[['top','Top'],['bottom','Bottom']],value.toolbar)+
      option('Handedness','hand',[['right','Right-handed'],['left','Left-handed']],value.hand)+
      toggle('Stylus-only writing','penOnly',value.penOnly)+toggle('Autosave to cloud','autosave',value.autosave)+toggle('Delete Confirmation','confirmDelete',value.confirmDelete))+
    '<details class="advanced-settings"><summary>Advanced</summary><div class="stack">'+group('Search and Indexing','<div class="row between"><span>Ready to Search</span><strong>'+indexed+'</strong></div><div class="row between"><span>Failed</span><strong>'+failed.length+'</strong></div>'+
      option('OCR Languages','ocrLanguages',[['eng+ara','English + Arabic'],['ara','Arabic'],['eng','English']],value.ocrLanguages)+toggle('OCR','ocr',value.ocr)+
      '<div class="row wrap">'+(failed.length?button('Retry Processing','retry-index',{variant:'accent'}):'')+button('Rebuild Index','reindex',{variant:'subtle'})+'</div>')+
    group('Storage and Sync','<div class="row between"><span>Sync Status</span>'+statusHtml()+'</div>'+
      '<div class="row between"><span>Storage Used</span><strong id="storage-used">'+(storedBytes===null?'—':shortBytes(storedBytes))+'</strong></div>'+
      '<div class="row between"><span>Offline Files</span><strong>'+offlineIds.size+'</strong></div><div class="row wrap">'+button('Export Data','export-data',{variant:'subtle'})+
      button('Backups','backup-info',{variant:'subtle'})+button('Recently Deleted','trash',{variant:'subtle'})+button('Clear Local Cache','clear-cache',{variant:'subtle'})+'</div>')+
    group('Account and Privacy','<div class="row between"><span>Profile</span><strong>Wijdan</strong></div><div class="row wrap">'+button('Access Credentials','credentials',{variant:'subtle'})+
      button('Connected Devices','devices',{variant:'subtle'})+button('Download Data','export-data',{variant:'subtle'})+button('Lock','lock',{variant:'subtle'})+
      button('Sign Out','logout',{variant:'danger'})+'</div>')+'</div></details></div>';
}

function installThumbnails(){
  thumbnailObserver?.disconnect();
  thumbnailObserver=new IntersectionObserver(entries=>{
    for(const entry of entries) if(entry.isIntersecting){
      thumbnailObserver.unobserve(entry.target);
      renderThumb(entry.target).catch(()=>{});
    }
  },{rootMargin:'240px'});
  host.querySelectorAll('[data-thumb],[data-direct-blob]').forEach(element=>thumbnailObserver.observe(element));
}
const previews=new Map();
async function renderThumb(element){
  const item=db.get(element.dataset.thumb);
  if(!element.dataset.directBlob&&(!item||item.type==='folder'))return;
  const name=element.dataset.pageKey||'';
  const key=item?.id+':'+name+':'+(item?.edited||0);
  let id=element.dataset.directBlob;
  if(!id){
    if(!previews.has(key)){
      previews.set(key,previewFor(item,name).catch(error=>{previews.delete(key);throw error;}));
      if(previews.size>100)previews.delete(previews.keys().next().value);
    }
    id=await previews.get(key);
  }
  if(!id||!element.isConnected)return;
  const url=URL.createObjectURL(id instanceof Blob?id:await db.fetchBlob(id));
  const image=new Image();
  image.alt='';
  image.decoding='async';
  image.onload=image.onerror=()=>URL.revokeObjectURL(url);
  image.src=url;
  element.replaceChildren(image);
}

function activateRail(){
  const rail=host.querySelector('.pinned-rail');
  if(!rail)return;
  let drag=null;
  let stopClick=false;
  rail.addEventListener('pointerdown',event=>{
    if(event.pointerType==='touch'||event.button!==0)return;
    drag={id:event.pointerId,x:event.clientX,left:rail.scrollLeft};
  });
  rail.addEventListener('pointermove',event=>{
    if(drag?.id!==event.pointerId)return;
    const dx=event.clientX-drag.x;
    if(Math.abs(dx)>8||stopClick){
      stopClick=true;
      rail.classList.add('dragging');
      if(!rail.hasPointerCapture(drag.id))rail.setPointerCapture(drag.id);
      rail.scrollLeft=drag.left-dx;
    }
  });
  for(const name of ['pointerup','pointercancel','lostpointercapture'])rail.addEventListener(name,()=>{
    drag=null;
    rail.classList.remove('dragging');
    setTimeout(()=>{stopClick=false;},0);
  });
  rail.addEventListener('click',event=>{if(stopClick){event.preventDefault();event.stopImmediatePropagation();}},{capture:true});
  rail.addEventListener('scroll',()=>{
    const pos=positions.get('study')||{};
    positions.set('study',{...pos,rail:rail.scrollLeft});
  },{passive:true});
}

function renderContent(){
  if(loc.query)return title(loc.answer?'Find in Sources':'Search')+
    (loc.answer?'<form class="row" id="ask-form">'+input('Question','question',loc.query)+button('Find sources','ask-submit',{variant:'accent'})+'</form>':'')+
    '<div id="search-results" class="stack" aria-live="polite"><p>Searching…</p></div>';
  return ({study,library,notes,settings}[loc.main])();
}
function redraw(preserve=true){
  if(role!=='student'||editor)return;
  if(preserve)remember();
  host.innerHTML='<main class="frame" id="main">'+header()+'<div id="view">'+renderContent()+'</div></main>'+mainNav();
  restorePosition();
  installThumbnails();
  activateRail();
  if(loc.query)performSearch();
  else if(loc.main==='settings'&&navigator.onLine){
    db.api('storage').then(({size})=>{
      storedBytes=size;
      const target=host.querySelector('#storage-used');
      if(target)target.textContent=shortBytes(size);
    }).catch(()=>{});
  }
}

function evidenceMarkup(hit,answer){
  const item=db.get(hit.id);
  const page=pageNumber(hit);
  return '<article class="results-hit"><div class="row"><div class="thumb" data-thumb="'+esc(hit.id)+'" data-page-key="'+esc(hit.page||'')+'">'+icon(typeIcon(item?.type),25)+'</div><div><strong dir="auto">'+esc(hit.name)+'</strong><p class="meta" dir="auto">'+esc(folderName(item?.folder))+(page?' · Page '+page:'')+' · '+esc(hit.type)+(hit.count?' · '+hit.count+' match'+(hit.count===1?'':'es'):'')+'</p></div></div>'+
    (hit.preview ? '<p dir="auto">'+highlighted(hit.preview,db.terms(loc.query))+'</p>':'')+
    button('Open Source','source',{variant:'accent',attrs:dataId(hit.id)+' data-page="'+esc(hit.page||'')+'" '+(!answer?'data-query="'+esc(loc.query)+'"':'')})+'</article>';
}
function highlighted(text,words){
  if(!words.length)return esc(text);
  const reg=new RegExp('('+words.join('|')+')','giu');
  return text.split(reg).map((part,index)=>index%2?'<mark>'+esc(part)+'</mark>':esc(part)).join('');
}
function parseSearch(q){
  remember();
  loc.query=q.trim();
  loc.answer=false;
  redraw(false);
  if(loc.query){
    const field=host.querySelector('input[name=query]');
    field?.focus();
    const len=field?.value.length;
    if(len && field.setSelectionRange && field.type!=='search')field.setSelectionRange(len,len);
  }
}
function hitsForLocal(q,deep=true){
  const words=db.terms(q);
  if(!words.length)return [];
  const match=value=>words.every(word=>db.normalize(value).includes(word));
  const result=[];
  for(const item of live()){
    const str=item.name+' '+folderName(item.folder);
    if(match(str))result.push({id:item.id,name:item.name,type:item.type==='folder'?'Folder':'File',preview:'',count:countMatches(db.normalize(str),words)});
  }
  if(!deep)return result;
  for(const item of fromFiles()){
    if(match(item.type+' '+item.name+' '+item.preview))result.push({...item,count:countMatches(db.normalize(item.preview),words)});
  }
  for(const anno of annotations()){
    const item=db.get(anno.item);
    if(item?.type!=='note'||item.deleted)continue;
    for(const object of anno.objects)if(object.text&&match(object.text))result.push({id:item.id,name:item.name,page:anno.page,preview:object.text,type:'Note Page',count:countMatches(db.normalize(object.text),words)});
  }
  for(const review of reviews()){
    const item=db.get(review.id);
    if(item&&!item.deleted&&match(item.name+' '+review.type+' '+review.preview))result.push({...review,name:item.name,type:'Review Later'});
  }
  return result;
}
const stopWords = new Set(['what','is','are','the','of','for','how','do','does','about','and','a','an','in','when','can','في','هو','هي','عن','من','ما','ماذا','كيف','هل','على','اذكر','فوائد']);
async function performSearch(){
  const output=host.querySelector('#search-results');
  const run=++activeSearch;
  const requested=loc.query;
  const answers=loc.answer;
  const tokens=db.terms(requested);
  const relevant=answers?tokens.filter(word=>!stopWords.has(word)):tokens;
  if(!relevant.length){output.innerHTML=empty(answers?'Not found in your library':'No search results');return;}
  const query=relevant.join(' ');
  const match=value=>relevant.every(word=>db.normalize(value).includes(word));
  const result=answers?[]:hitsForLocal(query);
  const add=(hit,text)=>{
    const item=db.get(hit.id);
    if(!item||item.deleted||result.some(entry=>entry.id===hit.id&&entry.page==='p'+hit.page&&['PDF Text','OCR Text'].includes(entry.type)))return;
    if(answers&&(!text||!match(text)))return;
    result.push({id:hit.id,name:item.name,page:'p'+hit.page,preview:text.trim(),type:hit.source==='pdf'?'PDF Text':'OCR Text',count:countMatches(db.normalize(text),relevant)});
  };
  if(navigator.onLine) {
    try{
      const response=await db.api('search?'+new URLSearchParams({q:query}));
      for(const hit of response.results)add(hit,hit.snippet);
    }catch {}
  }
  for(const hit of await db.localIndex()){
    if(!match(hit.text))continue;
    const value=db.normalize(hit.text);
    const i=value.indexOf(relevant[0]);
    const snippet=hit.text.slice(Math.max(0,i-70),i+(answers?430:210));
    add(hit,snippet);
  }
  if(run!==activeSearch||!output.isConnected)return;
  if(!result.length)output.innerHTML=empty(answers?'Not found in your library':'No search results');
  else output.innerHTML='<div class="surface">'+result.slice(0,answers?3:70).map(hit=>evidenceMarkup(hit,answers)).join('')+'</div>';
  installThumbnails();
}

async function fileMenu(item){
  if(!item)return toast('Missing File');
  if(item.deleted){
    const choice=await actionMenu(item.name,[{items:[['restore','Restore','undo']]}]);
    if(choice){const target=document.createElement('button');target.dataset.id=item.id;return runAction(choice,target);}
    return;
  }
  const study=[['open','Open','next'],['pin',pins().includes(item.id)?'Unpin':'Pin','pin']];
  if(item.type!=='folder')study.push(['review','Review Later','bookmark']);
  const view=[];
  if(item.type==='pdf'||item.type==='image')view.push(['reference',item.reference?'Remove Reference':'Mark as Reference','book'],['offline-file',offlineIds.has(item.blob)?'Remove Offline Copy':'Make Available Offline','download']);
  const file=[['rename','Rename','pen'],['move','Move','folder']];
  if(item.type==='pdf'||item.type==='image')file.push(['download','Download Original','download']);
  if(item.type!=='folder')file.push(['export','Export','download']);
  if(item.type==='note')file.push(['duplicate','Duplicate','plus']);
  const safety=[['archive',item.archived?'Unarchive':'Archive','archive'],['history','Version History','clock'],['delete','Delete','trash']];
  const choice=await actionMenu(item.name,[{label:'Study',items:study},...(view.length?[{label:'View',items:view}]:[]),{label:'File',items:file},{label:'Safety',items:safety}]);
  if(choice){const target=document.createElement('button');target.dataset.id=item.id;return runAction(choice,target);}
}
function closeDialog(){const dialog=document.querySelector('#dialog');if(dialog.open)dialog.close();}
async function patchItem(item,patch){await db.save(item.id,'item',{...db.get(item.id),...patch});}
async function setPins(ids){await db.save('pins','pins',{items:ids});redraw();}
async function togglePin(id){const saved=pins();await setPins(saved.includes(id)?saved.filter(key=>key!==id):[...saved,id]);}
function visualMove(ids,from,to){
  const next=[...ids];
  next.splice(to,0,next.splice(from,1)[0]);
  return next;
}
async function managePins(){
  let order=visiblePins().map(item=>item.id);
  const result=modal('Manage Pinned Items','<div class="pin-editor"></div>',{confirm:'Save order'});
  const panel=document.querySelector('.pin-editor');
  function renderOrder(){
    panel.innerHTML=order.map((id,index)=>'<div class="file-row" data-pin="'+id+'"><button type="button" class="icon-button drag-pin" aria-label="Drag to reorder" data-drag="'+id+'">'+icon('drag')+'</button><strong dir="auto">'+esc(db.get(id)?.name)+'</strong><div class="row wrap">'+
      '<button type="button" class="icon-button" aria-label="Move up" data-offset="-1" data-index="'+index+'" '+(index===0?'disabled':'')+'>↑</button><button type="button" class="icon-button" aria-label="Move down" data-offset="1" data-index="'+index+'" '+(index===order.length-1?'disabled':'')+'>↓</button>'+
      '<button type="button" class="icon-button" aria-label="Unpin" data-unpin="'+id+'">'+icon('close')+'</button></div></div>').join('');
  }
  panel.onclick=event=>{
    const offset=event.target.closest('[data-offset]');
    const unpin=event.target.closest('[data-unpin]');
    if(offset)order=visualMove(order,Number(offset.dataset.index),Number(offset.dataset.index)+Number(offset.dataset.offset));
    else if(unpin)order=order.filter(id=>id!==unpin.dataset.unpin);
    else return;
    renderOrder();
  };
  panel.onpointerdown=event=>{
    const grip=event.target.closest('[data-drag]');
    if(!grip||event.button>0)return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    grip.onpointerup=up=>{
      const row=document.elementFromPoint(up.clientX,up.clientY)?.closest('[data-pin]');
      const from=order.indexOf(grip.dataset.drag),to=order.indexOf(row?.dataset.pin);
      if(from!==-1&&to!==-1){order=visualMove(order,from,to);renderOrder();}
    };
  };
  renderOrder();
  if(await result)await setPins(order);
}
async function createFolder(){
  const form=await modal('New Folder',input('Name','name')+folderPicker(loc.folder),{confirm:'Create'});
  if(!form)return;
  const id=crypto.randomUUID();
  await db.save(id,'item',{id,type:'folder',area:loc.main==='notes'?'notes':'library',name:form.name.trim(),folder:form.folder||null,created:stamp()});
  loc.query='';
  if(loc.main!=='notes'){
    remember();loc.main='library';loc.library='Folders';loc.folder=form.folder||null;
  }
  redraw(false);
}
function folderPicker(value,forItem){
  const options=[['','Library root'],...ordered(folders()).filter(folder=>allowedFolder(forItem,folder.id)).map(folder=>[folder.id,folder.name])];
  return select('Folder','folder',options,value||'');
}
async function createNote(copy=null){
  const form=await modal('New Page',input('Name','name',copy?.name?copy.name+' copy':'')+folderPicker(loc.folder)+
    (!copy?select('Paper','paper',[['blank','Blank'],['lined','Lined'],['grid','Grid'],['dotted','Dotted']],'blank'):''),{confirm:'Create'});
  if(!form)return;
  const id=crypto.randomUUID();
  const pagesAdded=copy?(await itemPages(copy)).map(spec=>({...spec,key:crypto.randomUUID()})):[{key:crypto.randomUUID(),paper:form.paper,ratio:.7273}];
  const item={id,type:'note',name:form.name.trim(),folder:form.folder||null,created:stamp(),edited:stamp(),pagesAdded};
  await db.save(id,'item',item);
  if(copy){
    const sources=await itemPages(copy);
    for(const [i,spec] of pagesAdded.entries()){
      const objects=scene(copy.id,sources[i].key);
      if(objects.length)await db.save('annotation:'+id+':'+spec.key,'annotation',{item:id,page:spec.key,objects,edited:stamp()});
    }
  }
  openItem(item);
}
async function addReview(item,page='',object){
  const type=object?annoTypes[object.type]||'Annotation':page?'Page':item.type==='note'?'Note Page':'File';
  const existing=reviews().find(itemReview=>itemReview.id===item.id&&itemReview.page===page&&itemReview.object===(object?.id||''));
  if(existing)return toast('Already in Review Later');
  const reviewId=crypto.randomUUID();
  await db.save(reviewId,'review',{reviewId,id:item.id,page,object:object?.id||'',type,preview:object?.text||object?.caption||'',blob:object?.blob,created:stamp()});
  toast('Added to Review Later');
}
async function versionHistory(id,annotation){
  if(!navigator.onLine)return toast('Version History requires a connection.');
  const selection=await db.api('history/'+(annotation||id));
  if(!selection.versions.length)return toast('No earlier versions yet.');
  const form=await modal('Version History',select('Version','revision',selection.versions.map(version=>[String(version.rev),shortDate(version.changed)]),String(selection.versions[0].rev)),{confirm:'Restore'});
  if(!form)return;
  const restored=selection.versions.find(version=>version.rev===Number(form.revision));
  await db.save(annotation||id,annotation?'annotation':'item',restored.data);
  if(editor){const item=db.get(id);await leaveEditor();if(item)await openItem(item);}
  else redraw();
  toast('Version restored');
}
async function copyPage(item,spec,objects){
  const form=await modal('Save copy in Notes',input('Name','name',item.name.replace(/\.pdf$/i,'')+' page'),{confirm:'Save copy'});
  if(!form)return;
  const id=crypto.randomUUID(),key=crypto.randomUUID();
  await db.save(id,'item',{id,type:'note',name:form.name,folder:null,created:stamp(),edited:stamp(),pagesAdded:[{...spec,key,number:undefined}]});
  if(objects.length)await db.save('annotation:'+id+':'+key,'annotation',{item:id,page:key,objects,edited:stamp()});
  toast('Copied to My Notebook');
}

async function openItem(item,args={}){
  if(!item||item.deleted){toast(item?.deleted?'Deleted File':'Missing File');return;}
  if(item.type==='folder'){
    remember();
    loc.main=item.area==='notes'?'notes':'library';
    loc.folder=item.id;loc.query='';loc.filter='';loc.library='All Files';loc.notes='Pages';redraw(false);
    return;
  }
  if(!editor)remember();
  if(editor)await editor.close();
  thumbnailObserver?.disconnect();
  window.scrollTo(0,0);
  editor=await mountEditor(host,item,{
    prefs:prefs(),...args,back:leaveEditor,
    retry:async patch=>{await leaveEditor();await openItem(db.get(item.id),{...args,...patch});},
    opened:openedItem=>patchItem(openedItem,{lastOpened:stamp()}).catch(()=>{}),
    review:addReview,noteOptions:()=>ordered(live().filter(item=>item.type==='note')).map(item=>[item.id,item.name]),
    history:versionHistory,copyPage,
  });
}
async function leaveEditor(){
  if(!editor)return;
  await editor.close();
  editor=null;
  redraw(false);
}

function refreshState(phase,repaint=false){
  if(editor){editor.phase(phase);return;}
  for(const node of host.querySelectorAll('.status-chip')){
    node.dataset.phase=phase;node.textContent=report||phase;
  }
  if(repaint&&role==='student'&&!document.querySelector('dialog').open&&document.activeElement!==host.querySelector('input[name=query]'))redraw();
}
db.watch(refreshState);
function refreshItems(override){
  if(override)report=override;
  else report='';
  if(loc.main==='library'&&!editor&&!loc.query&&!document.querySelector('dialog').open)redraw();
  else refreshState(db.status());
}
function scheduleIndex(id,allowOcr=false){
  if(indexJobs.has(id))return;
  indexJobs.add(id);
  indexDocument(id,prefs(),refreshItems,{allowOcr}).catch(error=>toast(error.message)).finally(()=>{indexJobs.delete(id);refreshItems();});
}
async function uploadFiles(files){
  const packet=[...files];
  if(!packet.length)return;
  const fileCap=96*1024*1024,totalCap=350*1024*1024;
  let projected=live().reduce((sum,item)=>sum+(item.size||0),0);
  remember();
  loc.main='library';loc.library='All Files';loc.filter='';loc.query='';loc.selecting=false;loc.selected.clear();loc.limit=60;redraw(false);
  for(const file of packet){
    if(!file.size){toast(file.name+' is empty.');continue;}
    if(file.size>fileCap){toast(file.name+' exceeds the 96 MiB file limit.');continue;}
    if(projected+file.size>totalCap){toast('Storage limit reached. Remove files before adding '+file.name+'.');continue;}
    if(projected+file.size>totalCap*.82)toast('Storage is nearing the 350 MiB limit.');
    const type=file.type===PDF||/\.pdf$/i.test(file.name)?'pdf':'image';
    if(type==='image'&&!file.type.startsWith('image/')){toast(file.name+' is an unsupported file.');continue;}
    const id=crypto.randomUUID();
    const content=type==='image'?await compressImage(file):file.type===PDF?file:new Blob([file],{type:PDF});
    projected+=content.size;
    const blob=await db.saveBlob(content,{local:!navigator.onLine});
    const item={id,blob,type,name:file.name,folder:loc.folder,created:stamp(),size:content.size,indexState:'Uploading',indexProgress:0};
    await db.save(id,'item',item);
    refreshItems();
    if(navigator.onLine){
      try {
        await db.uploadNow(blob,(loaded,total)=>refreshItems('Uploading '+Math.round(loaded/Math.max(1,total)*100)+'%'));
      } catch(error){
        await patchItem(item,{indexState:'Failed Upload'});
        toast(error.message);
        continue;
      }
    }
    await patchItem(item,{indexState:'Queued'});
    scheduleIndex(id);
  }
  upload.value='';
}
upload.onchange=()=>uploadFiles(upload.files).catch(error=>toast(error.message));

async function moveItems(items){
  if(!items.length)return;
  const valid=ordered(folders()).filter(folder=>items.every(item=>allowedFolder(item,folder.id)));
  const result=await modal('Move',select('Destination','folder',[['','Library root'],...valid.map(folder=>[folder.id,folder.name])],items.length===1?items[0].folder:''),{confirm:'Move'});
  if(!result)return;
  for(const item of items)await patchItem(item,{folder:result.folder||null});
  loc.selected.clear();redraw();
}
async function trashItems(items){
  if(!items.length)return;
  const chosen=new Set(items.map(item=>item.id));
  if(items.some(item=>item.type==='folder'&&live().some(child=>child.folder===item.id&&!chosen.has(child.id)))) {
    toast('Move the files out of the folder before deleting it.');
    return;
  }
  if(prefs().confirmDelete&&!(await modal('Move to Recently Deleted?','<p dir="auto">'+esc(items.length===1?items[0].name:items.length+' selected items')+'</p>',{confirm:'Delete'})))return;
  for(const item of items)await patchItem(item,{deleted:stamp()});
  loc.selected.clear();redraw();toast('Moved to Recently Deleted');
}
async function trash(){
  const list=allItems().filter(item=>item.deleted).sort((a,b)=>b.deleted-a.deleted);
  return modal('Recently Deleted',list.length ? list.map(item=>'<article class="file-row">'+icon(typeIcon(item.type))+'<strong dir="auto">'+esc(item.name)+'</strong><div class="row wrap">'+
    button('Restore','restore',{variant:'subtle',attrs:dataId(item.id)})+button('Delete permanently','purge',{variant:'danger',attrs:dataId(item.id)})+'</div></article>').join('') : '<p>No recently deleted items</p>',{cancel:'',confirm:'Close'});
}
async function bulk(){
  const items=[...loc.selected].map(id=>db.get(id)).filter(Boolean);
  const form=await modal(items.length+' selected',select('Action','action',[['move','Move'],['archive','Archive'],['delete','Delete']], 'move'),{confirm:'Apply'});
  if(!form)return;
  if(form.action==='move')return moveItems(items);
  if(form.action==='delete')return trashItems(items);
  for(const item of items)await patchItem(item,{archived:true});
  loc.selected.clear();redraw();
}
async function exportData(){
  if(!navigator.onLine)return toast('Connect to include all cloud files.');
  await db.sync();
  const {Zip, ZipPassThrough, strToU8}=await import('/vendor/fflate.mjs');
  const packet=await db.api('data');
  const chunks=[];
  let finish;
  const finished=new Promise((resolve,reject)=>{finish={resolve,reject};});
  const zip=new Zip((error,chunk,done)=>{
    if(error){finish.reject(error);return;}
    chunks.push(chunk);
    if(done)finish.resolve();
  });
  const inventory=new ZipPassThrough('study-data.json');
  zip.add(inventory);
  inventory.push(strToU8(JSON.stringify([...db.entries.values()])),true);
  for(const {id,type} of packet.blobs){
    const ext={'application/pdf':'pdf','image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','image/avif':'avif'}[type]||'bin';
    const file=new ZipPassThrough('files/'+id+'.'+ext);
    const reader=(await db.fetchBlob(id)).stream().getReader();
    zip.add(file);
    while(true){
      const part=await reader.read();
      if(part.done)break;
      file.push(part.value,false);
    }
    file.push(new Uint8Array(),true);
  }
  zip.end();
  await finished;
  download(new Blob(chunks,{type:'application/zip'}),'Wijdan-library.zip');
}
async function accountDevices(){
  const {devices}=await db.api('devices');
  return modal('Connected Devices',devices.map(device=>'<div class="setting-row"><span>'+esc(device.current?'This device':device.device.slice(0,90))+'</span><small>'+esc(shortDate(device.created))+'</small>'+(device.current?'':button('Revoke','revoke',{variant:'subtle',attrs:dataId(device.id)}))+'</div>').join(''),{cancel:'',confirm:'Close'});
}
async function logout(lock=false){
  if(editor)await editor.close();
  if(role==='student'){
    if(!navigator.onLine)return toast('Connect before signing out or locking this device.');
    await db.sync();
    if(await db.pendingCount()){
      const form=await modal('Unsynced changes','<p>Changes are still on this device. Disconnecting now could remove them.</p>',{confirm:'Discard and sign out'});
      if(!form)return;
    }
  }
  try{await db.api('logout',{method:'POST'});}catch(error){if(error.status!==401)throw error;}
  await db.clearLocal();clearInterval(syncTimer);
  role=null;editor=null;liveTheme=null;
  locationsReset();signIn(lock?'Wijdan is locked':'');
}
function locationsReset(){loc.main='study';loc.query='';loc.folder=null;loc.selecting=false;loc.selected.clear();positions.clear();shelfSelection.clear();shelfOffsets.clear();}
function randomKey(){
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function rotateKey(){
  if(!(await modal('Replace Wijdan’s access key?','<p>Existing sessions will be signed out. Save the new key before closing it.</p>',{confirm:'Replace key'})))return;
  const key=randomKey();
  await db.api('owner/key',{method:'PUT',json:{key}});
  const link=location.origin+'/#access='+encodeURIComponent(key);
  await modal('New access key','<label class="field">Private access link<input readonly value="'+esc(link)+'"></label><p>Copy the link and share it directly with Wijdan.</p>',{cancel:'',confirm:'Done'});
}
async function paintOwner(){
  ownerData=await db.api('owner/status');
  host.innerHTML='<main class="frame stack" id="main"><header class="top"><div class="wordmark">Wijdan</div>'+button('Sign Out','logout',{variant:'subtle'})+'</header>'+title('Owner')+
    group('Access',button('Replace student key','owner-key',{variant:'subtle'})+option('Default Theme','ownerTheme',[['light','Light'],['dark','Dark'],['system','System']],ownerData.defaults.theme))+
    group('Storage','<div class="row between"><span>Items</span><strong>'+ownerData.count+'</strong></div><div class="row between"><span>Original files</span><strong>'+shortBytes(ownerData.size)+'</strong></div>'+
      '<div class="row between"><span>Cloud database</span><strong>Connected</strong></div>')+
    group('Processing',ownerData.processing.length?ownerData.processing.map(item=>'<div class="setting-row"><span dir="auto">'+esc(item.name)+' · '+esc(item.state)+'</span>'+button('Retry','owner-retry',{variant:'subtle',attrs:dataId(item.id)})+'</div>').join(''):'<p>No processing failures.</p>')+
    group('Backups',button('Create backup','owner-backup',{variant:'accent'})+ownerData.backups.map(item=>'<div class="setting-row"><span>'+esc(shortDate(item.created))+' · '+shortBytes(item.size)+'</span><a class="button subtle" href="/api/owner/backup/'+item.id+'" download>Download</a></div>').join(''))+'</main>';
}
async function completeSession(session){
  if((session.role==='owner')!==ownerMode) {
    if (session.role==='owner') return location.replace('/owner');
    location.replace('/');
    return;
  }
  role=session.role;
  if(role==='owner') {await paintOwner();return;}
  await db.restoreLocal();
  if(navigator.onLine)await db.setOfflineSession(Date.now()+7*86400_000);
  for(const id of await db.offlineBlobs())offlineIds.add(id);
  if(session.defaults?.theme&&!db.get('prefs'))defaults.theme=session.defaults.theme;
  applyAppearance();
  redraw(false);
  async function cycle(){
    if(!prefs().autosave){refreshState('Saved on this device');return;}
    await db.sync();
    for(const item of live()){
      if(item.indexState==='Queued' || (['Processing','OCR Processing','Uploading'].includes(item.indexState) && Date.now()-(item.indexTouched||item.created)>90_000)){
        if(item.indexState==='Uploading'){
          try { await db.uploadNow(item.blob); }
          catch {continue;}
        }
        scheduleIndex(item.id);
      }
    }
  }
  clearInterval(syncTimer);
  syncTimer=setInterval(cycle,18_000);
  cycle();
}
let linkedKey = new URLSearchParams(location.hash.slice(1)).get('access') || '';
if(linkedKey)history.replaceState(null,'',location.pathname+location.search);
function signIn(message=''){
  setTheme('light');
  host.innerHTML='<main class="signin" id="main"><div class="wordmark">Wijdan</div><h1>'+ (ownerMode?'Owner sign-in':'Study Library')+'</h1><form class="surface stack" id="login">'+input('Private access key','key',linkedKey,'password')+
    '<p class="meta" role="status">'+esc(message)+'</p><button type="submit" class="button accent">Sign In</button></form></main>';
  const form=host.querySelector('#login');
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    const feedback=form.querySelector('[role=status]');
    const control=form.querySelector('button');
    control.disabled=true;
    feedback.textContent='Signing in…';
    try{
      const key=new FormData(form).get('key').trim();
      const session=await db.api('login',{method:'POST',json:{key,role:ownerMode?'owner':'student'}});
      linkedKey='';
      await completeSession(session);
    }catch(error){feedback.textContent=error.message;control.disabled=false;}
  });
}
async function start(){
  if('serviceWorker' in navigator&&!ownerMode)navigator.serviceWorker.register('/sw.js').catch(()=>{});
  try{await completeSession(await db.api('session'));}
  catch(error){
    if(error.status===0&&!ownerMode&&(await db.offlineSession()||0)>Date.now()){
      await completeSession({role:'student'});
      refreshState('Offline');
      return;
    }
    if(error.status===401)await db.setOfflineSession(0);
    signIn(error.status===401?'':error.message);
  }
}

async function runAction(action,control){
  const {id,value,view,page,query,review,object}=control.dataset;
  const item=id&&db.get(id);
  if(action==='nav'){
    remember();loc.main=view;loc.folder=null;loc.query='';loc.answer=false;loc.selecting=false;loc.selected.clear();loc.limit=60;redraw(false);return;
  }
  if(action==='expand-search'){host.querySelector('input[name=query]')?.focus();return;}
  if(action==='add'){
    return modal('Add','<div class="menu-grid">'+button('Add File','upload',{symbol:'file',variant:'subtle'})+button('New Page','new-note',{symbol:'note',variant:'subtle'})+
      button('New Folder','new-folder',{symbol:'folder',variant:'subtle'})+'</div>',{cancel:'',confirm:'Close'});
  }
  if(action==='upload'){closeDialog();upload.click();return;}
  if(action==='new-note'){closeDialog();return createNote();}
  if(action==='new-folder'){closeDialog();return createFolder();}
  if(action==='open'||action==='resume'||action==='source'){closeDialog();return openItem(item,action==='resume'?{resume:db.get('resume')}:{pageKey:page,query,object});}
  if(action==='folder-up'){loc.folder=db.get(loc.folder)?.folder||null;loc.limit=60;redraw();return;}
  if(action==='library-options')return libraryOptions();
  if(action==='library-filters')return libraryFilters();
  if(action==='library-tab'){
    loc.library=value;loc.folder=null;loc.filter=value==='Archived'?'':loc.filter;loc.limit=60;redraw();return;
  }
  if(action==='library-view'){loc.layout=value;loc.selecting=false;loc.selected.clear();redraw();return;}
  if(action==='library-reset'){loc.library='All Files';loc.filter='';loc.selected.clear();loc.limit=60;redraw();return;}
  if(action==='shelf-select'){
    const key=control.dataset.shelf;
    const keyboard=control.matches(':focus-visible');
    shelfSelection.set(key,id);
    redraw();
    if(keyboard)host.querySelector('.shelf-book[data-shelf="'+CSS.escape(key)+'"][data-id="'+CSS.escape(id)+'"]')?.focus({preventScroll:true});
    return;
  }
  if(action==='select-mode'){
    closeDialog();
    loc.selecting=!loc.selecting;
    loc.selected.clear();
    redraw();
    return;
  }
  if(action==='notes-tab'||action==='notes-archive'){loc.notes=value||'Archived';loc.folder=null;loc.limit=60;redraw();return;}
  if(action==='show-more'){loc.limit+=60;redraw();return;}
  if(action==='item-menu'){closeDialog();return fileMenu(item);}
  if(action==='manage-pins')return managePins();
  if(action==='pin'){closeDialog();return togglePin(id);}
  if(action==='rename'){
    closeDialog();
    const form=await modal('Rename',input('Name','name',item.name),{confirm:'Rename'});
    if(form){await patchItem(item,{name:form.name.trim()});redraw();}
    return;
  }
  if(action==='move'){closeDialog();return moveItems([item]);}
  if(action==='bulk')return bulk();
  if(action==='reference'||action==='archive'){
    closeDialog();
    const field=action==='reference'?'reference':'archived';
    await patchItem(item,{[field]:!item[field]});redraw();return;
  }
  if(action==='delete'){closeDialog();return trashItems([item]);}
  if(action==='trash')return trash();
  if(action==='restore'){
    closeDialog();await patchItem(item,{deleted:null});redraw();toast('Restored');return;
  }
  if(action==='purge'){
    closeDialog();
    if(!(await modal('Permanently delete?','<p dir="auto">'+esc(item.name)+'</p>',{confirm:'Delete permanently'})))return;
    if(!navigator.onLine)return toast('Connect before permanently deleting a file.');
    await db.sync();
    const previous=db.get(id);
    await db.api('purge/'+id,{method:'POST'});
    if(previous?.blob)await db.forgetBlob(previous.blob);
    await db.sync();redraw();return;
  }
  if(action==='offline-file'){
    closeDialog();
    if(offlineIds.has(item.blob)){await db.forgetBlob(item.blob);offlineIds.delete(item.blob);}
    else {
      const linked=new Set([item.blob,item.thumb,...(item.pagesAdded||[]).map(spec=>spec.blob)]);
      for(const entry of annotations().filter(entry=>entry.item===item.id))for(const shape of entry.objects)linked.add(shape.blob);
      linked.delete(undefined);
      linked.delete(null);
      for(const blob of linked)await db.fetchBlob(blob,{keep:true});
      offlineIds.add(item.blob);
    }
    redraw();return;
  }
  if(action==='download'){closeDialog();download(await downloadOriginal(item),item.name);return;}
  if(action==='export'){closeDialog();toast('Preparing PDF…');return saveExport(item,await renderExport(item));}
  if(action==='duplicate'){closeDialog();return createNote(item);}
  if(action==='review'){closeDialog();return addReview(item);}
  if(action==='history'){closeDialog();return versionHistory(id);}
  if(action==='reviewed'||action==='remove-review'){
    const row=db.get(review);
    await db.save(review,'review',{...row,...(action==='reviewed'?{reviewed:row.reviewed?null:stamp()}:{removed:true})});
    redraw();return;
  }
  if(action==='ask'||action==='ask-submit'){
    closeDialog();
    const current=host.querySelector('input[name=question]')?.value;
    if(action==='ask-submit'&&current?.trim()) {loc.query=current.trim();redraw(false);return;}
    const form=await modal('Find in Sources',input('Question','question'),{confirm:'Find sources'});
    if(form?.question.trim()){remember();loc.answer=true;loc.query=form.question.trim();redraw(false);}
    return;
  }
  if(action==='theme'){liveTheme=value;applyAppearance();redraw();return;}
  if(action==='theme-apply'){const theme=liveTheme||prefs().theme;liveTheme=null;return changePrefs({theme});}
  if(action==='theme-reset'){
    liveTheme=null;
    return changePrefs({theme:defaults.theme,textScale:defaults.textScale,density:defaults.density,contrast:false,reduce:false});
  }
  if(action==='sync'){
    if(db.pendingConflicts.size){
      const [key]=db.pendingConflicts.keys();
      const form=await modal('Sync Conflict',select('Keep version','choice',[['local','This device'],['remote','Cloud']],'local'),{confirm:'Resolve'});
      if(form){await db.resolveConflict(key,form.choice);redraw();}
    }else await db.sync();
    return;
  }
  if(action==='retry-index'||action==='reindex'){
    const eligible=live().filter(item=>['pdf','image'].includes(item.type)&&(action==='reindex'||['Failed','OCR Required','Failed Upload'].includes(item.indexState)));
    if(!eligible.length)return toast('No files to process.');
    if(!(await modal('Process searchable text?','<p>This can use OCR for scanned pages. Progress can be paused or cancelled, and pages already processed remain searchable.</p>',{confirm:'Start processing'})))return;
    for(const item of eligible){
      if(item.indexState==='Failed Upload'){
        try {await db.uploadNow(item.blob);}
        catch(error){toast(error.message);continue;}
      }
      await patchItem(item,{indexState:'Queued',indexCursor:0,indexProgress:0,indexNeedsOCR:false});
      scheduleIndex(item.id,true);
    }
    return toast('Processing '+eligible.length+' file'+(eligible.length===1?'':'s'));
  }
  if(action==='index-pause'){pauseIndex(id);await patchItem(item,{indexState:'Paused'});redraw();return;}
  if(action==='index-resume'){resumeIndex(id);await patchItem(item,{indexState:'OCR Processing'});redraw();return;}
  if(action==='index-cancel'){cancelIndex(id);await patchItem(item,{indexState:'Cancelled'});redraw();return;}
  if(action==='export-data')return exportData();
  if(action==='backup-info')return modal('Backups','<p>Cloud snapshots are managed by the owner. You can also export your files and study data.</p>'+button('Export Data','export-data',{variant:'subtle'}),{cancel:'',confirm:'Close'});
  if(action==='clear-cache'){
    if(!navigator.onLine||await db.pendingCount())return toast('Sync your changes before clearing local storage.');
    if(!(await modal('Clear Local Cache?','<p>Offline copies will be removed from this device.</p>',{confirm:'Clear cache'})))return;
    await db.clearLocal();offlineIds.clear();await db.restoreLocal();
    await db.setOfflineSession(stamp()+7*86400_000);await db.sync();redraw();return;
  }
  if(action==='credentials')return modal('Access Credentials','<p>The owner can replace your private access key and revoke existing sign-ins.</p>',{cancel:'',confirm:'Done'});
  if(action==='devices')return accountDevices();
  if(action==='revoke'){closeDialog();await db.api('devices/'+id,{method:'DELETE'});return accountDevices();}
  if(action==='logout'||action==='lock')return logout(action==='lock');
  if(action==='owner-key')return rotateKey();
  if(action==='owner-backup'){await db.api('owner/backup',{method:'POST'});return paintOwner();}
  if(action==='owner-retry'){await db.api('owner/retry',{method:'POST',json:{id}});return paintOwner();}
}

document.addEventListener('click',event=>{
  const control=event.target.closest('button[data-action]');
  if(!control||control.disabled)return;
  if(control.closest('.editor-shell'))return;
  Promise.resolve(runAction(control.dataset.action,control)).catch(error=>toast(error.message));
});
document.addEventListener('submit',event=>{
  if(event.target.matches('.search')){
    event.preventDefault();parseSearch(new FormData(event.target).get('query'));
  }
  if(event.target.id==='ask-form'){
    event.preventDefault();
    loc.query=new FormData(event.target).get('question').trim();
    redraw(false);
  }
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&loc.query&&!editor&&!document.querySelector('dialog').open){loc.query='';loc.answer=false;redraw(false);}
});
document.addEventListener('change',event=>{
  if(event.target.matches('.file-select')){
    const id=event.target.dataset.id;
    if(event.target.checked)loc.selected.add(id);else loc.selected.delete(id);
    const bulkBar=document.querySelector('#bulk');
    if(bulkBar)bulkBar.hidden=!loc.selected.size;
  }
  if(event.target.matches('.library-sort')){loc.sort=event.target.value;redraw();}
  if(event.target.closest('.setting-group')&&event.target.matches('select,.preference')){
    const {name,type,checked,value}=event.target;
    if(name==='ownerTheme')db.api('owner/defaults',{method:'PUT',json:{theme:value}}).then(paintOwner).catch(error=>toast(error.message));
    else if(role==='student')changePrefs({[name]:type==='checkbox'?checked:value}).catch(error=>toast(error.message));
  }
});
window.addEventListener('online',()=>{if(role==='student')db.sync();});
window.addEventListener('offline',()=>{if(role==='student')refreshState('Offline');});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&role==='student')db.sync();});
start().catch(error=>signIn(error.message));
