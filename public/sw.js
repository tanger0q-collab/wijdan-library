const REVISION = 'BUILD_ID';
const CACHE = 'wijdan-shell-' + REVISION;
const VERSIONED = ['/study.css','/app.js','/store.js','/documents.js','/editor.js','/ui.js','/vendor/pdf.mjs','/vendor/pdf.worker.mjs'];
const STATIC = ['/assets/Alexandria.ttf','/assets/ElMessiri.ttf','/vendor/pdf-lib.js'];
const SHELL = ['/',...VERSIONED.map(path=>path+'?v='+REVISION),...STATIC];

self.addEventListener('install', event => event.waitUntil(
  caches.open(CACHE).then(cache=>cache.addAll(SHELL.map(path=>new Request(path,{cache:'reload'})))).then(()=>self.skipWaiting()),
));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys=>Promise.all(
  keys.filter(key=>key.startsWith('wijdan-shell-')&&key!==CACHE).map(key=>caches.delete(key)),
)).then(()=>self.clients.claim())));
self.addEventListener('fetch', event => {
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==location.origin||url.pathname.startsWith('/api/')||url.pathname==='/owner')return;
  if(event.request.mode==='navigate'){
    event.respondWith(fetch(event.request,{cache:'no-cache'}).catch(()=>caches.open(CACHE).then(cache=>cache.match('/'))));
    return;
  }
  if(!VERSIONED.includes(url.pathname)&&!STATIC.includes(url.pathname)&&!url.pathname.startsWith('/vendor/'))return;
  event.respondWith(caches.open(CACHE).then(async cache=>{
    const cached=await cache.match(event.request);
    if(cached)return cached;
    const response=await fetch(event.request);
    if(response.ok)event.waitUntil(cache.put(event.request,response.clone()));
    return response;
  }));
});
