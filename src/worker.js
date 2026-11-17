import {PrivateFiles} from './private-files.js';
const maxRecord = 900_000;
const duration = 30 * 86400_000;
const kinds = new Set(['item', 'annotation', 'prefs', 'resume', 'review', 'pins', 'index', 'site']);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const entity = /^[A-Za-z0-9_:-]{1,150}$/;
const keyFormat = /^[A-Za-z0-9_-]{43}$/;
const extensions = {'application/pdf':'pdf','image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/avif':'avif'};
const encoder = new TextEncoder();
const stamp = () => Date.now();
const fail = (message, status) => Object.assign(new Error(message), {status});
const json = (body, status = 200, extra) => Response.json(body, {status, headers:extra});

async function digest(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return Array.from(bytes, value => value.toString(16).padStart(2,'0')).join('');
}

function equalHash(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function sessionCookie(request, value, maxAge) {
  const secure = new URL(request.url).protocol === 'https:';
  return 'wijdan_session=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + (secure ? '; Secure' : '');
}

async function login(request, env) {
  const body = await request.json();
  const role = body.role === 'owner' ? 'owner' : 'student';
  const now = stamp();
  const bucket = Math.floor(now / 300_000);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const trace = await digest(bucket + ':' + ip);
  const attempt = await env.DB.prepare('INSERT INTO login_attempts VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET attempts=attempts+1 RETURNING attempts').bind(trace, (bucket + 1) * 300_000).first();
  if (attempt.attempts > 18) throw fail('Try again in a few minutes.',429);
  const account = await env.DB.prepare('SELECT key_hash FROM accounts WHERE role=?').bind(role).first();
  const configured = role === 'owner' ? env.OWNER_KEY_HASH : env.STUDENT_KEY_HASH;
  if (!keyFormat.test(body.key) || !equalHash(account?.key_hash || configured, await digest(body.key))) throw fail('Access key is incorrect.',401);
  const token = crypto.randomUUID() + '.' + crypto.randomUUID();
  const id = await digest(token);
  const device = (request.headers.get('User-Agent') || 'Browser').slice(0, 250);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').bind(id, role, now + duration, now, device),
    env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(now),
    env.DB.prepare('DELETE FROM login_attempts WHERE expires < ?').bind(now),
  ]);
  return json({role},200,{'Set-Cookie':sessionCookie(request,token,duration / 1000)});
}

async function getSession(request, env) {
  const token = request.headers.get('Cookie')?.match(/(?:^|;\s*)wijdan_session=([^;]+)/)?.[1];
  if (!token || !/^[\w.-]{73}$/.test(token)) return null;
  return env.DB.prepare('SELECT id,role,created FROM sessions WHERE id=? AND expires>?').bind(await digest(token), stamp()).first();
}

function checkMutation(request) {
  if (['GET','HEAD'].includes(request.method)) return;
  if (request.headers.get('Origin') !== new URL(request.url).origin) throw fail('Request origin is invalid.',403);
}

function decodeRecord(row) {
  return row && {...row, data:JSON.parse(row.data)};
}

async function changes(url, env) {
  const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
  const after = url.searchParams.get('after') || '';
  const rows = await env.DB.prepare("SELECT * FROM records WHERE kind!='site' AND (changed>? OR (changed=? AND id>?)) ORDER BY changed,id LIMIT 151").bind(since,since,after).all();
  const records = rows.results.slice(0,150).map(decodeRecord);
  const last = records.at(-1);
  return json({records, more:rows.results.length > 150, cursor:last ? [last.changed,last.id] : [since,after]});
}

