/* 서비스 워커 공용 코드. 각 앱 폴더의 sw.js 가 importScripts 로 불러온다.
 * 역할 1) 안드로이드 공유 시트에서 넘어온 이미지/텍스트(POST ./share)를 받아 캐시에 넣고 앱을 연다.
 * 역할 2) 정적 파일을 캐시해 오프라인에서도 앱이 뜨게 한다. */
var CACHE = 'ledger-static-v1';
var INBOX = 'ledger-share-inbox';

self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname.endsWith('/share')) {
    event.respondWith(handleShare(event));
    return;
  }
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request).then(function (res) {
      if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(event.request, copy); }); }
      return res;
    }).catch(function () { return caches.match(event.request); })
  );
});

async function handleShare(event) {
  var form = await event.request.formData();
  var inbox = await caches.open(INBOX);
  var file = form.get('image');
  var text = [form.get('title'), form.get('text'), form.get('url')].filter(Boolean).join('\n');
  var base = self.registration.scope;
  if (file && file.size) {
    await inbox.put(new URL('inbox-image', base), new Response(file, { headers: { 'Content-Type': file.type || 'image/png' } }));
  } else {
    await inbox.delete(new URL('inbox-image', base));
  }
  await inbox.put(new URL('inbox-text', base), new Response(text || '', { headers: { 'Content-Type': 'text/plain;charset=utf-8' } }));
  return Response.redirect(new URL('./?share=1', base).href, 303);
}
