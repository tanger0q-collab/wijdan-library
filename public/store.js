export async function api(path, options = {}) {
  const request = {...options};
  if (Object.hasOwn(options,'json')) {
    request.headers = {'Content-Type':'application/json',...request.headers};
    request.body = JSON.stringify(options.json);
  }
  let response;
  try { response = await fetch('/api/'+path,request); }
  catch { throw Object.assign(new Error('Connection unavailable.'),{status:0}); }
  if (!response.ok) {
    const details = await response.json().catch(()=>({}));
    throw Object.assign(new Error(details.error || 'Request failed.'),{status:response.status, details});
  }
  if (options.raw) return response;
  return response.json();
}

const tables = ['records','pending','blobs','meta','index'];
let databasePromise;
function database() {
  databasePromise ??= new Promise((resolve,reject) => {
    const open = indexedDB.open('wijdan-study',1);
    open.onupgradeneeded = () => {
      for (const table of tables) open.result.createObjectStore(table);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return databasePromise;
}

async function transaction(names, mode, run) {
  const db = await database();
  return new Promise((resolve,reject) => {
    const tx = db.transaction(names,mode);
    const result = run(tx);
    tx.oncomplete = () => resolve(result?.result);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('Local storage is full.'));
  });
}
const read = (table,key) => transaction([table],'readonly',tx=>tx.objectStore(table).get(key));
const list = table => transaction([table],'readonly',tx=>tx.objectStore(table).getAll());
const write = (table,key,value) => transaction([table],'readwrite',tx=>tx.objectStore(table).put(value,key));
const remove = (table,key) => transaction([table],'readwrite',tx=>tx.objectStore(table).delete(key));

export const entries = new Map();
const edits = new Map();
export const pendingConflicts = new Map();
let cursor = [0,''];
let task;
let scheduled;
let observer = () => {};
let phase = 'Saved';

export function watch(callback) { observer = callback; }
function publish(status, repaint = false) {
  phase = status;
  observer(phase,repaint);
}
export function status() { return phase; }
export const isPending = id => edits.has(id);
export const get = (id,fallback=null)=>entries.get(id)?.data ?? fallback;
export const byKind = kind => [...entries.values()].filter(record=>record.kind===kind);

export async function restoreLocal() {
  const [records,pending,savedCursor] = await Promise.all([list('records'),list('pending'),read('meta','cursor')]);
  entries.clear();
  edits.clear();
  pendingConflicts.clear();
  for (const record of records) entries.set(record.id,record);
  for (const edit of pending) {
    edits.set(edit.id,edit);
    if (edit.conflict) pendingConflicts.set(edit.id,edit.conflict);
  }
  cursor = savedCursor || [0,''];
}

export const setOfflineSession = value => write('meta','session',value);
export const offlineSession = ()=>read('meta','session');
export async function clearLocal() {
  await transaction(tables,'readwrite',tx=>{ for (const table of tables) tx.objectStore(table).clear(); });
  entries.clear();
  edits.clear();
  pendingConflicts.clear();
  cursor = [0,''];
}
export const pendingCount = async () => edits.size + (await list('blobs')).filter(row=>row.pending).length + (await list('index')).filter(row=>row.pending).length;

export async function save(id,kind,data, {cloud = true} = {}) {
  const record = {id,kind,rev:entries.get(id)?.rev || 0,changed:Date.now(),data:structuredClone(data)};
  const edit = {...record, generation:crypto.randomUUID(), conflict:pendingConflicts.get(id)};
  try {
    await transaction(['records','pending'],'readwrite',tx=>{
      tx.objectStore('records').put(record,id);
      tx.objectStore('pending').put(edit,id);
    });
  } catch (error) {
    publish(error.name === 'QuotaExceededError' ? 'Storage Full' : 'Local Save Failed');
    throw error;
  }
  entries.set(id,record);
  edits.set(id,edit);
  if (cloud && get('prefs')?.autosave !== false) schedule();
  return data;
}

export async function saveBlob(blob,{id=crypto.randomUUID(),local=true}={}) {
  await write('blobs',id,{id,blob,pending:true,keep:local});
  schedule();
  return id;
}

export async function cachedBlob(id) { return (await read('blobs',id))?.blob; }
export async function fetchBlob(id, {keep=false} = {}) {
  const local = await cachedBlob(id);
  if (local) return local;
  const blob = await (await api('blob/'+id,{raw:true})).blob();
  if (keep) await write('blobs',id,{id,blob,pending:false,keep:true});
  return blob;
}
export async function forgetBlob(id) {
  if (!(await read('blobs',id))?.pending) await remove('blobs',id);
}
export const offlineBlobs = async () => new Set((await list('blobs')).filter(row=>row.keep).map(row=>row.id));

const uploading = new Map();
export async function uploadNow(id, progress) {
  if (uploading.has(id)) return uploading.get(id);
  const task = uploadBlob(id,progress).finally(()=>uploading.delete(id));
  uploading.set(id,task);
  return task;
}
async function uploadBlob(id, progress) {
  const item = await read('blobs',id);
  if (!item?.pending) return;
  if (item.blob.size <= 32 * 1024 * 1024) {
    try {
      await new Promise((resolve,reject)=>{
        const upload = new XMLHttpRequest();
        upload.open('PUT','/api/blob/'+id);
        upload.setRequestHeader('Content-Type',item.blob.type);
        if (progress) upload.upload.onprogress = event=>progress(event.loaded,event.total);
        upload.onload = ()=>[200,409].includes(upload.status) ? resolve() : reject(Object.assign(new Error(upload.status===413?'Storage Full.':'Upload failed.'),{status:upload.status}));
        upload.onerror = ()=>reject(Object.assign(new Error('Upload interrupted.'),{status:0}));
        upload.send(item.blob);
      });
    } catch (error) { throw error; }
  } else {
    const size = 16 * 1024 * 1024;
    const {uploadId,exists} = await api('multipart/'+id,{method:'POST',json:{type:item.blob.type}});
    if (!exists) {
      const parts = [];
      try {
        for (let start=0, part=1; start<item.blob.size; start+=size,part++) {
          parts.push(await api('multipart/'+id+'/'+encodeURIComponent(uploadId)+'/'+part,{method:'PUT',body:item.blob.slice(start,start+size)}));
          progress?.(Math.min(start+size,item.blob.size),item.blob.size);
        }
        await api('multipart/'+id+'/'+encodeURIComponent(uploadId),{method:'POST',json:{parts}});
      } catch (error) {
        await api('multipart/'+id+'/'+encodeURIComponent(uploadId),{method:'DELETE'}).catch(()=>{});
        throw error;
      }
    }
  }
  if (item.keep) await write('blobs',id,{...item,pending:false});
  else await remove('blobs',id);
}

export async function saveIndex(id,page,text,source,anchors=[]) {
  await write('index',id+':'+page,{id,page,text,source,anchors,pending:true});
  schedule();
}
export const localIndex = ()=>list('index');
export const getIndex = (id,page)=>read('index',id+':'+page);
export const normalize = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[\u064b-\u065f\u0670\u0640]/g,'').replace(/[إأآ]/g,'ا');
export const terms = query => normalize(query).match(/[\p{L}\p{N}]+/gu)?.slice(0,16) || [];

async function resolveEdit(edit, record) {
  const current = edits.get(edit.id);
  if (current.generation !== edit.generation) {
    const nextEdit = {...current,rev:record.rev};
    edits.set(edit.id,nextEdit);
    entries.set(edit.id,{...nextEdit});
    await transaction(['records','pending'],'readwrite',tx=>{
      tx.objectStore('records').put(nextEdit,edit.id);
      tx.objectStore('pending').put(nextEdit,edit.id);
    });
    return;
  }
  await transaction(['records','pending'],'readwrite',tx=>{
    tx.objectStore('records').put(record,record.id);
    tx.objectStore('pending').delete(record.id);
  });
  entries.set(record.id,record);
  edits.delete(record.id);
}

async function pull() {
  let changed = false;
  let packet;
  do {
    packet = await api('changes?'+new URLSearchParams({since:cursor[0],after:cursor[1]}));
    await transaction(['records','meta'],'readwrite',tx=>{
      const records = tx.objectStore('records');
      for (const record of packet.records) {
        if (edits.has(record.id)) continue;
        records.put(record,record.id);
        if (record.rev !== entries.get(record.id)?.rev) changed = true;
        entries.set(record.id,record);
      }
      tx.objectStore('meta').put(packet.cursor,'cursor');
    });
    cursor = packet.cursor;
  } while(packet.more);
  return changed;
}

export function schedule(delay=300) {
  clearTimeout(scheduled);
  publish(navigator.onLine ? 'Saving' : 'Offline');
  scheduled = setTimeout(()=>sync(),delay);
}

export function sync() {
  if (task) return task;
  task = (async ()=>{
    if (!navigator.onLine) {publish('Offline');return;}
    publish('Saving');
    try {
      for (const blob of (await list('blobs')).filter(row=>row.pending)) await uploadNow(blob.id);
      for (const edit of [...edits.values()]) {
        if (pendingConflicts.has(edit.id)) continue;
        try {
          const record = await api('records/'+edit.id,{method:'PUT',json:edit});
          await resolveEdit(edit,record);
        } catch (error) {
          if (error.status !== 409) throw error;
          const remote = error.details.current;
          if (remote && JSON.stringify(remote.data) === JSON.stringify(edit.data)) {
            await resolveEdit(edit,remote);
            continue;
          }
          pendingConflicts.set(edit.id,remote);
          const conflicted = {...edits.get(edit.id),conflict:remote};
          edits.set(edit.id,conflicted);
          await write('pending',edit.id,conflicted);
        }
      }
      for (const row of (await list('index')).filter(row=>row.pending)) {
        await api('index/'+row.id,{method:'PUT',json:{...row,text:normalize(row.text)}});
        await write('index',row.id+':'+row.page,{...row,pending:false});
      }
      const changed = await pull();
      publish(pendingConflicts.size ? 'Sync Conflict' : 'Saved',changed);
    } catch (error) {
      publish(error.status===0 || !navigator.onLine ? 'Offline' : error.status===401 ? 'Sign in to sync' : error.status===413 ? 'Storage Full' : 'Sync Failed');
    }
  })().finally(()=>{ task = null; });
  return task;
}

export async function resolveConflict(id, choice) {
  const remote = pendingConflicts.get(id);
  if (!remote) return;
  pendingConflicts.delete(id);
  if (choice === 'local') {
    const edit = {...edits.get(id),rev:remote.rev, conflict:undefined, generation:crypto.randomUUID()};
    edits.set(id,edit);
    await write('pending',id,edit);
  } else {
    await transaction(['records','pending'],'readwrite',tx=>{
      tx.objectStore('records').put(remote,id);
      tx.objectStore('pending').delete(id);
    });
    entries.set(id,remote);
    edits.delete(id);
  }
  schedule(0);
}
