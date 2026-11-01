/* 가계부 PWA — 공동/개인 공용. 설정은 ./config.js (window.LEDGER_CONFIG) 와 서버 config 액션에서 온다. */
(function () {
  'use strict';
  var CFG = window.LEDGER_CONFIG || {};
  // 같은 도메인에 공동/개인 앱이 함께 올라가므로 저장 키를 경로별로 나눈다
  var NS = 'ledger:' + location.pathname.replace(/[^/]*$/, '') + ':';
  var LS_KEY = NS + 'settings';
  var QUEUE_KEY = NS + 'queue';
  var TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

  var $app = document.getElementById('app');
  var settings = loadSettings();
  var state = {
    config: null, cycle: null, rows: [], summary: null, dict: {}, merchants: [],
    loading: false, error: null, prefill: null, toast: null, ocr: null, view: 'home', editId: null
  };

  // ------------------------------------------------------------ 설정 저장
  function loadSettings() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { s = {}; }
    if (!s.endpoint && CFG.endpoint) s.endpoint = CFG.endpoint;
    // config.js 의 주소가 바뀌면(시트를 옮겼을 때) 직접 입력한 주소가 아닌 한 새 주소를 따라간다.
    // cfgEndpoint 는 "마지막으로 config.js 에서 받아 온 주소". 없으면 config.js 에서 온 것으로 본다.
    if (CFG.endpoint && s.endpoint !== CFG.endpoint && (s.cfgEndpoint === undefined || s.endpoint === s.cfgEndpoint)) s.endpoint = CFG.endpoint;
    if (CFG.endpoint) s.cfgEndpoint = CFG.endpoint;
    if (!s.me && CFG.defaultUser) s.me = CFG.defaultUser;
    if (s.local === undefined && s.endpoint) s.local = false;   // local 이 undefined 이면 첫 설정 화면을 보여준다
    return s;
  }
  function saveSettings() { try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) { } }

  // 설치 링크: ?setup=<base64url JSON {endpoint, pin, me}> 로 열면 설정이 자동 복원된다.
  // 휴대폰을 바꾸거나 앱을 다시 깔아도 이 링크 하나만 열면 끝.
  function b64e(s) { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function b64d(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return decodeURIComponent(escape(atob(s))); }
  function applySetupLink() {
    var m = /[?&]setup=([^&]+)/.exec(location.search);
    if (!m) return false;
    try {
      var o = JSON.parse(b64d(m[1]));
      if (o.endpoint) settings.endpoint = o.endpoint;
      if (o.pin != null) settings.pin = String(o.pin);
      if (o.me) settings.me = o.me;
      settings.local = !settings.endpoint;
      saveSettings();
    } catch (e) { }
    history.replaceState(null, '', location.pathname + location.hash);
    return true;
  }
  function makeSetupLink(name) {
    var base = location.origin + location.pathname;
    return base + '?setup=' + b64e(JSON.stringify({ endpoint: settings.endpoint, pin: settings.pin || '', me: name || settings.me || '' }));
  }

  // ------------------------------------------------------------ API (원격 Apps Script / 기기 내 체험 모드)
  var api = {
    call: function (action, payload) {
      payload = payload || {};
      if (settings.local || !settings.endpoint) return LocalApi.call(action, payload);
      var body = Object.assign({ action: action, pin: settings.pin || '' }, payload);
      return fetch(settings.endpoint, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json(); })
        .then(function (j) { if (!j.ok) throw new Error(j.error === 'pin' ? 'PIN이 틀렸습니다' : (j.error || '오류')); return j; });
    }
  };

  // 체험 모드: 서버 없이 기기 localStorage 에만 저장. 서버와 같은 응답 모양을 돌려준다.
  var LocalApi = (function () {
    var KEY = NS + 'local.rows';
    function rows() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } }
    function save(r) { localStorage.setItem(KEY, JSON.stringify(r)); }
    function cfg() {
      var type = CFG.localLedgerType || 'shared';
      return { ledgerType: type, cycleStartDay: 25, members: type === 'shared' ? ['덕우', '지민'] : ['덕우'],
        categories: ['식재료', '외식', '생활비', '월세', '관리비', '전기료', '가스료', '수도세', '교통', '의료', '기타'],
        budgetTotal: type === 'personal' ? 600000 : null, budgets: {}, currentCycle: LedgerParser.cycleMonth(nowIso(), 25), sheetUrl: '' };
    }
    function dict() { var d = {}; rows().forEach(function (o) { if (o['카테고리'] && o['가맹점']) d[LedgerParser.normalizeMerchant(o['가맹점'])] = o['카테고리']; }); return d; }
    var RULES = [['마트', '식재료'], ['카페', '외식'], ['커피', '외식'], ['스타벅스', '외식'], ['식당', '외식'], ['약국', '의료'], ['택시', '교통']];
    function normalize(tx, cur) {
      var c = cfg(); var o = Object.assign({}, cur || {}, tx);
      if (!o['일시']) o['일시'] = nowIso();
      o['일시'] = String(o['일시']).substring(0, 19);
      o['사이클'] = LedgerParser.cycleMonth(o['일시'], 25);
      o['유형'] = o['유형'] || '지출'; o['금액'] = Math.round(Number(String(o['금액']).replace(/[^\d.-]/g, '')) || 0);
      o['가맹점'] = String(o['가맹점'] || '').trim(); o['항목'] = String(o['항목'] || '').trim();
      o['결제인'] = o['결제인'] || c.members[0];
      o['정산'] = c.ledgerType === 'shared' ? (o['정산'] === 'O' ? 'O' : 'X') : '';
      o['계획'] = c.ledgerType === 'personal' ? (o['계획'] === 'Y' ? 'Y' : 'N') : '';
      if (!o['카테고리']) { var g = LedgerParser.guessCategory(o['가맹점'], dict(), RULES); o['카테고리'] = g ? g.category : ''; }
      o['출처'] = o['출처'] || '수동'; o['상태'] = o['상태'] || '확인'; o['원문'] = o['원문'] || '';
      return o;
    }
    function summary(cycle) {
      var c = cfg(); var all = rows(); var rs = all.filter(function (o) { return o['사이클'] === cycle && o['상태'] !== '취소'; });
      var out = { cycle: cycle, expense: 0, income: 0, byCategory: {}, byPayer: {}, unsettledByPayer: {}, planned: 0, unplanned: 0, count: rs.length, unconfirmed: 0, budgets: {} };
      rs.forEach(function (o) {
        if (o['상태'] === '미확인') out.unconfirmed++;
        if (o['유형'] === '수입') { out.income += o['금액']; return; }
        out.expense += o['금액']; var k = o['카테고리'] || '미분류'; out.byCategory[k] = (out.byCategory[k] || 0) + o['금액'];
        out.byPayer[o['결제인']] = (out.byPayer[o['결제인']] || 0) + o['금액'];
        if (c.ledgerType === 'shared' && o['정산'] === 'X') out.unsettledByPayer[o['결제인']] = (out.unsettledByPayer[o['결제인']] || 0) + o['금액'];
        if (c.ledgerType === 'personal') { if (o['계획'] === 'Y') out.planned += o['금액']; else out.unplanned += o['금액']; }
      });
      out.unconfirmedTotal = all.filter(function (o) { return o['상태'] === '미확인'; }).length;
      if (c.ledgerType === 'shared') {
        var un = {}; all.forEach(function (o) { if (o['유형'] === '지출' && o['정산'] === 'X' && o['상태'] !== '취소') un[o['결제인']] = (un[o['결제인']] || 0) + o['금액']; });
        out.unsettledAllByPayer = un;
        var a = un[c.members[0]] || 0, b = un[c.members[1]] || 0, d = (a - b) / 2;
        out.settlementAll = d === 0 ? null : { from: d > 0 ? c.members[1] : c.members[0], to: d > 0 ? c.members[0] : c.members[1], amount: Math.round(Math.abs(d)) };
      }
      if (c.budgetTotal) out.remaining = c.budgetTotal - out.expense;
      return out;
    }
    return {
      call: function (action, p) {
        return new Promise(function (resolve, reject) {
          try {
            var all = rows();
            switch (action) {
              case 'config': return resolve({ ok: true, config: cfg() });
              case 'bootstrap': { var c0 = cfg(); var cy0 = p.cycle || c0.currentCycle; var rs0 = all.filter(function (o) { return cy0 === 'all' || o['사이클'] === cy0 || o['상태'] === '미확인'; }); rs0.sort(function (a, b) { return a['일시'] < b['일시'] ? 1 : -1; }); var seen0 = {}, m0 = []; all.slice().sort(function (a, b) { return a['일시'] < b['일시'] ? 1 : -1; }).forEach(function (r) { if (r['가맹점'] && !seen0[r['가맹점']]) { seen0[r['가맹점']] = 1; m0.push({ name: r['가맹점'], category: r['카테고리'] }); } }); return resolve({ ok: true, config: c0, cycle: cy0, rows: rs0, summary: summary(cy0), dict: dict(), merchants: m0.slice(0, 60) }); }
              case 'list': { var cy = p.cycle || cfg().currentCycle; var rs = all.filter(function (o) { return cy === 'all' || o['사이클'] === cy || o['상태'] === '미확인'; }); rs.sort(function (a, b) { return a['일시'] < b['일시'] ? 1 : -1; }); return resolve({ ok: true, rows: rs, cycle: cy }); }
              case 'add': { var o = normalize(p.tx); o.id = Math.random().toString(36).slice(2) + Date.now().toString(36); o['등록'] = o['수정'] = nowIso(); all.push(o); save(all); return resolve({ ok: true, row: o }); }
              case 'update': { var i = all.findIndex(function (r) { return r.id === p.id; }); if (i < 0) throw new Error('not found'); var u = normalize(p.tx, all[i]); u['수정'] = nowIso(); all[i] = u; save(all); return resolve({ ok: true, row: u }); }
              case 'confirm': { var j = all.findIndex(function (r) { return r.id === p.id; }); if (j >= 0) { all[j]['상태'] = '확인'; save(all); } return resolve({ ok: true, row: all[j] }); }
              case 'delete': { save(all.filter(function (r) { return r.id !== p.id; })); return resolve({ ok: true, deleted: true }); }
              case 'settle': { var n = 0; all.forEach(function (r) { if (r['유형'] === '지출' && r['정산'] === 'X') { r['정산'] = 'O'; n++; } }); save(all); return resolve({ ok: true, settled: n }); }
              case 'summary': return resolve({ ok: true, summary: summary(p.cycle || cfg().currentCycle) });
              case 'dict': return resolve({ ok: true, dict: dict() });
              case 'merchants': { var seen = {}, m = []; all.slice().sort(function (a, b) { return a['일시'] < b['일시'] ? 1 : -1; }).forEach(function (r) { if (r['가맹점'] && !seen[r['가맹점']]) { seen[r['가맹점']] = 1; m.push({ name: r['가맹점'], category: r['카테고리'] }); } }); return resolve({ ok: true, merchants: m.slice(0, 60) }); }
              case 'ingest': { var parsed = p.source === '스크린샷' ? LedgerParser.parseScreenshot(p.text) : LedgerParser.parseNotification(p.text); if (!parsed.amount) throw new Error('amount not found'); var g = LedgerParser.guessCategory(parsed.merchant, dict(), RULES); var tx = normalize({ '일시': parsed.date, '유형': parsed.type, '금액': parsed.amount, '가맹점': parsed.merchant, '카테고리': g ? g.category : '', '결제인': p.payer || p.device, '출처': p.source || '알림', '상태': '미확인', '원문': p.text }); tx.id = Math.random().toString(36).slice(2); tx['등록'] = tx['수정'] = nowIso(); all.push(tx); save(all); return resolve({ ok: true, row: tx }); }
              default: throw new Error('unknown action ' + action);
            }
          } catch (e) { reject(e); }
        });
      }
    };
  })();

  // ------------------------------------------------------------ 유틸
  function nowIso() { var d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':00'; }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function won(n) { n = Number(n) || 0; return (n < 0 ? '-' : '') + Math.abs(n).toLocaleString('ko-KR') + '원'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function cycleLabel(c) { if (!c) return ''; var r = LedgerParser.cycleRange(c, state.config ? state.config.cycleStartDay : 25); var e = new Date(r.end.getTime() - 86400000); return (r.start.getMonth() + 1) + '/' + r.start.getDate() + ' ~ ' + (e.getMonth() + 1) + '/' + e.getDate(); }
  function shiftCycle(c, d) { var p = c.split('-'); var dt = new Date(+p[0], +p[1] - 1 + d, 1); return dt.getFullYear() + '-' + p2(dt.getMonth() + 1); }
  function dayKey(iso) { return String(iso).substring(0, 10); }
  function dayLabel(k) { var d = new Date(k + 'T00:00:00'); var w = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()]; return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + w + ')'; }
  function isShared() { return state.config && state.config.ledgerType === 'shared'; }
  function me() { return settings.me || (state.config && state.config.members[0]) || ''; }
  function toast(msg, action, onAction, ms) {
    if (state.toast && state.toast.timer) clearTimeout(state.toast.timer);
    state.toast = { msg: msg, action: action, onAction: onAction };
    state.toast.timer = setTimeout(function () { state.toast = null; renderToast(); }, ms || 4000);
    renderToast();
  }

  // ------------------------------------------------------------ 데이터 로드
  function loadAll() {
    state.loading = true; state.error = null; render();
    // 첫 화면에 필요한 것을 요청 한 번(bootstrap)으로 받는다
    return api.call('bootstrap', { cycle: state.cycle || '' }).then(function (j) {
      state.config = j.config;
      document.documentElement.setAttribute('data-ledger', j.config.ledgerType);
      state.cycle = j.cycle || state.cycle || j.config.currentCycle;
      state.rows = j.rows; state.summary = j.summary; state.dict = j.dict; state.merchants = j.merchants;
      state.loading = false; render();
      flushQueue();
    }).catch(function (e) { state.loading = false; state.error = e.message; render(); });
  }
  function refresh() {
    return api.call('bootstrap', { cycle: state.cycle }).then(function (j) {
      state.config = j.config; state.rows = j.rows; state.summary = j.summary; state.dict = j.dict; state.merchants = j.merchants; render();
    }).catch(function (e) { toast('새로고침 실패: ' + e.message); });
  }

  // 오프라인 큐: 저장 실패한 add 를 보관하고 다음 기회에 다시 보낸다
  function queue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch (e) { return []; } }
  function saveQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
  function flushQueue() {
    var q = queue(); if (!q.length) return;
    var next = q.shift();
    api.call('add', { tx: next }).then(function () { saveQueue(q); toast('대기 중이던 거래를 저장했습니다 (' + q.length + '건 남음)'); return flushQueue(); }).catch(function () { });
  }
  window.addEventListener('online', flushQueue);

  // 체험 모드 데이터를 서버(시트)로 한 건씩 올린다. 끝나면 기기 쪽 사본은 비운다.
  function uploadLocalRows(rows) {
    var i = 0, fail = 0;
    function next() {
      if (i >= rows.length) { if (!fail) localStorage.removeItem(NS + 'local.rows'); toast('시트로 ' + (rows.length - fail) + '건 올렸습니다' + (fail ? ' (' + fail + '건 실패, 기기 사본 유지)' : '')); return Promise.resolve(); }
      var r = rows[i++]; var tx = {}; Object.keys(r).forEach(function (k) { if (k !== 'id' && k !== '등록' && k !== '수정' && k !== '사이클') tx[k] = r[k]; });
      return api.call('add', { tx: tx }).catch(function () { fail++; }).then(next);
    }
    toast('시트로 올리는 중…', null, null, 60000);
    return next();
  }

  // ------------------------------------------------------------ 라우팅
  function route() {
    var h = (location.hash || '#home').replace('#', '');
    var parts = h.split('/');
    state.view = parts[0] || 'home';
    state.editId = parts[0] === 'edit' ? parts[1] : null;
    render();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  function go(v) { location.hash = '#' + v; }

  // ------------------------------------------------------------ 렌더
  function render() {
    var html = '';
    // 주소가 config.js 에 미리 들어 있어도 PIN 을 넣기 전까지는 처음 설정 화면을 보여준다
    if (settings.local === undefined || (!settings.local && (!settings.endpoint || !settings.pin))) { $app.innerHTML = renderSetup(); bind(); return; }
    html += renderHeader();
    if (state.error) html += '<div class="notice">' + esc(state.error) + ' <button class="btn small" data-act="retry">다시 시도</button> <button class="btn small" data-act="goto" data-to="more">설정</button></div>';
    if (state.loading && !state.config) html += '<div class="empty">불러오는 중…</div>';
    else if (state.config || state.view === 'more') {   // 연결이 안 돼도 설정 화면은 열려야 한다
      switch (state.view) {
        case 'add': html += renderForm(null); break;
        case 'edit': html += renderForm(state.rows.filter(function (r) { return r.id === state.editId; })[0]); break;
        case 'list': html += renderList(); break;
        case 'more': html += renderMore(); break;
        default: html += renderHome();
      }
    }
    html += renderNav();
    $app.innerHTML = html;
    renderToast();
    bind();
  }

  function renderHeader() {
    var title = CFG.name || (isShared() ? '공동 장부' : '내 예산');
    var c = state.cycle || '';
    var showCycle = state.view === 'home' || state.view === 'list';
    var q = queue().length;
    return '<header class="top"><h1>' + esc(title) + (settings.local ? ' <span class="sub">(체험)</span>' : '') + (q ? ' <span class="badge" title="연결되면 자동 전송">' + q + '건 대기</span>' : '') + '</h1>' +
      (showCycle ? '<div class="cycle"><button data-act="cycle" data-d="-1" aria-label="이전 달">‹</button><span>' + esc(c) + '<br><small class="muted" style="font-weight:400">' + esc(cycleLabel(c)) + '</small></span><button data-act="cycle" data-d="1" aria-label="다음 달">›</button></div>' : '') +
      '</header>';
  }

  function renderNav() {
    var un = state.summary ? state.summary.unconfirmedTotal : 0;
    function a(v, ico, label, badge) { return '<a href="#' + v + '" class="' + (state.view === v || (v === 'add' && state.view === 'edit') ? 'on' : '') + '"><span class="ico">' + ico + '</span>' + label + (badge ? '<span class="badge">' + badge + '</span>' : '') + '</a>'; }
    return '<nav class="bottom">' + a('home', '⌂', '홈', un) + a('add', '＋', '입력') + a('list', '☰', '목록') + a('more', '⋯', '더보기') + '</nav>';
  }

  function renderHome() {
    var s = state.summary; if (!s) return '';
    var h = '';
    var pending = state.rows.filter(function (r) { return r['상태'] === '미확인'; });
    if (pending.length) {
      h += '<div class="card"><h2>확인이 필요한 자동 수집 ' + pending.length + '건</h2>' + pending.map(txRow).join('') + '</div>';
    }
    h += '<div class="card"><h2>이번 사이클 지출</h2><div class="big">' + won(s.expense) + '</div>';
    if (isShared()) {
      var st = s.settlementAll;
      h += '<div class="sub" style="margin-top:6px">' + Object.keys(s.byPayer).map(function (p) { return esc(p) + ' ' + won(s.byPayer[p]); }).join(' · ') + '</div>';
      h += '<div class="row" style="margin-top:14px"><div>' + (st ? '<b>' + esc(st.from) + ' → ' + esc(st.to) + ' ' + won(st.amount) + '</b><div class="sub">미정산 전체 기준, 반씩 부담</div>' : '<span class="ok">정산할 금액이 없습니다</span>') + '</div>' +
        (st ? '<button class="btn small primary" data-act="settle">정산 완료</button>' : '') + '</div>';
    } else {
      if (s.remaining != null) {
        var bt = state.config.budgetTotal; var pct = Math.min(100, Math.round(s.expense / bt * 100));
        h += '<div class="sub" style="margin-top:6px">예산 ' + won(bt) + ' 중 <b class="' + (s.remaining < 0 ? 'danger' : 'ok') + '">' + (s.remaining < 0 ? '초과 ' : '남음 ') + won(Math.abs(s.remaining)) + '</b></div><div class="bar"><i class="' + (s.remaining < 0 ? 'over' : '') + '" style="width:' + pct + '%"></i></div>';
      }
      h += '<div class="grid2" style="margin-top:14px"><div><div class="sub">계획</div><b>' + won(s.planned) + '</b></div><div><div class="sub">비계획</div><b>' + won(s.unplanned) + '</b></div></div>';
    }
    if (s.income) h += '<div class="sub" style="margin-top:10px">수입 <b class="ok">' + won(s.income) + '</b></div>';
    h += '</div>';
    var cats = Object.keys(s.byCategory).sort(function (a, b) { return s.byCategory[b] - s.byCategory[a]; });
    var max = cats.length ? s.byCategory[cats[0]] : 1;
    h += '<div class="card catlist"><h2>카테고리</h2>' + (cats.length ? cats.map(function (c) {
      var b = s.budgets && s.budgets[c]; var v = s.byCategory[c];
      return '<div><div class="row"><span>' + esc(c) + '</span><span><b>' + won(v) + '</b>' + (b ? ' <span class="sub">/ ' + won(b) + '</span>' : '') + '</span></div><div class="bar"><i class="' + (b && v > b ? 'over' : '') + '" style="width:' + Math.round(v / (b || max) * 100) + '%"></i></div></div>';
    }).join('') : '<div class="empty">이 사이클에 거래가 없습니다</div>') + '</div>';
    h += '<button class="btn primary block" data-act="goto" data-to="add">＋ 거래 입력</button>';
    return h;
  }

  function txRow(r) {
    var cls = 'tx' + (r['상태'] === '미확인' ? ' unconfirmed' : '') + (r['상태'] === '취소' ? ' cancelled' : '');
    var meta = [String(r['일시']).substring(11, 16), r['항목'], isShared() ? r['결제인'] + (r['정산'] === 'X' ? ' · 미정산' : '') : (r['계획'] === 'Y' ? '계획' : ''), r['출처'] !== '수동' && r['출처'] !== '이관' ? r['출처'] : ''].filter(Boolean).join(' · ');
    return '<div class="' + cls + '" data-act="edit" data-id="' + esc(r.id) + '"><span class="cat ' + (r['카테고리'] ? '' : 'none') + '">' + esc(r['카테고리'] || '미분류') + '</span><div class="main"><div class="name">' + esc(r['가맹점'] || '(가맹점 없음)') + '</div><div class="meta">' + esc(meta) + '</div></div><span class="amt ' + (r['유형'] === '수입' ? 'income' : '') + '">' + (r['유형'] === '수입' ? '+' : '') + won(r['금액']) + '</span></div>';
  }

  function renderList() {
    var rows = state.rows.filter(function (r) { return r['사이클'] === state.cycle; });
    if (!rows.length) return '<div class="empty">이 사이클에 거래가 없습니다</div>';
    var h = '<div class="txlist">', last = null;
    rows.forEach(function (r) { var k = dayKey(r['일시']); if (k !== last) { h += '<div class="day">' + dayLabel(k) + '</div>'; last = k; } h += txRow(r); });
    return h + '</div>';
  }

  function renderForm(row) {
    var pf = state.prefill; var edit = !!row;
    var v = Object.assign({ '일시': nowIso(), '유형': '지출', '금액': '', '가맹점': '', '카테고리': '', '항목': '', '결제인': me(), '정산': 'X', '계획': 'N', '출처': '수동', '원문': '' }, row || {}, (!edit && pf) ? pf.tx : {});
    var cats = state.config.categories.slice(); if (v['카테고리'] && cats.indexOf(v['카테고리']) < 0) cats.push(v['카테고리']);
    var h = '<form id="txform" class="card" data-id="' + esc(row ? row.id : '') + '">';
    if (!edit && pf) h += '<div class="notice ' + (pf.tx['금액'] ? 'info' : '') + '">' + esc(pf.note) + (pf.raw ? '<details class="raw"><summary>읽은 원문</summary><pre>' + esc(pf.raw) + '</pre></details>' : '') + '</div>';
    if (edit && row['상태'] === '미확인') h += '<div class="notice">자동 수집된 거래입니다. 내용을 확인하고 저장하면 확인 처리됩니다.' + (row['원문'] ? '<details class="raw"><summary>원문</summary><pre>' + esc(row['원문']) + '</pre></details>' : '') + '</div>';
    h += '<div class="row"><div class="seg" data-name="유형"><button type="button" class="' + (v['유형'] === '지출' ? 'on' : '') + '" data-v="지출">지출</button><button type="button" class="' + (v['유형'] === '수입' ? 'on' : '') + '" data-v="수입">수입</button></div>';
    if (isShared()) h += '<div class="seg" data-name="결제인">' + state.config.members.map(function (m) { return '<button type="button" class="' + (v['결제인'] === m ? 'on' : '') + '" data-v="' + esc(m) + '">' + esc(m) + '</button>'; }).join('') + '</div>';
    else h += '<div class="seg" data-name="계획"><button type="button" class="' + (v['계획'] === 'Y' ? 'on' : '') + '" data-v="Y">계획</button><button type="button" class="' + (v['계획'] !== 'Y' ? 'on' : '') + '" data-v="N">비계획</button></div>';
    h += '</div>';
    h += '<div class="field"><label>금액</label><input class="amount-input" name="금액" type="text" inputmode="numeric" placeholder="0" value="' + esc(v['금액'] ? Number(v['금액']).toLocaleString('ko-KR') : '') + '" autocomplete="off"></div>';
    h += '<div class="field"><label>가맹점</label><input name="가맹점" type="text" list="merchants" value="' + esc(v['가맹점']) + '" placeholder="예: 농수축산물마트" autocomplete="off"><datalist id="merchants">' + state.merchants.map(function (m) { return '<option value="' + esc(m.name) + '">'; }).join('') + '</datalist></div>';
    h += '<div class="field"><label>카테고리 <span id="cat-hint" class="muted"></span></label><div class="chips" data-name="카테고리">' + cats.map(function (c) { return '<button type="button" class="chip ' + (v['카테고리'] === c ? 'on' : '') + '" data-v="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') + '<button type="button" class="chip" data-act="newcat">＋ 새 카테고리</button></div><input type="hidden" name="카테고리" value="' + esc(v['카테고리']) + '"></div>';
    h += '<div class="field"><label>항목 / 메모</label><input name="항목" type="text" value="' + esc(v['항목']) + '" placeholder="예: 고기, 자동차세"></div>';
    h += '<div class="field"><label>일시</label><input name="일시" type="datetime-local" value="' + esc(String(v['일시']).substring(0, 16)) + '"></div>';
    if (isShared() && edit) h += '<div class="field"><label>정산</label><div class="seg" data-name="정산"><button type="button" class="' + (v['정산'] === 'X' ? 'on' : '') + '" data-v="X">미정산</button><button type="button" class="' + (v['정산'] === 'O' ? 'on' : '') + '" data-v="O">정산됨</button></div></div>';
    h += '<input type="hidden" name="유형" value="' + esc(v['유형']) + '"><input type="hidden" name="결제인" value="' + esc(v['결제인']) + '"><input type="hidden" name="계획" value="' + esc(v['계획']) + '"><input type="hidden" name="정산" value="' + esc(v['정산']) + '"><input type="hidden" name="출처" value="' + esc(v['출처']) + '"><input type="hidden" name="원문" value="' + esc(v['원문']) + '">';
    h += '<div class="row" style="margin-top:16px;gap:8px">' + (edit ? '<button type="button" class="btn danger" data-act="delete" data-id="' + esc(row.id) + '">삭제</button>' : '<button type="button" class="btn" data-act="goto" data-to="home">취소</button>') + '<button type="submit" class="btn primary" style="flex:1">' + (edit ? '수정 저장' : '저장') + '</button></div>';
    h += '</form>';
    if (!edit) h += '<div class="card"><h2>스크린샷으로 입력</h2><p class="sub" style="margin:0 0 10px">토스 결제 화면을 캡처해서 이 앱으로 <b>공유</b>하면 자동으로 이 폼이 채워집니다. PC나 수동으로는 아래에서 이미지를 고르세요.</p><input type="file" id="ocrfile" accept="image/*" class="hidden"><button type="button" class="btn block" data-act="pickimage">이미지 선택해서 읽기</button>' + (state.ocr ? '<div class="sub" style="margin-top:8px">' + esc(state.ocr.status) + '</div><div class="progress"><i style="width:' + Math.round((state.ocr.progress || 0) * 100) + '%"></i></div>' : '') + '</div>';
    return h;
  }

  function renderMore() {
    var c = state.config;
    var h = '<div class="card"><h2>연결</h2>';
    h += '<div class="field"><label>Apps Script 웹앱 URL</label><input id="s-endpoint" type="url" value="' + esc(settings.endpoint || '') + '" placeholder="https://script.google.com/macros/s/…/exec"></div>';
    h += '<div class="field"><label>PIN</label><input id="s-pin" type="password" value="' + esc(settings.pin || '') + '"></div>';
    h += '<div class="field"><label>내 이름 (자동 수집·입력 시 결제인)</label><input id="s-me" type="text" value="' + esc(settings.me || '') + '" list="members"><datalist id="members">' + (c ? c.members.map(function (m) { return '<option value="' + esc(m) + '">'; }).join('') : '') + '</datalist></div>';
    h += '<div class="row"><label class="sub"><input type="checkbox" id="s-local" ' + (settings.local ? 'checked' : '') + '> 체험 모드 (서버 없이 이 기기에만 저장)</label></div>';
    h += '<button class="btn primary block" style="margin-top:12px" data-act="savesettings">저장하고 다시 연결</button></div>';
    h += '<div class="card"><h2>재설치·기기 교체 대비</h2><p class="sub" style="margin:0 0 10px">거래 기록은 휴대폰이 아니라 구글 시트(드라이브)에만 저장되므로 앱을 지워도 남습니다. 이 기기 설정(서버 주소·PIN·이름)은 아래 <b>설치 링크</b> 하나로 복원됩니다. 링크를 비밀번호 관리자나 나에게 보내는 메시지에 보관해 두세요. PIN 이 들어 있으니 공개하지 마세요.</p>' +
      (settings.endpoint ? '<div class="field"><label>이름 (링크를 만들 사람)</label><input id="s-linkname" type="text" value="' + esc(settings.me || '') + '" list="members"></div><button class="btn block" data-act="copylink">설치 링크 복사</button><div id="linkout" class="sub" style="margin-top:8px;word-break:break-all"></div>' : '<div class="sub">서버 주소를 먼저 연결하면 링크를 만들 수 있습니다.</div>') + '</div>';
    if (settings.local) {
      var n = 0; try { n = JSON.parse(localStorage.getItem(NS + 'local.rows') || '[]').length; } catch (e) { }
      if (n) h += '<div class="notice">체험 모드의 거래 ' + n + '건은 이 기기에만 있습니다. 위에서 서버 주소를 넣고 체험 모드를 끄면 시트로 올릴지 묻습니다.</div>';
    }
    h += '<div class="card"><h2>장부</h2><div class="sub">유형: ' + (c ? (c.ledgerType === 'shared' ? '공동 (' + c.members.join(', ') + ')' : '개인') : '-') + ' · 사이클 시작일: ' + (c ? c.cycleStartDay : '-') + '일</div>' + (c && c.sheetUrl ? '<p><a href="' + esc(c.sheetUrl) + '" target="_blank" rel="noopener">구글 시트에서 열기 (PC 수정)</a></p>' : '') + '<p class="sub">카테고리, 예산, 멤버는 시트의 <code>설정</code> 탭에서 바꿉니다.</p></div>';
    h += '<div class="card"><h2>알림 문구 테스트</h2><p class="sub" style="margin:0 0 8px">MacroDroid 가 보내는 알림 문구가 어떻게 읽히는지 확인합니다.</p><div class="field"><textarea id="ntest" rows="2" placeholder="[토스] 스타벅스 4,500원 결제 완료"></textarea></div><button class="btn block" data-act="ntest">파싱해 보기</button><div id="ntest-out" class="sub" style="margin-top:8px"></div></div>';
    h += '<div class="card"><h2>자동 수집 설정 요약</h2><p class="sub">안드로이드 MacroDroid 에서 "알림 수신(토스)" 트리거 → "HTTP 요청(POST)" 액션으로 아래 JSON 을 웹앱 URL 로 보냅니다. 자세한 절차는 README 참고.</p><pre style="white-space:pre-wrap;font-size:12px;background:var(--bg);padding:10px;border-radius:10px">' + esc(JSON.stringify({ action: 'ingest', pin: '(PIN)', device: me() || '(이름)', source: '알림', text: '[notification_title] [notification_text]' }, null, 1)) + '</pre></div>';
    return h;
  }

  function renderSetup() {
    var preset = !!(CFG.endpoint && settings.endpoint === CFG.endpoint);   // 주소가 config.js 에 들어 있으면 URL 칸은 숨긴다
    var h = '<header class="top"><h1>' + esc(CFG.name || '가계부') + '</h1></header><div class="card"><h2>처음 설정</h2>';
    if (preset) {
      h += '<p class="sub">시트 설정 탭에 적어 둔 PIN 과 내 이름을 넣으면 바로 연결됩니다.</p>' +
        '<input id="s-endpoint" type="hidden" value="' + esc(settings.endpoint) + '">';
    } else {
      h += '<p class="sub">시트에 붙인 Apps Script 웹앱 URL 과 PIN 을 넣으세요. 아직 없으면 체험 모드로 먼저 써볼 수 있습니다.</p>' +
        '<div class="field"><label>Apps Script 웹앱 URL</label><input id="s-endpoint" type="url" value="' + esc(settings.endpoint || '') + '" placeholder="https://script.google.com/macros/s/…/exec"></div>';
    }
    h += '<div class="field"><label>PIN</label><input id="s-pin" type="password" inputmode="numeric" autocomplete="off"></div>' +
      '<div class="field"><label>내 이름</label><input id="s-me" type="text" value="' + esc(settings.me || '') + '" placeholder="덕우"></div>' +
      '<button class="btn primary block" data-act="savesettings">연결</button>';
    if (!preset) h += '<button class="btn block" style="margin-top:8px" data-act="trylocal">체험 모드로 시작</button>';
    h += (preset ? '<p class="sub" style="margin-top:12px">다른 시트에 연결하려면 더보기 → 연결 설정에서 주소를 바꿀 수 있습니다.</p>' : '') + '</div>';
    return h;
  }

  function renderToast() {
    var old = document.querySelector('.toast'); if (old) old.remove();
    if (!state.toast) return;
    var d = document.createElement('div'); d.className = 'toast';
    d.innerHTML = '<span>' + esc(state.toast.msg) + '</span>' + (state.toast.action ? '<button data-act="toastaction">' + esc(state.toast.action) + '</button>' : '');
    document.body.appendChild(d);
  }

  // ------------------------------------------------------------ 이벤트
  function bind() {
    var form = document.getElementById('txform');
    if (form) {
      form.addEventListener('submit', onSubmit);
      var amt = form.querySelector('[name=금액]');
      amt.addEventListener('input', function () { var n = amt.value.replace(/[^\d]/g, ''); amt.value = n ? Number(n).toLocaleString('ko-KR') : ''; });
      if (!amt.value) setTimeout(function () { amt.focus(); }, 50);
      var mer = form.querySelector('[name=가맹점]');
      mer.addEventListener('input', function () { autoCategory(form, mer.value); });
      mer.addEventListener('change', function () { autoCategory(form, mer.value); });
      form.querySelectorAll('.seg').forEach(function (seg) {
        seg.addEventListener('click', function (e) {
          var b = e.target.closest('button'); if (!b) return;
          seg.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on');
          form.querySelector('[name=' + seg.getAttribute('data-name') + ']').value = b.getAttribute('data-v');
        });
      });
      var chips = form.querySelector('.chips');
      chips.addEventListener('click', function (e) {
        var c = e.target.closest('.chip'); if (!c) return;
        if (c.getAttribute('data-act') === 'newcat') { var name = prompt('새 카테고리 이름'); if (!name) return; var s = document.createElement('button'); s.type = 'button'; s.className = 'chip'; s.setAttribute('data-v', name); s.textContent = name; chips.insertBefore(s, c); c = s; }
        chips.querySelectorAll('.chip').forEach(function (x) { x.classList.remove('on'); }); c.classList.add('on');
        form.querySelector('input[name=카테고리]').value = c.getAttribute('data-v');
        document.getElementById('cat-hint').textContent = '';
      });
      var file = document.getElementById('ocrfile');
      if (file) file.addEventListener('change', function () { if (file.files[0]) runOcr(file.files[0]); });
    }
  }

  function autoCategory(form, merchant) {
    var hidden = form.querySelector('input[name=카테고리]');
    var g = LedgerParser.guessCategory(merchant, state.dict, [['마트', '식재료'], ['카페', '외식'], ['커피', '외식'], ['식당', '외식']]);
    var hint = document.getElementById('cat-hint');
    if (!g) { hint.textContent = ''; return; }
    hidden.value = g.category;
    form.querySelectorAll('.chips .chip').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-v') === g.category); });
    hint.textContent = g.how === 'exact' ? '(이전 기록에서 자동 선택)' : '(추정)';
  }

  function onSubmit(e) {
    e.preventDefault();
    var form = e.target; var id = form.getAttribute('data-id');
    var tx = {};
    ['금액', '가맹점', '카테고리', '항목', '일시', '유형', '결제인', '계획', '정산', '출처', '원문'].forEach(function (k) { var el = form.querySelector('[name=' + k + ']'); if (el) tx[k] = el.value; });
    tx['금액'] = Number(String(tx['금액']).replace(/[^\d]/g, '')) || 0;
    if (!tx['금액']) { toast('금액을 입력하세요'); return; }
    if (tx['일시'] && tx['일시'].length === 16) tx['일시'] += ':00';
    tx['상태'] = '확인';
    state.prefill = null;
    var btn = form.querySelector('[type=submit]'); btn.disabled = true;
    var p = id ? api.call('update', { id: id, tx: tx }) : api.call('add', { tx: tx });
    p.then(function () { toast(id ? '수정했습니다' : '저장했습니다'); go('list'); return refresh(); })
      .catch(function (err) {
        btn.disabled = false;
        if (!id && !settings.local && /fetch|network|Failed/i.test(err.message)) { var q = queue(); q.push(tx); saveQueue(q); toast('오프라인: 연결되면 자동으로 저장합니다 (' + q.length + '건 대기)'); go('list'); }
        else toast('실패: ' + err.message);
      });
  }

  var pendingDelete = null;
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]'); if (!el) return;
    var act = el.getAttribute('data-act');
    switch (act) {
      case 'goto': go(el.getAttribute('data-to')); break;
      case 'retry': loadAll(); break;
      case 'cycle': state.cycle = shiftCycle(state.cycle, Number(el.getAttribute('data-d'))); state.loading = true; render(); refresh().then(function () { state.loading = false; render(); }); break;
      case 'edit': go('edit/' + el.getAttribute('data-id')); break;
      case 'settle':
        if (!confirm('지금까지의 미정산 거래를 모두 정산 완료로 표시할까요?')) return;
        api.call('settle', {}).then(function (j) { toast(j.settled + '건 정산 처리'); return refresh(); }).catch(function (err) { toast('실패: ' + err.message); });
        break;
      case 'delete': {
        var id = el.getAttribute('data-id'); var row = state.rows.filter(function (r) { return r.id === id; })[0];
        state.rows = state.rows.filter(function (r) { return r.id !== id; });
        go('list');
        var timer = setTimeout(function () { pendingDelete = null; api.call('delete', { id: id }).then(refresh).catch(function (err) { toast('삭제 실패: ' + err.message); refresh(); }); }, 5000);
        pendingDelete = { id: id, row: row, timer: timer };
        toast('삭제했습니다', '되돌리기', function () { clearTimeout(timer); pendingDelete = null; state.rows.push(row); state.rows.sort(function (a, b) { return a['일시'] < b['일시'] ? 1 : -1; }); render(); }, 5000);
        break;
      }
      case 'toastaction': if (state.toast && state.toast.onAction) { var fn = state.toast.onAction; state.toast = null; renderToast(); fn(); } break;
      case 'pickimage': document.getElementById('ocrfile').click(); break;
      case 'savesettings': {
        var wasLocal = settings.local;
        settings.endpoint = (document.getElementById('s-endpoint').value || '').trim();
        settings.pin = document.getElementById('s-pin').value || '';
        settings.me = (document.getElementById('s-me').value || '').trim();
        var lc = document.getElementById('s-local'); settings.local = lc ? lc.checked : !settings.endpoint;
        if (!settings.local && settings.endpoint && !settings.pin) { toast('PIN을 입력하세요'); break; }
        saveSettings(); state.config = null; state.cycle = null; go('home');
        var localRows = []; try { localRows = JSON.parse(localStorage.getItem(NS + 'local.rows') || '[]'); } catch (err) { }
        if (wasLocal && !settings.local && settings.endpoint && localRows.length && confirm('체험 모드에 저장된 거래 ' + localRows.length + '건을 시트로 올릴까요?')) {
          uploadLocalRows(localRows).then(loadAll);
        } else loadAll();
        break;
      }
      case 'copylink': {
        var link = makeSetupLink((document.getElementById('s-linkname').value || '').trim());
        var out = document.getElementById('linkout'); out.textContent = link;
        if (navigator.clipboard) navigator.clipboard.writeText(link).then(function () { toast('설치 링크를 복사했습니다'); }, function () { toast('아래 링크를 길게 눌러 복사하세요'); });
        else toast('아래 링크를 길게 눌러 복사하세요');
        break;
      }
      case 'trylocal': settings.local = true; saveSettings(); go('home'); loadAll(); break;
      case 'ntest': {
        var txt = document.getElementById('ntest').value; var r = LedgerParser.parseNotification(txt);
        var g = LedgerParser.guessCategory(r.merchant, state.dict, []);
        document.getElementById('ntest-out').textContent = JSON.stringify({ 금액: r.amount, 가맹점: r.merchant, 일시: r.date, 카테고리: g ? g.category : '(사전에 없음 → 미확인으로 등록)', 신뢰도: r.confidence, 취소: r.cancelled });
        break;
      }
    }
  });

  // ------------------------------------------------------------ OCR (Tesseract.js, 기기/브라우저 안에서 처리)
  function loadScript(src) { return new Promise(function (res, rej) { if (window.Tesseract) return res(); var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = function () { rej(new Error('OCR 라이브러리를 불러오지 못했습니다')); }; document.head.appendChild(s); }); }
  function downscale(blob, maxW) {
    return new Promise(function (res) {
      var img = new Image(); var url = URL.createObjectURL(blob);
      img.onload = function () {
        var scale = Math.min(1, maxW / img.width); var cv = document.createElement('canvas');
        cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
        var ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0, cv.width, cv.height);
        // 대비 강화: 밝은 배경/어두운 글자 또는 그 반대 모두 흑백에 가깝게
        var d = ctx.getImageData(0, 0, cv.width, cv.height); var px = d.data;
        for (var i = 0; i < px.length; i += 4) { var g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; var v = g < 128 ? Math.max(0, g * 0.6) : Math.min(255, 128 + (g - 128) * 1.6); px[i] = px[i + 1] = px[i + 2] = v; }
        ctx.putImageData(d, 0, 0);
        URL.revokeObjectURL(url); res(cv);
      };
      img.src = url;
    });
  }
  function runOcr(blob) {
    state.ocr = { status: 'OCR 준비 중…', progress: 0 }; if (state.view !== 'add') go('add'); else render();
    return loadScript(TESSERACT_URL).then(function () { return downscale(blob, 1400); }).then(function (canvas) {
      return window.Tesseract.recognize(canvas, 'kor+eng', { logger: function (m) { if (m.status) { state.ocr = { status: m.status === 'recognizing text' ? '글자 읽는 중…' : (m.status.indexOf('load') >= 0 ? '한국어 데이터 내려받는 중 (처음 한 번)…' : m.status), progress: m.progress || 0 }; var pr = document.querySelector('.progress > i'); if (pr) pr.style.width = Math.round((m.progress || 0) * 100) + '%'; var st = pr && pr.parentElement.previousElementSibling; if (st) st.textContent = state.ocr.status; } } });
    }).then(function (res) {
      state.ocr = null;
      prefillFromText(res.data.text, '스크린샷');
    }).catch(function (err) { state.ocr = null; toast('OCR 실패: ' + err.message); render(); });
  }

  function prefillFromText(text, source) {
    var r = source === '스크린샷' ? LedgerParser.parseScreenshot(text) : LedgerParser.parseNotification(text);
    var g = LedgerParser.guessCategory(r.merchant, state.dict, [['마트', '식재료'], ['카페', '외식'], ['커피', '외식']]);
    var note = r.amount ? ('읽은 내용을 확인하고 저장하세요.' + (r.dateGuessed ? ' 날짜를 찾지 못해 지금 시각으로 넣었습니다.' : '')) : '금액을 읽지 못했습니다. 직접 입력해 주세요.';
    state.prefill = { note: note, raw: text, tx: { '금액': r.amount || '', '가맹점': r.merchant || '', '카테고리': g ? g.category : '', '일시': r.date, '유형': r.type, '결제인': me(), '출처': source, '원문': String(text).substring(0, 500) } };
    if (state.view !== 'add') go('add'); else render();
  }

  // 공유 시트로 들어온 이미지/텍스트 처리 (sw-core.js 가 캐시에 넣어 둠)
  function checkShareInbox() {
    if (!/[?&]share=1/.test(location.search) || !('caches' in window)) return Promise.resolve(false);
    history.replaceState(null, '', location.pathname + location.hash);
    return caches.open('ledger-share-inbox').then(function (c) {
      return Promise.all([c.match(new URL('inbox-image', location.href)), c.match(new URL('inbox-text', location.href))]).then(function (rs) {
        var img = rs[0], txt = rs[1];
        c.delete(new URL('inbox-image', location.href)); c.delete(new URL('inbox-text', location.href));
        if (img) return img.blob().then(function (b) { runOcr(b); return true; });
        if (txt) return txt.text().then(function (t) { if (t.trim()) { prefillFromText(t, '알림'); return true; } return false; });
        return false;
      });
    }).catch(function () { return false; });
  }

  // ------------------------------------------------------------ 시작
  if ('serviceWorker' in navigator) { navigator.serviceWorker.register('./sw.js').catch(function () { }); }
  applySetupLink();
  route();
  if (settings.local !== undefined) loadAll().then(checkShareInbox);
})();