async function saveRecord(request, env, id) {
  const {kind,rev,data} = await request.json();
  if (!entity.test(id) || !kinds.has(kind) || kind === 'site' || !Number.isSafeInteger(rev) || rev < 0 || !data || typeof data !== 'object') throw fail('Record is invalid.',400);
  if (kind === 'item' && (!uuid.test(id) || !['pdf','image','note','folder'].includes(data.type))) throw fail('Item is invalid.',400);
  if (kind === 'item' && rev > 0) {
    const prior = decodeRecord(await env.DB.prepare('SELECT * FROM records WHERE id=?').bind(id).first());
    if (prior?.data.purged) throw fail('This item has been permanently deleted.',410);
    if (prior?.data.blob && data.blob !== prior.data.blob) throw fail('The original file cannot be replaced.',400);
  }
  const serialized = JSON.stringify(data);
  if (encoder.encode(serialized).length > maxRecord) throw fail('This page reached its save limit. Add another page.',413);
  const changed = stamp();
  const saved = rev === 0
    ? await env.DB.prepare('INSERT OR IGNORE INTO records (id,kind,data,changed) VALUES (?,?,?,MAX(?,1+COALESCE((SELECT MAX(changed) FROM records),0))) RETURNING *').bind(id,kind,serialized,changed).first()
    : await env.DB.prepare('UPDATE records SET data=?, changed=MAX(?,1+(SELECT MAX(changed) FROM records)), rev=rev+1 WHERE id=? AND kind=? AND rev=? RETURNING *').bind(serialized,changed,id,kind,rev).first();
  if (saved) return json(decodeRecord(saved));
  const existing = await env.DB.prepare('SELECT * FROM records WHERE id=?').bind(id).first();
  return json({error:'Sync conflict', current:decodeRecord(existing)},409);
}

async function blob(request, env, id) {
  if (!uuid.test(id)) throw fail('File not found.',404);
  if(await env.DB.prepare('SELECT key FROM deleted_blobs WHERE key=?').bind(id).first())throw fail('File not found.',404);
  if (request.method === 'PUT') {
    const type = request.headers.get('Content-Type');
    const size = Number(request.headers.get('Content-Length'));
    if(size > 32*1024*1024)throw fail('Use multipart upload.',413);
    if (!extensions[type] || !request.body || size > 95 * 1024 * 1024) throw fail('Unsupported file or upload size.',415);
    const saved = await env.FILES.put('files/' + id, request.body, {onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:type}});
    if (!saved) throw fail('This file already exists.',409);
    return json({id,size:saved.size});
  }
  if (!['GET','HEAD'].includes(request.method)) throw fail('Method not allowed.',405);
  const key = 'files/' + id;
  const object = await env.FILES.head(key);
  if (!object) throw fail('File not found.',404);
  const headers = new Headers({'Accept-Ranges':'bytes','Content-Length':String(object.size),'ETag':object.httpEtag});
  object.writeHttpMetadata(headers);
  if (request.method === 'HEAD') return new Response(null,{headers});
  const range = request.headers.get('Range');
  if (!range) {
    const file = await env.FILES.get(key);
    if (!file) throw fail('File not found.',404);
    return new Response(file.body,{headers});
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  const offset = Number(match?.[1]);
  const end = match?.[2] ? Math.min(Number(match[2]),object.size - 1) : object.size - 1;
  if (!match || offset > end || offset < 0) return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+object.size}});
  const length = end - offset + 1;
  const file = await env.FILES.get(key,{range:{offset,length}});
  if (!file) throw fail('File not found.',404);
  headers.set('Content-Length',String(length));
  headers.set('Content-Range','bytes '+offset+'-'+end+'/'+object.size);
  return new Response(file.body,{status:206,headers});
}

async function multipart(request, env, path) {
  const [, , , id, rawUpload, part] = path.split('/');
  if (!uuid.test(id)) throw fail('Item is invalid.',400);
  const key = 'files/' + id;
  if (!rawUpload && request.method === 'POST') {
    const {type} = await request.json();
    if (!extensions[type]) throw fail('Unsupported file.',415);
    if (await env.FILES.head(key)) return json({exists:true});
    const upload = await env.FILES.createMultipartUpload(key,{httpMetadata:{contentType:type}});
    return json({uploadId:upload.uploadId});
  }
  if (!rawUpload) throw fail('Upload not found.',404);
  const upload = env.FILES.resumeMultipartUpload(key,decodeURIComponent(rawUpload));
  if (part && request.method === 'PUT') {
    const number = Number(part);
    if (!Number.isInteger(number) || number < 1 || number > 10000 || !request.body) throw fail('Invalid upload part.',400);
    return json(await upload.uploadPart(number,request.body));
  }
  if (request.method === 'DELETE') {
    await upload.abort();
    return json({ok:true});
  }
  if (request.method === 'POST') {
    const {parts} = await request.json();
    if (!Array.isArray(parts) || !parts.length) throw fail('Invalid upload parts.',400);
    if (await env.FILES.head(key)) {
      await upload.abort();
      return json({id});
    }
    const object = await upload.complete(parts);
    return json({id,size:object.size});
  }
  throw fail('Upload method not allowed.',405);
}

