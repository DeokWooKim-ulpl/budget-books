/* 가계부 PWA — 공동/개인 공용. 설정은 ./config.js (window.LEDGER_CONFIG) 와 서버 config 액션에서 온다. */
(function () {
  'use strict';
  var APP_VERSION = '2026-11-04e';   // 더보기 맨 아래에 보인다. 배포할 때 index.html / sw.js 의 ?v= 와 같이 올린다
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
    recurring: [], due: [], recEdit: null,
    calMonth: null, calDay: null, extra: {}, extraLoading: {},   // 달력: 보고 있는 달, 고른 날, 현재 사이클 밖의 거래(사이클별), 받아 오는 중인 사이클
    // v3
    balance: null, settlements: [], settlementsTotal: 0, accounts: [], accountLog: [], accSel: null, accEdit: null, debts: [], debtEdit: null, events: [], evtEdit: null,
    itemCounts: {}, formItems: null, budget: null, budgetSuggest: null, categoryStats: null, listQ: '', listFilter: null, listAll: null, listAllLoading: false,
    groups: [], groupSel: null, groupEdit: null, accLogs: {}, accTxEdit: null, accYear: {},
    syncing: false, returnTo: null,
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
  // 화면 밝기: light(기본) / dark / auto(기기 설정 따름). styles.css 의 [data-theme] 규칙이 색을 바꾼다.
  function applyTheme() {
    var t = settings.theme || 'light';
    if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  }
  applyTheme();

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
    var KEYR = NS + 'local.recurring';
    function rows() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } }
    function save(r) { localStorage.setItem(KEY, JSON.stringify(r)); }
    function recs() { try { return JSON.parse(localStorage.getItem(KEYR) || '[]'); } catch (e) { return []; } }
    function saveRecs(r) { localStorage.setItem(KEYR, JSON.stringify(r)); }
    function recDate(item, cycle) { var p = cycle.split('-'); var y = +p[0], m = +p[1]; var day = item['일']; if (day < 25) { m += 1; if (m > 12) { m = 1; y += 1; } } var lastDay = new Date(y, m, 0).getDate(); if (day > lastDay) day = lastDay; return y + '-' + p2(m) + '-' + p2(day) + 'T12:00:00'; }
    function due(cycle) { var have = {}; rows().forEach(function (o) { if (o['사이클'] === cycle && o['출처'] === '고정') have[o['원문']] = 1; }); return recs().filter(function (r) { return r['활성'] !== 'N' && !have['고정:' + r.id]; }); }
    function trend(cycle, n) { var p = cycle.split('-'); var out = []; for (var i = n - 1; i >= 0; i--) { var d = new Date(+p[0], +p[1] - 1 - i, 1); out.push({ cycle: d.getFullYear() + '-' + p2(d.getMonth() + 1), expense: 0, income: 0, fixed: 0, planned: 0, count: 0 }); } var map = {}; out.forEach(function (t) { map[t.cycle] = t; }); rows().forEach(function (o) { var t = map[o['사이클']]; if (!t || o['상태'] === '취소') return; if (o['유형'] === '수입') { t.income += o['금액']; return; } t.expense += o['금액']; t.count++; if (o['출처'] === '고정') t.fixed += o['금액']; if (o['계획'] === 'Y') t.planned += o['금액']; }); return out; }
    function cfg() {
      var type = CFG.localLedgerType || 'shared';
      var cats = null; try { cats = JSON.parse(localStorage.getItem(NS + 'local.cats') || 'null'); } catch (e) { cats = null; }
      return { ledgerType: type, cycleStartDay: 25, members: type === 'shared' ? ['덕우', '지민'] : ['덕우'],
        categories: cats || ['식재료', '외식', '생활비', '월세', '관리비', '전기료', '가스료', '수도세', '교통', '의료', '기타'],
        budgetTotal: type === 'personal' ? 600000 : null, budgets: {}, currentCycle: LedgerParser.cycleMonth(nowIso(), 25), sheetUrl: '',
        apiVersion: 3, splitRatio: type === 'shared' ? { '덕우': 0.5, '지민': 0.5 } : null };
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
      o['분담'] = c.ledgerType === 'shared' ? String(o['분담'] || '').trim() : ''; o['태그'] = String(o['태그'] || '').trim();
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
      out.fixed = 0; rs.forEach(function (o) { if (o['유형'] !== '수입' && o['출처'] === '고정') out.fixed += o['금액']; }); out.variable = out.expense - out.fixed; out.trend = trend(cycle, 6);
      if (c.ledgerType === 'shared') {
        var un = {}; all.forEach(function (o) { if (o['유형'] === '지출' && o['정산'] === 'X' && o['상태'] !== '취소') un[o['결제인']] = (un[o['결제인']] || 0) + o['금액']; });
        out.unsettledAllByPayer = un;
        out.balance = balance(); out.settlementAll = out.balance.remaining;
      }
      if (c.ledgerType === 'personal') { var bud = budgetFor(cycle); out.budgetTotal = bud.total; if (bud.total) out.remaining = bud.total - out.expense; out.budgets = bud.byCategory; }
      else if (c.budgetTotal) out.remaining = c.budgetTotal - out.expense;
      return out;
    }
    // ---- v3 표 (체험 모드): 정산 기록, 통장, 통장거래, 부채, 이벤트, 품목, 예산
    function tbl(name) { try { return JSON.parse(localStorage.getItem(NS + 'local.' + name) || '[]'); } catch (e) { return []; } }
    function saveTbl(name, rows) { localStorage.setItem(NS + 'local.' + name, JSON.stringify(rows)); }
    function upsert(name, o, prefix) { var rows = tbl(name); var i = o.id ? rows.findIndex(function (r) { return r.id === o.id; }) : -1; if (i < 0) { o.id = (prefix || '') + Math.random().toString(36).slice(2, 10); o['등록'] = nowIso(); rows.push(o); } else { o['등록'] = rows[i]['등록']; rows[i] = o; } saveTbl(name, rows); return o; }
    function del(name, id) { var rows = tbl(name); var n = rows.length; rows = rows.filter(function (r) { return r.id !== id; }); saveTbl(name, rows); return rows.length < n; }
    function balance() { var c = cfg(); return calcBalance(rows(), tbl('settle').filter(function (s) { return s['상태'] !== '마감'; }), c.members, c.splitRatio); }
    function closeAll() { var all = rows(); var n = 0; all.forEach(function (r) { if (r['유형'] === '지출' && r['정산'] === 'X') { r['정산'] = 'O'; n++; } }); save(all); saveTbl('settle', tbl('settle').map(function (s) { s['상태'] = '마감'; return s; })); return n; }
    function settlementsRead() { var log = tbl('settle').slice().sort(function (a, b) { return a['일시'] < b['일시'] ? 1 : -1; }); return { balance: balance(), log: log.slice(0, 100), total: log.length }; }
    function accountsRead() { var txs = tbl('acctx').slice().sort(function (a, b) { return a['일시'] < b['일시'] ? 1 : -1; }); var bal = {}, monthly = {}; var today = dayKey(nowIso()); var from6 = addMonths(today.substring(0, 7) + '-01', -5).substring(0, 7); txs.forEach(function (t) { var sg = t['구분'] === '출금' ? -t['금액'] : t['금액']; bal[t['통장']] = (bal[t['통장']] || 0) + sg; var ym = String(t['일시']).substring(0, 7); if (ym >= from6) { var m = monthly[t['통장']] || (monthly[t['통장']] = {}); m[ym] = (m[ym] || 0) + sg; } }); var accounts = tbl('acc').map(function (a) { var b = bal[a.id] || 0; var m = monthly[a.id] || {}; var avg = Math.round(Object.keys(m).reduce(function (x, k) { return x + m[k]; }, 0) / 6); var target = amt(a['목표금액']); var goal = null; if (target > 0) { var remaining = Math.max(0, target - b); var eta = remaining > 0 && avg > 0 ? Math.ceil(remaining / avg) : null; goal = { target: target, remaining: remaining, progress: Math.min(1, b / target), avgMonthly: avg, etaMonths: eta, etaDate: eta ? addMonths(today, eta) : (remaining === 0 ? today : ''), dueDate: String(a['목표일'] || '').substring(0, 10), neededMonthly: a['목표일'] && remaining > 0 ? Math.ceil(remaining / Math.max(1, monthsBetween(today, String(a['목표일']).substring(0, 10)))) : null }; } return Object.assign({}, a, { balance: b, monthly: m, avgMonthly: avg, goal: goal }); }); var sum = 0; accounts.forEach(function (a) { if (a['활성'] !== 'N') sum += a.balance; }); return { accounts: accounts, sum: sum, log: txs.slice(0, 100), total: txs.length }; }
    function debtsRead() { return tbl('debt').map(function (d) { return Object.assign({}, d, { calc: debtCalc(d) }); }); }
    function eventsRead() { var by = {}; rows().forEach(function (o) { var t = o['태그']; if (!t || o['상태'] === '취소') return; var e = by[t] || (by[t] = { expense: 0, income: 0, count: 0, byPayer: {}, byCategory: {} }); e.count++; if (o['유형'] === '수입') { e.income += o['금액']; return; } e.expense += o['금액']; e.byPayer[o['결제인']] = (e.byPayer[o['결제인']] || 0) + o['금액']; e.byCategory[o['카테고리'] || '미분류'] = (e.byCategory[o['카테고리'] || '미분류'] || 0) + o['금액']; }); var pay = {}; tbl('settle').forEach(function (s) { if (s['태그']) (pay[s['태그']] = pay[s['태그']] || []).push(s); }); return tbl('evt').map(function (e) { return Object.assign({}, e, { stats: by[e['이름']] || { expense: 0, income: 0, count: 0, byPayer: {}, byCategory: {} }, payments: pay[e['이름']] || [] }); }); }
    function itemCounts() { var out = {}; tbl('item').forEach(function (it) { out[it['거래id']] = (out[it['거래id']] || 0) + 1; }); return out; }
    function budgetFor(cycle) { var c = cfg(); var out = { total: c.budgetTotal, byCategory: Object.assign({}, c.budgets), isOverride: false, overrides: {} }; tbl('budget').forEach(function (b) { if (b['사이클'] !== cycle) return; if (!b['카테고리']) { out.total = b['금액'] || null; out.isOverride = true; } else { out.byCategory[b['카테고리']] = b['금액']; out.overrides[b['카테고리']] = b['금액']; } }); return out; }
    function budgetSuggest(cycle) { var tr = trend(cycle, 4).slice(0, 3); var n = tr.filter(function (t) { return t.count; }).length || 1; var inc = 0, exp = 0; recs().forEach(function (r) { if (r['활성'] === 'N') return; if (r['유형'] === '수입') inc += r['금액']; else exp += r['금액']; }); return { avgExpense: Math.round(tr.reduce(function (a, t) { return a + t.expense; }, 0) / n), fixedIncome: inc, fixedExpense: exp, free: inc - exp }; }
    function categoryStats() { var counts = {}, sums = {}; rows().forEach(function (o) { if (o['유형'] === '수입') return; var c = o['카테고리'] || ''; counts[c] = (counts[c] || 0) + 1; sums[c] = (sums[c] || 0) + o['금액']; }); var cats = cfg().categories.slice(); Object.keys(counts).forEach(function (c) { if (c && cats.indexOf(c) < 0) cats.push(c); }); return cats.map(function (c) { return { name: c, count: counts[c] || 0, sum: sums[c] || 0, inConfig: cfg().categories.indexOf(c) >= 0 }; }); }
    function amt(v) { return Math.round(Number(String(v == null ? '' : v).replace(/[^\d.-]/g, '')) || 0); }
    function groupsRead() { var items = tbl('grpi'), pays = tbl('grpp'); return tbl('grp').map(function (g) { var its = items.filter(function (it) { return it['모임id'] === g.id; }).sort(function (a, b) { return a['일자'] < b['일자'] ? -1 : 1; }); var ps = pays.filter(function (p) { return p['모임id'] === g.id; }); return Object.assign({}, g, { items: its, payments: ps, calc: groupCalc(g, its, ps) }); }).sort(function (a, b) { return a['날짜'] < b['날짜'] ? 1 : -1; }); }
    function v3(action, p, all) {
      switch (action) {
        case 'settlements': return Object.assign({ ok: true }, settlementsRead());
        case 'settlePay': { var a = amt(p.amount); if (a <= 0) throw new Error('금액을 입력하세요'); if (!p.from || !p.to || p.from === p.to) throw new Error('보낸 사람과 받는 사람을 확인하세요'); var when = p.date ? p.date + 'T12:00:00' : nowIso(); var o = upsert('settle', { '일시': when, '사이클': LedgerParser.cycleMonth(when, 25), '보낸사람': p.from, '받는사람': p.to, '금액': a, '메모': p.memo || '', '태그': p.tag || '', '상태': '열림' }, 's'); var closed = false; if (!balance().remaining) { closeAll(); closed = true; } return { ok: true, payment: o, balance: balance(), closed: closed }; }
        case 'settleFinish': { var b = balance(); var pay = null; if (b.remaining) pay = upsert('settle', { '일시': nowIso(), '사이클': cfg().currentCycle, '보낸사람': b.remaining.from, '받는사람': b.remaining.to, '금액': b.remaining.amount, '메모': '정산 완료', '태그': '', '상태': '열림' }, 's'); var n = closeAll(); return { ok: true, payment: pay, settledTx: n, balance: balance() }; }
        case 'settleDelete': { var row = tbl('settle').filter(function (s) { return s.id === p.id; })[0]; if (row && row['상태'] === '마감') throw new Error('마감된 정산 기록은 지울 수 없습니다'); return { ok: true, deleted: del('settle', p.id), balance: balance() }; }
        case 'accounts': return Object.assign({ ok: true }, accountsRead());
        case 'accountSave': { var it = Object.assign({ '종류': '공금', '소유': '', '메모': '', '활성': 'Y', '목표금액': '', '목표일': '' }, p.item || {}); if (!String(it['이름'] || '').trim()) throw new Error('통장 이름을 입력하세요'); it['목표금액'] = amt(it['목표금액']) || ''; it['목표일'] = String(it['목표일'] || '').substring(0, 10); delete it.goal; delete it.monthly; delete it.balance; delete it.avgMonthly; upsert('acc', it, 'a'); return { ok: true, item: it, accounts: accountsRead() }; }
        case 'accountTransfer': { var fa = tbl('acc'); if (!fa.some(function (a) { return a.id === p.from; }) || !fa.some(function (a) { return a.id === p.to; }) || p.from === p.to) throw new Error('보내는 통장과 받는 통장을 확인하세요'); var ta2 = amt(p.amount); if (ta2 <= 0) throw new Error('금액을 입력하세요'); var w2 = p.date ? p.date + 'T12:00:00' : nowIso(); var nm = function (id) { return (fa.filter(function (a) { return a.id === id; })[0] || {})['이름'] || id; }; var mm = '[이체] ' + (p.memo || ''); var o1 = upsert('acctx', { '일시': w2, '통장': p.from, '구분': '출금', '금액': ta2, '메모': mm + ' → ' + nm(p.to), '거래id': '' }, 't'); upsert('acctx', { '일시': w2, '통장': p.to, '구분': '입금', '금액': ta2, '메모': mm + ' ← ' + nm(p.from), '거래id': '' }, 't'); return { ok: true, item: o1, accounts: accountsRead() }; }
        case 'accountDelete': { var used = tbl('acctx').filter(function (t) { return t['통장'] === p.id; }).length; if (used && !p.cascade) throw new Error('기록이 ' + used + '건 있는 통장입니다. 기록까지 지우려면 확인하세요'); saveTbl('acctx', tbl('acctx').filter(function (t) { return t['통장'] !== p.id; })); del('acc', p.id); return { ok: true, deleted: true, accounts: accountsRead() }; }
        case 'accountTxUpdate': { var rows2 = tbl('acctx'); var k2 = rows2.findIndex(function (t) { return t.id === p.id; }); if (k2 < 0) throw new Error('기록을 찾지 못했습니다'); var o2 = rows2[k2], tx2 = p.tx || {}; if (tx2['금액'] !== undefined) { var a2 = amt(tx2['금액']); if (a2 <= 0) throw new Error('금액을 입력하세요'); o2['금액'] = a2; } if (tx2['구분'] !== undefined) o2['구분'] = tx2['구분'] === '출금' ? '출금' : '입금'; if (tx2['일시']) o2['일시'] = String(tx2['일시']).length === 10 ? tx2['일시'] + 'T12:00:00' : tx2['일시']; if (tx2['메모'] !== undefined) o2['메모'] = tx2['메모']; saveTbl('acctx', rows2); return { ok: true, item: o2, accounts: accountsRead() }; }
        case 'accountLog': { var lg = tbl('acctx').filter(function (t) { return t['통장'] === p.id; }).slice().sort(function (a, b) { return a['일시'] < b['일시'] ? -1 : (a['일시'] > b['일시'] ? 1 : (a['등록'] < b['등록'] ? -1 : 1)); }); var bl = 0; lg.forEach(function (t) { bl += t['구분'] === '출금' ? -t['금액'] : t['금액']; t.balance = bl; }); var ys = {}; lg.forEach(function (t) { var y = String(t['일시']).substring(0, 4); var yy = ys[y] || (ys[y] = { year: y, in: 0, out: 0, count: 0 }); yy.count++; if (t['구분'] === '출금') yy.out += t['금액']; else yy.in += t['금액']; }); lg.reverse(); return { ok: true, id: p.id, log: lg, years: Object.keys(ys).sort().reverse().map(function (y) { return ys[y]; }) }; }
        case 'accountTxAdd': { var t = p.tx || {}; var ta = amt(t['금액']); if (ta <= 0) throw new Error('금액을 입력하세요'); if (!tbl('acc').some(function (a) { return a.id === t['통장']; })) throw new Error('통장을 고르세요'); var to = upsert('acctx', { '일시': t['일시'] ? (String(t['일시']).length === 10 ? t['일시'] + 'T12:00:00' : t['일시']) : nowIso(), '통장': t['통장'], '구분': t['구분'] === '출금' ? '출금' : '입금', '금액': ta, '메모': t['메모'] || '', '거래id': t['거래id'] || '' }, 't'); return { ok: true, item: to, accounts: accountsRead() }; }
        case 'accountTxDelete': return { ok: true, deleted: del('acctx', p.id), accounts: accountsRead() };
        case 'debts': return { ok: true, debts: debtsRead() };
        case 'debtSave': { var d = Object.assign({ '기관': '', '소유': '', '메모': '', '활성': 'Y', '납입회차': '', '총회차': '' }, p.item || {}); if (!String(d['이름'] || '').trim()) throw new Error('이름을 입력하세요'); d['원금'] = amt(d['원금']); if (!d['원금']) throw new Error('원금을 입력하세요'); d['연이율'] = Number(String(d['연이율']).replace(/[^\d.]/g, '')) || 0; d['월상환금'] = amt(d['월상환금']); d['총회차'] = Number(d['총회차']) || ''; d['납입회차'] = d['납입회차'] === '' ? '' : (Number(d['납입회차']) || 0); d['시작일'] = String(d['시작일'] || '').substring(0, 10); if (!d['월상환금'] && !d['총회차']) throw new Error('월상환금 또는 총회차 중 하나는 입력하세요'); upsert('debt', d, 'd'); return { ok: true, item: Object.assign({}, d, { calc: debtCalc(d) }), debts: debtsRead() }; }
        case 'debtDelete': return { ok: true, deleted: del('debt', p.id), debts: debtsRead() };
        case 'events': return { ok: true, events: eventsRead() };
        case 'eventSave': { var ev = Object.assign({ '시작일': '', '종료일': '', '메모': '', '상태': '진행' }, p.item || {}); if (!String(ev['이름'] || '').trim()) throw new Error('이벤트 이름을 입력하세요'); delete ev.stats; delete ev.payments; upsert('evt', ev, 'e'); return { ok: true, item: ev, events: eventsRead() }; }
        case 'eventDelete': return { ok: true, deleted: del('evt', p.id), events: eventsRead() };
        case 'items': return { ok: true, items: tbl('item').filter(function (it) { return it['거래id'] === p.txId; }) };
        case 'itemsSave': { if (!p.txId) throw new Error('거래를 먼저 저장하세요'); var keep = tbl('item').filter(function (it) { return it['거래id'] !== p.txId; }); (p.items || []).forEach(function (it) { if (!String(it['품목'] || '').trim()) return; keep.push({ id: 'i' + Math.random().toString(36).slice(2, 10), '거래id': p.txId, '품목': it['품목'], '수량': Number(it['수량']) || 1, '금액': amt(it['금액']), '등록': nowIso() }); }); saveTbl('item', keep); return { ok: true, items: keep.filter(function (it) { return it['거래id'] === p.txId; }) }; }
        case 'budget': { var bc = p.cycle || cfg().currentCycle; return { ok: true, cycle: bc, budget: budgetFor(bc), suggest: budgetSuggest(bc) }; }
        case 'budgetSave': { var cy = p.cycle || cfg().currentCycle; var cat = String(p.category || '').trim(); var rowsB = tbl('budget').filter(function (b) { return !(b['사이클'] === cy && b['카테고리'] === cat); }); if (p.amount !== '' && p.amount != null) rowsB.push({ '사이클': cy, '카테고리': cat, '금액': amt(p.amount) }); saveTbl('budget', rowsB); return { ok: true, budget: budgetFor(cy) }; }
        case 'categories': return { ok: true, categories: categoryStats() };
        case 'groups': return { ok: true, groups: groupsRead() };
        case 'groupSave': { var gg = Object.assign({ '날짜': dayKey(nowIso()), '메모': '', '상태': '진행' }, p.item || {}); delete gg.items; delete gg.payments; delete gg.calc; gg['이름'] = String(gg['이름'] || '').trim(); if (!gg['이름']) throw new Error('모임 이름을 입력하세요'); gg['참여자'] = String(gg['참여자'] || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean).join(','); if (!gg['참여자']) throw new Error('참여자를 쉼표로 넣으세요'); gg['상태'] = gg['상태'] === '마감' ? '마감' : '진행'; upsert('grp', gg, 'g'); return { ok: true, item: gg, groups: groupsRead() }; }
        case 'groupDelete': { saveTbl('grpi', tbl('grpi').filter(function (it) { return it['모임id'] !== p.id; })); saveTbl('grpp', tbl('grpp').filter(function (x) { return x['모임id'] !== p.id; })); del('grp', p.id); return { ok: true, deleted: true, groups: groupsRead() }; }
        case 'groupItemSave': { var gi = Object.assign({ '일자': dayKey(nowIso()), '참여자': '', '메모': '' }, p.item || {}); if (!tbl('grp').some(function (g) { return g.id === gi['모임id']; })) throw new Error('모임을 먼저 만드세요'); gi['금액'] = amt(gi['금액']); if (gi['금액'] <= 0) throw new Error('금액을 입력하세요'); gi['항목'] = String(gi['항목'] || '').trim() || '항목'; gi['참여자'] = String(gi['참여자'] || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean).join(','); upsert('grpi', gi, 'gi'); return { ok: true, item: gi, groups: groupsRead() }; }
        case 'groupItemDelete': return { ok: true, deleted: del('grpi', p.id), groups: groupsRead() };
        case 'groupPaySave': { var gp = Object.assign({ '일자': dayKey(nowIso()), '메모': '' }, p.item || {}); gp['금액'] = amt(gp['금액']); if (gp['금액'] <= 0) throw new Error('금액을 입력하세요'); if (!gp['보낸사람'] || !gp['받는사람'] || gp['보낸사람'] === gp['받는사람']) throw new Error('보낸 사람과 받는 사람을 확인하세요'); upsert('grpp', gp, 'gp'); return { ok: true, item: gp, groups: groupsRead() }; }
        case 'groupPayDelete': return { ok: true, deleted: del('grpp', p.id), groups: groupsRead() };
        case 'renameCategory': { var from = String(p.from || '').trim(), to = String(p.to || '').trim(); if (!to) throw new Error('새 이름을 입력하세요'); var n2 = 0; all.forEach(function (o) { if (o['카테고리'] === from) { o['카테고리'] = to; n2++; } }); save(all); saveRecs(recs().map(function (r) { if (r['카테고리'] === from) r['카테고리'] = to; return r; })); saveTbl('budget', tbl('budget').map(function (b) { if (b['카테고리'] === from) b['카테고리'] = to; return b; })); var cl = JSON.parse(localStorage.getItem(NS + 'local.cats') || 'null') || cfg().categories; cl = cl.filter(function (c) { return c !== from; }); if (cl.indexOf(to) < 0) cl.push(to); localStorage.setItem(NS + 'local.cats', JSON.stringify(cl)); return { ok: true, tx: n2, from: from, to: to, categories: categoryStats(), config: cfg() }; }
      }
      return null;
    }
    return {
      call: function (action, p) {
        return new Promise(function (resolve, reject) {
          try {
            var all = rows();
            var r3 = v3(action, p, all); if (r3) return resolve(r3);
            switch (action) {
              case 'config': return resolve({ ok: true, config: cfg() });
              case 'bootstrap': { var c0 = cfg(); var cy0 = p.cycle || c0.currentCycle; var rs0 = all.filter(function (o) { return cy0 === 'all' || o['사이클'] === cy0 || o['상태'] === '미확인'; }); rs0.sort(function (a, b) { return a['일시'] < b['일시'] ? 1 : -1; }); var m0 = merchantStats(all); var ar0 = accountsRead(); var b0 = { ok: true, config: c0, cycle: cy0, rows: rs0, summary: summary(cy0), dict: dict(), merchants: m0, recurring: recs(), recurringDue: due(cy0).map(function (r) { return r.id; }), accounts: ar0.accounts, accountsSum: ar0.sum, groups: groupsRead().filter(function (g) { return g['상태'] !== '마감'; }).slice(0, 5), debts: debtsRead(), events: eventsRead(), itemCounts: itemCounts() }; if (c0.ledgerType === 'shared') { var st0 = settlementsRead(); b0.balance = st0.balance; b0.settlements = st0.log.slice(0, 20); } else { b0.budget = budgetFor(cy0); b0.budgetSuggest = budgetSuggest(cy0); } return resolve(b0); }
              case 'recurring': { var cyr = p.cycle || cfg().currentCycle; return resolve({ ok: true, recurring: recs(), due: due(cyr).map(function (r) { return r.id; }), cycle: cyr }); }
              case 'recurringSave': { var rl = recs(); var it = Object.assign({ '유형': '지출', '활성': 'Y', '계획': 'Y' }, p.item || {}); it['금액'] = Math.round(Number(String(it['금액']).replace(/[^\d.-]/g, '')) || 0); it['일'] = Math.min(31, Math.max(1, Number(it['일']) || 1)); it['결제인'] = it['결제인'] || cfg().members[0]; if (!it['이름']) throw new Error('이름을 입력하세요'); if (!it['금액']) throw new Error('금액을 입력하세요'); if (!it['카테고리']) it['카테고리'] = it['유형'] === '수입' ? '수입' : ''; var ri = it.id ? rl.findIndex(function (r) { return r.id === it.id; }) : -1; if (ri < 0) { it.id = 'r' + Math.random().toString(36).slice(2); rl.push(it); } else rl[ri] = it; saveRecs(rl); return resolve({ ok: true, item: it, recurring: rl }); }
              case 'recurringDelete': { var rl2 = recs().filter(function (r) { return r.id !== p.id; }); saveRecs(rl2); return resolve({ ok: true, deleted: true, recurring: rl2 }); }
              case 'applyRecurring': { var cya = p.cycle || cfg().currentCycle; var ds = due(cya); if (p.ids && p.ids.length) ds = ds.filter(function (r) { return p.ids.indexOf(r.id) >= 0; }); var am = p.amounts || {}, ud = p.updateDefault || []; var added = ds.map(function (r) { var amt = Math.round(Number(String(am[r.id] == null ? '' : am[r.id]).replace(/[^\d.-]/g, '')) || 0); if (amt <= 0) amt = r['금액']; if (amt !== r['금액'] && ud.indexOf(r.id) >= 0) { var rl3 = recs(); var k3 = rl3.findIndex(function (x) { return x.id === r.id; }); if (k3 >= 0) { rl3[k3]['금액'] = amt; saveRecs(rl3); } } var tx = normalize({ '일시': recDate(r, cya), '유형': r['유형'], '금액': amt, '가맹점': r['이름'], '카테고리': r['카테고리'], '항목': r['메모'] || '', '결제인': r['결제인'], '계획': r['계획'], '출처': '고정', '상태': '확인', '원문': '고정:' + r.id, '분담': r['분담'] || '' }); tx.id = Math.random().toString(36).slice(2) + Date.now().toString(36); tx['등록'] = tx['수정'] = nowIso(); all.push(tx); return tx; }); save(all); return resolve({ ok: true, added: added.length, rows: added }); }
              case 'list': { var cy = p.cycle || cfg().currentCycle; var rs = all.filter(function (o) { return cy === 'all' || o['사이클'] === cy || o['상태'] === '미확인'; }); rs.sort(function (a, b) { return a['일시'] < b['일시'] ? 1 : -1; }); return resolve({ ok: true, rows: rs, cycle: cy }); }
              case 'add': { var o = normalize(p.tx); o.id = Math.random().toString(36).slice(2) + Date.now().toString(36); o['등록'] = o['수정'] = nowIso(); all.push(o); save(all); return resolve({ ok: true, row: o }); }
              case 'update': { var i = all.findIndex(function (r) { return r.id === p.id; }); if (i < 0) throw new Error('not found'); var u = normalize(p.tx, all[i]); u['수정'] = nowIso(); all[i] = u; save(all); return resolve({ ok: true, row: u }); }
              case 'confirm': { var j = all.findIndex(function (r) { return r.id === p.id; }); if (j >= 0) { all[j]['상태'] = '확인'; save(all); } return resolve({ ok: true, row: all[j] }); }
              case 'delete': { save(all.filter(function (r) { return r.id !== p.id; })); return resolve({ ok: true, deleted: true }); }
              case 'settle': { var n = 0; all.forEach(function (r) { if (r['유형'] === '지출' && r['정산'] === 'X') { r['정산'] = 'O'; n++; } }); save(all); return resolve({ ok: true, settled: n }); }
              case 'summary': return resolve({ ok: true, summary: summary(p.cycle || cfg().currentCycle) });
              case 'dict': return resolve({ ok: true, dict: dict() });
              case 'merchants': return resolve({ ok: true, merchants: merchantStats(all) });
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
  // 자주 쓰는 가맹점 (서버 recentMerchants_ 와 같은 규칙). 체험 모드에서 쓴다.
  function merchantStats(all) {
    var rows = all.filter(function (o) { return o['가맹점'] && o['상태'] !== '취소' && o['출처'] !== '고정'; }).slice().sort(function (a, b) { return a['일시'] < b['일시'] ? 1 : -1; });
    var cut90 = new Date(Date.now() - 90 * 86400000).toISOString().substring(0, 10); var stat = {}, order = [];
    rows.forEach(function (o) { var st = stat[o['가맹점']]; if (!st) { st = stat[o['가맹점']] = { name: o['가맹점'], category: o['카테고리'], lastAmount: o['금액'], lastDate: o['일시'], type: o['유형'], count: 0, recent: 0, cats: {} }; order.push(o['가맹점']); } st.count++; if (o['일시'] >= cut90) st.recent++; st.cats[o['카테고리'] || ''] = (st.cats[o['카테고리'] || ''] || 0) + 1; });
    return order.map(function (m) { var st = stat[m]; var best = st.category; Object.keys(st.cats).forEach(function (c) { if (c && (!best || st.cats[c] > (st.cats[best] || 0))) best = c; }); return { name: st.name, category: best, lastAmount: st.lastAmount, lastDate: st.lastDate, type: st.type, count: st.count, recent: st.recent, score: st.recent * 3 + Math.min(st.count, 30) * 0.3 + (order.indexOf(m) < 10 ? 2 : 0) }; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 60);
  }
  function dayLabel(k) { var d = new Date(k + 'T00:00:00'); var w = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()]; return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + w + ')'; }
  function isShared() { return state.config && state.config.ledgerType === 'shared'; }
  function me() { return settings.me || (state.config && state.config.members[0]) || ''; }
  function toast(msg, action, onAction, ms) {
    if (state.toast && state.toast.timer) clearTimeout(state.toast.timer);
    state.toast = { msg: msg, action: action, onAction: onAction };
    state.toast.timer = setTimeout(function () { state.toast = null; renderToast(); }, ms || 4000);
    renderToast();
  }

  // ------------------------------------------------------------ v3 공용 계산 (서버 Code.gs 의 balance_/debtCalc_ 와 같은 규칙)
  // 미정산 거래와 열린 정산 기록으로 "누가 누구에게 얼마"를 계산한다. ratio: {이름: 비율}. 거래의 분담: '' = ratio, 이름 = 그 사람 전액, "60:40".
  function shareOf(tx, member, members, ratio) {
    var s = String(tx['분담'] || '').trim();
    if (!s) return ratio[member] || 0;
    if (members.indexOf(s) >= 0) return s === member ? 1 : 0;
    var parts = s.split(/[:\/]/).map(Number);
    if (parts.length === members.length && !parts.some(isNaN)) { var sum = parts.reduce(function (a, b) { return a + b; }, 0); return sum ? parts[members.indexOf(member)] / sum : ratio[member] || 0; }
    return ratio[member] || 0;
  }
  function calcBalance(rows, payments, members, ratio) {
    ratio = ratio || {}; if (!Object.keys(ratio).length) members.forEach(function (m) { ratio[m] = 1 / members.length; });
    var net = {}, paid = {}, share = {}, openTx = 0, openTxSum = 0, paySum = 0;
    members.forEach(function (m) { net[m] = 0; paid[m] = 0; share[m] = 0; });
    rows.forEach(function (o) {
      if (o['유형'] !== '지출' || o['정산'] !== 'X' || o['상태'] === '취소') return;
      openTx++; openTxSum += Number(o['금액']) || 0; var p = o['결제인'];
      if (net[p] === undefined) { net[p] = 0; paid[p] = 0; share[p] = 0; }
      paid[p] += Number(o['금액']) || 0;
      members.forEach(function (m) { share[m] += (Number(o['금액']) || 0) * shareOf(o, m, members, ratio); });
    });
    Object.keys(net).forEach(function (m) { net[m] = paid[m] - (share[m] || 0); });
    (payments || []).forEach(function (s) { var a = Number(s['금액']) || 0; paySum += a; if (net[s['보낸사람']] !== undefined) net[s['보낸사람']] += a; if (net[s['받는사람']] !== undefined) net[s['받는사람']] -= a; });
    var remaining = null;
    if (members.length === 2) { var d = Math.round(net[members[0]]); if (d !== 0) remaining = { from: d > 0 ? members[1] : members[0], to: d > 0 ? members[0] : members[1], amount: Math.abs(d) }; }
    return { net: net, paid: paid, share: share, remaining: remaining, openTx: openTx, openTxSum: openTxSum, openPayments: (payments || []).length, openPaymentsSum: paySum, ratio: ratio };
  }
  // 거래 하나를 더하거나(+1) 뺄 때(-1) 잔액(state.balance)을 서버 응답 없이 먼저 맞춘다
  function bumpBalance(o, sign) {
    var b = state.balance; if (!b || !isShared() || o['유형'] !== '지출' || o['정산'] !== 'X' || o['상태'] === '취소') return;
    var m = state.config.members, ratio = state.config.splitRatio || b.ratio || {}; var a = (Number(o['금액']) || 0) * sign; var p = o['결제인'];
    if (b.net[p] === undefined) { b.net[p] = 0; b.paid[p] = 0; b.share[p] = 0; }
    b.paid[p] += a; b.net[p] += a; b.openTx += sign; b.openTxSum += a;
    m.forEach(function (x) { var s = a * shareOf(o, x, m, ratio); b.share[x] += s; b.net[x] -= s; });
    var d = Math.round(b.net[m[0]]); b.remaining = m.length === 2 && d !== 0 ? { from: d > 0 ? m[1] : m[0], to: d > 0 ? m[0] : m[1], amount: Math.abs(d) } : null;
    if (state.summary) state.summary.settlementAll = b.remaining;
  }
  // 모임 정산 계산 (서버 groupCalc_ 와 동일): 부담 = 참여한 항목 ÷ 참여자 수, 낸 돈 = 계산한 항목 + 보낸 납입
  function groupCalc(g, items, pays) {
    var members = String(g['참여자'] || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    var paid = {}, share = {}, net = {}; members.forEach(function (m) { paid[m] = 0; share[m] = 0; }); var total = 0;
    items.forEach(function (it) { var a = Number(it['금액']) || 0; total += a; var who = String(it['낸사람'] || '').trim(); if (who) { if (paid[who] === undefined) { paid[who] = 0; share[who] = 0; } paid[who] += a; } var parts = String(it['참여자'] || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean); if (!parts.length) parts = members; parts.forEach(function (m) { if (share[m] === undefined) { paid[m] = 0; share[m] = 0; } share[m] += a / parts.length; }); });
    pays.forEach(function (p) { var a = Number(p['금액']) || 0; if (paid[p['보낸사람']] !== undefined) paid[p['보낸사람']] += a; if (paid[p['받는사람']] !== undefined) paid[p['받는사람']] -= a; });
    Object.keys(paid).forEach(function (m) { net[m] = Math.round(paid[m] - (share[m] || 0)); });
    var debt = Object.keys(net).filter(function (m) { return net[m] < 0; }).map(function (m) { return { m: m, v: -net[m] }; }).sort(function (a, b) { return b.v - a.v; });
    var cred = Object.keys(net).filter(function (m) { return net[m] > 0; }).map(function (m) { return { m: m, v: net[m] }; }).sort(function (a, b) { return b.v - a.v; });
    var transfers = [], i = 0, j = 0;
    while (i < debt.length && j < cred.length) { var x = Math.min(debt[i].v, cred[j].v); if (x > 0) transfers.push({ from: debt[i].m, to: cred[j].m, amount: x }); debt[i].v -= x; cred[j].v -= x; if (debt[i].v <= 0) i++; if (cred[j].v <= 0) j++; }
    return { members: Object.keys(paid), total: total, paid: paid, share: share, net: net, transfers: transfers, count: items.length };
  }
  // 원리금균등 상환 계산 (서버 debtCalc_ 와 동일)
  function debtCalc(d) {
    var P = Number(String(d['원금']).replace(/[^\d.-]/g, '')) || 0, r = Number(d['연이율']) || 0, i = r / 1200;
    var n = Number(d['총회차']) || 0, M = Number(String(d['월상환금']).replace(/[^\d.-]/g, '')) || 0;
    if (!n && M && P) n = i > 0 ? Math.ceil(-Math.log(1 - P * i / M) / Math.log(1 + i)) : Math.ceil(P / M);
    if (!M && n && P) M = i > 0 ? Math.round(P * i * Math.pow(1 + i, n) / (Math.pow(1 + i, n) - 1)) : Math.round(P / n);
    var start = String(d['시작일'] || '').substring(0, 10);
    var k = d['납입회차'] === '' || d['납입회차'] == null ? monthsBetween(start, dayKey(nowIso())) : Number(d['납입회차']) || 0;
    if (n) k = Math.min(n, Math.max(0, k));
    var remaining = i > 0 ? P * Math.pow(1 + i, k) - M * (Math.pow(1 + i, k) - 1) / i : P - M * k;
    remaining = Math.max(0, Math.round(remaining)); if (n && k >= n) remaining = 0;
    return { principal: P, rate: r, monthly: M, months: n, paid: k, remaining: remaining, progress: n ? k / n : 0, totalInterest: n && M ? M * n - P : 0, nextDue: start ? addMonths(start, k + 1) : '', endDate: start && n ? addMonths(start, n) : '' };
  }
  function monthsBetween(a, b) { if (!a || !b) return 0; var pa = a.split('-').map(Number), pb = b.split('-').map(Number); var m = (pb[0] - pa[0]) * 12 + (pb[1] - pa[1]); if (pb[2] < pa[2]) m -= 1; return Math.max(0, m); }
  function addMonths(day, n) { var p = day.split('-').map(Number); var d = new Date(p[0], p[1] - 1 + n, 1); var last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(Math.min(p[2], last)); }

  // ------------------------------------------------------------ 데이터 로드
  // 속도: 마지막 bootstrap 응답을 기기에 캐시해 두고, 다음에 열 때 먼저 그려 준 뒤 서버 응답으로 바꾼다.
  // Apps Script 는 첫 응답에 1~3초 걸리므로 이게 체감 속도의 대부분이다.
  function cacheKey(c) { return NS + 'boot.' + (c || 'cur'); }
  function readCache(c) { try { return JSON.parse(localStorage.getItem(cacheKey(c)) || 'null'); } catch (e) { return null; } }
  function writeCache(c, j) { try { localStorage.setItem(cacheKey(c), JSON.stringify(j)); } catch (e) { } }
  function storeBoot(j) { if (settings.local) return; writeCache(j.cycle, j); if (j.config && j.cycle === j.config.currentCycle) writeCache('cur', j); }
  function applyBoot(j) {
    state.config = j.config;
    document.documentElement.setAttribute('data-ledger', j.config.ledgerType);
    state.cycle = j.cycle || state.cycle || j.config.currentCycle;
    state.rows = j.rows; state.summary = j.summary; state.dict = j.dict; state.merchants = j.merchants;
    state.recurring = j.recurring || []; state.due = j.recurringDue || [];
    state.oldBackend = (j.recurring === undefined);   // 옛 Code.gs 는 recurring 을 모른다
    // v3
    state.balance = j.balance || null; state.settlements = j.settlements || []; state.accounts = j.accounts || []; state.debts = j.debts || []; state.events = j.events || [];
    state.itemCounts = j.itemCounts || {}; state.budget = j.budget || null; state.budgetSuggest = j.budgetSuggest || null; state.accountsSum = j.accountsSum || 0; state.groups = j.groups || state.groups || [];
    state.extra = {};                                   // 달력용 다른 사이클 거래는 다시 받는다
  }
  // 입력 폼을 쓰는 중에 화면을 통째로 다시 그리면 입력이 날아가므로, 폼 화면에서는 그리지 않는다 (상태만 바뀌고 다음 이동 때 반영)
  function renderSoft() { if ((state.view === 'add' || state.view === 'edit') && document.querySelector('#txform')) return; render(); }
  function loadAll() {
    state.error = null;
    var cached = settings.local ? null : readCache(state.cycle);
    // 캐시가 "지금 사이클" 것일 때만 먼저 보여준다 (25일이 지나 사이클이 바뀌었으면 서버를 기다린다)
    if (cached && cached.config && (state.cycle || cached.cycle === LedgerParser.cycleMonth(nowIso(), cached.config.cycleStartDay || 25))) { applyBoot(cached); state.loading = false; state.syncing = true; }
    else state.loading = true;
    render();
    var want = state.cycle;
    return api.call('bootstrap', { cycle: state.cycle || '' }).then(function (j) {
      if (want && state.cycle !== want) return;          // 기다리는 사이 다른 사이클로 옮겼으면 버린다
      applyBoot(j); storeBoot(j);
      state.loading = false; state.syncing = false; renderSoft();
      flushQueue();
      loadViewData().catch(function () { });
    }).catch(function (e) { state.loading = false; state.syncing = false; state.error = e.message; renderSoft(); });
  }
  // 화면별로 추가로 받아야 하는 것 (정산 기록 전체, 통장 입출금, 카테고리 통계)
  function loadViewData() {
    if (!hasV3() || !state.config) return Promise.resolve();
    var v = state.view;
    if (v === 'settle') return api.call('settlements', {}).then(function (j) { state.balance = j.balance; state.settlements = j.log; state.settlementsTotal = j.total; renderSoft(); });
    if (v === 'accounts') return api.call('accounts', {}).then(function (j) { state.accounts = j.accounts; state.accountLog = j.log; renderSoft(); return loadAccLog(); });
    if (v === 'categories') return api.call('categories', {}).then(function (j) { state.categoryStats = j.categories; renderSoft(); });
    if (v === 'groups') return api.call('groups', {}).then(function (j) { state.groups = j.groups; renderSoft(); });
    return Promise.resolve();
  }
  // 통장 하나의 전체 입출금 기록 (연도별 합계·잔액 포함)
  function loadAccLog(id) {
    id = id || state.accSel || ((state.accounts || [])[0] || {}).id; if (!id) return Promise.resolve();
    return api.call('accountLog', { id: id }).then(function (j) { state.accLogs[id] = j; if (state.view === 'accounts') renderSoft(); }).catch(function () { });
  }
  function refresh() {
    var want = state.cycle;
    state.syncing = true; renderSoft();
    return api.call('bootstrap', { cycle: want }).then(function (j) {
      if (state.cycle !== want) return;
      applyBoot(j); storeBoot(j); state.loading = false; state.syncing = false; renderSoft();
      return loadViewData();
    }).catch(function (e) { state.loading = false; state.syncing = false; renderSoft(); toast('새로고침 실패: ' + e.message); });
  }

  // 저장 즉시 반영: 서버 응답을 기다리지 않고 화면의 거래·요약을 먼저 고친 뒤, 뒤에서 서버에 보내고 refresh 로 맞춘다.
  function localTx(tx, id) {
    var cur = id ? state.rows.filter(function (r) { return r.id === id; })[0] : null;
    var o = Object.assign({}, cur || {}, tx);
    o['금액'] = Number(o['금액']) || 0;
    o['사이클'] = LedgerParser.cycleMonth(o['일시'], (state.config && state.config.cycleStartDay) || 25);
    if (!o['카테고리']) { var g = LedgerParser.guessCategory(o['가맹점'], state.dict || {}, []); o['카테고리'] = g ? g.category : ''; }
    o['정산'] = isShared() ? (o['정산'] === 'O' ? 'O' : 'X') : '';
    o['계획'] = isShared() ? '' : (o['계획'] === 'Y' ? 'Y' : 'N');
    o['출처'] = o['출처'] || '수동'; o['상태'] = o['상태'] || '확인';
    return o;
  }
  function sortRows() { state.rows.sort(function (a, b) { return a['일시'] < b['일시'] ? 1 : -1; }); }
  // 요약 숫자를 거래 하나만큼 더하거나(+1) 뺀다(-1). 서버 summary_ 와 같은 규칙.
  function bumpSummary(o, sign) {
    var s = state.summary; if (!s || o['사이클'] !== state.cycle || o['상태'] === '취소') return;
    var amt = (Number(o['금액']) || 0) * sign; var cfg = state.config || {}; var who = o['결제인'] || '';
    s.count = (s.count || 0) + sign;
    if (o['유형'] === '수입') { s.income = (s.income || 0) + amt; return; }
    s.expense = (s.expense || 0) + amt;
    var k = o['카테고리'] || '미분류'; s.byCategory[k] = (s.byCategory[k] || 0) + amt; if (!s.byCategory[k]) delete s.byCategory[k];
    s.byPayer[who] = (s.byPayer[who] || 0) + amt; if (!s.byPayer[who]) delete s.byPayer[who];
    if (isShared() && o['정산'] === 'X') {
      s.unsettledByPayer[who] = (s.unsettledByPayer[who] || 0) + amt;
      if (s.unsettledAllByPayer) {
        s.unsettledAllByPayer[who] = (s.unsettledAllByPayer[who] || 0) + amt;
        var m = cfg.members || []; var a = s.unsettledAllByPayer[m[0]] || 0, b = s.unsettledAllByPayer[m[1]] || 0, d = (a - b) / 2;
        s.settlementAll = d === 0 ? null : { from: d > 0 ? m[1] : m[0], to: d > 0 ? m[0] : m[1], amount: Math.round(Math.abs(d)) };
      }
    }
    if (!isShared()) { if (o['계획'] === 'Y') s.planned = (s.planned || 0) + amt; else s.unplanned = (s.unplanned || 0) + amt; }
    if (o['출처'] === '고정') s.fixed = (s.fixed || 0) + amt;
    s.variable = s.expense - (s.fixed || 0);
    var bt = s.budgetTotal || cfg.budgetTotal; if (bt) s.remaining = bt - s.expense;
    bumpBalance(o, sign);
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
    if (state.view !== 'add' && state.view !== 'edit') state.formItems = null;
    else if (state.view === 'edit' && hasV3() && state.editId && state.itemCounts[state.editId] && state.formItems === null) api.call('items', { txId: state.editId }).then(function (j) { if (state.view === 'edit' && state.editId) { state.formItems = j.items; var box = document.getElementById('items'); if (box) render(); } }).catch(function () { });
    if (state.view !== 'list') { state.listAll = null; }
    render();
    window.scrollTo(0, 0);
    if (state.config && (state.view === 'settle' || state.view === 'accounts' || state.view === 'categories' || state.view === 'groups')) loadViewData().catch(function (e) { toast('불러오기 실패: ' + e.message); });
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
    if (!state.oldBackend && !settings.local && state.config && !hasV3() && (state.view === 'home' || state.view === 'more')) html += '<div class="notice info"><b>앱이 새 기능(정산 기록·통장·대출·이벤트·품목·사이클 예산)을 받았습니다.</b> 시트의 서버를 새 Code.gs 로 바꾸고 <b>배포 → 배포 관리 → ✎ → 새 버전</b>을 하면 켜집니다. <a href="' + esc(settings.endpoint) + '" target="_blank" rel="noopener">서버 상태 보기</a> (version 3) <button class="btn small" data-act="retry">다시 확인</button></div>';
    if (state.oldBackend && !settings.local) html += '<div class="notice"><b>시트의 서버가 옛 버전입니다.</b> 거래가 안 보이고 통계·고정 항목이 비어 있을 수 있습니다.<br>시트 → 확장 프로그램 → Apps Script 에 최신 Code.gs 를 붙여 넣고 저장한 뒤, <b>배포 → 배포 관리 → ✎(연필) → 버전 "새 버전" → 배포</b>.<br><a href="' + esc(settings.endpoint) + '" target="_blank" rel="noopener">서버 상태 보기</a> (version 3 이 보이면 완료) <button class="btn small" data-act="retry">다시 확인</button></div>';
    if (state.loading && state.view !== 'more') html += '<div class="empty">불러오는 중…</div>';
    else if (state.config || state.view === 'more') {   // 연결이 안 돼도 설정 화면은 열려야 한다
      switch (state.view) {
        case 'add': html += renderForm(null); break;
        case 'edit': html += renderForm(state.rows.filter(function (r) { return r.id === state.editId; })[0]); break;
        case 'list': html += renderList(); break;
        case 'cal': html += renderCal(); break;
        case 'stats': html += renderStats(); break;
        case 'recurring': html += renderRecurring(); break;
        case 'recapply': html += renderRecApply(); break;
        case 'settle': html += renderSettle(); break;
        case 'accounts': html += renderAccounts(); break;
        case 'debts': html += renderDebts(); break;
        case 'events': html += renderEvents(); break;
        case 'budget': html += renderBudget(); break;
        case 'categories': html += renderCategories(); break;
        case 'groups': html += renderGroups(); break;
        case 'more': html += renderMore(); break;
        default: html += renderHome();
      }
    }
    html += renderNav();
    $app.innerHTML = html;
    if (state.view === 'cal') fitCalAmounts();
    renderToast();
    bind();
  }

  function renderHeader() {
    var title = CFG.name || (isShared() ? '공동 장부' : '내 예산');
    var c = state.cycle || '';
    var showCycle = state.view === 'home' || state.view === 'list' || state.view === 'stats';
    var q = queue().length;
    return '<header class="top"><h1>' + esc(title) + (settings.local ? ' <span class="sub">(체험)</span>' : '') + (state.syncing ? ' <span class="sync" title="서버와 맞추는 중">↻</span>' : '') + (q ? ' <span class="badge" title="연결되면 자동 전송">' + q + '건 대기</span>' : '') + '</h1>' +
      (showCycle ? '<div class="cycle"><button data-act="cycle" data-d="-1" aria-label="이전 달">‹</button><span>' + esc(c) + '<br><small class="muted" style="font-weight:400">' + esc(cycleLabel(c)) + '</small></span><button data-act="cycle" data-d="1" aria-label="다음 달">›</button></div>' : '') +
      '</header>';
  }

  function renderNav() {
    var un = state.summary ? state.summary.unconfirmedTotal : 0;
    function a(v, ico, label, badge) { return '<a href="#' + v + '" class="' + (state.view === v || (v === 'add' && state.view === 'edit') || (v === 'list' && state.view === 'cal') ? 'on' : '') + '"><span class="ico">' + ico + '</span>' + label + (badge ? '<span class="badge">' + badge + '</span>' : '') + '</a>'; }
    return '<nav class="bottom">' + a('home', '⌂', '홈', un) + a('add', '＋', '입력') + a('list', '☰', '목록') + a('stats', '◔', '통계') + a('more', '⋯', '더보기') + '</nav>';
  }

  function renderHome() {
    var s = state.summary; if (!s) return '';
    var h = '';
    var pending = state.rows.filter(function (r) { return r['상태'] === '미확인'; });
    if (pending.length) {
      h += '<div class="card"><h2>확인이 필요한 자동 수집 ' + pending.length + '건</h2>' + pending.map(txRow).join('') + '</div>';
    }
    if (state.due.length) {
      var dueItems = state.recurring.filter(function (r) { return state.due.indexOf(r.id) >= 0; });
      var dueSum = dueItems.reduce(function (a, r) { return a + (r['유형'] === '수입' ? 0 : r['금액']); }, 0);
      h += '<div class="card"><h2>이번 사이클에 아직 반영 안 된 고정 항목 ' + dueItems.length + '건</h2><div class="sub" style="margin-bottom:10px">' + esc(dueItems.map(function (r) { return r['이름'] + ' ' + won(r['금액']); }).join(' · ')) + (dueSum ? ' (지출 ' + won(dueSum) + ')' : '') + '</div><div class="row" style="gap:8px"><button class="btn primary" style="flex:1" data-act="recapply">거래에 반영</button><button class="btn" data-act="goto" data-to="recurring">목록 보기</button></div></div>';
    }
    h += renderQuickCard();
    h += '<div class="card"><h2>이번 사이클 지출</h2><div class="big">' + won(s.expense) + '</div>';
    if (isShared()) {
      h += '<div class="sub" style="margin-top:6px">' + Object.keys(s.byPayer).map(function (p) { return esc(p) + ' ' + won(s.byPayer[p]); }).join(' · ') + '</div>';
    } else {
      var bt = s.budgetTotal || state.config.budgetTotal;
      if (s.remaining != null && bt) {
        var pct = Math.min(100, Math.round(s.expense / bt * 100)); var da = dailyAllowance();
        h += '<div class="sub" style="margin-top:6px">예산 ' + won(bt) + (state.budget && state.budget.isOverride ? ' <span class="muted">(이 사이클)</span>' : '') + ' 중 <b class="' + (s.remaining < 0 ? 'danger' : 'ok') + '">' + (s.remaining < 0 ? '초과 ' : '남음 ') + won(Math.abs(s.remaining)) + '</b>' + (hasV3() ? ' · <a href="#budget">예산 수정</a>' : '') + '</div><div class="bar"><i class="' + (s.remaining < 0 ? 'over' : '') + '" style="width:' + pct + '%"></i></div>';
        if (da && s.remaining > 0) h += '<div class="sub" style="margin-top:6px">오늘부터 ' + da.daysLeft + '일 동안 <b>하루 ' + won(da.perDay) + '</b>씩 쓸 수 있습니다</div>';
      } else if (hasV3()) h += '<div class="sub" style="margin-top:6px"><a href="#budget">예산 정하기 →</a></div>';
      h += '<div class="grid2" style="margin-top:14px"><div><div class="sub">계획</div><b>' + won(s.planned) + '</b></div><div><div class="sub">비계획</div><b>' + won(s.unplanned) + '</b></div></div>';
    }
    if (s.fixed) h += '<div class="sub" style="margin-top:10px">고정 ' + won(s.fixed) + ' · 변동 ' + won(s.variable) + '</div>';
    if (s.income) h += '<div class="sub" style="margin-top:6px">수입 <b class="ok">' + won(s.income) + '</b>' + (s.income > s.expense ? ' · 남는 돈 <b class="ok">' + won(s.income - s.expense) + '</b>' : '') + '</div>';
    h += '<div style="margin-top:10px"><a href="#stats" class="sub">그래프로 보기 →</a> <span class="sub">·</span> <a href="#cal" class="sub">달력으로 보기 →</a></div>';
    h += '</div>';
    if (isShared()) h += renderSettleCard();
    h += renderAccountsCard() + renderDebtsCard() + renderEventsCard() + renderGroupsCard();
    var cats = Object.keys(s.byCategory).sort(function (a, b) { return s.byCategory[b] - s.byCategory[a]; });
    var max = cats.length ? s.byCategory[cats[0]] : 1;
    h += '<div class="card catlist"><h2>카테고리</h2>' + (cats.length ? cats.map(function (c) {
      var b = s.budgets && s.budgets[c]; var v = s.byCategory[c];
      return '<div><div class="row"><span>' + esc(c) + '</span><span><b>' + won(v) + '</b>' + (b ? ' <span class="sub">/ ' + won(b) + '</span>' : '') + '</span></div><div class="bar"><i class="' + (b && v > b ? 'over' : '') + '" style="width:' + Math.round(v / (b || max) * 100) + '%"></i></div></div>';
    }).join('') : '<div class="empty">이 사이클에 거래가 없습니다</div>') + '</div>';
    h += '<button class="btn primary block" data-act="goto" data-to="add">＋ 거래 입력</button>';
    return h;
  }

  // 빠른 입력 칩: 자주 쓰는 가맹점을 누르면 가맹점·카테고리·마지막 금액이 채워진 입력 폼이 열린다
  function quickList() { return (state.merchants || []).filter(function (m) { return m.name && m.type !== '수입'; }); }
  function quickChips(n, cls) {
    var ms = quickList().slice(0, n);
    if (!ms.length) return '';
    return '<div class="chips quick' + (cls ? ' ' + cls : '') + '">' + ms.map(function (m, i) { return '<button type="button" class="chip" data-act="quick" data-i="' + i + '" title="' + esc(m.category || '') + '">' + esc(m.name) + (m.lastAmount ? ' <span class="muted">' + Number(m.lastAmount).toLocaleString('ko-KR') + '</span>' : '') + '</button>'; }).join('') + '</div>';
  }
  function renderQuickCard() {
    var chips = quickChips(8); if (!chips) return '';
    return '<div class="card"><h2>빠른 입력 <span class="muted">자주 쓰는 곳 · 누르면 금액만 확인하고 저장</span></h2>' + chips + '</div>';
  }
  function txRow(r) {
    var cls = 'tx' + (r['상태'] === '미확인' ? ' unconfirmed' : '') + (r['상태'] === '취소' ? ' cancelled' : '');
    var meta = [r['항목'], isShared() ? r['결제인'] + (r['정산'] === 'X' ? ' · 미정산' : '') + (r['분담'] ? ' · ' + shareLabel(r['분담']) : '') : (r['계획'] === 'Y' ? '계획' : ''), r['태그'] ? '#' + r['태그'] : '', state.itemCounts[r.id] ? '품목 ' + state.itemCounts[r.id] : '', r['출처'] !== '수동' && r['출처'] !== '이관' ? r['출처'] : ''].filter(Boolean).join(' · ');
    return '<div class="' + cls + '" data-act="edit" data-id="' + esc(r.id) + '"><span class="cat ' + (r['카테고리'] ? '' : 'none') + '">' + esc(r['카테고리'] || '미분류') + '</span><div class="main"><div class="name">' + esc(r['가맹점'] || '(가맹점 없음)') + '</div><div class="meta">' + esc(meta) + '</div></div><span class="amt ' + (r['유형'] === '수입' ? 'income' : '') + '">' + (r['유형'] === '수입' ? '+' : '') + won(r['금액']) + '</span></div>';
  }

  function viewToggle(cur) {
    return '<div class="seg toggle"><button type="button" class="' + (cur === 'list' ? 'on' : '') + '" data-act="goto" data-to="list">목록</button><button type="button" class="' + (cur === 'cal' ? 'on' : '') + '" data-act="goto" data-to="cal">달력</button></div>';
  }
  function matchQ(r, q) { q = q.toLowerCase(); return ['가맹점', '항목', '카테고리', '결제인', '태그', '원문'].some(function (k) { return String(r[k] || '').toLowerCase().indexOf(q) >= 0; }) || String(r['금액']).indexOf(q.replace(/,/g, '')) >= 0; }
  function renderList() {
    var q = (state.listQ || '').trim(); var f = state.listFilter;
    var all = state.listAll ? state.listAll : state.rows.filter(function (r) { return r['사이클'] === state.cycle; });
    var rows = all.filter(function (r) { return (!q || matchQ(r, q)) && (!f || r[f.key] === f.value); });
    var h = viewToggle('list');
    h += '<div class="searchbar"><input id="listq" type="search" placeholder="가맹점·항목·금액·태그 검색" value="' + esc(q) + '" autocomplete="off">' + (q || f || state.listAll ? '<button class="btn small" data-act="listclear">지우기</button>' : '') + '</div>';
    if (q || f) h += '<div class="sub" style="margin:4px 4px 0">' + (state.listAll ? '전체 기간' : '이 사이클') + '에서 ' + rows.length + '건' + (f ? ' · ' + esc(f.label) : '') + ' · 합계 ' + won(rows.reduce(function (a, r) { return a + (r['유형'] === '수입' ? 0 : r['금액']); }, 0)) + (!state.listAll ? ' · <a href="#list" data-act="listall">전체 기간에서 찾기</a>' : '') + '</div>';
    if (state.listAllLoading) h += '<div class="sub" style="margin:4px">전체 거래 불러오는 중…</div>';
    if (!rows.length) return h + '<div class="empty">' + (q || f ? '찾은 거래가 없습니다' : '이 사이클에 거래가 없습니다') + '</div>';
    h += '<div class="txlist">'; var last = null;
    rows.slice(0, 400).forEach(function (r) { var k = dayKey(r['일시']); if (k !== last) { h += '<div class="day">' + dayLabel(k) + '</div>'; last = k; } h += txRow(r); });
    if (rows.length > 400) h += '<div class="sub" style="text-align:center">400건까지만 표시. 검색어로 좁히세요</div>';
    return h + '</div>';
  }

  // ---- 달력 (토스 가계부처럼: 달 단위, 날짜마다 수입/지출 합계, 누르면 아래에 그날 내역)
  // 달력 한 달은 사이클 두 개에 걸친다 (전달 25일~이달 24일 = 사이클 m-1, 이달 25일~ = 사이클 m). 현재 사이클 밖의 거래는 list 로 받아 state.extra 에 둔다.
  function monthCycles(m) { var sd = (state.config && state.config.cycleStartDay) || 25; return sd > 1 ? [shiftCycle(m, -1), m] : [m]; }
  function rowsForCycle(c) { var r = c === state.cycle ? state.rows : state.extra[c]; return r ? r.filter(function (x) { return x['사이클'] === c; }) : null; }
  function ensureMonth() {
    monthCycles(state.calMonth).forEach(function (c) {
      if (rowsForCycle(c) || state.extraLoading[c]) return;
      state.extraLoading[c] = true;
      api.call('list', { cycle: c }).then(function (j) { state.extra[c] = j.rows || []; }).catch(function (e) { state.extra[c] = []; toast('불러오기 실패: ' + e.message); })
        .then(function () { delete state.extraLoading[c]; if (state.view === 'cal') render(); });
    });
  }
  // 달력 칸의 금액: 1원 단위까지 다 쓰되, 글자 수에 따라 크기를 줄여 칸 밖으로 나가지 않게 한다
  function calAmt(n, cls, sign) {
    var t = sign + Math.round(Math.abs(Number(n) || 0)).toLocaleString('ko-KR');
    var sz = t.length <= 6 ? '' : t.length <= 8 ? ' s1' : t.length <= 10 ? ' s2' : ' s3';
    return '<span class="' + cls + sz + '">' + t + '</span>';
  }
  // 렌더 뒤 실제 너비를 재서, 그래도 칸보다 긴 금액은 글자 크기를 비율대로 더 줄인다 (화면 폭이 어떻든 칸 밖으로 안 나간다)
  function fitCalAmounts() {
    var els = $app.querySelectorAll('.cal-grid .d .inc, .cal-grid .d .exp');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], cw = el.clientWidth, sw = el.scrollWidth;
      if (!cw || sw <= cw) continue;
      var fs = parseFloat(getComputedStyle(el).fontSize) || 10;
      el.style.fontSize = Math.max(5, Math.floor(fs * cw / sw * 10) / 10) + 'px';
    }
  }
  function renderCal() {
    var todayK = dayKey(nowIso());
    if (!state.calMonth) state.calMonth = todayK.substring(0, 7);
    if (state.calDay === null) state.calDay = todayK;
    var m = state.calMonth; var y = +m.split('-')[0], mo = +m.split('-')[1];
    var rows = [], missing = false;
    monthCycles(m).forEach(function (c) { var r = rowsForCycle(c); if (r) rows = rows.concat(r); else missing = true; });
    if (missing) ensureMonth();
    var byDay = {};
    rows.forEach(function (r) { if (r['상태'] === '취소') return; var k = dayKey(r['일시']); var d = byDay[k] || (byDay[k] = { inc: 0, exp: 0, rows: [] }); if (r['유형'] === '수입') d.inc += Number(r['금액']) || 0; else d.exp += Number(r['금액']) || 0; d.rows.push(r); });
    var incT = 0, expT = 0; Object.keys(byDay).forEach(function (k) { if (k.substring(0, 7) === m) { incT += byDay[k].inc; expT += byDay[k].exp; } });
    var startOff = new Date(y, mo - 1, 1).getDay(); var days = new Date(y, mo, 0).getDate();
    var sel = state.calDay && state.calDay.substring(0, 7) === m ? state.calDay : null;
    var sd = (state.config && state.config.cycleStartDay) || 25;
    var h = viewToggle('cal');
    h += '<div class="card cal"><div class="cal-head"><button type="button" data-act="calmonth" data-d="-1" aria-label="이전 달">‹</button><b>' + y + '년 ' + mo + '월</b><button type="button" data-act="calmonth" data-d="1" aria-label="다음 달">›</button></div>';
    h += '<div class="sub" style="text-align:center;margin-bottom:8px">수입 <b class="ok">' + won(incT) + '</b> · 지출 <b>' + won(expT) + '</b>' + (missing ? ' <span class="sync">↻</span>' : '') + '</div>';
    h += '<div class="cal-grid">' + ['일', '월', '화', '수', '목', '금', '토'].map(function (w, i) { return '<div class="wd' + (i === 0 ? ' sun' : '') + '">' + w + '</div>'; }).join('');
    for (var i = 0; i < startOff; i++) h += '<div class="d pad"></div>';
    for (var d = 1; d <= days; d++) {
      var k = m + '-' + p2(d); var v = byDay[k];
      h += '<button type="button" class="d' + (k === todayK ? ' today' : '') + (k === sel ? ' sel' : '') + (d === sd ? ' cyc' : '') + '" data-act="calday" data-k="' + k + '"><span class="n">' + d + '</span>' +
        (v && v.inc ? calAmt(v.inc, 'inc', '+') : '') + (v && v.exp ? calAmt(v.exp, 'exp', '-') : '') + '</button>';
    }
    h += '</div><div class="sub" style="margin-top:8px;font-size:12px">' + sd + '일(세로줄)부터 새 사이클</div></div>';
    if (sel) {
      var v2 = byDay[sel];
      h += '<div class="card"><div class="row"><h2 style="margin:0">' + esc(dayLabel(sel)) + '</h2><button type="button" class="btn small primary" data-act="addon" data-date="' + sel + '">＋ 이 날 입력</button></div>';
      if (v2) { v2.rows.sort(function (a, b) { return a['일시'] < b['일시'] ? 1 : -1; }); h += '<div class="sub" style="margin:8px 0">' + (v2.inc ? '수입 ' + won(v2.inc) + ' · ' : '') + '지출 ' + won(v2.exp) + '</div><div class="txlist">' + v2.rows.map(txRow).join('') + '</div>'; }
      else h += '<div class="empty" style="padding:16px 0">거래가 없습니다</div>';
      h += '</div>';
    } else h += '<div class="empty">날짜를 누르면 그날 내역이 나옵니다</div>';
    return h;
  }

  // ============================================================ v3 화면: 정산 기록 · 통장 · 부채 · 이벤트 · 예산 · 카테고리 정리
  function hasV3() { return settings.local || !!(state.config && state.config.apiVersion >= 3); }
  function v3Notice() { return '<div class="notice">이 화면은 시트의 서버를 새 버전(version 3)으로 배포한 뒤에 쓸 수 있습니다. 더보기 → 연결 아래의 안내를 보세요.</div>'; }
  function kv(label, value, cls) { return '<div class="row kv"><span class="sub">' + label + '</span><b class="' + (cls || '') + '">' + value + '</b></div>'; }
  function fmtDay(iso) { var k = dayKey(iso); return k.length === 10 ? k.substring(5).replace('-', '/') : k; }
  function memberSeg(name, cur, members) { return '<div class="seg" data-name="' + name + '">' + members.map(function (m) { return '<button type="button" class="' + (cur === m ? 'on' : '') + '" data-v="' + esc(m) + '">' + esc(m) + '</button>'; }).join('') + '</div>'; }
  function activeEvents() { return (state.events || []).filter(function (e) { return e['상태'] !== '마감'; }); }
  function shareLabel(v) { var m = state.config.members; if (!v) return '반씩'; if (m.indexOf(v) >= 0) return v + ' 전액'; return v; }

  // ---- 정산 (공동): 지금 누가 누구에게 얼마, 일부 보내기, 기록
  function renderSettleCard() {
    var b = state.balance; var s = state.summary;
    var st = b ? b.remaining : (s && s.settlementAll);
    var h = '<div class="card"><h2>정산</h2>';
    h += '<div class="row"><div>' + (st ? '<div class="big" style="font-size:24px">' + esc(st.from) + ' → ' + esc(st.to) + ' ' + won(st.amount) + '</div><div class="sub">미정산 ' + (b ? b.openTx + '건 · ' : '') + '분담 비율 반영</div>' : '<span class="ok" style="font-weight:700">정산할 금액이 없습니다</span>') + '</div></div>';
    if (hasV3()) h += '<div class="row" style="margin-top:12px;gap:8px">' + (st ? '<button class="btn" style="flex:1" data-act="goto" data-to="settle">일부 보내기</button><button class="btn primary" style="flex:1" data-act="settlefinish">정산 완료</button>' : '<button class="btn" style="flex:1" data-act="goto" data-to="settle">정산 기록 보기</button>') + '</div>';
    else if (st) h += '<div style="margin-top:12px"><button class="btn small primary" data-act="settle">정산 완료</button></div>';
    return h + '</div>';
  }
  function renderSettle() {
    if (!hasV3()) return v3Notice();
    var b = state.balance; var m = state.config.members; var st = b && b.remaining;
    var h = '<div class="card"><h2>지금 정산하면</h2>';
    h += st ? '<div class="big" style="font-size:26px">' + esc(st.from) + ' → ' + esc(st.to) + ' ' + won(st.amount) + '</div>' : '<div class="ok" style="font-weight:700">정산할 금액이 없습니다</div>';
    if (b) {
      h += '<div class="sub" style="margin:8px 0 4px">미정산 지출 ' + b.openTx + '건 ' + won(b.openTxSum) + (b.openPayments ? ' · 그중 이미 보낸 돈 ' + won(b.openPaymentsSum) : '') + '</div>';
      h += '<div class="grid2">' + m.map(function (x) { return '<div><div class="sub">' + esc(x) + ' 낸 돈 / 부담</div><b>' + won(b.paid[x] || 0) + '</b> <span class="sub">/ ' + won(Math.round(b.share[x] || 0)) + '</span></div>'; }).join('') + '</div>';
      var r = state.config.splitRatio || {};
      h += '<div class="sub" style="margin-top:8px">분담 비율 ' + m.map(function (x) { return esc(x) + ' ' + Math.round((r[x] || 0) * 100) + '%'; }).join(' : ') + ' <span class="muted">(시트 설정 SPLIT_RATIO)</span></div>';
    }
    if (st) h += '<button class="btn primary block" style="margin-top:12px" data-act="settlefinish">정산 완료 (' + won(st.amount) + ' 보낸 것으로 기록)</button>';
    h += '</div>';
    // 일부 보내기
    var from = st ? st.from : m[0], to = st ? st.to : m[1];
    h += '<form id="settleform" class="card"><h2>보낸 돈 기록 (일부 정산)</h2>';
    h += '<div class="row" style="gap:8px;flex-wrap:wrap"><div><div class="sub">보낸 사람</div>' + memberSeg('from', from, m) + '</div><div><div class="sub">받는 사람</div>' + memberSeg('to', to, m) + '</div></div>';
    h += '<div class="field" style="margin-top:10px"><label>금액</label><input class="amount-input" name="amount" type="text" inputmode="numeric" placeholder="0" autocomplete="off"></div>';
    h += '<div class="grid2"><div class="field"><label>날짜</label><input name="date" type="date" value="' + dayKey(nowIso()) + '"></div><div class="field"><label>메모</label><input name="memo" type="text" placeholder="예: 11월 정산 일부"></div></div>';
    var evs = activeEvents();
    if (evs.length) h += '<div class="field"><label>이벤트 (선택)</label><div class="chips" data-name="tag">' + evs.map(function (e) { return '<button type="button" class="chip" data-v="' + esc(e['이름']) + '">' + esc(e['이름']) + '</button>'; }).join('') + '</div><input type="hidden" name="tag" value=""></div>';
    h += '<input type="hidden" name="from" value="' + esc(from) + '"><input type="hidden" name="to" value="' + esc(to) + '">';
    h += '<button type="submit" class="btn primary block">기록</button><div class="sub" style="margin-top:8px">남은 금액이 0이 되면 자동으로 정산 완료 처리됩니다.</div></form>';
    // 기록
    var log = state.settlements || [];
    h += '<div class="card"><h2>정산 기록</h2>' + (log.length ? log.map(function (s) {
      return '<div class="row kv"><span><b>' + esc(s['보낸사람']) + ' → ' + esc(s['받는사람']) + '</b> <span class="sub">' + fmtDay(s['일시']) + (s['메모'] ? ' · ' + esc(s['메모']) : '') + (s['태그'] ? ' · ' + esc(s['태그']) : '') + '</span></span><span>' + won(s['금액']) + ' ' + (s['상태'] === '마감' ? '<span class="pill">마감</span>' : '<button class="btn small" data-act="settledel" data-id="' + esc(s.id) + '">삭제</button>') + '</span></div>';
    }).join('') + (state.settlementsTotal > log.length ? '<div class="sub" style="margin-top:6px">최근 ' + log.length + '건만 표시. 전체는 시트 정산 탭</div>' : '') : '<div class="empty" style="padding:12px 0">아직 기록이 없습니다</div>') + '</div>';
    return h;
  }

  // ---- 통장 (공금·비상금)
  function accWord() { return isShared() ? '통장' : '통장 · 목돈'; }
  function goalBar(a) {
    var g = a.goal; if (!g) return '';
    return '<div class="bar" style="margin-top:4px"><i style="width:' + Math.round(g.progress * 100) + '%"></i></div><div class="sub" style="font-size:12px">목표 ' + won(g.target) + ' · ' + (g.remaining ? won(g.remaining) + ' 남음' + (g.etaDate ? ' · 이 속도면 ' + esc(g.etaDate.substring(0, 7).replace('-', '년 ')) + '월' : '') : '달성!') + '</div>';
  }
  function renderAccountsCard() {
    var accs = (state.accounts || []).filter(function (a) { return a['활성'] !== 'N'; });
    if (!accs.length) return hasV3() && !isShared() ? '<div class="card tap" data-act="goto" data-to="accounts"><h2>목돈</h2><div class="sub">저축 목표(목표 금액·날짜)를 만들고 넣은 돈을 기록하면 진행률과 예상 달성 시기가 보입니다 →</div></div>' : '';
    return '<div class="card tap" data-act="goto" data-to="accounts"><h2>' + accWord() + (accs.length > 1 ? ' <span class="muted">합계 ' + won(state.accountsSum || accs.reduce(function (x, a) { return x + a.balance; }, 0)) + '</span>' : '') + '</h2><div class="grid2">' + accs.map(function (a) { return '<div><div class="sub">' + esc(a['이름']) + (a['소유'] ? ' <span class="muted">(' + esc(a['소유']) + ')</span>' : '') + '</div><b>' + won(a.balance) + '</b>' + goalBar(a) + '</div>'; }).join('') + '</div><div class="sub" style="margin-top:8px">누르면 입출금 기록 →</div></div>';
  }
  function renderAccounts() {
    if (!hasV3()) return v3Notice();
    var accs = state.accounts || []; var sel = state.accSel && accs.some(function (a) { return a.id === state.accSel; }) ? state.accSel : (accs[0] && accs[0].id);
    if (!state.accSel) state.accSel = sel;   // 방금 만든 통장이 아직 목록에 없을 때 선택을 첫 통장으로 덮어쓰지 않는다
    var h = '';
    if (state.accEdit) {
      var cur = state.accEdit === 'new' ? {} : (accs.filter(function (a) { return a.id === state.accEdit; })[0] || {});
      var v = Object.assign({ '이름': '', '종류': isShared() ? '공금' : '저축', '소유': '', '메모': '', '활성': 'Y', '목표금액': '', '목표일': '' }, cur);
      h += '<form id="accform" class="card" data-id="' + esc(cur.id || '') + '"><h2>' + (cur.id ? '통장 수정' : '통장 추가') + '</h2>';
      h += '<div class="field"><label>이름 <span class="muted">(바꾸면 기록·카드에 바로 반영)</span></label><input name="이름" type="text" value="' + esc(v['이름']) + '" placeholder="' + (isShared() ? '예: 공금, 지민비상금' : '예: 비상금, 등록금, 자동차 관리비') + '"></div>';
      h += '<div class="row" style="gap:8px;flex-wrap:wrap"><div class="seg" data-name="종류">' + ['공금', '비상금', '저축'].map(function (k) { return '<button type="button" class="' + (v['종류'] === k ? 'on' : '') + '" data-v="' + k + '">' + k + '</button>'; }).join('') + '</div>' + (isShared() ? memberSeg('소유', v['소유'], state.config.members.concat(['공동'])) : '') + '</div>';
      h += '<div class="grid2" style="margin-top:10px"><div class="field"><label>목표 금액 <span class="muted">(목돈 모으기, 선택)</span></label><input name="목표금액" type="text" inputmode="numeric" value="' + esc(v['목표금액'] ? Number(v['목표금액']).toLocaleString('ko-KR') : '') + '" placeholder="예: 10,000,000"></div><div class="field"><label>목표일 <span class="muted">(선택)</span></label><input name="목표일" type="date" value="' + esc(dayKey(v['목표일'] || '')) + '"></div></div>';
      h += '<div class="field"><label>메모</label><input name="메모" type="text" value="' + esc(v['메모']) + '"></div>';
      h += '<input type="hidden" name="종류" value="' + esc(v['종류']) + '"><input type="hidden" name="소유" value="' + esc(v['소유']) + '"><input type="hidden" name="활성" value="' + esc(v['활성']) + '">';
      h += '<div class="row" style="gap:8px">' + (cur.id ? '<button type="button" class="btn danger" data-act="accdel" data-id="' + esc(cur.id) + '">삭제</button><button type="button" class="btn" data-act="acctoggle" data-id="' + esc(cur.id) + '">' + (v['활성'] === 'N' ? '켜기' : '끄기') + '</button>' : '') + '<button type="button" class="btn" data-act="acccancel">취소</button><button type="submit" class="btn primary" style="flex:1">저장</button></div></form>';
    }
    h += '<div class="card"><div class="row"><h2 style="margin:0">' + accWord() + (accs.length > 1 ? ' <span class="muted">합계 ' + won(state.accountsSum || 0) + '</span>' : '') + '</h2><button class="btn small" data-act="accnew">＋ ' + (isShared() ? '통장' : '목돈') + ' 추가</button></div>';
    if (!accs.length) h += '<div class="empty" style="padding:16px 0">' + (isShared() ? '통장이 없습니다. 공금이나 비상금 통장을 추가하고 현재 잔액을 "입금"으로 넣어 시작하세요.' : '목돈 통장이 없습니다. "＋ 목돈 추가"에서 이름·목표 금액·목표일을 넣고, 지금 모아 둔 돈을 "입금"으로 넣어 시작하세요. 매달 넣을 때마다 진행률과 예상 달성 시기가 보입니다.') + '</div>';
    else h += '<div class="chips" style="margin-top:8px">' + accs.map(function (a) { return '<button type="button" class="chip ' + (a.id === sel ? 'on' : '') + (a['활성'] === 'N' ? ' off' : '') + '" data-act="accsel" data-id="' + esc(a.id) + '">' + esc(a['이름']) + ' ' + won(a.balance) + '</button>'; }).join('') + '</div>';
    h += '</div>';
    var acc = accs.filter(function (a) { return a.id === sel; })[0];
    if (acc) {
      h += '<div class="card"><div class="row"><div><h2 style="margin:0">' + esc(acc['이름']) + ' <span class="muted">' + esc(acc['종류']) + (acc['소유'] ? ' · ' + esc(acc['소유']) : '') + '</span></h2><div class="big" style="font-size:26px">' + won(acc.balance) + '</div></div><button class="btn small" data-act="accedit" data-id="' + esc(acc.id) + '">수정</button></div>';
      if (acc.goal) { var g = acc.goal; h += '<div class="bar" style="margin-top:8px"><i style="width:' + Math.round(g.progress * 100) + '%"></i></div><div class="grid2" style="margin-top:8px">' + kv('목표', won(g.target)) + kv('남은 금액', g.remaining ? won(g.remaining) : '달성!', g.remaining ? '' : 'ok') + kv('최근 6개월 월평균', won(g.avgMonthly)) + kv('이 속도면', g.etaDate ? esc(g.etaDate) + (g.etaMonths ? ' (' + g.etaMonths + '개월)' : '') : '적립이 없어 계산 불가') + (g.dueDate ? kv('목표일', esc(g.dueDate)) + kv('목표일까지 매달', g.neededMonthly ? won(g.neededMonthly) : '-') : '') + '</div>'; }
      else if (acc.avgMonthly) h += '<div class="sub" style="margin-top:6px">최근 6개월 월평균 ' + (acc.avgMonthly >= 0 ? '+' : '') + won(acc.avgMonthly) + '</div>';
      h += '<form id="acctxform" class="row" style="gap:8px;margin-top:12px;align-items:flex-end;flex-wrap:wrap"><div class="seg" data-name="구분"><button type="button" class="on" data-v="입금">입금</button><button type="button" data-v="출금">출금</button></div><input type="hidden" name="구분" value="입금"><input type="hidden" name="통장" value="' + esc(acc.id) + '">' +
        '<div class="field" style="flex:1;min-width:120px;margin:0"><input name="금액" type="text" inputmode="numeric" placeholder="금액" autocomplete="off" class="amount-input" style="font-size:20px"></div></form>' +
        '<div class="grid2" style="margin-top:8px"><div class="field" style="margin:0"><input name="일시" form="acctxform" type="date" value="' + dayKey(nowIso()) + '"></div><div class="field" style="margin:0"><input name="메모" form="acctxform" type="text" placeholder="메모 (예: 11월 예산 잔액)"></div></div>' +
        '<button type="submit" form="acctxform" class="btn primary block" style="margin-top:8px">기록</button></div>';
      var others = accs.filter(function (a) { return a.id !== acc.id && a['활성'] !== 'N'; });
      if (others.length) h += '<form id="acctransferform" class="card"><h2>다른 통장으로 옮기기</h2><div class="row" style="gap:8px;flex-wrap:wrap"><div class="seg" data-name="to">' + others.map(function (a, i) { return '<button type="button" class="' + (i === 0 ? 'on' : '') + '" data-v="' + esc(a.id) + '">' + esc(a['이름']) + '</button>'; }).join('') + '</div><input type="hidden" name="to" value="' + esc(others[0].id) + '"><input type="hidden" name="from" value="' + esc(acc.id) + '"><div class="field" style="flex:1;min-width:120px;margin:0"><input name="amount" type="text" inputmode="numeric" placeholder="금액" autocomplete="off"></div></div><div class="grid2" style="margin-top:8px"><div class="field" style="margin:0"><input name="date" type="date" value="' + dayKey(nowIso()) + '"></div><div class="field" style="margin:0"><input name="memo" type="text" placeholder="메모"></div></div><button type="submit" class="btn block" style="margin-top:8px">' + esc(acc['이름']) + ' → 옮기기</button></form>';
      h += renderAccLog(acc);
    }
    return h;
  }

  // 입출금 기록: 연도별 표 (날짜 · 입금 · 출금 · 잔액 · 메모), 연도 머리에 합계, 올해만 펼침. 줄의 ✎ 로 수정, ✕ 로 삭제
  function renderAccLog(acc) {
    var data = state.accLogs[acc.id];
    if (!data) return '<div class="card"><h2>입출금 기록</h2><div class="sub">불러오는 중…</div></div>';
    if (!data.log.length) return '<div class="card"><h2>입출금 기록</h2><div class="empty" style="padding:12px 0">기록이 없습니다</div></div>';
    var openY = state.accYear[acc.id] !== undefined ? state.accYear[acc.id] : data.years[0].year;
    var h = '<div class="card"><h2>입출금 기록 <span class="muted">' + data.log.length + '건</span></h2>';
    data.years.forEach(function (y) {
      var open = y.year === openY;
      h += '<div class="yearhead' + (open ? ' open' : '') + '" data-act="accyear" data-y="' + y.year + '"><b>' + y.year + '년</b><span class="sub">입금 <b class="ok">' + won(y.in) + '</b> · 출금 <b class="danger">' + won(y.out) + '</b> · 순 <b>' + (y.in - y.out >= 0 ? '+' : '−') + won(Math.abs(y.in - y.out)) + '</b> · ' + y.count + '건</span><span class="muted">' + (open ? '▴' : '▾') + '</span></div>';
      if (!open) return;
      h += '<table class="tbl"><thead><tr><th>날짜</th><th class="r">입금</th><th class="r">출금</th><th class="r">잔액</th><th>메모</th><th></th></tr></thead><tbody>';
      data.log.filter(function (t) { return String(t['일시']).substring(0, 4) === y.year; }).forEach(function (t) {
        if (state.accTxEdit === t.id) {
          h += '<tr><td colspan="6"><form id="acctxeditform" data-id="' + esc(t.id) + '" class="row" style="gap:6px;flex-wrap:wrap"><input name="일시" type="date" value="' + esc(dayKey(t['일시'])) + '" style="width:140px"><div class="seg" data-name="구분"><button type="button" class="' + (t['구분'] !== '출금' ? 'on' : '') + '" data-v="입금">입금</button><button type="button" class="' + (t['구분'] === '출금' ? 'on' : '') + '" data-v="출금">출금</button></div><input type="hidden" name="구분" value="' + esc(t['구분']) + '"><input name="금액" type="text" inputmode="numeric" value="' + esc(Number(t['금액']).toLocaleString('ko-KR')) + '" style="width:110px;text-align:right"><input name="메모" type="text" value="' + esc(t['메모'] || '') + '" placeholder="메모" style="flex:1;min-width:120px"><button type="submit" class="btn small primary">저장</button><button type="button" class="btn small" data-act="acctxcancel">취소</button></form></td></tr>';
          return;
        }
        h += '<tr><td class="nowrap">' + esc(String(t['일시']).substring(5, 10).replace('-', '/')) + '</td><td class="r ok">' + (t['구분'] === '출금' ? '' : won(t['금액'])) + '</td><td class="r danger">' + (t['구분'] === '출금' ? won(t['금액']) : '') + '</td><td class="r">' + won(t.balance) + '</td><td class="memo">' + esc(t['메모'] || '') + '</td><td class="nowrap"><button class="btn small" data-act="acctxedit" data-id="' + esc(t.id) + '" title="수정">✎</button> <button class="btn small" data-act="acctxdel" data-id="' + esc(t.id) + '" title="삭제">✕</button></td></tr>';
      });
      h += '</tbody></table>';
    });
    return h + '</div>';
  }

  // ---- 부채 (대출)
  function renderDebtsCard() {
    var ds = (state.debts || []).filter(function (d) { return d['활성'] !== 'N' && d.calc.remaining > 0; });
    if (!ds.length) return '';
    return '<div class="card tap" data-act="goto" data-to="debts"><h2>대출</h2>' + ds.map(function (d) {
      return '<div class="row kv"><span>' + esc(d['이름']) + ' <span class="sub">' + d.calc.paid + '/' + d.calc.months + '회</span></span><b>남은 원금 ' + won(d.calc.remaining) + '</b></div><div class="bar"><i style="width:' + Math.round(d.calc.progress * 100) + '%"></i></div>';
    }).join('') + '</div>';
  }
  function renderDebts() {
    if (!hasV3()) return v3Notice();
    var ds = state.debts || []; var h = '';
    if (state.debtEdit) {
      var cur = state.debtEdit === 'new' ? {} : (ds.filter(function (d) { return d.id === state.debtEdit; })[0] || {});
      var v = Object.assign({ '이름': '', '기관': '', '원금': '', '연이율': '', '월상환금': '', '시작일': dayKey(nowIso()), '총회차': '', '납입회차': '', '소유': me(), '메모': '', '활성': 'Y' }, cur);
      h += '<form id="debtform" class="card" data-id="' + esc(cur.id || '') + '"><h2>' + (cur.id ? '대출 수정' : '대출 추가') + '</h2>';
      h += '<div class="field"><label>이름</label><input name="이름" type="text" value="' + esc(v['이름']) + '" placeholder="예: 지민 자동차 대출"></div>';
      h += '<div class="grid2"><div class="field"><label>기관</label><input name="기관" type="text" value="' + esc(v['기관']) + '"></div><div class="field"><label>시작일 (첫 납입 기준)</label><input name="시작일" type="date" value="' + esc(dayKey(v['시작일'])) + '"></div></div>';
      h += '<div class="field"><label>원금</label><input name="원금" type="text" inputmode="numeric" class="amount-input" value="' + esc(v['원금'] ? Number(v['원금']).toLocaleString('ko-KR') : '') + '" placeholder="0"></div>';
      h += '<div class="grid2"><div class="field"><label>연이율 (%)</label><input name="연이율" type="number" step="0.01" value="' + esc(v['연이율']) + '"></div><div class="field"><label>월상환금</label><input name="월상환금" type="text" inputmode="numeric" value="' + esc(v['월상환금'] ? Number(v['월상환금']).toLocaleString('ko-KR') : '') + '" placeholder="비우면 총회차로 계산"></div></div>';
      h += '<div class="grid2"><div class="field"><label>총회차 (개월)</label><input name="총회차" type="number" value="' + esc(v['총회차']) + '" placeholder="비우면 월상환금으로 계산"></div><div class="field"><label>납입한 회차</label><input name="납입회차" type="number" value="' + esc(v['납입회차']) + '" placeholder="비우면 시작일부터 자동"></div></div>';
      if (isShared()) h += '<div class="field"><label>누구 대출</label>' + memberSeg('소유', v['소유'], state.config.members) + '<input type="hidden" name="소유" value="' + esc(v['소유']) + '"></div>';
      h += '<div class="field"><label>메모</label><input name="메모" type="text" value="' + esc(v['메모']) + '" placeholder="예: 원리금 균등"></div><input type="hidden" name="활성" value="' + esc(v['활성']) + '">';
      h += '<div class="row" style="gap:8px">' + (cur.id ? '<button type="button" class="btn danger" data-act="debtdel" data-id="' + esc(cur.id) + '">삭제</button>' : '') + '<button type="button" class="btn" data-act="debtcancel">취소</button><button type="submit" class="btn primary" style="flex:1">저장</button></div></form>';
    } else h += '<button class="btn primary block" data-act="debtnew">＋ 대출 추가</button>';
    if (!ds.length) h += '<div class="empty">등록된 대출이 없습니다.' + (isShared() ? '<br>옛 시트의 대출 상환 표는 시트 메뉴 "가계부 앱 → 대출 상환 표 → 부채 이관"으로 가져옵니다.' : '') + '</div>';
    ds.forEach(function (d) {
      var c = d.calc; var pct = Math.round(c.progress * 100);
      h += '<div class="card' + (d['활성'] === 'N' ? ' off' : '') + '"><div class="row"><h2 style="margin:0">' + esc(d['이름']) + (d['기관'] ? ' <span class="muted">' + esc(d['기관']) + '</span>' : '') + '</h2><button class="btn small" data-act="debtedit" data-id="' + esc(d.id) + '">수정</button></div>';
      h += '<div class="big" style="font-size:26px;margin-top:6px">' + won(c.remaining) + '<span class="sub" style="font-size:14px;font-weight:400"> 남음</span></div>';
      h += '<div class="bar"><i style="width:' + pct + '%"></i></div><div class="sub">' + c.paid + ' / ' + c.months + '회 납입 (' + pct + '%) · ' + (c.months - c.paid) + '회 남음</div>';
      h += '<div class="grid2" style="margin-top:10px">' + kv('원금', won(c.principal)) + kv('연이율', c.rate + '%') + kv('월 상환', won(c.monthly)) + kv('총 이자', won(Math.round(c.totalInterest))) + kv('다음 납입', c.remaining > 0 ? esc(c.nextDue) : '완납') + kv('완납 예정', esc(c.endDate)) + '</div>';
      var linked = state.recurring.some(function (r) { return r['메모'] === '부채:' + d.id; });
      if (c.remaining > 0 && !linked) h += '<button class="btn block" style="margin-top:10px" data-act="debtrec" data-id="' + esc(d.id) + '">매달 고정 지출로 등록 (' + won(c.monthly) + ')</button>';
      else if (linked) h += '<div class="sub" style="margin-top:8px">고정 지출로 등록됨 → <a href="#recurring">고정 항목</a></div>';
      h += '</div>';
    });
    return h;
  }

  // ---- 이벤트 (여행 등 태그로 묶어 보기)
  function renderEventsCard() {
    var evs = activeEvents(); if (!evs.length) return '';
    return '<div class="card tap" data-act="goto" data-to="events"><h2>진행 중인 이벤트</h2>' + evs.map(function (e) { return '<div class="row kv"><span>' + esc(e['이름']) + ' <span class="sub">' + e.stats.count + '건</span></span><b>' + won(e.stats.expense) + '</b></div>'; }).join('') + '</div>';
  }
  function renderEvents() {
    if (!hasV3()) return v3Notice();
    var evs = state.events || []; var h = '';
    if (state.evtEdit) {
      var cur = state.evtEdit === 'new' ? {} : (evs.filter(function (e) { return e.id === state.evtEdit; })[0] || {});
      var v = Object.assign({ '이름': '', '시작일': dayKey(nowIso()), '종료일': '', '메모': '', '상태': '진행' }, cur);
      h += '<form id="evtform" class="card" data-id="' + esc(cur.id || '') + '"><h2>' + (cur.id ? '이벤트 수정' : '이벤트 추가') + '</h2>';
      h += '<div class="field"><label>이름 (거래에 붙는 태그)</label><input name="이름" type="text" value="' + esc(v['이름']) + '" placeholder="예: 제주여행, 이사"></div>';
      h += '<div class="grid2"><div class="field"><label>시작</label><input name="시작일" type="date" value="' + esc(dayKey(v['시작일'])) + '"></div><div class="field"><label>끝</label><input name="종료일" type="date" value="' + esc(dayKey(v['종료일'])) + '"></div></div>';
      h += '<div class="field"><label>메모</label><input name="메모" type="text" value="' + esc(v['메모']) + '"></div>';
      h += '<div class="seg" data-name="상태"><button type="button" class="' + (v['상태'] !== '마감' ? 'on' : '') + '" data-v="진행">진행 중</button><button type="button" class="' + (v['상태'] === '마감' ? 'on' : '') + '" data-v="마감">마감</button></div><input type="hidden" name="상태" value="' + esc(v['상태']) + '">';
      h += '<div class="row" style="gap:8px;margin-top:12px">' + (cur.id ? '<button type="button" class="btn danger" data-act="evtdel" data-id="' + esc(cur.id) + '">삭제</button>' : '') + '<button type="button" class="btn" data-act="evtcancel">취소</button><button type="submit" class="btn primary" style="flex:1">저장</button></div></form>';
    } else h += '<button class="btn primary block" data-act="evtnew">＋ 이벤트 추가</button><div class="sub" style="margin:8px 4px">여행처럼 따로 모아 보고 싶은 지출은 입력할 때 이벤트 태그를 고르세요. 미리 보낸 돈은 정산 화면에서 같은 태그로 기록하면 여기에 함께 나옵니다.</div>';
    if (!evs.length) h += '<div class="empty">이벤트가 없습니다</div>';
    evs.forEach(function (e) {
      var st = e.stats; var payers = Object.keys(st.byPayer);
      h += '<div class="card' + (e['상태'] === '마감' ? ' off' : '') + '"><div class="row"><h2 style="margin:0">' + esc(e['이름']) + ' ' + (e['상태'] === '마감' ? '<span class="pill">마감</span>' : '') + '</h2><button class="btn small" data-act="evtedit" data-id="' + esc(e.id) + '">수정</button></div>';
      h += '<div class="sub">' + esc(dayKey(e['시작일'])) + (e['종료일'] ? ' ~ ' + esc(dayKey(e['종료일'])) : '') + (e['메모'] ? ' · ' + esc(e['메모']) : '') + '</div>';
      h += '<div class="big" style="font-size:26px;margin-top:6px">' + won(st.expense) + '<span class="sub" style="font-size:14px;font-weight:400"> · ' + st.count + '건</span></div>';
      if (payers.length) h += '<div class="sub" style="margin-top:6px">' + payers.map(function (p) { return esc(p) + ' ' + won(st.byPayer[p]); }).join(' · ') + '</div>';
      var cats = Object.keys(st.byCategory).sort(function (a, b) { return st.byCategory[b] - st.byCategory[a]; });
      if (cats.length) h += '<div class="sub" style="margin-top:4px">' + cats.map(function (c) { return esc(c) + ' ' + won(st.byCategory[c]); }).join(' · ') + '</div>';
      if (e.payments && e.payments.length) h += '<div class="sub" style="margin-top:6px">보낸 돈: ' + e.payments.map(function (p) { return esc(p['보낸사람']) + '→' + esc(p['받는사람']) + ' ' + won(p['금액']); }).join(', ') + '</div>';
      if (isShared() && payers.length === 2 && state.config.members.length === 2) {
        var r = state.config.splitRatio || {}; var m = state.config.members;
        var net = (st.byPayer[m[0]] || 0) - st.expense * (r[m[0]] || 0.5);
        (e.payments || []).forEach(function (p) { if (p['보낸사람'] === m[0]) net += p['금액']; else net -= p['금액']; });
        net = Math.round(net);
        h += '<div style="margin-top:8px"><b>' + (net === 0 ? '이 이벤트는 정산이 맞습니다' : (net > 0 ? esc(m[1]) + ' → ' + esc(m[0]) : esc(m[0]) + ' → ' + esc(m[1])) + ' ' + won(Math.abs(net))) + '</b> <span class="sub">(이벤트만 따로 계산)</span></div>';
      }
      h += '<div style="margin-top:8px"><a href="#list" class="sub" data-act="evtfilter" data-tag="' + esc(e['이름']) + '">거래 보기 →</a></div></div>';
    });
    return h;
  }

  // ---- 모임 정산 (회식·학회·여행 n빵): 항목마다 낸 사람과 참여자, 자동으로 누가 누구에게
  function renderGroupsCard() {
    var gs = (state.groups || []).filter(function (g) { return g['상태'] !== '마감'; }); if (!gs.length) return '';
    return '<div class="card tap" data-act="goto" data-to="groups"><h2>진행 중인 모임 정산</h2>' + gs.map(function (g) { var mine = g.calc.net[me()]; return '<div class="row kv"><span>' + esc(g['이름']) + ' <span class="sub">' + g.calc.count + '건 · ' + won(g.calc.total) + '</span></span><b class="' + (mine > 0 ? 'ok' : mine < 0 ? 'danger' : '') + '">' + (mine === undefined ? '' : (mine > 0 ? '받을 ' : mine < 0 ? '줄 ' : '') + won(Math.abs(mine))) + '</b></div>'; }).join('') + '</div>';
  }
  function renderGroups() {
    if (!hasV3()) return v3Notice();
    var gs = state.groups || []; var h = '';
    if (state.groupEdit) {
      var cur = state.groupEdit === 'new' ? {} : (gs.filter(function (g) { return g.id === state.groupEdit; })[0] || {});
      var v = Object.assign({ '이름': '', '날짜': dayKey(nowIso()), '참여자': me(), '메모': '', '상태': '진행' }, cur);
      h += '<form id="groupform" class="card" data-id="' + esc(cur.id || '') + '"><h2>' + (cur.id ? '모임 수정' : '모임 만들기') + '</h2>';
      h += '<div class="field"><label>이름</label><input name="이름" type="text" value="' + esc(v['이름']) + '" placeholder="예: 학회 회식, 제주 출장"></div>';
      h += '<div class="grid2"><div class="field"><label>날짜</label><input name="날짜" type="date" value="' + esc(dayKey(v['날짜'])) + '"></div><div class="field"><label>상태</label><div class="seg" data-name="상태"><button type="button" class="' + (v['상태'] !== '마감' ? 'on' : '') + '" data-v="진행">진행</button><button type="button" class="' + (v['상태'] === '마감' ? 'on' : '') + '" data-v="마감">마감</button></div><input type="hidden" name="상태" value="' + esc(v['상태']) + '"></div></div>';
      h += '<div class="field"><label>참여자 <span class="muted">(쉼표로 구분, 나 포함)</span></label><input name="참여자" type="text" value="' + esc(v['참여자']) + '" placeholder="예: 덕우, 준호, 언택"></div>';
      h += '<div class="field"><label>메모</label><input name="메모" type="text" value="' + esc(v['메모']) + '"></div>';
      h += '<div class="row" style="gap:8px">' + (cur.id ? '<button type="button" class="btn danger" data-act="groupdel" data-id="' + esc(cur.id) + '">삭제</button>' : '') + '<button type="button" class="btn" data-act="groupcancel">취소</button><button type="submit" class="btn primary" style="flex:1">저장</button></div></form>';
      return h;
    }
    h += '<div class="row" style="margin-top:12px"><h2 style="margin:0">모임 정산</h2><button class="btn small primary" data-act="groupnew">＋ 모임</button></div>';
    if (!gs.length) return h + '<div class="empty">회식·학회·여행처럼 여러 명이 나눠 내는 자리를 만들고, 항목마다 "누가 냈나"와 "누가 먹었나"만 적으면 누가 누구에게 얼마를 보내야 하는지 계산해 줍니다.</div>';
    var sel = state.groupSel && gs.some(function (g) { return g.id === state.groupSel; }) ? state.groupSel : gs[0].id;
    h += '<div class="chips" style="margin:10px 0">' + gs.map(function (g) { return '<button type="button" class="chip ' + (g.id === sel ? 'on' : '') + (g['상태'] === '마감' ? ' off' : '') + '" data-act="groupsel" data-id="' + esc(g.id) + '">' + esc(g['이름']) + '</button>'; }).join('') + '</div>';
    var g = gs.filter(function (x) { return x.id === sel; })[0]; var c = g.calc; var members = String(g['참여자']).split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    h += '<div class="card"><div class="row"><div><h2 style="margin:0">' + esc(g['이름']) + ' ' + (g['상태'] === '마감' ? '<span class="pill">마감</span>' : '') + '</h2><div class="sub">' + esc(dayKey(g['날짜'])) + ' · ' + esc(members.join(', ')) + (g['메모'] ? ' · ' + esc(g['메모']) : '') + '</div></div><button class="btn small" data-act="groupedit" data-id="' + esc(g.id) + '">수정</button></div>';
    h += '<div class="big" style="font-size:26px;margin-top:6px">' + won(c.total) + '<span class="sub" style="font-size:14px;font-weight:400"> · ' + c.count + '건 · 1인 평균 ' + won(Math.round(c.total / Math.max(1, members.length))) + '</span></div>';
    h += '<div style="margin-top:10px">' + c.members.map(function (m) { var n = c.net[m]; return '<div class="row kv"><span>' + esc(m) + ' <span class="sub">낸 돈 ' + won(c.paid[m]) + ' / 부담 ' + won(Math.round(c.share[m])) + '</span></span><b class="' + (n > 0 ? 'ok' : n < 0 ? 'danger' : '') + '">' + (n > 0 ? '받을 ' : n < 0 ? '줄 ' : '정산 끝 ') + (n ? won(Math.abs(n)) : '') + '</b></div>'; }).join('') + '</div>';
    if (c.transfers.length) h += '<div class="notice info" style="margin:10px 0 0">' + c.transfers.map(function (t) { return '<div><b>' + esc(t.from) + ' → ' + esc(t.to) + ' ' + won(t.amount) + '</b> <button class="btn small" data-act="grouppaid" data-from="' + esc(t.from) + '" data-to="' + esc(t.to) + '" data-amt="' + t.amount + '">보냈음</button></div>'; }).join('') + '</div>';
    else if (c.count) h += '<div class="sub ok" style="margin-top:8px;font-weight:700">정산이 모두 맞습니다</div>';
    h += '</div>';
    // 항목 추가
    h += '<form id="groupitemform" class="card"><h2>항목 추가</h2><input type="hidden" name="모임id" value="' + esc(g.id) + '">';
    h += '<div class="row" style="gap:8px"><div class="field" style="flex:1;margin:0"><input name="항목" type="text" placeholder="예: 1차 고기, 택시"></div><div class="field" style="width:130px;margin:0"><input name="금액" type="text" inputmode="numeric" placeholder="금액" class="amount-input" style="font-size:20px"></div></div>';
    h += '<div class="field" style="margin-top:10px"><label>낸 사람</label><div class="chips" data-name="낸사람">' + members.map(function (m, i) { return '<button type="button" class="chip ' + (m === me() || (!members.some(function (x) { return x === me(); }) && i === 0) ? 'on' : '') + '" data-v="' + esc(m) + '">' + esc(m) + '</button>'; }).join('') + '</div><input type="hidden" name="낸사람" value="' + esc(members.indexOf(me()) >= 0 ? me() : members[0]) + '"></div>';
    h += '<div class="field"><label>먹은 사람 <span class="muted">(누르면 제외, 기본은 전원)</span></label><div class="chips multi" data-name="참여자">' + members.map(function (m) { return '<button type="button" class="chip on" data-v="' + esc(m) + '">' + esc(m) + '</button>'; }).join('') + '</div><input type="hidden" name="참여자" value=""></div>';
    h += '<div class="grid2"><div class="field"><input name="일자" type="date" value="' + esc(dayKey(g['날짜'])) + '"></div><div class="field"><input name="메모" type="text" placeholder="메모"></div></div><button type="submit" class="btn primary block">추가</button></form>';
    // 항목·납입 목록
    h += '<div class="card"><h2>항목</h2>' + (g.items.length ? g.items.map(function (it) { return '<div class="row kv"><span><b>' + esc(it['항목']) + '</b> <span class="sub">' + esc(dayKey(it['일자'])) + ' · ' + esc(it['낸사람'] || '?') + ' 냄 · ' + (it['참여자'] ? esc(it['참여자']) : '전원') + (it['메모'] ? ' · ' + esc(it['메모']) : '') + '</span></span><span>' + won(it['금액']) + ' <button class="btn small" data-act="groupitemdel" data-id="' + esc(it.id) + '">✕</button></span></div>'; }).join('') : '<div class="empty" style="padding:12px 0">항목이 없습니다</div>');
    if (g.payments.length) h += '<h2 style="margin-top:14px">보낸 돈</h2>' + g.payments.map(function (p) { return '<div class="row kv"><span>' + esc(p['보낸사람']) + ' → ' + esc(p['받는사람']) + ' <span class="sub">' + esc(dayKey(p['일자'])) + (p['메모'] ? ' · ' + esc(p['메모']) : '') + '</span></span><span>' + won(p['금액']) + ' <button class="btn small" data-act="grouppaydel" data-id="' + esc(p.id) + '">✕</button></span></div>'; }).join('');
    h += '</div>';
    return h;
  }

  // ---- 예산 (개인): 사이클별 총예산·카테고리별 예산
  function dailyAllowance() {
    var s = state.summary; if (!s || s.remaining == null || !state.cycle) return null;
    var r = LedgerParser.cycleRange(state.cycle, state.config.cycleStartDay); var now = new Date();
    if (now < r.start || now >= r.end) return null;
    var left = Math.max(1, Math.ceil((r.end.getTime() - now.getTime()) / 86400000));
    return { perDay: Math.floor(s.remaining / left), daysLeft: left };
  }
  function renderBudget() {
    if (!hasV3()) return v3Notice();
    var b = state.budget || { total: state.config.budgetTotal, byCategory: {}, isOverride: false, overrides: {} };
    var sg = state.budgetSuggest; var s = state.summary || {};
    var h = '<form id="budgetform" class="card"><h2>' + esc(state.cycle) + ' 사이클 예산 <span class="muted">(' + esc(cycleLabel(state.cycle)) + ')</span></h2>';
    h += '<div class="field"><label>총 예산' + (b.isOverride ? ' <span class="muted">(이 사이클만)</span>' : ' <span class="muted">(기본값 ' + won(state.config.budgetTotal || 0) + ')</span>') + '</label><input class="amount-input" name="total" type="text" inputmode="numeric" value="' + esc(b.total ? Number(b.total).toLocaleString('ko-KR') : '') + '" placeholder="비우면 기본값"></div>';
    if (sg) h += '<div class="sub" style="margin:-4px 0 10px">제안: 고정 수입 ' + won(sg.fixedIncome) + ' − 고정 지출 ' + won(sg.fixedExpense) + ' = <b>' + won(sg.free) + '</b> · 최근 3사이클 평균 지출 <b>' + won(sg.avgExpense) + '</b> ' + (sg.free > 0 ? '<button type="button" class="btn small" data-act="budgetuse" data-v="' + sg.free + '">제안값 넣기</button>' : '') + '</div>';
    h += '<h2 style="margin-top:14px">카테고리별 예산 <span class="muted">(비우면 없음)</span></h2>';
    var cats = state.config.categories.slice(); Object.keys(b.byCategory).forEach(function (c) { if (cats.indexOf(c) < 0) cats.push(c); });
    h += cats.map(function (c) { var v = b.byCategory[c]; var spent = (s.byCategory || {})[c] || 0; return '<div class="row kv"><span>' + esc(c) + ' <span class="sub">쓴 돈 ' + won(spent) + '</span></span><input name="cat:' + esc(c) + '" type="text" inputmode="numeric" value="' + esc(v ? Number(v).toLocaleString('ko-KR') : '') + '" placeholder="0" style="width:120px;text-align:right"></div>'; }).join('');
    h += '<button type="submit" class="btn primary block" style="margin-top:12px">저장</button><div class="sub" style="margin-top:8px">사이클별 값은 시트 "예산" 탭에, 기본값은 설정 탭 BUDGET_TOTAL 에 있습니다.</div></form>';
    return h;
  }

  // ---- 카테고리 정리 (이름 바꾸기 = 합치기)
  function renderCategories() {
    if (!hasV3()) return v3Notice();
    var cs = state.categoryStats;
    var h = '<div class="card"><h2>카테고리 정리</h2><p class="sub" style="margin:0 0 10px">이름을 바꾸면 거래·고정 항목·사전·예산이 전부 따라 바뀝니다. 이미 있는 이름으로 바꾸면 그 카테고리에 합쳐집니다 (예: 식비 → 외식).</p>';
    if (!cs) { h += '<div class="empty">불러오는 중…</div></div>'; return h; }
    h += cs.map(function (c) { return '<div class="row kv"><span>' + (c.name ? esc(c.name) : '<i class="muted">(빈칸)</i>') + (c.inConfig ? '' : ' <span class="pill warn">설정에 없음</span>') + ' <span class="sub">' + c.count + '건 · ' + won(c.sum) + '</span></span>' + (c.name ? '<button class="btn small" data-act="catrename" data-v="' + esc(c.name) + '">바꾸기</button>' : '') + '</div>'; }).join('');
    h += '</div>';
    return h;
  }

  function renderForm(row) {
    var pf = state.prefill; var edit = !!row;
    var v = Object.assign({ '일시': nowIso(), '유형': '지출', '금액': '', '가맹점': '', '카테고리': '', '항목': '', '결제인': me(), '정산': 'X', '계획': 'N', '출처': '수동', '원문': '' }, row || {}, (!edit && pf) ? pf.tx : {});
    var cats = state.config.categories.slice(); if (v['카테고리'] && cats.indexOf(v['카테고리']) < 0) cats.push(v['카테고리']);
    var h = '<form id="txform" class="card" data-id="' + esc(row ? row.id : '') + '">';
    if (!edit && pf && pf.note) h += '<div class="notice ' + (pf.tx['금액'] ? 'info' : '') + '">' + esc(pf.note) + (pf.raw ? '<details class="raw"><summary>읽은 원문</summary><pre>' + esc(pf.raw) + '</pre></details>' : '') + '</div>';
    if (edit && row['상태'] === '미확인') h += '<div class="notice">자동 수집된 거래입니다. 내용을 확인하고 저장하면 확인 처리됩니다.' + (row['원문'] ? '<details class="raw"><summary>원문</summary><pre>' + esc(row['원문']) + '</pre></details>' : '') + '</div>';
    h += '<div class="row"><div class="seg" data-name="유형"><button type="button" class="' + (v['유형'] === '지출' ? 'on' : '') + '" data-v="지출">지출</button><button type="button" class="' + (v['유형'] === '수입' ? 'on' : '') + '" data-v="수입">수입</button></div>';
    if (isShared()) h += '<div class="seg" data-name="결제인">' + state.config.members.map(function (m) { return '<button type="button" class="' + (v['결제인'] === m ? 'on' : '') + '" data-v="' + esc(m) + '">' + esc(m) + '</button>'; }).join('') + '</div>';
    else h += '<div class="seg" data-name="계획"><button type="button" class="' + (v['계획'] === 'Y' ? 'on' : '') + '" data-v="Y">계획</button><button type="button" class="' + (v['계획'] !== 'Y' ? 'on' : '') + '" data-v="N">비계획</button></div>';
    h += '</div>';
    h += '<div class="field"><label>금액</label><input class="amount-input" name="금액" type="text" inputmode="numeric" placeholder="0" value="' + esc(v['금액'] ? Number(v['금액']).toLocaleString('ko-KR') : '') + '" autocomplete="off"></div>';
    h += '<div class="field"><label>가맹점</label>' + (!edit && !v['가맹점'] ? quickChips(6, 'inform') : '') + '<input name="가맹점" type="text" list="merchants" value="' + esc(v['가맹점']) + '" placeholder="예: 농수축산물마트" autocomplete="off"><datalist id="merchants">' + state.merchants.map(function (m) { return '<option value="' + esc(m.name) + '">'; }).join('') + '</datalist></div>';
    h += '<div class="field"><label>카테고리 <span id="cat-hint" class="muted"></span></label><div class="chips" data-name="카테고리">' + cats.map(function (c) { return '<button type="button" class="chip ' + (v['카테고리'] === c ? 'on' : '') + '" data-v="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') + '<button type="button" class="chip" data-act="newcat">＋ 새 카테고리</button></div><input type="hidden" name="카테고리" value="' + esc(v['카테고리']) + '"></div>';
    h += '<div class="field"><label>항목 / 메모</label><input name="항목" type="text" value="' + esc(v['항목']) + '" placeholder="예: 고기, 자동차세"></div>';
    h += '<div class="field"><label>날짜</label><input name="일시" type="date" value="' + esc(String(v['일시']).substring(0, 10)) + '"></div>';
    if (isShared() && hasV3()) h += '<div class="field"><label>분담 <span class="muted">(누가 부담하나)</span></label><div class="seg" data-name="분담"><button type="button" class="' + (!v['분담'] ? 'on' : '') + '" data-v="">같이</button>' + state.config.members.map(function (m) { return '<button type="button" class="' + (v['분담'] === m ? 'on' : '') + '" data-v="' + esc(m) + '">' + esc(m) + ' 전액</button>'; }).join('') + '</div></div>';
    var evs = activeEvents(); if (v['태그'] && !evs.some(function (e) { return e['이름'] === v['태그']; })) evs = evs.concat([{ '이름': v['태그'] }]);
    if (hasV3() && evs.length) h += '<div class="field"><label>이벤트 태그 <span class="muted">(여행 등)</span></label><div class="chips" data-name="태그"><button type="button" class="chip ' + (!v['태그'] ? 'on' : '') + '" data-v="">없음</button>' + evs.map(function (e) { return '<button type="button" class="chip ' + (v['태그'] === e['이름'] ? 'on' : '') + '" data-v="' + esc(e['이름']) + '">' + esc(e['이름']) + '</button>'; }).join('') + '</div></div>';
    if (hasV3()) h += renderItemsEditor(v);
    if (isShared() && edit) h += '<div class="field"><label>정산</label><div class="seg" data-name="정산"><button type="button" class="' + (v['정산'] === 'X' ? 'on' : '') + '" data-v="X">미정산</button><button type="button" class="' + (v['정산'] === 'O' ? 'on' : '') + '" data-v="O">정산됨</button></div></div>';
    h += '<input type="hidden" name="유형" value="' + esc(v['유형']) + '"><input type="hidden" name="결제인" value="' + esc(v['결제인']) + '"><input type="hidden" name="계획" value="' + esc(v['계획']) + '"><input type="hidden" name="정산" value="' + esc(v['정산']) + '"><input type="hidden" name="출처" value="' + esc(v['출처']) + '"><input type="hidden" name="원문" value="' + esc(v['원문']) + '"><input type="hidden" name="분담" value="' + esc(v['분담'] || '') + '"><input type="hidden" name="태그" value="' + esc(v['태그'] || '') + '">';
    h += '<div class="row" style="margin-top:16px;gap:8px">' + (edit ? '<button type="button" class="btn danger" data-act="delete" data-id="' + esc(row.id) + '">삭제</button><button type="button" class="btn" data-act="copytx" data-id="' + esc(row.id) + '" title="같은 내용으로 오늘 날짜 새 거래">복사</button>' : '<button type="button" class="btn" data-act="goto" data-to="home">취소</button>') + '<button type="submit" class="btn primary" style="flex:1">' + (edit ? '수정 저장' : '저장') + '</button></div>';
    h += '</form>';
    if (!edit) h += '<div class="card"><h2>스크린샷으로 입력</h2><p class="sub" style="margin:0 0 10px">토스 결제 화면을 캡처해서 이 앱으로 <b>공유</b>하면 자동으로 이 폼이 채워집니다. PC나 수동으로는 아래에서 이미지를 고르세요.</p><input type="file" id="ocrfile" accept="image/*" class="hidden"><button type="button" class="btn block" data-act="pickimage">이미지 선택해서 읽기</button>' + (state.ocr ? '<div class="sub" style="margin-top:8px">' + esc(state.ocr.status) + '</div><div class="progress"><i style="width:' + Math.round((state.ocr.progress || 0) * 100) + '%"></i></div>' : '') + '</div>';
    return h;
  }


  // 영수증 세부 품목 편집 (거래 폼 안). state.formItems 가 편집 중인 목록. 저장은 거래 저장 뒤 itemsSave 로.
  function renderItemsEditor(v) {
    var items = state.formItems || [];
    var sum = items.reduce(function (a, it) { return a + (Number(it['금액']) || 0) * 1; }, 0);
    var h = '<details class="items"' + (items.length ? ' open' : '') + '><summary>세부 품목 <span class="muted">' + (items.length ? items.length + '개 · ' + won(sum) : '(선택) 영수증 품목을 적어 두면 뭘 샀는지 남습니다') + '</span></summary>';
    h += '<div id="items">' + items.map(function (it, i) { return '<div class="row itemrow" data-i="' + i + '"><input type="text" value="' + esc(it['품목']) + '" placeholder="품목" data-k="품목"><input type="text" inputmode="numeric" value="' + esc(it['수량'] && it['수량'] !== 1 ? it['수량'] : '') + '" placeholder="수량" data-k="수량" style="width:52px"><input type="text" inputmode="numeric" value="' + esc(it['금액'] ? Number(it['금액']).toLocaleString('ko-KR') : '') + '" placeholder="금액" data-k="금액" style="width:96px;text-align:right"><button type="button" class="btn small" data-act="itemdel" data-i="' + i + '">✕</button></div>'; }).join('') + '</div>';
    h += '<div class="row" style="gap:8px;margin-top:6px"><button type="button" class="btn small" data-act="itemadd">＋ 품목</button>' + (items.length ? '<button type="button" class="btn small" data-act="itemsum" data-v="' + sum + '">합계 ' + won(sum) + ' 를 금액에</button>' : '') + '</div></details>';
    return h;
  }
  function readItemsFromDom() {
    var out = []; var rows = document.querySelectorAll('#items .itemrow');
    for (var i = 0; i < rows.length; i++) { var g = function (k) { var el = rows[i].querySelector('[data-k=' + k + ']'); return el ? el.value : ''; }; out.push({ '품목': g('품목'), '수량': Number(g('수량')) || 1, '금액': Number(String(g('금액')).replace(/[^\d]/g, '')) || 0 }); }
    return out;
  }

  function renderMore() {
    var c = state.config;
    var th = settings.theme || 'light';
    var h = '<div class="card"><h2>화면</h2><div class="row"><span>밝기</span><div class="seg" id="theme-seg">' + [['light', '밝게'], ['dark', '어둡게'], ['auto', '자동']].map(function (o) { return '<button type="button" class="' + (th === o[0] ? 'on' : '') + '" data-act="theme" data-v="' + o[0] + '">' + o[1] + '</button>'; }).join('') + '</div></div><div class="sub" style="margin-top:6px">자동은 휴대폰의 다크 모드 설정을 따릅니다.</div></div>';
    if (hasV3()) h += '<div class="card"><h2>관리</h2><div class="linklist">' + (isShared() ? '<a href="#settle">정산 기록 <span class="muted">누가 누구에게, 일부 정산</span></a>' : '<a href="#budget">예산 <span class="muted">이번 사이클 총액·카테고리별</span></a>') + '<a href="#accounts">' + (isShared() ? '통장 <span class="muted">공금·비상금 잔액과 입출금</span>' : '목돈 <span class="muted">저축 목표·진행률·입출금</span>') + '</a><a href="#debts">대출 <span class="muted">남은 원금·납입 진행</span></a><a href="#events">이벤트 <span class="muted">여행처럼 묶어서 보기</span></a><a href="#groups">모임 정산 <span class="muted">회식·학회 n명 나눠 내기</span></a><a href="#categories">카테고리 정리 <span class="muted">이름 바꾸기·합치기</span></a><a href="#recurring">고정 항목 <span class="muted">월세·월급</span></a></div></div>';
    h += '<details class="card adv"><summary><h2 style="display:inline">고급 설정 <span class="muted">연결 주소·PIN·설치 링크·자동 수집</span></h2></summary>';
    h += '<div style="margin-top:12px"><h2>연결</h2>';
    h += '<div class="field"><label>Apps Script 웹앱 URL</label><input id="s-endpoint" type="url" value="' + esc(settings.endpoint || '') + '" placeholder="https://script.google.com/macros/s/…/exec"></div>';
    h += '<div class="field"><label>PIN</label><input id="s-pin" type="password" value="' + esc(settings.pin || '') + '"></div>';
    h += '<div class="field"><label>내 이름 (자동 수집·입력 시 결제인)</label><input id="s-me" type="text" value="' + esc(settings.me || '') + '" list="members"><datalist id="members">' + (c ? c.members.map(function (m) { return '<option value="' + esc(m) + '">'; }).join('') : '') + '</datalist></div>';
    h += '<div class="row"><label class="sub"><input type="checkbox" id="s-local" ' + (settings.local ? 'checked' : '') + '> 체험 모드 (서버 없이 이 기기에만 저장)</label></div>';
    h += '<button class="btn primary block" style="margin-top:12px" data-act="savesettings">저장하고 다시 연결</button></div>';
    h += '<div style="margin-top:18px"><h2>재설치·기기 교체 대비</h2><p class="sub" style="margin:0 0 10px">거래 기록은 휴대폰이 아니라 구글 시트(드라이브)에만 저장되므로 앱을 지워도 남습니다. 이 기기 설정(서버 주소·PIN·이름)은 아래 <b>설치 링크</b> 하나로 복원됩니다. 링크를 비밀번호 관리자나 나에게 보내는 메시지에 보관해 두세요. PIN 이 들어 있으니 공개하지 마세요.</p>' +
      (settings.endpoint ? '<div class="field"><label>이름 (링크를 만들 사람)</label><input id="s-linkname" type="text" value="' + esc(settings.me || '') + '" list="members"></div><button class="btn block" data-act="copylink">설치 링크 복사</button><div id="linkout" class="sub" style="margin-top:8px;word-break:break-all"></div>' : '<div class="sub">서버 주소를 먼저 연결하면 링크를 만들 수 있습니다.</div>') + '</div>';
    if (settings.local) {
      var n = 0; try { n = JSON.parse(localStorage.getItem(NS + 'local.rows') || '[]').length; } catch (e) { }
      if (n) h += '<div class="notice">체험 모드의 거래 ' + n + '건은 이 기기에만 있습니다. 위에서 서버 주소를 넣고 체험 모드를 끄면 시트로 올릴지 묻습니다.</div>';
    }
    h += '<div style="margin-top:18px"><h2>자동 수집 (선택)</h2><p class="sub">안드로이드 MacroDroid 에서 "알림 수신(토스)" 트리거 → "HTTP 요청(POST)" 액션으로 아래 JSON 을 웹앱 URL 로 보내면 결제 알림이 자동으로 들어옵니다. 절차는 README.</p><pre style="white-space:pre-wrap;font-size:12px;background:var(--bg);padding:10px;border-radius:10px">' + esc(JSON.stringify({ action: 'ingest', pin: '(PIN)', device: me() || '(이름)', source: '알림', text: '[notification_title] [notification_text]' }, null, 1)) + '</pre></div>';
    h += '</details>';
    h += '<div class="card"><h2>장부</h2><div class="sub">유형: ' + (c ? (c.ledgerType === 'shared' ? '공동 (' + c.members.join(', ') + ')' : '개인') : '-') + ' · 사이클 시작일: ' + (c ? c.cycleStartDay : '-') + '일</div>' + (c && c.sheetUrl ? '<p><a href="' + esc(c.sheetUrl) + '" target="_blank" rel="noopener">구글 시트에서 열기 (PC 수정)</a></p>' : '') + '<p class="sub">카테고리, 예산, 멤버는 시트의 <code>설정</code> 탭에서 바꿉니다.</p></div>';
    h += '<div class="card"><h2>고정 수입 / 지출</h2><p class="sub" style="margin:0 0 10px">월세, 월급, 보험료처럼 매달 반복되는 항목을 등록해 두면 사이클마다 한 번에 거래로 넣을 수 있습니다.</p><button class="btn block" data-act="goto" data-to="recurring">고정 항목 관리 (' + state.recurring.length + '건)</button></div>';
    h += '<div class="sub" style="text-align:center;margin:16px 0 4px">앱 버전 ' + APP_VERSION + ' · <a href="#" data-act="reload">새로고침</a></div>';
    return h;
  }

  // ------------------------------------------------------------ 통계 (SVG 로 직접 그림, 라이브러리 없음)
  var PALETTE = ['#1b6ef3', '#0f9d58', '#f4b400', '#db4437', '#8e44ad', '#00acc1', '#ff7043', '#9e9e9e'];
  function short(n) { n = Number(n) || 0; var a = Math.abs(n); var t = a >= 100000000 ? (a / 100000000).toFixed(1).replace(/\.0$/, '') + '억' : a >= 10000 ? Math.round(a / 10000) + '만' : a.toLocaleString('ko-KR'); return (n < 0 ? '-' : '') + t; }
  function monthLabel(c) { return String(c).substring(5, 7).replace(/^0/, '') + '월'; }

  function chartBars(trend) {
    var W = 320, H = 170, L = 8, B = 24, T = 18;
    var max = Math.max.apply(null, trend.map(function (t) { return Math.max(t.expense, t.income); }).concat([1]));
    var n = trend.length, slot = (W - L * 2) / n, bw = Math.min(22, slot / 3);
    var h = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart">';
    [0.25, 0.5, 0.75, 1].forEach(function (f) { var y = T + (H - T - B) * (1 - f); h += '<line x1="' + L + '" x2="' + (W - L) + '" y1="' + y + '" y2="' + y + '" class="grid"/>'; });
    trend.forEach(function (t, i) {
      var cx = L + slot * i + slot / 2;
      var he = (H - T - B) * t.expense / max, hi = (H - T - B) * t.income / max;
      var cur = t.cycle === state.cycle;
      h += '<rect x="' + (cx - bw - 1) + '" y="' + (H - B - he) + '" width="' + bw + '" height="' + he + '" rx="3" class="bar-exp' + (cur ? ' cur' : '') + '"/>';
      if (t.income) h += '<rect x="' + (cx + 1) + '" y="' + (H - B - hi) + '" width="' + bw + '" height="' + hi + '" rx="3" class="bar-inc"/>';
      if (t.expense) h += '<text x="' + (cx - 1) + '" y="' + (H - B - he - 4) + '" class="lbl" text-anchor="middle">' + short(t.expense) + '</text>';
      h += '<text x="' + cx + '" y="' + (H - 7) + '" class="lbl' + (cur ? ' cur' : '') + '" text-anchor="middle">' + monthLabel(t.cycle) + '</text>';
    });
    return h + '</svg><div class="legend"><span><i style="background:var(--accent)"></i>지출</span><span><i style="background:var(--ok)"></i>수입</span></div>';
  }

  function chartCumulative(rows, cycle, budget) {
    var r = LedgerParser.cycleRange(cycle, state.config.cycleStartDay);
    var days = Math.round((r.end.getTime() - r.start.getTime()) / 86400000);
    var daily = []; for (var i = 0; i < days; i++) daily.push(0);
    rows.forEach(function (o) {
      if (o['유형'] === '수입' || o['상태'] === '취소' || o['사이클'] !== cycle) return;
      var d = Math.floor((new Date(String(o['일시']).substring(0, 10) + 'T00:00:00').getTime() - r.start.getTime()) / 86400000);
      if (d >= 0 && d < days) daily[d] += o['금액'];
    });
    var cum = [], acc = 0; daily.forEach(function (v) { acc += v; cum.push(acc); });
    var today = Math.floor((new Date(new Date().toISOString().substring(0, 10) + 'T00:00:00').getTime() - r.start.getTime()) / 86400000);
    var isCur = today >= 0 && today < days;
    var upto = isCur ? today : days - 1;
    var max = Math.max(acc, budget || 0, 1);
    var W = 320, H = 170, L = 8, B = 22, T = 14, R = 8;
    function x(i) { return L + (W - L - R) * i / (days - 1); }
    function y(v) { return T + (H - T - B) * (1 - v / max); }
    var h = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart">';
    [0.25, 0.5, 0.75, 1].forEach(function (f) { h += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(max * f) + '" y2="' + y(max * f) + '" class="grid"/>'; });
    if (budget) h += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(budget) + '" y2="' + y(budget) + '" class="budget"/><text x="' + (W - R) + '" y="' + (y(budget) - 4) + '" class="lbl" text-anchor="end">예산 ' + short(budget) + '</text>';
    var pts = []; for (var k = 0; k <= upto; k++) pts.push(x(k).toFixed(1) + ',' + y(cum[k]).toFixed(1));
    if (pts.length > 1) h += '<polygon points="' + x(0).toFixed(1) + ',' + y(0).toFixed(1) + ' ' + pts.join(' ') + ' ' + x(upto).toFixed(1) + ',' + y(0).toFixed(1) + '" class="area"/>';
    h += '<polyline points="' + pts.join(' ') + '" class="line"/>';
    if (isCur) h += '<circle cx="' + x(upto) + '" cy="' + y(cum[upto]) + '" r="4" class="dot"/><text x="' + Math.min(x(upto), W - 50) + '" y="' + (y(cum[upto]) - 8) + '" class="lbl" text-anchor="' + (x(upto) > W - 60 ? 'end' : 'start') + '">' + short(cum[upto]) + '</text>';
    function dl(i) { var d = new Date(r.start.getTime() + i * 86400000); return (d.getMonth() + 1) + '/' + d.getDate(); }
    h += '<text x="' + L + '" y="' + (H - 6) + '" class="lbl">' + dl(0) + '</text><text x="' + x(Math.floor(days / 2)) + '" y="' + (H - 6) + '" class="lbl" text-anchor="middle">' + dl(Math.floor(days / 2)) + '</text><text x="' + (W - R) + '" y="' + (H - 6) + '" class="lbl" text-anchor="end">' + dl(days - 1) + '</text>';
    h += '</svg>';
    var spent = cum[upto] || 0, elapsed = upto + 1;
    var avg = spent / elapsed, proj = Math.round(avg * days);
    var cap = isCur ? '오늘까지 ' + elapsed + '일 동안 ' + won(spent) + ' · 하루 평균 ' + won(Math.round(avg)) + ' · 이 속도면 사이클 끝에 약 <b>' + won(proj) + '</b>' + (budget ? (proj > budget ? ' <span class="danger">(예산 초과 예상)</span>' : ' <span class="ok">(예산 안)</span>') : '') : '사이클 합계 ' + won(acc) + ' · 하루 평균 ' + won(Math.round(acc / days));
    return h + '<div class="sub" style="margin-top:6px">' + cap + '</div>';
  }

  function chartDonut(map, total) {
    var keys = Object.keys(map).sort(function (a, b) { return map[b] - map[a]; });
    if (!keys.length || !total) return '<div class="empty">데이터가 없습니다</div>';
    var items = keys.slice(0, 7).map(function (k) { return { k: k, v: map[k] }; });
    if (keys.length > 7) items.push({ k: '그 외 ' + (keys.length - 7) + '개', v: keys.slice(7).reduce(function (a, k) { return a + map[k]; }, 0) });
    var cx = 70, cy = 70, R = 60, r0 = 38, a0 = -Math.PI / 2;
    var h = '<div class="donut-wrap"><svg viewBox="0 0 140 140" class="donut">';
    items.forEach(function (it, i) {
      var a1 = a0 + Math.PI * 2 * it.v / total;
      var large = a1 - a0 > Math.PI ? 1 : 0;
      var p = function (a, rr) { return (cx + rr * Math.cos(a)).toFixed(2) + ',' + (cy + rr * Math.sin(a)).toFixed(2); };
      if (it.v / total > 0.999) h += '<circle cx="' + cx + '" cy="' + cy + '" r="' + ((R + r0) / 2) + '" fill="none" stroke="' + PALETTE[i % PALETTE.length] + '" stroke-width="' + (R - r0) + '"/>';
      else h += '<path d="M' + p(a0, R) + ' A' + R + ',' + R + ' 0 ' + large + ',1 ' + p(a1, R) + ' L' + p(a1, r0) + ' A' + r0 + ',' + r0 + ' 0 ' + large + ',0 ' + p(a0, r0) + ' Z" fill="' + PALETTE[i % PALETTE.length] + '"/>';
      a0 = a1;
    });
    h += '<text x="' + cx + '" y="' + (cy - 2) + '" class="lbl" text-anchor="middle" style="font-size:9px">합계</text><text x="' + cx + '" y="' + (cy + 12) + '" class="lbl big" text-anchor="middle">' + short(total) + '</text></svg>';
    h += '<div class="donut-legend">' + items.map(function (it, i) { return '<div class="row"><span><i style="background:' + PALETTE[i % PALETTE.length] + '"></i>' + esc(it.k) + '</span><span><b>' + won(it.v) + '</b> <span class="sub">' + Math.round(it.v / total * 100) + '%</span></span></div>'; }).join('') + '</div></div>';
    return h;
  }

  function stackBar(parts) {
    var total = parts.reduce(function (a, p) { return a + p.v; }, 0);
    if (!total) return '<div class="empty">데이터가 없습니다</div>';
    return '<div class="stack">' + parts.map(function (p, i) { return p.v ? '<i style="width:' + (p.v / total * 100) + '%;background:' + PALETTE[i % PALETTE.length] + '" title="' + esc(p.k) + '"></i>' : ''; }).join('') + '</div>' +
      '<div class="legend">' + parts.map(function (p, i) { return '<span><i style="background:' + PALETTE[i % PALETTE.length] + '"></i>' + esc(p.k) + ' <b>' + won(p.v) + '</b> (' + Math.round(p.v / total * 100) + '%)</span>'; }).join('') + '</div>';
  }

  function renderStats() {
    var s = state.summary; if (!s) return '';
    var h = '';
    var trend = s.trend || [];
    h += '<div class="card"><h2>최근 ' + trend.length + '개 사이클 지출 · 수입</h2>' + (trend.length ? chartBars(trend) : '<div class="empty">데이터가 없습니다</div>');
    if (trend.length >= 2) { var prev = trend[trend.length - 2], curT = trend[trend.length - 1]; var diff = curT.expense - prev.expense; if (prev.expense) h += '<div class="sub" style="margin-top:6px">지난 사이클보다 <b class="' + (diff > 0 ? 'danger' : 'ok') + '">' + (diff > 0 ? '+' : '') + won(diff) + '</b> (' + (diff > 0 ? '+' : '') + Math.round(diff / prev.expense * 100) + '%)</div>'; }
    h += '</div>';
    h += '<div class="card"><h2>이번 사이클 누적 지출</h2>' + chartCumulative(state.rows, state.cycle, isShared() ? null : state.config.budgetTotal) + '</div>';
    h += '<div class="card"><h2>카테고리 비율</h2>' + chartDonut(s.byCategory, s.expense) + '</div>';
    if (isShared()) {
      var payers = Object.keys(s.byPayer).map(function (k) { return { k: k, v: s.byPayer[k] }; });
      h += '<div class="card"><h2>누가 얼마나 냈나</h2>' + stackBar(payers) + (s.settlement ? '<div class="sub" style="margin-top:8px">이 사이클 기준 정산: ' + esc(s.settlement.from) + ' → ' + esc(s.settlement.to) + ' ' + won(s.settlement.amount) + '</div>' : '') + '</div>';
    } else {
      h += '<div class="card"><h2>계획 / 비계획</h2>' + stackBar([{ k: '계획', v: s.planned }, { k: '비계획', v: s.unplanned }]) + '</div>';
    }
    h += '<div class="card"><h2>고정 / 변동</h2>' + stackBar([{ k: '고정', v: s.fixed || 0 }, { k: '변동', v: s.variable != null ? s.variable : s.expense }]) + '<div class="sub" style="margin-top:8px">고정은 <a href="#recurring">고정 항목</a>에서 반영한 거래입니다.</div></div>';
    h += '<div class="card"><h2>수입과 지출</h2>' + stackBar([{ k: '지출', v: s.expense }, { k: '수입', v: s.income }]) + (s.income ? '<div class="sub" style="margin-top:8px">' + (s.income >= s.expense ? '남는 돈 <b class="ok">' + won(s.income - s.expense) + '</b>' : '수입보다 <b class="danger">' + won(s.expense - s.income) + '</b> 더 썼습니다') + '</div>' : '') + '</div>';
    return h;
  }

  // ------------------------------------------------------------ 고정 수입/지출
  // 고정 항목 반영 확인: 항목마다 이번 달 금액을 고치고(월급·전기료처럼 달마다 다른 것), 빼고 싶은 건 체크 해제
  function renderRecApply() {
    var dueItems = state.recurring.filter(function (r) { return state.due.indexOf(r.id) >= 0; });
    if (!dueItems.length) return '<div class="empty">이번 사이클(' + esc(state.cycle) + ')에 반영할 고정 항목이 없습니다</div><button class="btn block" data-act="goto" data-to="recurring">고정 항목 관리</button>';
    var h = '<form id="recapplyform" class="card"><h2>' + esc(state.cycle) + ' 사이클에 반영 <span class="muted">(' + esc(cycleLabel(state.cycle)) + ')</span></h2><p class="sub" style="margin:0 0 10px">금액이 다른 달은 여기서 고치고 반영하세요. "기본값으로"를 켜면 다음 달부터 그 금액이 기본이 됩니다.</p>';
    ['수입', '지출'].forEach(function (t) {
      var list = dueItems.filter(function (r) { return (r['유형'] === '수입') === (t === '수입'); }); if (!list.length) return;
      h += '<h2 style="margin-top:12px">' + t + '</h2>' + list.map(function (r) {
        return '<div class="recapply-row"><label class="row" style="gap:8px;justify-content:flex-start"><input type="checkbox" name="use:' + esc(r.id) + '" checked><b>' + esc(r['이름']) + '</b><span class="sub">' + esc([r['카테고리'], isShared() ? r['결제인'] : '', '매월 ' + r['일'] + '일'].filter(Boolean).join(' · ')) + '</span></label>' +
          '<div class="row" style="gap:8px;margin-top:4px"><input type="text" inputmode="numeric" name="amt:' + esc(r.id) + '" value="' + esc(Number(r['금액']).toLocaleString('ko-KR')) + '" style="flex:1;text-align:right;font-weight:700"><label class="sub" style="white-space:nowrap"><input type="checkbox" name="def:' + esc(r.id) + '"> 기본값으로</label></div></div>';
      }).join('');
    });
    h += '<div class="row" style="gap:8px;margin-top:14px"><button type="button" class="btn" data-act="goto" data-to="home">취소</button><button type="submit" class="btn primary" style="flex:1">거래에 반영</button></div></form>';
    return h;
  }
  function renderRecurring() {
    var h = '';
    var dueItems = state.recurring.filter(function (r) { return state.due.indexOf(r.id) >= 0; });
    if (dueItems.length) h += '<div class="notice info row"><span>이번 사이클(' + esc(state.cycle) + ')에 반영 안 된 항목 ' + dueItems.length + '건</span><button class="btn small primary" data-act="recapply">모두 반영</button></div>';
    var editing = state.recEdit;
    if (editing) {
      var cur = editing === 'new' ? {} : (state.recurring.filter(function (r) { return r.id === editing; })[0] || {});
      var v = Object.assign({ '유형': '지출', '이름': '', '금액': '', '카테고리': '', '결제인': me(), '일': state.config.cycleStartDay, '계획': 'Y', '활성': 'Y', '메모': '', '분담': '' }, cur);
      var cats = state.config.categories.slice(); if (v['카테고리'] && cats.indexOf(v['카테고리']) < 0) cats.push(v['카테고리']);
      h += '<form id="recform" class="card" data-id="' + esc(cur.id || '') + '"><h2>' + (cur.id ? '고정 항목 수정' : '고정 항목 추가') + '</h2>';
      h += '<div class="row"><div class="seg" data-name="유형"><button type="button" class="' + (v['유형'] === '지출' ? 'on' : '') + '" data-v="지출">지출</button><button type="button" class="' + (v['유형'] === '수입' ? 'on' : '') + '" data-v="수입">수입</button></div>';
      if (isShared()) h += '<div class="seg" data-name="결제인">' + state.config.members.map(function (m) { return '<button type="button" class="' + (v['결제인'] === m ? 'on' : '') + '" data-v="' + esc(m) + '">' + esc(m) + '</button>'; }).join('') + '</div>';
      else h += '<div class="seg" data-name="계획"><button type="button" class="' + (v['계획'] !== 'N' ? 'on' : '') + '" data-v="Y">계획</button><button type="button" class="' + (v['계획'] === 'N' ? 'on' : '') + '" data-v="N">비계획</button></div>';
      h += '</div>';
      h += '<div class="field"><label>이름</label><input name="이름" type="text" value="' + esc(v['이름']) + '" placeholder="예: 월세, 월급, 실비보험"></div>';
      h += '<div class="field"><label>금액</label><input class="amount-input" name="금액" type="text" inputmode="numeric" value="' + esc(v['금액'] ? Number(v['금액']).toLocaleString('ko-KR') : '') + '" placeholder="0"></div>';
      h += '<div class="field"><label>매월 며칠</label><input name="일" type="number" min="1" max="31" value="' + esc(v['일']) + '"><div class="sub" style="margin-top:4px">사이클 시작일(' + state.config.cycleStartDay + '일)보다 작은 날은 다음 달로 잡힙니다. 예: 10일 → 10/25 시작 사이클이면 11/10</div></div>';
      h += '<div class="field"><label>카테고리</label><div class="chips" data-name="카테고리">' + cats.concat(['수입']).filter(function (c, i, a) { return a.indexOf(c) === i; }).map(function (c) { return '<button type="button" class="chip ' + (v['카테고리'] === c ? 'on' : '') + '" data-v="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') + '</div><input type="hidden" name="카테고리" value="' + esc(v['카테고리']) + '"></div>';
      if (isShared()) h += '<div class="field"><label>분담 <span class="muted">(반영될 거래의 부담)</span></label><div class="seg" data-name="분담"><button type="button" class="' + (!v['분담'] ? 'on' : '') + '" data-v="">같이</button>' + state.config.members.map(function (m) { return '<button type="button" class="' + (v['분담'] === m ? 'on' : '') + '" data-v="' + esc(m) + '">' + esc(m) + ' 전액</button>'; }).join('') + '</div></div>';
      h += '<div class="field"><label>메모</label><input name="메모" type="text" value="' + esc(v['메모']) + '"></div>';
      h += '<input type="hidden" name="유형" value="' + esc(v['유형']) + '"><input type="hidden" name="결제인" value="' + esc(v['결제인']) + '"><input type="hidden" name="계획" value="' + esc(v['계획']) + '"><input type="hidden" name="활성" value="' + esc(v['활성']) + '"><input type="hidden" name="분담" value="' + esc(v['분담'] || '') + '">';
      h += '<div class="row" style="margin-top:16px;gap:8px">' + (cur.id ? '<button type="button" class="btn danger" data-act="recdel" data-id="' + esc(cur.id) + '">삭제</button>' : '') + '<button type="button" class="btn" data-act="reccancel">취소</button><button type="submit" class="btn primary" style="flex:1">저장</button></div></form>';
    } else {
      h += '<button class="btn primary block" data-act="recnew">＋ 고정 항목 추가</button>';
    }
    var inc = state.recurring.filter(function (r) { return r['유형'] === '수입'; }), exp = state.recurring.filter(function (r) { return r['유형'] !== '수입'; });
    function sum(list) { return list.reduce(function (a, r) { return a + (r['활성'] === 'N' ? 0 : r['금액']); }, 0); }
    function recRow(r) {
      var meta = ['매월 ' + r['일'] + '일', r['카테고리'], isShared() ? r['결제인'] + (r['분담'] ? ' · ' + shareLabel(r['분담']) : '') : (r['계획'] === 'N' ? '비계획' : '계획'), r['메모']].filter(Boolean).join(' · ');
      var isDue = state.due.indexOf(r.id) >= 0;
      return '<div class="tx' + (r['활성'] === 'N' ? ' cancelled' : '') + '" data-act="recedit" data-id="' + esc(r.id) + '"><span class="cat ' + (isDue ? 'none' : '') + '">' + (r['활성'] === 'N' ? '꺼짐' : (isDue ? '미반영' : '반영됨')) + '</span><div class="main"><div class="name">' + esc(r['이름']) + '</div><div class="meta">' + esc(meta) + '</div></div><span class="amt ' + (r['유형'] === '수입' ? 'income' : '') + '">' + (r['유형'] === '수입' ? '+' : '') + won(r['금액']) + '</span><button type="button" class="btn small" data-act="rectoggle" data-id="' + esc(r.id) + '" title="켜기/끄기">' + (r['활성'] === 'N' ? '켜기' : '끄기') + '</button></div>';
    }
    h += '<div class="card"><h2>고정 수입 · 매달 ' + won(sum(inc)) + '</h2>' + (inc.length ? inc.map(recRow).join('') : '<div class="empty">없음</div>') + '</div>';
    h += '<div class="card"><h2>고정 지출 · 매달 ' + won(sum(exp)) + '</h2>' + (exp.length ? exp.map(recRow).join('') : '<div class="empty">없음. 월세·관리비·보험료·구독료를 넣어 두세요</div>') + '</div>';
    if (inc.length || exp.length) h += '<div class="card"><h2>매달 남는 돈 (고정 기준)</h2><div class="big ' + (sum(inc) - sum(exp) < 0 ? 'danger' : '') + '">' + won(sum(inc) - sum(exp)) + '</div><div class="sub">고정 수입 − 고정 지출. 변동 지출은 빼기 전입니다.</div></div>';
    return h;
  }


  function formVals(form, keys) { var o = {}; keys.forEach(function (k) { var el = form.querySelector('[name="' + k + '"]') || document.querySelector('[form="' + form.id + '"][name="' + k + '"]'); if (el) o[k] = el.value; }); return o; }
  function num(v) { return Number(String(v == null ? '' : v).replace(/[^\d.-]/g, '')) || 0; }
  function onV3Submit(e) {
    e.preventDefault();
    var form = e.target; var id = form.getAttribute('data-id') || ''; var btn = form.querySelector('[type=submit]') || document.querySelector('[form="' + form.id + '"][type=submit]'); if (btn) btn.disabled = true;
    var done = function (msg) { return function (j) { toast(msg); return refresh().then(function () { if (state.view === 'accounts') return loadAccLog(); }); }; };
    var fail = function (err) { if (btn) btn.disabled = false; toast('실패: ' + err.message); };
    var p;
    switch (form.id) {
      case 'settleform': { var v = formVals(form, ['from', 'to', 'amount', 'date', 'memo', 'tag']); if (!num(v.amount)) { toast('금액을 입력하세요'); if (btn) btn.disabled = false; return; }
        p = api.call('settlePay', { from: v.from, to: v.to, amount: num(v.amount), date: v.date, memo: v.memo, tag: v.tag }).then(function (j) { toast(j.closed ? '남은 금액이 0이 되어 정산 완료 처리했습니다' : '기록했습니다'); return refresh(); }); break; }
      case 'accform': { var a = Object.assign({ id: id }, formVals(form, ['이름', '종류', '소유', '메모', '활성', '목표금액', '목표일'])); a['목표금액'] = a['목표금액'] ? num(a['목표금액']) : ''; p = api.call('accountSave', { item: a }).then(function (j) { state.accEdit = null; state.accSel = j.item.id; toast('저장했습니다'); return refresh(); }); break; }
      case 'acctransferform': { var tf = formVals(form, ['from', 'to', 'amount', 'date', 'memo']); if (!num(tf.amount)) { toast('금액을 입력하세요'); if (btn) btn.disabled = false; return; } p = api.call('accountTransfer', { from: tf.from, to: tf.to, amount: num(tf.amount), date: tf.date, memo: tf.memo }).then(done('옮겼습니다')); break; }
      case 'acctxeditform': { var ex = formVals(form, ['일시', '구분', '금액', '메모']); if (!num(ex['금액'])) { toast('금액을 입력하세요'); if (btn) btn.disabled = false; return; } ex['금액'] = num(ex['금액']); p = api.call('accountTxUpdate', { id: id, tx: ex }).then(function () { state.accTxEdit = null; toast('고쳤습니다'); return refresh().then(function () { return loadAccLog(); }); }); break; }
      case 'acctxform': { var t = formVals(form, ['통장', '구분', '금액', '일시', '메모']); if (!num(t['금액'])) { toast('금액을 입력하세요'); if (btn) btn.disabled = false; return; } t['금액'] = num(t['금액']); p = api.call('accountTxAdd', { tx: t }).then(done('기록했습니다')); break; }
      case 'debtform': { var d = Object.assign({ id: id }, formVals(form, ['이름', '기관', '시작일', '원금', '연이율', '월상환금', '총회차', '납입회차', '소유', '메모', '활성'])); p = api.call('debtSave', { item: d }).then(function () { state.debtEdit = null; toast('저장했습니다'); return refresh(); }); break; }
      case 'evtform': { var ev = Object.assign({ id: id }, formVals(form, ['이름', '시작일', '종료일', '메모', '상태'])); p = api.call('eventSave', { item: ev }).then(function () { state.evtEdit = null; toast('저장했습니다'); return refresh(); }); break; }
      case 'recapplyform': {
        var ids = [], amounts = {}, ud = [];
        form.querySelectorAll('input[name^="use:"]').forEach(function (cb) { var rid = cb.name.substring(4); if (!cb.checked) return; ids.push(rid); var ai = form.querySelector('[name="amt:' + rid + '"]'); if (ai) amounts[rid] = num(ai.value); var di = form.querySelector('[name="def:' + rid + '"]'); if (di && di.checked) ud.push(rid); });
        if (!ids.length) { toast('반영할 항목을 고르세요'); if (btn) btn.disabled = false; return; }
        p = api.call('applyRecurring', { cycle: state.cycle, ids: ids, amounts: amounts, updateDefault: ud }).then(function (j) { toast(j.added + '건을 거래에 넣었습니다'); go('home'); return refresh(); }); break;
      }
      case 'groupform': { var gv = Object.assign({ id: id }, formVals(form, ['이름', '날짜', '참여자', '메모', '상태'])); p = api.call('groupSave', { item: gv }).then(function (j) { state.groups = j.groups; state.groupEdit = null; state.groupSel = j.item.id; toast('저장했습니다'); render(); }); break; }
      case 'groupitemform': { var giv = formVals(form, ['모임id', '항목', '금액', '낸사람', '참여자', '일자', '메모']); if (!num(giv['금액'])) { toast('금액을 입력하세요'); if (btn) btn.disabled = false; return; } giv['금액'] = num(giv['금액']); p = api.call('groupItemSave', { item: giv }).then(function (j) { state.groups = j.groups; toast('추가했습니다'); render(); }); break; }
      case 'budgetform': {
        var total = form.querySelector('[name=total]').value; var calls = [api.call('budgetSave', { cycle: state.cycle, category: '', amount: total.trim() === '' ? '' : num(total) })];
        var b = state.budget || { overrides: {}, byCategory: {} };
        form.querySelectorAll('input[name^="cat:"]').forEach(function (inp) { var c = inp.name.substring(4); var val = inp.value.trim(); var cur = b.byCategory[c]; var want = val === '' ? '' : num(val); if ((want === '' && cur) || (want !== '' && want !== cur)) calls.push(api.call('budgetSave', { cycle: state.cycle, category: c, amount: want })); });
        p = Promise.all(calls).then(function () { toast('예산을 저장했습니다'); go('home'); return refresh(); }); break;
      }
    }
    if (p) p.catch(fail);
  }

  function onRecSubmit(e) {
    e.preventDefault();
    var form = e.target; var item = { id: form.getAttribute('data-id') || '' };
    ['유형', '이름', '금액', '카테고리', '결제인', '일', '계획', '활성', '메모', '분담'].forEach(function (k) { var el = form.querySelector('[name=' + k + ']'); if (el) item[k] = el.value; });
    var btn = form.querySelector('[type=submit]'); btn.disabled = true;
    api.call('recurringSave', { item: item }).then(function () { state.recEdit = null; toast('저장했습니다'); return refresh(); }).catch(function (err) { btn.disabled = false; toast('실패: ' + err.message); });
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
      if (!form.getAttribute('data-id')) setTimeout(function () { amt.focus(); if (amt.value) amt.select(); }, 50);   // 새 입력: 금액으로 포커스 (채워져 있으면 바로 고칠 수 있게 선택)
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
      var chips = form.querySelector('.chips[data-name=카테고리]');
      chips.addEventListener('click', function (e) {
        var c = e.target.closest('.chip'); if (!c) return;
        if (c.getAttribute('data-act') === 'newcat') { var name = prompt('새 카테고리 이름'); if (!name) return; var s = document.createElement('button'); s.type = 'button'; s.className = 'chip'; s.setAttribute('data-v', name); s.textContent = name; chips.insertBefore(s, c); c = s; }
        chips.querySelectorAll('.chip').forEach(function (x) { x.classList.remove('on'); }); c.classList.add('on');
        form.querySelector('input[name=카테고리]').value = c.getAttribute('data-v');
        document.getElementById('cat-hint').textContent = '';
      });
      var tagChips = form.querySelector('.chips[data-name=태그]');
      if (tagChips) tagChips.addEventListener('click', function (e) { var c = e.target.closest('.chip'); if (!c) return; tagChips.querySelectorAll('.chip').forEach(function (x) { x.classList.remove('on'); }); c.classList.add('on'); form.querySelector('input[name=태그]').value = c.getAttribute('data-v'); });
      var itemsBox = document.getElementById('items');
      if (itemsBox) itemsBox.addEventListener('input', function (e) { var el = e.target; if (el.getAttribute('data-k') === '금액') { var n = el.value.replace(/[^\d]/g, ''); el.value = n ? Number(n).toLocaleString('ko-KR') : ''; } });
      var file = document.getElementById('ocrfile');
      if (file) file.addEventListener('change', function () { if (file.files[0]) runOcr(file.files[0]); });
    }
    // v3 폼들: seg/chips 는 공통 처리, submit 은 onV3Submit
    ['settleform', 'accform', 'acctxform', 'acctxeditform', 'acctransferform', 'debtform', 'evtform', 'budgetform', 'recapplyform', 'groupform', 'groupitemform'].forEach(function (fid) {
      var f = document.getElementById(fid); if (!f) return;
      f.addEventListener('submit', onV3Submit);
      var host = fid === 'acctxform' ? f.parentElement : f;
      host.querySelectorAll('.seg[data-name]').forEach(function (seg) {
        seg.addEventListener('click', function (e) {
          var b = e.target.closest('button'); if (!b) return;
          seg.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on');
          var hid = host.querySelector('input[name=' + seg.getAttribute('data-name') + ']'); if (hid) hid.value = b.getAttribute('data-v');
        });
      });
      host.querySelectorAll('.chips[data-name]').forEach(function (ch) {
        ch.addEventListener('click', function (e) {
          var c = e.target.closest('.chip'); if (!c) return; var hid = host.querySelector('input[name=' + ch.getAttribute('data-name') + ']');
          if (ch.classList.contains('multi')) { c.classList.toggle('on'); var on2 = Array.prototype.map.call(ch.querySelectorAll('.chip.on'), function (x) { return x.getAttribute('data-v'); }); var all = ch.querySelectorAll('.chip').length; if (hid) hid.value = on2.length === all ? '' : on2.join(','); return; }
          var on = c.classList.contains('on'); ch.querySelectorAll('.chip').forEach(function (x) { x.classList.remove('on'); }); if (!on) c.classList.add('on'); if (hid) hid.value = on ? '' : c.getAttribute('data-v');
        });
      });
      host.querySelectorAll('input[inputmode=numeric]').forEach(function (inp) { inp.addEventListener('input', function () { var n = inp.value.replace(/[^\d]/g, ''); inp.value = n ? Number(n).toLocaleString('ko-KR') : ''; }); });
    });
    var lq = document.getElementById('listq');
    if (lq) { lq.addEventListener('input', function () { state.listQ = lq.value; var pos = lq.selectionStart; render(); var nq = document.getElementById('listq'); if (nq) { nq.focus(); try { nq.setSelectionRange(pos, pos); } catch (e) { } } }); }
    var rform = document.getElementById('recform');
    if (rform) {
      rform.addEventListener('submit', onRecSubmit);
      var ramt = rform.querySelector('[name=금액]');
      ramt.addEventListener('input', function () { var n = ramt.value.replace(/[^\d]/g, ''); ramt.value = n ? Number(n).toLocaleString('ko-KR') : ''; });
      rform.querySelectorAll('.seg').forEach(function (seg) {
        seg.addEventListener('click', function (e) {
          var b = e.target.closest('button'); if (!b) return;
          seg.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on');
          rform.querySelector('[name=' + seg.getAttribute('data-name') + ']').value = b.getAttribute('data-v');
        });
      });
      var rchips = rform.querySelector('.chips');
      rchips.addEventListener('click', function (e) {
        var c = e.target.closest('.chip'); if (!c) return;
        rchips.querySelectorAll('.chip').forEach(function (x) { x.classList.remove('on'); }); c.classList.add('on');
        rform.querySelector('input[name=카테고리]').value = c.getAttribute('data-v');
      });
    }
  }

  function autoCategory(form, merchant) {
    var hidden = form.querySelector('input[name=카테고리]');
    var g = LedgerParser.guessCategory(merchant, state.dict, [['마트', '식재료'], ['카페', '외식'], ['커피', '외식'], ['식당', '외식']]);
    var hint = document.getElementById('cat-hint');
    if (!g) { hint.textContent = ''; return; }
    hidden.value = g.category;
    form.querySelectorAll('.chips[data-name=카테고리] .chip').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-v') === g.category); });
    hint.textContent = g.how === 'exact' ? '(이전 기록에서 자동 선택)' : '(추정)';
  }

  function onSubmit(e) {
    e.preventDefault();
    var form = e.target; var id = form.getAttribute('data-id');
    var tx = {};
    ['금액', '가맹점', '카테고리', '항목', '일시', '유형', '결제인', '계획', '정산', '출처', '원문', '분담', '태그'].forEach(function (k) { var el = form.querySelector('[name=' + k + ']'); if (el) tx[k] = el.value; });
    var items = hasV3() && document.getElementById('items') ? readItemsFromDom().filter(function (it) { return it['품목'].trim(); }) : null; state.formItems = null;
    tx['금액'] = Number(String(tx['금액']).replace(/[^\d]/g, '')) || 0;
    if (!tx['금액']) { toast('금액을 입력하세요'); return; }
    if (tx['일시'] && tx['일시'].length === 10) tx['일시'] += 'T12:00:00';
    if (tx['일시'] && tx['일시'].length === 16) tx['일시'] += ':00';
    tx['상태'] = '확인';
    state.prefill = null;
    var btn = form.querySelector('[type=submit]'); btn.disabled = true;
    // 먼저 화면에 반영하고(즉시), 서버에는 뒤에서 보낸다. 실패하면 되돌린다.
    var local = localTx(tx, id); var idx = -1, prev = null;
    if (id) { idx = state.rows.map(function (r) { return r.id; }).indexOf(id); prev = idx >= 0 ? state.rows[idx] : null; if (prev) { bumpSummary(prev, -1); state.rows[idx] = local; bumpSummary(local, 1); sortRows(); } }
    else { local.id = 'tmp-' + Date.now(); if (local['사이클'] === state.cycle) { state.rows.push(local); sortRows(); bumpSummary(local, 1); } }
    delete state.extra[local['사이클']];
    if (id) toast('수정했습니다'); else toast('저장했습니다', '하나 더', function () { go('add'); }, 5000);
    go(state.returnTo || 'list'); state.returnTo = null;
    var p = id ? api.call('update', { id: id, tx: tx }) : api.call('add', { tx: tx });
    p.then(function (j) {
      if (!id && j.row) { var k = state.rows.map(function (r) { return r.id; }).indexOf(local.id); if (k >= 0) state.rows[k] = j.row; }
      var txId = id || (j.row && j.row.id);
      if (items && txId && (items.length || state.itemCounts[txId])) return api.call('itemsSave', { txId: txId, items: items }).then(function () { return refresh(); });
      return refresh();
    }).catch(function (err) {
      if (id) { if (prev) { bumpSummary(local, -1); state.rows[idx] = prev; bumpSummary(prev, 1); } }
      else { if (local['사이클'] === state.cycle) { state.rows = state.rows.filter(function (r) { return r.id !== local.id; }); bumpSummary(local, -1); } }
      if (!id && !settings.local && /fetch|network|Failed/i.test(err.message)) { var q = queue(); q.push(tx); saveQueue(q); toast('오프라인: 연결되면 자동으로 저장합니다 (' + q.length + '건 대기)'); }
      else toast('저장 실패, 되돌렸습니다: ' + err.message, null, null, 6000);
      renderSoft();
    });
  }

  // 목록: 전체 기간 검색은 서버에서 전부 받아 온다 (1,000건 정도는 문제 없음)
  function loadAllRows() {
    if (state.listAll || state.listAllLoading) return;
    state.listAllLoading = true; render();
    api.call('list', { cycle: 'all' }).then(function (j) { state.listAll = j.rows || []; state.listAllLoading = false; if (state.view === 'list') render(); }).catch(function (e) { state.listAllLoading = false; toast('불러오기 실패: ' + e.message); render(); });
  }
  // 품목 편집 줄만 다시 그린다 (폼 전체를 다시 그리면 입력이 날아가므로)
  function rerenderItems() {
    var det = document.querySelector('#txform details.items'); if (!det) return;
    var wrap = document.createElement('div'); wrap.innerHTML = renderItemsEditor({});
    det.replaceWith(wrap.firstChild);
    var itemsBox = document.getElementById('items');
    if (itemsBox) { itemsBox.addEventListener('input', function (e) { var el = e.target; if (el.getAttribute('data-k') === '금액') { var n = el.value.replace(/[^\d]/g, ''); el.value = n ? Number(n).toLocaleString('ko-KR') : ''; } }); var last = itemsBox.querySelector('.itemrow:last-child input'); if (last && !last.value) last.focus(); }
  }

  // PC 단축키: n 새 거래, / 목록 검색, Esc 폼 닫기 (글자 입력 중이 아닐 때만)
  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName || '').toLowerCase(); var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.metaKey || e.ctrlKey || e.altKey;
    if (e.key === 'Escape' && (state.view === 'add' || state.view === 'edit')) { go(state.returnTo || 'list'); return; }
    if (typing || !state.config) return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); go('add'); }
    else if (e.key === '/') { e.preventDefault(); if (state.view !== 'list') go('list'); setTimeout(function () { var q = document.getElementById('listq'); if (q) q.focus(); }, 50); }
  });
  var pendingDelete = null;
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]'); if (!el) return;
    var act = el.getAttribute('data-act');
    switch (act) {
      case 'goto': go(el.getAttribute('data-to')); break;
      case 'retry': loadAll(); break;
      case 'reload': e.preventDefault(); location.reload(); break;
      case 'cycle': { state.cycle = shiftCycle(state.cycle, Number(el.getAttribute('data-d'))); var cc = settings.local ? null : readCache(state.cycle); if (cc) { applyBoot(cc); state.loading = false; } else state.loading = true; render(); refresh(); break; }
      case 'calmonth': state.calMonth = shiftCycle(state.calMonth, Number(el.getAttribute('data-d'))); state.calDay = ''; render(); break;
      case 'calday': state.calDay = el.getAttribute('data-k'); render(); break;
      case 'theme': settings.theme = el.getAttribute('data-v'); saveSettings(); applyTheme(); render(); break;
      // ---- v3
      case 'settlefinish': {
        var rb = state.balance && state.balance.remaining; if (!rb) { toast('정산할 금액이 없습니다'); break; }
        if (!confirm(rb.from + ' → ' + rb.to + ' ' + won(rb.amount) + ' 을 보낸 것으로 기록하고, 미정산 거래를 모두 정산 완료로 표시합니다. 계속할까요?')) break;
        api.call('settleFinish', {}).then(function (j) { toast('정산 완료 (' + j.settledTx + '건)'); return refresh(); }).catch(function (err) { toast('실패: ' + err.message); });
        break;
      }
      case 'settledel': if (!confirm('이 정산 기록을 지울까요?')) break; api.call('settleDelete', { id: el.getAttribute('data-id') }).then(function () { toast('지웠습니다'); return refresh(); }).catch(function (err) { toast('실패: ' + err.message); }); break;
      case 'accnew': state.accEdit = 'new'; render(); break;
      case 'accedit': state.accEdit = el.getAttribute('data-id'); render(); window.scrollTo(0, 0); break;
      case 'acccancel': state.accEdit = null; render(); break;
      case 'accsel': state.accSel = el.getAttribute('data-id'); state.accTxEdit = null; render(); if (!state.accLogs[state.accSel]) loadAccLog(state.accSel); break;
      case 'accyear': { var ay = el.getAttribute('data-y'); state.accYear[state.accSel] = state.accYear[state.accSel] === ay ? '' : ay; render(); break; }
      case 'acctxedit': state.accTxEdit = el.getAttribute('data-id'); render(); break;
      case 'acctxcancel': state.accTxEdit = null; render(); break;
      case 'acctoggle': { var aid = el.getAttribute('data-id'); var acc = state.accounts.filter(function (a) { return a.id === aid; })[0]; if (!acc) break; api.call('accountSave', { item: Object.assign({}, acc, { '활성': acc['활성'] === 'N' ? 'Y' : 'N' }) }).then(function () { state.accEdit = null; return refresh(); }).catch(function (err) { toast('실패: ' + err.message); }); break; }
      case 'accdel': { var dAcc = state.accounts.filter(function (a) { return a.id === el.getAttribute('data-id'); })[0]; var dLog = state.accLogs[el.getAttribute('data-id')]; var dn = dLog ? dLog.log.length : (state.accountLog || []).filter(function (t) { return t['통장'] === el.getAttribute('data-id'); }).length; if (!confirm('"' + (dAcc ? dAcc['이름'] : '') + '" 을(를) 지울까요?' + (dn ? '\n입출금 기록 ' + dn + '건도 같이 지워집니다. 되돌릴 수 없습니다.' : ''))) break; api.call('accountDelete', { id: el.getAttribute('data-id'), cascade: true }).then(function () { state.accEdit = null; state.accSel = null; toast('지웠습니다'); return refresh(); }).catch(function (err) { toast('실패: ' + err.message); }); break; }
      case 'acctxdel': if (!confirm('이 입출금 기록을 지울까요?')) break; api.call('accountTxDelete', { id: el.getAttribute('data-id') }).then(function () { toast('지웠습니다'); return refresh().then(function () { return loadAccLog(); }); }).catch(function (err) { toast('실패: ' + err.message); }); break;
      case 'debtnew': state.debtEdit = 'new'; render(); break;
      case 'debtedit': state.debtEdit = el.getAttribute('data-id'); render(); window.scrollTo(0, 0); break;
      case 'debtcancel': state.debtEdit = null; render(); break;
      case 'debtdel': if (!confirm('이 대출을 지울까요?')) break; api.call('debtDelete', { id: el.getAttribute('data-id') }).then(function () { state.debtEdit = null; toast('지웠습니다'); return refresh(); }).catch(function (err) { toast('실패: ' + err.message); }); break;
      case 'debtrec': {
        var did = el.getAttribute('data-id'); var dd = state.debts.filter(function (d) { return d.id === did; })[0]; if (!dd) break;
        var day = Number(String(dd['시작일'] || '').substring(8, 10)) || state.config.cycleStartDay;
        if (!confirm('매월 ' + day + '일 ' + won(dd.calc.monthly) + ' 을 고정 지출로 등록합니다. 홈에서 "거래에 반영"을 누르면 매 사이클 거래로 들어갑니다.')) break;
        api.call('recurringSave', { item: { '유형': '지출', '이름': dd['이름'] + ' 상환', '금액': dd.calc.monthly, '카테고리': '대출', '결제인': dd['소유'] || me(), '일': day, '계획': 'Y', '활성': 'Y', '메모': '부채:' + dd.id } }).then(function () { toast('고정 지출로 등록했습니다'); return refresh(); }).catch(function (err) { toast('실패: ' + err.message); });
        break;
      }
      case 'groupnew': state.groupEdit = 'new'; render(); break;
      case 'groupedit': state.groupEdit = el.getAttribute('data-id'); render(); window.scrollTo(0, 0); break;
      case 'groupcancel': state.groupEdit = null; render(); break;
      case 'groupsel': state.groupSel = el.getAttribute('data-id'); render(); break;
      case 'groupdel': if (!confirm('이 모임과 항목을 모두 지울까요?')) break; api.call('groupDelete', { id: el.getAttribute('data-id') }).then(function (j) { state.groups = j.groups; state.groupEdit = null; state.groupSel = null; toast('지웠습니다'); render(); }).catch(function (err) { toast('실패: ' + err.message); }); break;
      case 'groupitemdel': api.call('groupItemDelete', { id: el.getAttribute('data-id') }).then(function (j) { state.groups = j.groups; render(); }).catch(function (err) { toast('실패: ' + err.message); }); break;
      case 'grouppaydel': api.call('groupPayDelete', { id: el.getAttribute('data-id') }).then(function (j) { state.groups = j.groups; render(); }).catch(function (err) { toast('실패: ' + err.message); }); break;
      case 'grouppaid': { var gsel = (state.groups || []).filter(function (g) { return g.id === state.groupSel; })[0] || (state.groups || [])[0]; if (!gsel) break; api.call('groupPaySave', { item: { '모임id': gsel.id, '보낸사람': el.getAttribute('data-from'), '받는사람': el.getAttribute('data-to'), '금액': Number(el.getAttribute('data-amt')) } }).then(function (j) { state.groups = j.groups; toast('기록했습니다'); render(); }).catch(function (err) { toast('실패: ' + err.message); }); break; }
      case 'evtnew': state.evtEdit = 'new'; render(); break;
      case 'evtedit': state.evtEdit = el.getAttribute('data-id'); render(); window.scrollTo(0, 0); break;
      case 'evtcancel': state.evtEdit = null; render(); break;
      case 'evtdel': if (!confirm('이 이벤트를 지울까요? 거래의 태그는 남습니다.')) break; api.call('eventDelete', { id: el.getAttribute('data-id') }).then(function () { state.evtEdit = null; toast('지웠습니다'); return refresh(); }).catch(function (err) { toast('실패: ' + err.message); }); break;
      case 'evtfilter': e.preventDefault(); state.listFilter = { key: '태그', value: el.getAttribute('data-tag'), label: '#' + el.getAttribute('data-tag') }; state.listQ = ''; loadAllRows(); go('list'); break;
      case 'listclear': state.listQ = ''; state.listFilter = null; state.listAll = null; render(); break;
      case 'listall': e.preventDefault(); loadAllRows(); break;
      case 'budgetuse': { var inp = document.querySelector('#budgetform [name=total]'); if (inp) inp.value = Number(el.getAttribute('data-v')).toLocaleString('ko-KR'); break; }
      case 'catrename': {
        var fromC = el.getAttribute('data-v'); var toC = prompt('"' + fromC + '" 의 새 이름 (이미 있는 이름이면 합쳐집니다)', fromC); if (!toC || toC.trim() === fromC) break;
        if (!confirm('"' + fromC + '" → "' + toC.trim() + '" 로 바꿀까요? 거래·고정 항목·사전·예산이 모두 바뀝니다.')) break;
        api.call('renameCategory', { from: fromC, to: toC.trim() }).then(function (j) { state.categoryStats = j.categories; if (j.config) state.config = j.config; toast(j.tx + '건을 바꿨습니다'); return refresh(); }).catch(function (err) { toast('실패: ' + err.message); });
        break;
      }
      case 'itemadd': { state.formItems = (document.getElementById('items') ? readItemsFromDom() : (state.formItems || [])).concat([{ '품목': '', '수량': 1, '금액': 0 }]); rerenderItems(); break; }
      case 'itemdel': { var li = readItemsFromDom(); li.splice(Number(el.getAttribute('data-i')), 1); state.formItems = li; rerenderItems(); break; }
      case 'itemsum': { var ai = document.querySelector('#txform [name=금액]'); if (ai) ai.value = Number(el.getAttribute('data-v')).toLocaleString('ko-KR'); break; }
      case 'quick': { var qm = quickList()[Number(el.getAttribute('data-i'))]; if (!qm) break;
        var inForm = document.getElementById('txform');
        if (inForm) { inForm.querySelector('[name=가맹점]').value = qm.name; autoCategory(inForm, qm.name); if (qm.category) { inForm.querySelector('input[name=카테고리]').value = qm.category; inForm.querySelectorAll('.chips[data-name=카테고리] .chip').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-v') === qm.category); }); } var qa = inForm.querySelector('[name=금액]'); if (qa && !qa.value.replace(/[^\d]/g, '') && qm.lastAmount) qa.value = Number(qm.lastAmount).toLocaleString('ko-KR'); var qc = inForm.querySelector('.chips.quick'); if (qc) qc.remove(); if (qa) { qa.focus(); qa.select(); } break; }
        state.prefill = { tx: { '가맹점': qm.name, '카테고리': qm.category || '', '금액': qm.lastAmount || '', '결제인': me() }, note: '' }; go('add'); break; }
      case 'copytx': { var ct = state.rows.filter(function (r) { return r.id === el.getAttribute('data-id'); })[0]; if (!ct) break; state.prefill = { tx: { '가맹점': ct['가맹점'], '카테고리': ct['카테고리'], '금액': ct['금액'], '항목': ct['항목'], '결제인': ct['결제인'], '유형': ct['유형'], '분담': ct['분담'] || '', '태그': ct['태그'] || '', '일시': nowIso() }, note: '' }; go('add'); break; }
      case 'addon': state.prefill = { tx: { '일시': el.getAttribute('data-date') + 'T12:00:00' } }; state.returnTo = 'cal'; go('add'); break;
      case 'edit': go('edit/' + el.getAttribute('data-id')); break;
      case 'settle':
        if (!confirm('지금까지의 미정산 거래를 모두 정산 완료로 표시할까요?')) return;
        api.call('settle', {}).then(function (j) { toast(j.settled + '건 정산 처리'); return refresh(); }).catch(function (err) { toast('실패: ' + err.message); });
        break;
      case 'delete': {
        var id = el.getAttribute('data-id'); var row = state.rows.filter(function (r) { return r.id === id; })[0];
        state.rows = state.rows.filter(function (r) { return r.id !== id; }); if (row) bumpSummary(row, -1);
        go(state.returnTo || 'list'); state.returnTo = null;
        var timer = setTimeout(function () { pendingDelete = null; api.call('delete', { id: id }).then(refresh).catch(function (err) { toast('삭제 실패: ' + err.message); refresh(); }); }, 5000);
        pendingDelete = { id: id, row: row, timer: timer };
        toast('삭제했습니다', '되돌리기', function () { clearTimeout(timer); pendingDelete = null; state.rows.push(row); sortRows(); bumpSummary(row, 1); render(); }, 5000);
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
      case 'recnew': state.recEdit = 'new'; render(); break;
      case 'recedit': if (e.target.closest('[data-act="rectoggle"]')) break; state.recEdit = el.getAttribute('data-id'); render(); window.scrollTo(0, 0); break;
      case 'reccancel': state.recEdit = null; render(); break;
      case 'rectoggle': {
        var rid = el.getAttribute('data-id'); var ritem = state.recurring.filter(function (r) { return r.id === rid; })[0]; if (!ritem) break;
        var copy = Object.assign({}, ritem, { '활성': ritem['활성'] === 'N' ? 'Y' : 'N' });
        api.call('recurringSave', { item: copy }).then(function () { toast(copy['활성'] === 'N' ? '껐습니다' : '켰습니다'); return refresh(); }).catch(function (err) { toast('실패: ' + err.message); });
        break;
      }
      case 'recdel': {
        if (!confirm('이 고정 항목을 삭제할까요? 이미 거래에 반영된 내역은 남습니다.')) break;
        api.call('recurringDelete', { id: el.getAttribute('data-id') }).then(function () { state.recEdit = null; toast('삭제했습니다'); return refresh(); }).catch(function (err) { toast('실패: ' + err.message); });
        break;
      }
      case 'recapply': { if (!state.recurring.some(function (r) { return state.due.indexOf(r.id) >= 0; })) { toast('반영할 항목이 없습니다'); break; } go('recapply'); break; }
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
    if (source === '스크린샷' && LedgerParser.parseReceiptItems) { var its = LedgerParser.parseReceiptItems(text); if (its.length >= 2) { state.formItems = its.map(function (it) { return { '품목': it.name, '수량': it.qty, '금액': it.price }; }); state.prefill.note += ' 품목 ' + its.length + '개를 읽었습니다 (세부 품목에서 확인).'; } }
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
  if ('serviceWorker' in navigator) {
    var hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').then(function (reg) {
      // 앱을 다시 앞으로 가져올 때마다 새 버전이 있는지 묻는다 (PWA 는 자주 안 닫으니까)
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') reg.update().catch(function () { }); });
    }).catch(function () { });
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController) return;   // 처음 설치될 때는 새로고침할 필요 없다
      hadController = false;
      if (state.view === 'add' || state.view === 'edit') toast('새 버전이 있습니다', '새로고침', function () { location.reload(); }, 15000);
      else location.reload();
    });
  }
  applySetupLink();
  route();
  if (settings.local !== undefined) loadAll().then(checkShareInbox);
})();
