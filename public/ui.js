const shapes = {
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  plus:'<path d="M12 4v16M4 12h16"/>',
  book:'<path d="M12 6c-4-3-7-3-10-1v15c4-2 7-2 10 0 3-2 6-2 10 0V5c-3-2-6-2-10 1v14z"/><path d="M15 4v6l2-1.4 2 1.4V4"/>',
  folder:'<path d="M2 7a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"/>',
  note:'<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v5m8-5v5m-8 4h8m-8 4h6"/>',
  gear:'<path d="m10 3-.6 2.2-1.5.7-2-.9-2 2 .9 2-.7 1.5-2.1.6v2.8l2.1.6.7 1.5-.9 2 2 2 2-.9 1.5.7.6 2.2h2.8l.6-2.2 1.5-.7 2 .9 2-2-.9-2 .7-1.5 2.2-.6v-2.8l-2.2-.6-.7-1.5.9-2-2-2-2 .9-1.5-.7L12.8 3z"/><circle cx="11.4" cy="12.5" r="3.1"/>',
  file:'<path d="M5 2h9l5 5v15H5zM14 2v6h5M8 12h8m-8 4h8"/>',
  image:'<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m4 17 5-4 3 2 4-5 4 5"/>',
  pin:'<path d="M8 3h8l-1.5 6 3.5 4v2H6v-2l3.5-4zM12 15v6"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  back:'<path d="m14 5-7 7 7 7"/>',
  next:'<path d="m9 5 7 7-7 7"/>',
  more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  grid:'<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  shelves:'<path d="M4 4h4v14H4zM10 4h4v14h-4zM16 4h4v14h-4zM2 20h20"/>',
  list:'<path d="M8 6h12M8 12h12M8 18h12M4 6h.1M4 12h.1M4 18h.1"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2m0-14-2 2M5 19l2-2"/>',
  moon:'<path d="M21 14a9 9 0 0 1-11-11 9 9 0 1 0 11 11z"/>',
  monitor:'<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M12 17v4m-5 0h10"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  undo:'<path d="M8 5 3 10l5 5M3 10h11a5 5 0 0 1 0 10"/>',
  redo:'<path d="m16 5 5 5-5 5m5-5H10a5 5 0 0 0 0 10"/>',
  pen:'<path d="m4 16-1 5 5-1L20 8l-4-4zM13 7l4 4"/>',
  marker:'<path d="m6 15 9-10 4 4L9 18H6zM3 21h12"/>',
  erase:'<path d="m4 13 9-9 7 7-9 9H8zM8 9l8 7M12 20h8"/>',
  lasso:'<path d="M8 16c-3 0-5-3-5-6 0-4 4-7 9-7s9 3 9 7-4 7-9 7c-5 0-6-3-4-4s5 2 3 5l-3 3"/>',
  text:'<path d="M4 5h16M12 5v15m-4 0h8"/>',
  shape:'<rect x="3" y="3" width="10" height="10" rx="1"/><circle cx="16" cy="16" r="5"/>',
  bookmark:'<path d="M6 3h12v18l-6-4-6 4z"/>',
  download:'<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  archive:'<path d="M4 8v12h16V8M3 3h18v5H3zm6 9h6"/>',
  trash:'<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15m-8 4v7m4-7v7"/>',
  drag:'<path d="M7 5h.1M7 12h.1M7 19h.1M16 5h.1M16 12h.1M16 19h.1"/>',
  pages:'<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/>',
  crop:'<path d="M7 2v15a2 2 0 0 0 2 2h13M2 7h15a2 2 0 0 1 2 2v13"/>',
  rotate:'<path d="M20 11a8 8 0 1 0-2 5.3M20 4v7h-7"/>',
  pause:'<path d="M8 5v14M16 5v14"/>',
};
export const icon = (name,size=22) => '<svg width="'+size+'" height="'+size+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(shapes[name] || '')+'</svg>';
export const esc = value => String(value ?? '').replace(/[&<>"']/g, char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
export const shortDate = time => time ? new Intl.DateTimeFormat('en',{dateStyle:'medium',timeStyle:'short'}).format(time) : '—';
export const shortBytes = size => size < 1024*1024 ? (size/1024).toFixed(1)+' KB' : (size/(1024*1024)).toFixed(1)+' MB';
export const button = (label,action,{symbol,variant='',attrs=''}={}) => '<button type="button" class="button '+variant+'" data-action="'+esc(action)+'" '+attrs+'>'+(symbol ? icon(symbol) : '')+'<span>'+esc(label)+'</span></button>';
export const iconButton = (symbol,label,action,attrs='') => '<button class="icon-button" type="button" aria-label="'+esc(label)+'" title="'+esc(label)+'" data-action="'+esc(action)+'" '+attrs+'>'+icon(symbol)+'</button>';
const dialog = document.querySelector('#dialog');
let finish;

export function modal(title,content,{confirm='Done',cancel='Cancel',className=''}={}) {
  if (dialog.open) dialog.close();
  finish?.(null);
  dialog.onclick=null;
  dialog.className = className;
  dialog.innerHTML = '<form method="dialog"><header><h2>'+esc(title)+'</h2><button type="button" class="icon-button" aria-label="Close">'+icon('close')+'</button></header><div class="dialog-body">'+content+'</div><footer>'+(cancel ? '<button class="button subtle" value="cancel" formnovalidate>'+esc(cancel)+'</button>' : '')+'<button class="button accent" value="confirm">'+esc(confirm)+'</button></footer></form>';
  dialog.querySelector('header button').onclick = ()=>dialog.close('cancel');
  dialog.showModal();
  return new Promise(resolve=>{
    finish = resolve;
    dialog.querySelector('form').onsubmit = event=>{
      event.preventDefault();
      const result = event.submitter?.value === 'cancel' ? null : Object.fromEntries(new FormData(event.currentTarget));
      finish = null;
      dialog.close();
      resolve(result);
    };
    dialog.onclose = ()=>{ if (!dialog.open && finish===resolve) {finish = null;resolve(null);} };
  });
}

export function actionMenu(title,groups,{className='action-sheet'}={}) {
  if (dialog.open) dialog.close();
  finish?.(null);
  dialog.onclick=null;
  dialog.className=className;
  dialog.innerHTML='<div class="action-menu" role="document"><header><h2>'+esc(title)+'</h2><button type="button" class="icon-button" aria-label="Close">'+icon('close')+'</button></header><div class="action-menu-groups">'+groups.map(group=>
    '<section class="action-menu-group" aria-label="'+esc(group.label||title)+'">'+(group.label?'<h3>'+esc(group.label)+'</h3>':'')+group.items.map(([value,label,symbol,attrs=''])=>
      '<button type="button" class="action-menu-item" data-menu-value="'+esc(value)+'" '+attrs+'>'+(symbol?icon(symbol):'')+'<span>'+esc(label)+'</span></button>').join('')+'</section>').join('')+'</div></div>';
  dialog.querySelector('header button').onclick=()=>dialog.close();
  dialog.showModal();
  return new Promise(resolve=>{
    finish=resolve;
    dialog.onclick=event=>{
      const control=event.target.closest('[data-menu-value]');
      if(!control)return;
      finish=null;
      dialog.close();
      resolve(control.dataset.menuValue);
    };
    dialog.onclose=()=>{if(!dialog.open&&finish===resolve){finish=null;resolve(null);}};
  });
}
export const input = (label,name,value='',type='text')=>'<label class="field"><span>'+esc(label)+'</span><input type="'+esc(type)+'" name="'+esc(name)+'" value="'+esc(value)+'" required maxlength="220" dir="auto"></label>';
export const select = (label,name,options,value='')=>'<label class="field"><span>'+esc(label)+'</span><select name="'+esc(name)+'" aria-label="'+esc(label)+'">'+options.map(([id,title])=>'<option value="'+esc(id)+'" '+(id===value?'selected':'')+'>'+esc(title)+'</option>').join('')+'</select></label>';
let toastTimer;
export function toast(message, duration=3800) {
  const element = document.querySelector('#status');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{element.hidden=true;},duration);
}
export function download(blob,name) {
  const url = URL.createObjectURL(blob);
  const anchor=document.createElement('a');
  anchor.href=url;
  anchor.download=name;
  anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),8000);
}
export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name=theme-color]').content = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches) ? '#171717' : '#ebebeb';
}