async function indexPage(request, env, id) {
  if (!uuid.test(id)) throw fail('Item is invalid.',400);
  const {page,text,source,anchors} = await request.json();
  if (!Number.isSafeInteger(page) || page < 1 || typeof text !== 'string' || !['pdf','ocr','image'].includes(source)) throw fail('Page is invalid.',400);
  const value = text.slice(0,120_000).normalize('NFKC');
  const boxes=Array.isArray(anchors) ? JSON.stringify(anchors.slice(0,6000)) : '[]';
  if(boxes.length>475_000)throw fail('Page index is too large.',413);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO library_index (item,page,source,text,anchors) VALUES (?,?,?,?,?) ON CONFLICT(item,page) DO UPDATE SET source=excluded.source,text=excluded.text,anchors=excluded.anchors').bind(id,page,source,value,boxes),
    env.DB.prepare('DELETE FROM search_index WHERE item=? AND page=?').bind(id,page),
    env.DB.prepare('INSERT INTO search_index VALUES (?,?,?)').bind(id,page,value),
  ]);
  return json({ok:true});
}

async function search(url, env) {
  const words = (url.searchParams.get('q') || '').normalize('NFKC').match(/[\p{L}\p{M}\p{N}]+/gu)?.slice(0,16) || [];
  if (!words.length) return json({results:[]});
  const query = words.map(word => '"' + word + '"').join(' AND ');
  const {results} = await env.DB.prepare(`SELECT search_index.item AS id, search_index.page AS page,
    snippet(search_index,2,'','',' … ',28) AS snippet, library_index.source
    FROM search_index JOIN library_index ON library_index.item=search_index.item AND library_index.page=search_index.page
    JOIN records ON records.id=search_index.item AND records.kind='item'
    WHERE search_index MATCH ? AND COALESCE(json_extract(records.data,'$.deleted'),0)=0
    ORDER BY bm25(search_index) LIMIT 80`).bind(query).all();
  return json({results});
}

async function backup(env) {
  const id = crypto.randomUUID();
  const now = stamp();
  const lines = [];
  let cursor = '';
  while (true) {
    const {results} = await env.DB.prepare('SELECT * FROM records WHERE id>? ORDER BY id LIMIT 100').bind(cursor).all();
    lines.push(...results.map(row => JSON.stringify(row)));
    if (results.length < 100) break;
    cursor = results.at(-1).id;
  }
  const value = lines.join('\n');
  const saved = await env.FILES.put('backups/' + id,value,{httpMetadata:{contentType:'application/x-ndjson'}});
  await env.DB.prepare('INSERT INTO backups VALUES (?,?,?)').bind(id,now,saved.size).run();
  return json({id,created:now,size:saved.size});
}

async function purge(env, id) {
  if (!uuid.test(id)) throw fail('Item is invalid.',400);
  const record = decodeRecord(await env.DB.prepare("SELECT * FROM records WHERE id=? AND kind='item'").bind(id).first());
  if (!record?.data.deleted) throw fail('File is not in Recently Deleted.',409);
  const data=record.data;
  if(!data.purged) {
    if (data.type==='folder') {
      const children=await env.DB.prepare("SELECT id FROM records WHERE kind='item' AND json_extract(data,'$.folder')=? AND COALESCE(json_extract(data,'$.purged'),0)=0 LIMIT 1").bind(id).first();
      if(children) throw fail('Move files out of this folder before permanently deleting it.',409);
    }
    const tombstone=JSON.stringify({id,type:data.type,deleted:data.deleted,purged:true});
    const batch=[
      env.DB.prepare("UPDATE records SET data=?,rev=rev+1,changed=MAX(?,1+(SELECT MAX(changed) FROM records)) WHERE id=? AND rev=?").bind(tombstone,stamp(),id,record.rev),
    ];
    if(data.blob) batch.push(env.DB.prepare("INSERT OR IGNORE INTO deleted_blobs (key) SELECT ? WHERE EXISTS(SELECT 1 FROM records WHERE id=? AND json_extract(data,'$.purged')=1)").bind(data.blob,id));
    const updated=await env.DB.batch(batch);
    if(!updated[0].meta.changes)throw fail('This file changed. Sync and try again.',409);
  }
  const original=data.blob || (await env.DB.prepare("SELECT json_extract(data,'$.blob') AS blob FROM history WHERE id=? ORDER BY rev DESC LIMIT 1").bind(id).first())?.blob;
  if(original)await env.FILES.delete('files/'+original);
  await env.DB.batch([
    env.DB.prepare("UPDATE records SET data=json_object('item',?,'page',json_extract(data,'$.page'),'objects',json('[]'),'purged',1),rev=rev+1,changed=MAX(?,1+(SELECT MAX(changed) FROM records)) WHERE kind='annotation' AND json_extract(data,'$.item')=? AND COALESCE(json_extract(data,'$.purged'),0)=0").bind(id,stamp(),id),
    env.DB.prepare('DELETE FROM history WHERE id=? OR id LIKE ?').bind(id,'annotation:'+id+':%'),
    env.DB.prepare('DELETE FROM library_index WHERE item=?').bind(id),
    env.DB.prepare('DELETE FROM search_index WHERE item=?').bind(id),
  ]);
  return json({ok:true});
}

