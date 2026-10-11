/* Mimi PWA service worker — app shell offline, APIs hamesha network se */
const CACHE='mimi-v5';
const SHELL=['/cute-ai/','/cute-ai/index.html','/cute-ai/manifest.json','/cute-ai/icons/icon.svg'];
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()).catch(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys()
    .then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  const u=new URL(e.request.url);
  const sameApp=u.origin===self.location.origin&&u.pathname.startsWith('/cute-ai/');
  const cdn=u.hostname==='cdn.jsdelivr.net';
  if(!sameApp&&!cdn) return; /* API calls hamesha network se */
  e.respondWith(
    caches.match(e.request).then(hit=>{
      const net=fetch(e.request).then(r=>{
        if(r&&(r.ok||r.type==='opaque')){ const cp=r.clone(); caches.open(CACHE).then(c=>c.put(e.request,cp)); }
        return r;
      }).catch(()=>hit);
      return hit||net;
    })
  );
});
