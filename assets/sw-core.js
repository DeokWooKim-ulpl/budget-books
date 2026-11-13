/* 서비스 워커 공용 코드. 각 앱 폴더의 sw.js 가 importScripts 로 불러온다.
 * 역할 1) 안드로이드 공유 시트에서 넘어온 이미지/텍스트(POST ./share)를 받아 캐시에 넣고 앱을 연다.
 * 역할 2) 정적 파일을 캐시해 오프라인에서도 앱이 뜨게 한다. */
var CACHE = 'ledger-static-v2';   // 이름을 바꾸면 옛 캐시는 activate 때 지워진다 ('ledger-' 로 시작하는 것만)
var INBOX = 'ledger-share-inbox';

self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    // 캐시 저장소는 앱 폴더가 아니라 주소(github.io) 단위라 같은 주소의 다른 앱 것도 보인다. 가계부의 옛 캐시('ledger-…')만 지운다
    return Promise.all(keys.filter(function (k) { return k.indexOf('ledger-') === 0 && k !== CACHE && k !== INBOX; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname.endsWith('/share')) {
    event.respondWith(handleShare(event));
    return;
  }
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // cache:'no-cache' = 브라우저 HTTP 캐시를 믿지 않고 서버(GitHub Pages)에 바뀌었는지 묻는다(304면 공짜). 그래야 새 버전을 올린 즉시 폰에 반영된다. 오프라인이면 캐시 사본.
  // (navigate 요청은 init 을 붙여 다시 fetch 할 수 없어서 URL 로 새 Request 를 만든다)
  var fresh = new Request(event.request.url, { cache: 'no-cache', credentials: 'same-origin' });
  // 화면 주소(navigate)는 물음표 뒤(?share=1, ?setup=…)를 떼고 저장·조회한다. 어느 쪽이든 같은 index.html 이라, 오프라인에서 공유로 열 때(./?share=1)도 평소에 받아 둔 './' 사본이 맞는다
  var key = event.request.mode === 'navigate' ? url.origin + url.pathname : event.request;
  event.respondWith(
    fetch(fresh).then(function (res) {
      if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(key, copy); }); }
      return res;
    }).catch(function () { return caches.match(key); })
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