async function dataExport(env) {
  const {results}=await env.DB.prepare('SELECT key,size,type FROM objects WHERE key LIKE ? ORDER BY key').bind('files/%').all();
  return json({blobs:results.map(record=>({...record,id:record.key.slice(6)}))});
}

async function admin(request, env, url) {
  const path = url.pathname;
  if (path === '/api/owner/key' && request.method === 'PUT') {
    const {key} = await request.json();
    if (!keyFormat.test(key)) throw fail('Generate a valid access key.',400);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO accounts VALUES ('student',?) ON CONFLICT(role) DO UPDATE SET key_hash=excluded.key_hash").bind(await digest(key)),
      env.DB.prepare("DELETE FROM sessions WHERE role='student'"),
    ]);
    return json({ok:true});
  }
  if (path === '/api/owner/defaults' && request.method === 'PUT') {
    const {theme} = await request.json();
    if (!['light','dark','system'].includes(theme)) throw fail('Theme is invalid.',400);
    await env.DB.prepare("INSERT INTO records VALUES ('site','site',1,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,changed=excluded.changed,rev=records.rev+1").bind(JSON.stringify({theme}),stamp()).run();
    return json({ok:true});
  }
  if (path === '/api/owner/backup' && request.method === 'POST') return backup(env);
  if (path.startsWith('/api/owner/backup/') && request.method === 'GET') {
    const id = path.split('/').at(-1);
    if (!uuid.test(id)) throw fail('Backup not found.',404);
    const file = await env.FILES.get('backups/' + id);
    if (!file) throw fail('Backup not found.',404);
    return new Response(file.body,{headers:{'Content-Type':'application/x-ndjson','Content-Disposition':'attachment; filename="wijdan-backup.ndjson"'}});
  }
  if (path === '/api/owner/status' && request.method === 'GET') {
    const [items, site, backups] = await env.DB.batch([
      env.DB.prepare(`SELECT id,json_extract(data,'$.name') AS name,json_extract(data,'$.indexState') AS state, COALESCE(json_extract(data,'$.size'),0) AS size FROM records WHERE kind='item' AND COALESCE(json_extract(data,'$.deleted'),0)=0`),
      env.DB.prepare("SELECT data FROM records WHERE id='site'"),
      env.DB.prepare('SELECT * FROM backups ORDER BY created DESC LIMIT 40'),
    ]);
    return json({count:items.results.length,size:items.results.reduce((a,b)=>a+b.size,0), processing:items.results.filter(item=>['Failed','Failed Upload','OCR Required'].includes(item.state)), defaults:site.results[0] ? JSON.parse(site.results[0].data) : {theme:'light'}, backups:backups.results});
  }
  if (path === '/api/owner/retry' && request.method === 'POST') {
    const {id} = await request.json();
    if (!uuid.test(id)) throw fail('Item is invalid.',400);
    await env.DB.prepare("UPDATE records SET data=json_set(data,'$.indexState','Queued','$.indexCursor',0,'$.indexProgress',0,'$.indexNeedsOCR',0), rev=rev+1, changed=MAX(?,1+(SELECT MAX(changed) FROM records)) WHERE id=? AND kind='item'").bind(stamp(),id).run();
    return json({ok:true});
  }
  throw fail('Owner route not found.',404);
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (!path.startsWith('/api/')) {
    if (path === '/owner' || path === '/') return env.ASSETS.fetch(new Request(new URL('/index.html',url),request));
    return env.ASSETS.fetch(request);
  }
  checkMutation(request);
  if (path === '/api/login' && method === 'POST') return login(request,env);
  const session = await getSession(request,env);
  if (!session) throw fail('Sign in to continue.',401);
  if (path === '/api/session' && method === 'GET') {
    const site = await env.DB.prepare("SELECT data FROM records WHERE id='site'").first();
    return json({role:session.role, defaults:site ? JSON.parse(site.data) : {theme:'light'}});
  }
  if (path === '/api/logout' && method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE id=?').bind(session.id).run();
    return json({ok:true},200,{'Set-Cookie':sessionCookie(request,'',0)});
  }
  if (path.startsWith('/api/owner/')) {
    if (session.role !== 'owner') throw fail('Access denied.',403);
    return admin(request,env,url);
  }
  if (session.role !== 'student') throw fail('Access denied.',403);
  if (path === '/api/devices' && method === 'GET') {
    const {results} = await env.DB.prepare('SELECT id,device,created FROM sessions WHERE role=? AND expires>? ORDER BY created DESC').bind(session.role,stamp()).all();
    return json({devices:results.map(result=>({...result,current:result.id===session.id}))});
  }
  if (path.startsWith('/api/devices/') && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM sessions WHERE id=? AND role=? AND id!=?').bind(path.split('/').at(-1),session.role,session.id).run();
    return json({ok:true});
  }
  if (path === '/api/data' && method === 'GET') return dataExport(env);
  if (path === '/api/storage' && method === 'GET') {
    const {size}=await env.DB.prepare("SELECT COALESCE(SUM(size),0) AS size FROM objects").first();
    return json({size});
  }
  if (path.startsWith('/api/purge/') && method === 'POST') return purge(env,path.split('/').at(-1));
  if (path === '/api/changes' && method === 'GET') return changes(url,env);
  if (path.startsWith('/api/records/') && method === 'PUT') return saveRecord(request,env,path.split('/').at(-1));
  if (path.startsWith('/api/history/') && method === 'GET') {
    const {results} = await env.DB.prepare('SELECT rev,changed,data FROM history WHERE id=? ORDER BY rev DESC LIMIT 50').bind(path.split('/').at(-1)).all();
    return json({versions:results.map(decodeRecord)});
  }
  if (path.startsWith('/api/multipart/')) return multipart(request,env,path);
  if (path.startsWith('/api/blob/')) return blob(request,env,path.split('/').at(-1));
  if (path.startsWith('/api/index/') && method === 'PUT') return indexPage(request,env,path.split('/').at(-1));
  if (path.startsWith('/api/index/') && method === 'GET') {
    const [, , , id, page] = path.split('/');
    if(!uuid.test(id))throw fail('Item is invalid.',400);
    const found=await env.DB.prepare('SELECT anchors FROM library_index WHERE item=? AND page=?').bind(id,Number(page)).first();
    return json({anchors:found ? JSON.parse(found.anchors) : []});
  }
  if (path === '/api/search' && method === 'GET') return search(url,env);
  throw fail('Route not found.',404);
}

export default {
  async fetch(request,env) {
    let response;
    const bindings = {...env, FILES:env.FILES || new PrivateFiles(env.DB)};
    try { response = await route(request,bindings); }
    catch (error) {
      const status = error.status || (error instanceof SyntaxError ? 400 : 500);
      if (status >= 500) console.error(error.name, error.message);
      response = json({error:status === 500 ? 'Saving or loading failed. Try again.' : error.message},status);
    }
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options','nosniff');
    headers.set('Referrer-Policy','no-referrer');
    headers.set('X-Frame-Options','DENY');
    headers.set('X-Robots-Tag','noindex, noarchive');
    headers.set('Permissions-Policy','camera=(self),microphone=(),geolocation=()');
    headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'self' blob:; frame-ancestors 'none'; form-action 'self'");
    if (new URL(request.url).pathname.startsWith('/api/')) headers.set('Cache-Control','private, no-store');
    return new Response(response.body,{status:response.status,headers});
  },
};
