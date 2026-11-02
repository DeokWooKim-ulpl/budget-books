/**
 * 가계부 백엔드 (Google Apps Script 웹앱)
 * 스프레드시트 하나에 붙여서 쓴다. 공동 장부 / 개인 예산안 둘 다 같은 코드.
 * 차이는 "설정" 탭의 LEDGER_TYPE 값(shared | personal)으로 갈린다.
 *
 * 탭 구성 (setup() 이 자동 생성)
 *   거래  : 한 줄에 거래 하나. 앱과 PC 시트 양쪽에서 수정 가능.
 *   설정  : key / value
 *   사전  : 가맹점(정규화) → 카테고리 (자동 분류용)
 *   고정  : 매달 반복되는 수입/지출 (월세, 월급, 보험료 …). 앱에서 "이번 사이클에 반영"을 누르면 거래 탭에 들어간다.
 *   정산 / 통장 / 통장거래 / 부채 / 이벤트 / 품목 / 예산 : v3 에서 추가. 파일 아래쪽 'v3' 절 참고.
 *
 * 배포: 배포 > 새 배포 > 웹 앱, 실행 사용자 = 나, 액세스 = 모든 사용자.
 *       요청마다 PIN 을 확인하므로 URL 이 알려져도 PIN 없이는 쓸 수 없다.
 */

var SHEET_TX = '거래';
var SHEET_CFG = '설정';
var SHEET_DICT = '사전';
var SHEET_REC = '고정';
var API_VERSION = 3;   // 요청 처리(handle_/read_/응답 모양)가 바뀌면 1 올린다. 앱이 옛 서버를 감지해 안내하는 데 쓴다.
var SERVER_BUILD = '2026-11-02f';   // 코드를 고칠 때마다 올린다. 자동 업데이트가 GitHub 와 비교할 때 쓰고 doGet 응답에도 보인다.

// 고정 탭 열. 일 = 매달 며칠에 나가는지(1~31). 계획 = 개인 장부에서 계획 지출로 넣을지(Y/N). 활성 = N 이면 반영하지 않음.
var RCOLS = ['id', '유형', '이름', '금액', '카테고리', '결제인', '일', '계획', '활성', '메모', '등록', '수정'];
var RCOL = {};
RCOLS.forEach(function (c, i) { RCOL[c] = i; });

// 분담(v3): 공동 장부에서 빈칸 = 설정 비율(SPLIT_RATIO), 이름 = 그 사람 전액 부담, "60:40" = 이 거래만 다른 비율. 태그(v3): 이벤트 이름.
var COLS = ['id', '일시', '사이클', '유형', '금액', '가맹점', '카테고리', '항목', '결제인', '정산', '계획', '출처', '상태', '원문', '등록', '수정', '분담', '태그'];
var COL = {};
COLS.forEach(function (c, i) { COL[c] = i; });

var DEFAULT_CFG = {
  PIN: '0000',
  LEDGER_TYPE: 'shared',          // shared | personal
  CYCLE_START_DAY: '25',
  MEMBERS: '덕우,지민',
  CATEGORIES: '식재료,외식,생활비,월세,관리비,전기료,가스료,수도세,교통,의료,기타',
  CATEGORY_RULES: '마트:식재료;식자재:식재료;농수축산:식재료;정육:식재료;카페:외식;커피:외식;스타벅스:외식;식당:외식;치킨:외식;피자:외식;배민:외식;요기요:외식;쿠팡이츠:외식;약국:의료;병원:의료;주유:교통;택시:교통;버스:교통;지하철:교통;다이소:생활비;쿠팡:생활비',
  BUDGET_TOTAL: '',               // personal: 월 예산 총액 (비우면 미사용). 사이클마다 다르면 예산 탭(앱의 예산 수정)이 우선
  SPLIT_RATIO: '',                // shared: 분담 비율, MEMBERS 순서로 "50,50". 비우면 똑같이 나눔
  // BUDGET_식비 = 500000 처럼 카테고리별 예산을 추가할 수 있다
  AUTO_CONFIRM_MIN_CONFIDENCE: '0.9'
};

// ---------------------------------------------------------------- 진입점
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action) return handle_(p);
  return json_({ ok: true, app: 'ledger', version: API_VERSION, build: SERVER_BUILD, ledgerType: cfg_('LEDGER_TYPE'), hint: 'POST JSON {action, pin, ...}' });
}

function doPost(e) {
  // 앱은 JSON 본문을, MacroDroid 같은 자동화 앱은 폼 파라미터(pin=..&action=ingest&text=..)를 보낼 수 있다. 둘 다 받는다.
  var body = null;
  try { body = JSON.parse((e.postData && e.postData.contents) || ''); } catch (err) { body = null; }
  if (!body || typeof body !== 'object') body = (e && e.parameter) || {};
  return handle_(body);
}

// 요청 하나가 처리되는 동안 시트를 한 번만 읽도록 하는 캐시. 요청이 시작될 때 비운다.
var CACHE_ = {};
var WRITE_ACTIONS_ = { add: 1, update: 1, delete: 1, confirm: 1, settle: 1, ingest: 1, recurringSave: 1, recurringDelete: 1, applyRecurring: 1,
  settlePay: 1, settleFinish: 1, settleDelete: 1, accountSave: 1, accountDelete: 1, accountTxAdd: 1, accountTxDelete: 1, debtSave: 1, debtDelete: 1,
  eventSave: 1, eventDelete: 1, itemsSave: 1, budgetSave: 1, renameCategory: 1, migrate: 1, setConfig: 1, updateServer: 1, recurringPurge: 1 };

function handle_(req) {
  CACHE_ = {};
  try {
    setup();
    if (String(req.pin || '') !== String(cfg_('PIN'))) return json_({ ok: false, error: 'pin' });
    // 읽기는 잠금 없이 바로 처리한다. 잠금은 시트를 고치는 요청끼리만 줄을 세운다.
    if (!WRITE_ACTIONS_[req.action]) return json_(read_(req));
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) return json_({ ok: false, error: '시트가 바쁩니다. 잠시 후 다시 시도하세요' });
    try {
      CACHE_.tx = null;
      switch (req.action) {
        case 'add': return json_({ ok: true, row: addTx_(req.tx || {}) });
        case 'update': return json_({ ok: true, row: updateTx_(req.id, req.tx || {}) });
        case 'delete': return json_({ ok: true, deleted: deleteTx_(req.id) });
        case 'confirm': return json_({ ok: true, row: updateTx_(req.id, { '상태': '확인' }) });
        case 'settle': return json_({ ok: true, settled: settle_(req.cycle) });
        case 'ingest': return json_({ ok: true, row: ingest_(req) });
        case 'recurringSave': return json_({ ok: true, item: saveRecurring_(req.item || {}), recurring: readRecurring_() });
        case 'recurringDelete': return json_({ ok: true, deleted: deleteRecurring_(req.id), recurring: readRecurring_() });
        case 'applyRecurring': { var ap = applyRecurring_(req.cycle || currentCycle_(), req.ids); return json_({ ok: true, added: ap.length, rows: ap }); }
        // ---- v3
        case 'settlePay': return json_(Object.assign({ ok: true }, settlePay_(req)));
        case 'settleFinish': return json_(Object.assign({ ok: true }, settleFinish_(req)));
        case 'settleDelete': return json_({ ok: true, deleted: settleDelete_(req.id), balance: balance_() });
        case 'accountSave': return json_({ ok: true, item: accountSave_(req.item || {}), accounts: accountsRead_() });
        case 'accountDelete': return json_({ ok: true, deleted: accountDelete_(req.id), accounts: accountsRead_() });
        case 'accountTxAdd': return json_({ ok: true, item: accountTxAdd_(req.tx || {}), accounts: accountsRead_() });
        case 'accountTxDelete': return json_({ ok: true, deleted: tabDelete_(SHEET_ACCTX, req.id), accounts: accountsRead_() });
        case 'debtSave': return json_({ ok: true, item: debtSave_(req.item || {}), debts: debtsRead_() });
        case 'debtDelete': return json_({ ok: true, deleted: tabDelete_(SHEET_DEBT, req.id), debts: debtsRead_() });
        case 'eventSave': return json_({ ok: true, item: eventSave_(req.item || {}), events: eventsRead_() });
        case 'eventDelete': return json_({ ok: true, deleted: tabDelete_(SHEET_EVT, req.id), events: eventsRead_() });
        case 'itemsSave': return json_({ ok: true, items: itemsSave_(req.txId, req.items || []) });
        case 'budgetSave': return json_({ ok: true, budget: budgetSave_(req) });
        case 'renameCategory': return json_(Object.assign({ ok: true }, renameCategory_(req.from, req.to), { categories: categoryStats_(), config: publicConfig_() }));
        case 'migrate': case 'setConfig': case 'updateServer': case 'recurringPurge': return json_(admin_(req));
      }
    } finally { lock.releaseLock(); }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function read_(req) {
  switch (req.action) {
    case 'config': return { ok: true, config: publicConfig_() };
    case 'list': return { ok: true, rows: listTx_(req.cycle, req.includeUnconfirmed !== false), cycle: req.cycle || currentCycle_() };
    case 'summary': return { ok: true, summary: summary_(req.cycle || currentCycle_()) };
    case 'dict': return { ok: true, dict: readDict_() };
    case 'merchants': return { ok: true, merchants: recentMerchants_() };
    case 'recurring': { var rc = req.cycle || currentCycle_(); return { ok: true, recurring: readRecurring_(), due: dueRecurring_(rc).map(function (r) { return r.id; }), cycle: rc }; }
    case 'bootstrap': {
      // 앱 첫 화면에 필요한 것을 한 번에 돌려준다 (요청 5번 → 1번)
      var cycle = req.cycle || currentCycle_();
      var out = { ok: true, config: publicConfig_(), cycle: cycle, rows: listTx_(cycle, true), summary: summary_(cycle), dict: readDict_(), merchants: recentMerchants_(),
        recurring: readRecurring_(), recurringDue: dueRecurring_(cycle).map(function (r) { return r.id; }) };
      // v3: 홈 카드에 필요한 것들
      out.accounts = accountsRead_().accounts;
      out.debts = debtsRead_();
      out.events = eventsRead_();
      out.itemCounts = itemCounts_();
      if (cfg_('LEDGER_TYPE') === 'shared') { var st = settlementsRead_(); out.balance = st.balance; out.settlements = st.log.slice(0, 20); }
      else { out.budget = budgetFor_(cycle); out.budgetSuggest = budgetSuggest_(cycle); }
      return out;
    }
    // ---- v3
    case 'settlements': return Object.assign({ ok: true }, settlementsRead_());
    case 'accounts': return Object.assign({ ok: true }, accountsRead_());
    case 'debts': return { ok: true, debts: debtsRead_() };
    case 'events': return { ok: true, events: eventsRead_() };
    case 'items': return { ok: true, items: itemsRead_(req.txId) };
    case 'budget': { var bc = req.cycle || currentCycle_(); return { ok: true, cycle: bc, budget: budgetFor_(bc), suggest: budgetSuggest_(bc) }; }
    case 'categories': return { ok: true, categories: categoryStats_() };
    case 'health': return admin_(req);
    default: return { ok: false, error: 'unknown action' };
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- 설정
function setup() {
  var ss = SpreadsheetApp.getActive();
  var tx = ss.getSheetByName(SHEET_TX);
  if (!tx) {
    tx = ss.insertSheet(SHEET_TX);
    tx.getRange(1, 1, 1, COLS.length).setValues([COLS]).setFontWeight('bold');
    tx.setFrozenRows(1);
    tx.getRange('B:B').setNumberFormat('yyyy-mm-dd hh:mm');
    tx.getRange('C:C').setNumberFormat('@');   // 사이클 "2026-10" 이 날짜로 바뀌지 않게 글자 서식
    tx.getRange('E:E').setNumberFormat('#,##0');
    tx.getRange('O:P').setNumberFormat('yyyy-mm-dd hh:mm');
  }
  var cfg = ss.getSheetByName(SHEET_CFG);
  if (!cfg) {
    cfg = ss.insertSheet(SHEET_CFG);
    var rows = [['key', 'value', '설명']];
    rows.push(['PIN', DEFAULT_CFG.PIN, '앱에서 입력하는 비밀번호. 꼭 바꾸세요']);
    rows.push(['LEDGER_TYPE', DEFAULT_CFG.LEDGER_TYPE, 'shared(공동) 또는 personal(개인)']);
    rows.push(['CYCLE_START_DAY', DEFAULT_CFG.CYCLE_START_DAY, '월 사이클 시작일']);
    rows.push(['MEMBERS', DEFAULT_CFG.MEMBERS, '쉼표로 구분. 공동 장부의 결제인 목록 / 개인은 본인 이름 하나']);
    rows.push(['CATEGORIES', DEFAULT_CFG.CATEGORIES, '쉼표로 구분']);
    rows.push(['CATEGORY_RULES', DEFAULT_CFG.CATEGORY_RULES, '키워드:카테고리;... 사전에 없을 때 쓰는 규칙']);
    rows.push(['BUDGET_TOTAL', DEFAULT_CFG.BUDGET_TOTAL, '개인: 월 예산 총액 (사이클마다 다르면 앱의 예산 수정이 우선)']);
    rows.push(['SPLIT_RATIO', DEFAULT_CFG.SPLIT_RATIO, '공동: 분담 비율, MEMBERS 순서로 50,50 처럼. 비우면 똑같이']);
    rows.push(['AUTO_CONFIRM_MIN_CONFIDENCE', DEFAULT_CFG.AUTO_CONFIRM_MIN_CONFIDENCE, '알림 자동 수집 시 이 값 이상이면 확인 없이 등록']);
    rows.push(['LLM_ENDPOINT', '', '(선택) OpenAI 호환 chat/completions URL. 비우면 LLM 을 쓰지 않음']);
    rows.push(['LLM_KEY', '', '(선택) API 키']);
    rows.push(['LLM_MODEL', '', '(선택) 모델 이름, 예: gemini-2.5-flash-lite / gpt-5-nano']);
    cfg.getRange(1, 1, rows.length, 3).setValues(rows);
    cfg.getRange(1, 1, 1, 3).setFontWeight('bold');
    cfg.setColumnWidth(2, 400);
  }
  var dict = ss.getSheetByName(SHEET_DICT);
  if (!dict) {
    dict = ss.insertSheet(SHEET_DICT);
    dict.getRange(1, 1, 1, 3).setValues([['가맹점(정규화)', '카테고리', '횟수']]).setFontWeight('bold');
    dict.setFrozenRows(1);
  }
  var rec = ss.getSheetByName(SHEET_REC);
  if (!rec) {
    rec = ss.insertSheet(SHEET_REC);
    rec.getRange(1, 1, 1, RCOLS.length).setValues([RCOLS]).setFontWeight('bold');
    rec.setFrozenRows(1);
    rec.getRange('D:D').setNumberFormat('#,##0');
    rec.getRange('K:L').setNumberFormat('yyyy-mm-dd hh:mm');
  }
  setupV3_();
}

function cfgAll_() {
  if (CACHE_.cfg) return CACHE_.cfg;
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_CFG);
  var out = {};
  Object.keys(DEFAULT_CFG).forEach(function (k) { out[k] = DEFAULT_CFG[k]; });
  if (!sh) return out;
  var vals = sh.getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) {
    if (vals[i][0]) out[String(vals[i][0]).trim()] = String(vals[i][1]).trim();
  }
  CACHE_.cfg = out;
  return out;
}
function cfg_(key) { return cfgAll_()[key]; }

function publicConfig_() {
  var all = cfgAll_();
  var budgets = {};
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('BUDGET_') === 0 && k !== 'BUDGET_TOTAL' && all[k] !== '') budgets[k.substring(7)] = Number(String(all[k]).replace(/[^\d.-]/g, ''));
  });
  return {
    ledgerType: all.LEDGER_TYPE,
    cycleStartDay: Number(all.CYCLE_START_DAY) || 25,
    members: split_(all.MEMBERS),
    categories: split_(all.CATEGORIES),
    budgetTotal: all.BUDGET_TOTAL === '' ? null : Number(String(all.BUDGET_TOTAL).replace(/[^\d.-]/g, '')),
    budgets: budgets,
    apiVersion: API_VERSION,
    splitRatio: all.LEDGER_TYPE === 'shared' ? splitRatio_() : null,
    currentCycle: currentCycle_(),
    sheetUrl: SpreadsheetApp.getActive().getUrl()
  };
}

function split_(s) { return String(s || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean); }
function rules_() {
  return String(cfg_('CATEGORY_RULES') || '').split(';').map(function (p) {
    var kv = p.split(':'); return kv.length === 2 ? [kv[0].trim(), kv[1].trim()] : null;
  }).filter(Boolean);
}
function startDay_() { return Number(cfg_('CYCLE_START_DAY')) || 25; }
function currentCycle_() { return LedgerParser.cycleMonth(isoLocal_(new Date()), startDay_()); }

// ---------------------------------------------------------------- 거래 CRUD
function txSheet_() { return SpreadsheetApp.getActive().getSheetByName(SHEET_TX); }

function rowToObj_(row) {
  var o = {};
  COLS.forEach(function (c, i) {
    var v = row[i];
    if (v instanceof Date) v = isoLocal_(v);
    o[c] = v === undefined || v === null ? '' : v;
  });
  o['금액'] = Number(o['금액']) || 0;
  o['사이클'] = cycleStr_(o['사이클']);
  return o;
}

// 시트가 "2026-10" 을 날짜(2026-10-01)로 바꿔 저장해 두었어도 항상 "yyyy-mm" 글자로 돌려준다
function cycleStr_(v) {
  if (v instanceof Date) v = isoLocal_(v);
  var m = /^(\d{4})-(\d{2})/.exec(String(v || ''));
  return m ? m[1] + '-' + m[2] : String(v || '');
}

// 거래 한 줄을 r 행에 쓴다. 사이클 칸은 글자 서식으로 고정해 날짜로 바뀌는 것을 막는다.
function writeTxRow_(sh, r, o) {
  sh.getRange(r, COL['사이클'] + 1).setNumberFormat('@');
  sh.getRange(r, 1, 1, COLS.length).setValues([objToRow_(o)]);
}

function objToRow_(o) {
  return COLS.map(function (c) {
    var v = o[c];
    if (v === undefined || v === null) return '';
    if ((c === '일시' || c === '등록' || c === '수정') && v) return new Date(v);
    return v;
  });
}

function isoLocal_(d) {
  var tz = Session.getScriptTimeZone();
  return Utilities.formatDate(d, tz, "yyyy-MM-dd'T'HH:mm:ss");
}

function newId_() { return Utilities.getUuid().split('-')[0] + Date.now().toString(36); }

function findRowIndex_(id) {
  var sh = txSheet_();
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return -1;
}

function normalizeTx_(tx, existing) {
  var o = existing ? JSON.parse(JSON.stringify(existing)) : {};
  Object.keys(tx).forEach(function (k) { if (COLS.indexOf(k) >= 0 && k !== 'id') o[k] = tx[k]; });
  if (!o['일시']) o['일시'] = isoLocal_(new Date());
  o['일시'] = String(o['일시']).length === 10 ? o['일시'] + 'T12:00:00' : String(o['일시']).substring(0, 19);
  o['사이클'] = LedgerParser.cycleMonth(o['일시'], startDay_());
  o['유형'] = o['유형'] || '지출';
  o['금액'] = Math.round(Number(String(o['금액']).replace(/[^\d.-]/g, '')) || 0);
  o['가맹점'] = String(o['가맹점'] || '').trim();
  o['항목'] = String(o['항목'] || '').trim();
  var type = cfg_('LEDGER_TYPE');
  if (type === 'shared') {
    o['결제인'] = o['결제인'] || split_(cfg_('MEMBERS'))[0] || '';
    o['정산'] = o['정산'] === 'O' ? 'O' : 'X';
    o['계획'] = o['계획'] || '';
  } else {
    o['결제인'] = o['결제인'] || split_(cfg_('MEMBERS'))[0] || '';
    o['정산'] = '';
    o['계획'] = o['계획'] === 'Y' ? 'Y' : 'N';
  }
  if (!o['카테고리']) {
    var g = LedgerParser.guessCategory(o['가맹점'], readDict_(), rules_());
    o['카테고리'] = g ? g.category : '';
  }
  o['출처'] = o['출처'] || '수동';
  o['상태'] = o['상태'] || '확인';
  o['원문'] = o['원문'] || '';
  o['분담'] = type === 'shared' ? String(o['분담'] || '').trim() : '';
  o['태그'] = String(o['태그'] || '').trim();
  return o;
}

function addTx_(tx) {
  var sh = txSheet_();
  var o = normalizeTx_(tx, null);
  o.id = newId_();
  var now = isoLocal_(new Date());
  o['등록'] = now; o['수정'] = now;
  writeTxRow_(sh, sh.getLastRow() + 1, o);
  CACHE_.tx = null;
  if (o['상태'] === '확인') learn_(o['가맹점'], o['카테고리']);
  return o;
}

function updateTx_(id, tx) {
  var r = findRowIndex_(id);
  if (r < 0) throw new Error('not found: ' + id);
  var sh = txSheet_();
  var cur = rowToObj_(sh.getRange(r, 1, 1, COLS.length).getValues()[0]);
  var o = normalizeTx_(tx, cur);
  o.id = cur.id; o['등록'] = cur['등록']; o['수정'] = isoLocal_(new Date());
  writeTxRow_(sh, r, o);
  CACHE_.tx = null;
  if (o['상태'] === '확인') learn_(o['가맹점'], o['카테고리']);
  return o;
}

function deleteTx_(id) {
  var r = findRowIndex_(id);
  if (r < 0) return false;
  txSheet_().deleteRow(r);
  CACHE_.tx = null;
  return true;
}

function allTx_() {
  if (CACHE_.tx) return CACHE_.tx;
  var sh = txSheet_();
  var last = sh.getLastRow();
  var rows = last < 2 ? [] : sh.getRange(2, 1, last - 1, COLS.length).getValues().map(rowToObj_).filter(function (o) { return o.id; });
  CACHE_.tx = rows;
  return rows;
}

function listTx_(cycle, includeUnconfirmed) {
  cycle = cycle || currentCycle_();
  var rows = allTx_().filter(function (o) {
    return cycle === 'all' || o['사이클'] === cycle || (includeUnconfirmed && o['상태'] === '미확인');
  });
  rows.sort(function (a, b) { return a['일시'] < b['일시'] ? 1 : -1; });
  return rows;
}

function recentMerchants_() {
  var rows = allTx_();
  rows.sort(function (a, b) { return a['일시'] < b['일시'] ? 1 : -1; });
  var seen = {}, out = [];
  for (var i = 0; i < rows.length && out.length < 60; i++) {
    var m = rows[i]['가맹점'];
    if (!m || seen[m]) continue;
    seen[m] = true;
    out.push({ name: m, category: rows[i]['카테고리'] });
  }
  return out;
}

// ---------------------------------------------------------------- 정산 (공동)
function settle_(cycle) {
  var sh = txSheet_();
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var rng = sh.getRange(2, 1, last - 1, COLS.length);
  var vals = rng.getValues();
  var n = 0;
  for (var i = 0; i < vals.length; i++) {
    var o = rowToObj_(vals[i]);
    if (o['유형'] !== '지출' || o['정산'] !== 'X') continue;
    if (cycle && cycle !== 'all' && o['사이클'] > cycle) continue;   // 해당 사이클까지만
    vals[i][COL['정산']] = 'O';
    vals[i][COL['수정']] = new Date();
    n++;
  }
  if (n) rng.setValues(vals);
  return n;
}

// ---------------------------------------------------------------- 알림/스크린샷 자동 수집
// req: { text, device, source('알림'|'스크린샷'), payer? }
function ingest_(req) {
  var text = String(req.text || '');
  if (!text.trim()) throw new Error('empty text');
  var parsed = req.source === '스크린샷' ? LedgerParser.parseScreenshot(text) : LedgerParser.parseNotification(text);
  if (parsed.cancelled) {
    // 취소 알림: 같은 금액·가맹점의 최근 거래를 찾아 삭제 표시
    var rows = allTx_();
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i]['금액'] === parsed.amount && LedgerParser.normalizeMerchant(rows[i]['가맹점']) === LedgerParser.normalizeMerchant(parsed.merchant)) {
        return updateTx_(rows[i].id, { '상태': '취소', '항목': (rows[i]['항목'] ? rows[i]['항목'] + ' ' : '') + '(결제취소)' });
      }
    }
    return null;
  }
  if (!parsed.amount) throw new Error('amount not found');
  // 중복 방지: 같은 금액·가맹점이 10분 안에 이미 있으면 무시
  var dup = allTx_().filter(function (o) {
    return o['금액'] === parsed.amount && LedgerParser.normalizeMerchant(o['가맹점']) === LedgerParser.normalizeMerchant(parsed.merchant)
      && Math.abs(new Date(o['일시']).getTime() - new Date(parsed.date).getTime()) < 10 * 60 * 1000;
  });
  if (dup.length) return dup[0];
  var guess = LedgerParser.guessCategory(parsed.merchant, readDict_(), rules_());
  if (!guess) { var llm = llmClassify_(parsed.merchant, text); if (llm) guess = { category: llm, how: 'llm' }; }
  var minConf = Number(cfg_('AUTO_CONFIRM_MIN_CONFIDENCE')) || 0.9;
  var confirmed = parsed.confidence >= minConf && guess && (guess.how === 'exact' || guess.how === 'fuzzy');
  return addTx_({
    '일시': parsed.date,
    '유형': parsed.type,
    '금액': parsed.amount,
    '가맹점': parsed.merchant,
    '카테고리': guess ? guess.category : '',
    '결제인': req.payer || req.device || '',
    '출처': req.source || '알림',
    '상태': confirmed ? '확인' : '미확인',
    '원문': text.substring(0, 500)
  });
}

// ---------------------------------------------------------------- LLM 폴백 (선택, 제공사 무관)
/**
 * 사전·규칙으로 분류하지 못한 가맹점만 LLM 에 묻는다. 설정 탭에 아래 세 값을 넣으면 켜진다.
 *   LLM_ENDPOINT : OpenAI 호환 chat/completions URL
 *       OpenAI  https://api.openai.com/v1/chat/completions
 *       Gemini  https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
 *       Groq    https://api.groq.com/openai/v1/chat/completions
 *       Ollama  http://<내PC>:11434/v1/chat/completions   (로컬, 무료; 외부에서 접근 가능해야 함)
 *       Claude  OpenRouter 등 OpenAI 호환 게이트웨이를 통해 사용
 *   LLM_KEY   : API 키
 *   LLM_MODEL : 모델 이름 (가장 작은 모델이면 충분)
 * 이미지가 아니라 텍스트만, 그것도 가맹점명과 원문 일부만 보내므로 호출당 100 토큰 안팎이다.
 * 한 번 분류되어 사용자가 확인하면 사전에 저장되어 같은 가맹점은 다시 묻지 않는다.
 */
function llmClassify_(merchant, rawText) {
  var all = cfgAll_();
  if (!all.LLM_ENDPOINT || !all.LLM_MODEL) return null;
  var cats = split_(all.CATEGORIES);
  if (!cats.length) return null;
  var payload = {
    model: all.LLM_MODEL,
    temperature: 0,
    max_tokens: 12,
    messages: [
      { role: 'system', content: '가계부 분류기. 주어진 카테고리 목록 중 가장 알맞은 하나만 그대로 출력한다. 설명 금지.' },
      { role: 'user', content: '가맹점: ' + merchant + '\n원문: ' + String(rawText || '').substring(0, 120) + '\n카테고리: ' + cats.join(', ') }
    ]
  };
  try {
    var res = UrlFetchApp.fetch(all.LLM_ENDPOINT, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: all.LLM_KEY ? { Authorization: 'Bearer ' + all.LLM_KEY } : {},
      payload: JSON.stringify(payload)
    });
    if (res.getResponseCode() >= 300) { Logger.log('LLM ' + res.getResponseCode() + ' ' + res.getContentText().substring(0, 200)); return null; }
    var j = JSON.parse(res.getContentText());
    var answer = String(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
    for (var i = 0; i < cats.length; i++) if (answer.indexOf(cats[i]) >= 0) return cats[i];
    return null;
  } catch (err) { Logger.log('LLM error ' + err); return null; }
}

// ---------------------------------------------------------------- 요약
function summary_(cycle) {
  var rows = allTx_().filter(function (o) { return o['사이클'] === cycle && o['상태'] !== '취소'; });
  var type = cfg_('LEDGER_TYPE');
  var out = { cycle: cycle, expense: 0, income: 0, byCategory: {}, byPayer: {}, unsettledByPayer: {}, planned: 0, unplanned: 0, count: rows.length, unconfirmed: 0 };
  rows.forEach(function (o) {
    if (o['상태'] === '미확인') out.unconfirmed++;
    if (o['유형'] === '수입') { out.income += o['금액']; return; }
    out.expense += o['금액'];
    var c = o['카테고리'] || '미분류';
    out.byCategory[c] = (out.byCategory[c] || 0) + o['금액'];
    var p = o['결제인'] || '?';
    out.byPayer[p] = (out.byPayer[p] || 0) + o['금액'];
    if (type === 'shared' && o['정산'] === 'X') out.unsettledByPayer[p] = (out.unsettledByPayer[p] || 0) + o['금액'];
    if (type === 'personal') { if (o['계획'] === 'Y') out.planned += o['금액']; else out.unplanned += o['금액']; }
  });
  // 미확인 건은 사이클과 무관하게 알려준다
  out.unconfirmedTotal = allTx_().filter(function (o) { return o['상태'] === '미확인'; }).length;
  if (type === 'shared') {
    // 둘이 반씩 부담한다고 보고, 더 많이 낸 사람에게 차액의 절반을 돌려주는 계산
    var members = split_(cfg_('MEMBERS'));
    if (members.length === 2) {
      var a = out.unsettledByPayer[members[0]] || 0, b = out.unsettledByPayer[members[1]] || 0;
      var diff = (a - b) / 2;
      out.settlement = diff === 0 ? null : { from: diff > 0 ? members[1] : members[0], to: diff > 0 ? members[0] : members[1], amount: Math.round(Math.abs(diff)) };
    }
    // 미정산 전체(사이클 무관)
    var un = {};
    allTx_().forEach(function (o) { if (o['유형'] === '지출' && o['정산'] === 'X' && o['상태'] !== '취소') un[o['결제인'] || '?'] = (un[o['결제인'] || '?'] || 0) + o['금액']; });
    out.unsettledAllByPayer = un;
    // v3: 분담 비율과 정산 기록(일부 정산)을 반영한 실제 남은 금액
    var bal = balance_();
    out.settlementAll = bal.remaining;
    out.balance = bal;
  }
  // 고정(출처=고정) / 변동 지출
  out.fixed = 0;
  rows.forEach(function (o) { if (o['유형'] !== '수입' && o['출처'] === '고정') out.fixed += o['금액']; });
  out.variable = out.expense - out.fixed;
  out.trend = trend_(cycle, 6);
  var pc = publicConfig_();
  if (type === 'personal') {
    var bud = budgetFor_(cycle);           // v3: 사이클별 예산이 있으면 그것, 없으면 설정 탭 값
    out.budgetTotal = bud.total;
    if (bud.total) out.remaining = bud.total - out.expense;
    out.budgets = bud.byCategory;
  } else {
    if (pc.budgetTotal) out.remaining = pc.budgetTotal - out.expense;
    out.budgets = pc.budgets;
  }
  return out;
}

// 해당 사이클까지 n개 사이클의 지출/수입/고정 합계 (통계 화면의 추이 그래프용)
function trend_(cycle, n) {
  var cycles = [];
  var p = cycle.split('-'); var y = +p[0], m = +p[1];
  for (var i = n - 1; i >= 0; i--) {
    var d = new Date(y, m - 1 - i, 1);
    cycles.push(d.getFullYear() + '-' + (d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1));
  }
  var map = {};
  cycles.forEach(function (c) { map[c] = { cycle: c, expense: 0, income: 0, fixed: 0, planned: 0, count: 0 }; });
  allTx_().forEach(function (o) {
    var t = map[o['사이클']];
    if (!t || o['상태'] === '취소') return;
    if (o['유형'] === '수입') { t.income += o['금액']; return; }
    t.expense += o['금액']; t.count++;
    if (o['출처'] === '고정') t.fixed += o['금액'];
    if (o['계획'] === 'Y') t.planned += o['금액'];
  });
  return cycles.map(function (c) { return map[c]; });
}

// ---------------------------------------------------------------- 고정 수입/지출
function recSheet_() { return SpreadsheetApp.getActive().getSheetByName(SHEET_REC); }

function readRecurring_() {
  if (CACHE_.rec) return CACHE_.rec;
  var sh = recSheet_();
  var out = [];
  if (sh && sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, RCOLS.length).getValues().forEach(function (row) {
      if (!row[0]) return;
      var o = {};
      RCOLS.forEach(function (c, i) { var v = row[i]; if (v instanceof Date) v = isoLocal_(v); o[c] = v === undefined || v === null ? '' : v; });
      o['금액'] = Number(o['금액']) || 0;
      o['일'] = Math.min(31, Math.max(1, Number(o['일']) || 1));
      o['활성'] = o['활성'] === 'N' ? 'N' : 'Y';
      out.push(o);
    });
  }
  out.sort(function (a, b) { return a['유형'] === b['유형'] ? a['일'] - b['일'] : (a['유형'] === '수입' ? -1 : 1); });
  CACHE_.rec = out;
  return out;
}

function saveRecurring_(item) {
  var sh = recSheet_();
  var o = {};
  RCOLS.forEach(function (c) { o[c] = item[c] === undefined || item[c] === null ? '' : item[c]; });
  o['유형'] = o['유형'] === '수입' ? '수입' : '지출';
  o['이름'] = String(o['이름'] || '').trim();
  if (!o['이름']) throw new Error('이름을 입력하세요');
  o['금액'] = Math.round(Number(String(o['금액']).replace(/[^\d.-]/g, '')) || 0);
  if (!o['금액']) throw new Error('금액을 입력하세요');
  o['카테고리'] = String(o['카테고리'] || (o['유형'] === '수입' ? '수입' : '')).trim();
  o['결제인'] = o['결제인'] || split_(cfg_('MEMBERS'))[0] || '';
  o['일'] = Math.min(31, Math.max(1, Number(o['일']) || 1));
  o['계획'] = cfg_('LEDGER_TYPE') === 'personal' ? (o['계획'] === 'N' ? 'N' : 'Y') : '';
  o['활성'] = o['활성'] === 'N' ? 'N' : 'Y';
  o['메모'] = String(o['메모'] || '').trim();
  var now = isoLocal_(new Date());
  var r = -1;
  if (o.id) {
    var last = sh.getLastRow();
    if (last >= 2) { var ids = sh.getRange(2, 1, last - 1, 1).getValues(); for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(o.id)) { r = i + 2; break; } }
  }
  if (r < 0) { o.id = 'r' + newId_(); o['등록'] = now; r = sh.getLastRow() + 1; }
  else { var cur = sh.getRange(r, RCOL['등록'] + 1).getValue(); o['등록'] = cur instanceof Date ? isoLocal_(cur) : (cur || now); }
  o['수정'] = now;
  sh.getRange(r, 1, 1, RCOLS.length).setValues([RCOLS.map(function (c) { var v = o[c]; return (c === '등록' || c === '수정') && v ? new Date(v) : v; })]);
  CACHE_.rec = null;
  return o;
}

function deleteRecurring_(id) {
  var sh = recSheet_();
  var last = sh.getLastRow();
  if (last < 2) return false;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) { sh.deleteRow(i + 2); CACHE_.rec = null; return true; }
  return false;
}

// 고정 항목이 이 사이클에서 나가는 날짜. 사이클 시작일(25) 이상이면 시작 달, 아니면 다음 달.
function recurringDate_(item, cycle) {
  var p = cycle.split('-'); var y = +p[0], m = +p[1];
  var startDay = startDay_();
  var day = item['일'];
  if (day < startDay) { m += 1; if (m > 12) { m = 1; y += 1; } }
  var lastDay = new Date(y, m, 0).getDate();
  if (day > lastDay) day = lastDay;
  return y + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day + 'T12:00:00';
}

function recurringKey_(id) { return '고정:' + id; }

// 아직 이 사이클의 거래 탭에 들어가지 않은 활성 고정 항목
function dueRecurring_(cycle) {
  var have = {};
  allTx_().forEach(function (o) { if (o['사이클'] === cycle && o['출처'] === '고정') have[String(o['원문'])] = true; });
  return readRecurring_().filter(function (r) { return r['활성'] !== 'N' && !have[recurringKey_(r.id)]; });
}

function applyRecurring_(cycle, ids) {
  var due = dueRecurring_(cycle);
  if (ids && ids.length) due = due.filter(function (r) { return ids.indexOf(r.id) >= 0; });
  return due.map(function (r) {
    return addTx_({
      '일시': recurringDate_(r, cycle), '유형': r['유형'], '금액': r['금액'], '가맹점': r['이름'], '카테고리': r['카테고리'],
      '항목': r['메모'], '결제인': r['결제인'], '계획': r['계획'], '출처': '고정', '상태': '확인', '원문': recurringKey_(r.id)
    });
  });
}

// ---------------------------------------------------------------- 사전
function readDict_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_DICT);
  var out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) { if (r[0] && r[1]) out[String(r[0])] = String(r[1]); });
  return out;
}

function learn_(merchant, category) {
  var key = LedgerParser.normalizeMerchant(merchant);
  if (!key || !category) return;
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_DICT);
  var last = sh.getLastRow();
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 3).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0]) === key) {
        sh.getRange(i + 2, 2, 1, 2).setValues([[category, (Number(vals[i][2]) || 0) + 1]]);
        return;
      }
    }
  }
  sh.appendRow([key, category, 1]);
}

/** 거래 탭 전체로 사전을 다시 만든다. (메뉴/편집기에서 실행) */
function rebuildDict() {
  setup();
  var counts = {};
  allTx_().forEach(function (o) {
    if (o['유형'] !== '지출' || !o['가맹점'] || !o['카테고리']) return;
    var k = LedgerParser.normalizeMerchant(o['가맹점']);
    if (!k) return;
    counts[k] = counts[k] || {};
    counts[k][o['카테고리']] = (counts[k][o['카테고리']] || 0) + 1;
  });
  var rows = [];
  Object.keys(counts).sort().forEach(function (k) {
    var best = null;
    Object.keys(counts[k]).forEach(function (c) { if (!best || counts[k][c] > counts[k][best]) best = c; });
    rows.push([k, best, counts[k][best]]);
  });
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_DICT);
  sh.clearContents();
  sh.getRange(1, 1, 1, 3).setValues([['가맹점(정규화)', '카테고리', '횟수']]).setFontWeight('bold');
  if (rows.length) sh.getRange(2, 1, rows.length, 3).setValues(rows);
  Logger.log('사전 ' + rows.length + '개');
}

// ---------------------------------------------------------------- 기존 월별 시트 → 거래 탭 이관
/**
 * 기존 탭(2024년, 2025년, 26년 1월 ...)에서 "지출일자" 머리글을 찾아 그 아래 블록을 읽어 거래 탭에 넣는다.
 * 머리글 이름으로 열을 찾기 때문에 열 순서가 달라도 된다.
 *   지출일자 / 카테고리 / 구매처·세부내역 / 항목 / 금액 / 결제인 / 정산여부
 * 수입 표(연번 / 수입자 / 수입원 / 금액)도 유형=수입으로 넣는다.
 * 연도는 탭 이름(2024년, 26년 1월)에서 가져온다. 날짜가 비어 있으면 위 행의 날짜를 쓴다.
 * 두 번 실행하면 중복되므로, 이미 이관된 행(출처=이관)이 있으면 중단한다. 다시 하려면 force=true.
 */
function migrateLegacy(force) {
  setup();
  CACHE_ = {};
  var ss = SpreadsheetApp.getActive();
  var existing = allTx_().filter(function (o) { return o['출처'] === '이관'; });
  if (existing.length && !force) throw new Error('이미 이관된 행이 ' + existing.length + '개 있습니다. 다시 하려면 메뉴의 "이관 다시 하기"를 쓰세요');
  if (existing.length && force) removeMigratedRows_();   // 앱에서 직접 넣은 거래는 남기고 이관 행만 지운 뒤 다시 읽는다
  var type = cfg_('LEDGER_TYPE');
  var startDay = startDay_();
  var out = [];
  var log = [];
  var now = new Date();

  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (APP_SHEETS_.indexOf(name) >= 0) return;
    var ym = /(\d{2,4})\s*년(?:\s*(\d{1,2})\s*월)?/.exec(name);
    if (!ym) { log.push(name + ': 연도 없음, 건너뜀'); return; }
    var year = Number(ym[1]); if (year < 100) year += 2000;
    var month = ym[2] ? Number(ym[2]) : null;
    var vals = sh.getDataRange().getValues();
    var before = out.length;

    for (var r = 0; r < vals.length; r++) {
      for (var c = 0; c < vals[r].length; c++) {
        var h = String(vals[r][c]).trim();
        if (h === '지출일자') readExpenseBlock_(vals, r, c, { year: year, month: month, sheet: name }, out, type);
        else if (h === '수입자') readIncomeBlock_(vals, r, c, { year: year, month: month, sheet: name }, out);
      }
    }
    log.push(name + ': ' + (out.length - before) + '건');
  });

  if (!out.length) { Logger.log(log.join('\n')); return log; }
  var sh = txSheet_();
  var nowIso = isoLocal_(now);
  var rows = out.map(function (o) {
    o.id = newId_();
    o['사이클'] = LedgerParser.cycleMonth(o['일시'], startDay);
    o['출처'] = '이관'; o['상태'] = '확인'; o['등록'] = nowIso; o['수정'] = nowIso;
    return objToRow_(o);
  });
  var startRow = sh.getLastRow() + 1;
  sh.getRange(startRow, COL['사이클'] + 1, rows.length, 1).setNumberFormat('@');
  sh.getRange(startRow, 1, rows.length, COLS.length).setValues(rows);
  CACHE_.tx = null;
  rebuildDict();
  log.push('합계 ' + rows.length + '건 이관');
  Logger.log(log.join('\n'));
  return log;
}

// 출처가 '이관'인 행만 지운다 (수동/알림/스크린샷으로 넣은 거래는 보존)
function removeMigratedRows_() {
  var sh = txSheet_();
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var vals = sh.getRange(2, 1, last - 1, COLS.length).getValues();
  var keep = vals.filter(function (row) { return String(row[COL['출처']]) !== '이관'; });
  sh.getRange(2, 1, last - 1, COLS.length).clearContent();
  if (keep.length) sh.getRange(2, 1, keep.length, COLS.length).setValues(keep);
  CACHE_ = {};
  return vals.length - keep.length;
}

function headerMap_(vals, r, c, maxCols) {
  var map = {};
  for (var k = 0; k < maxCols && c + k < vals[r].length; k++) {
    var h = String(vals[r][c + k]).trim();
    if (!h && k > 0) break;
    if (h === '지출일자' || h === '일자') map.date = c + k;
    else if (h === '카테고리') map.category = c + k;
    else if (h === '구매처' || h === '세부내역' || h === '상호') map.merchant = c + k;
    else if (h === '항목' || h === '내용') map.item = c + k;
    else if (h === '금액' || h === '가격' || h === '총액') map.amount = c + k;
    else if (h === '결제인') map.payer = c + k;
    else if (h === '정산여부' || h === '정산') map.settled = c + k;
    else if (h === '연번') map.seq = c + k;
    else if (h === '수입자') map.payer = c + k;
    else if (h === '수입원') map.merchant = c + k;
  }
  return map;
}

function cellDate_(v, ctx, prev) {
  // v: Date | "4월 9일" | "2025-01-01" | "" ; 연도는 탭 이름 기준으로 보정
  var mo = null, d = null, y = ctx.year;
  if (v instanceof Date) { mo = v.getMonth() + 1; d = v.getDate(); y = ctx.year; }
  else {
    var s = String(v || '').trim();
    var m;
    if ((m = /(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/.exec(s))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/.exec(s))) { mo = +m[1]; d = +m[2]; }
    else if ((m = /^(\d{1,2})[./](\d{1,2})$/.exec(s))) { mo = +m[1]; d = +m[2]; }
  }
  if (!mo || !d) return prev || null;
  // "26년 1월" 탭은 1월 25일~2월 24일 사이클: 탭 월보다 작은 달(1~2월 → 다음 해 1,2월은 아님)… 연도 넘김 보정
  if (ctx.month && mo < ctx.month && ctx.month === 12) y = ctx.year + 1;
  var iso = y + '-' + (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d + 'T12:00:00';
  return iso;
}

function cellAmount_(v) {
  if (typeof v === 'number') return Math.round(v);
  var n = parseInt(String(v || '').replace(/[^\d-]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function readExpenseBlock_(vals, r, c, ctx, out, type) {
  var map = headerMap_(vals, r, c, 9);
  if (map.amount == null) return;
  // 블록 위 2행 안에 "계획"/"비계획" 표시가 있으면 개인 장부의 계획 구분으로 쓴다
  var planned = '';
  for (var up = 1; up <= 2 && r - up >= 0; up++) {
    for (var k = -1; k <= 4; k++) {
      var t = String((vals[r - up] || [])[c + k] || '');
      if (/비계획/.test(t)) { planned = 'N'; break; }
      if (/계획/.test(t)) { planned = 'Y'; break; }
    }
    if (planned) break;
  }
  // 블록 제목에 "2025년12월 25일~" 처럼 연도·월이 있으면 그걸 사이클 시작으로 본다 (탭 이름 연도보다 우선).
  // 시작 달보다 작은 달은 다음 해 (12월 시작 사이클의 1월 거래 등).
  var blockYear = null, blockMonth = null;
  for (var up2 = 1; up2 <= 3 && r - up2 >= 0; up2++) {
    for (var k2 = -1; k2 <= 4; k2++) {
      var bt = /(\d{4})\s*년\s*(\d{1,2})\s*월/.exec(String((vals[r - up2] || [])[c + k2] || ''));
      if (bt) { blockYear = Number(bt[1]); blockMonth = Number(bt[2]); break; }
    }
    if (blockYear) break;
  }
  var prevDate = null, blank = 0;
  for (var i = r + 1; i < vals.length; i++) {
    var row = vals[i];
    var cat = String(row[map.category] != null && map.category != null ? row[map.category] : '').trim();
    if (cat === '지출일자' || String(row[map.date] || '').trim() === '지출일자') break;   // 다음 블록 머리글
    var amt = cellAmount_(row[map.amount]);
    var rawDate = map.date != null ? row[map.date] : '';
    var dateIso = cellDate_(rawDate, ctx, prevDate);
    if (blockYear && dateIso && !/\d{4}/.test(String(rawDate instanceof Date ? '' : rawDate))) {
      var mo2 = Number(dateIso.substring(5, 7));
      dateIso = (mo2 < blockMonth ? blockYear + 1 : blockYear) + dateIso.substring(4);
    }
    var merchant = map.merchant != null ? String(row[map.merchant] || '').trim() : '';
    var item = map.item != null ? String(row[map.item] || '').trim() : '';
    var empty = !amt && !cat && !merchant && !item;
    if (empty) { blank++; if (blank >= 6) break; continue; }
    blank = 0;
    if (/^(합계|총계|소계|당월)/.test(cat) || /^(합계|총계|소계)/.test(merchant) || /^(합계|총계|소계)/.test(item)) continue;
    if (!amt) continue;
    if (dateIso) prevDate = dateIso;
    if (!dateIso) dateIso = ctx.year + '-' + ((ctx.month || 1) < 10 ? '0' : '') + (ctx.month || 1) + '-25T12:00:00';
    var o = {
      '일시': dateIso, '유형': '지출', '금액': amt, '가맹점': merchant || cat, '카테고리': cat, '항목': item,
      '결제인': map.payer != null ? String(row[map.payer] || '').trim() : '',
      '정산': type === 'shared' ? (map.settled != null && String(row[map.settled]).trim() === 'X' ? 'X' : 'O') : '',
      '계획': type === 'personal' ? (planned || 'N') : '',
      '원문': ctx.sheet
    };
    out.push(o);
  }
}

function readIncomeBlock_(vals, r, c, ctx, out) {
  var map = headerMap_(vals, r, c - 1 >= 0 ? c - 1 : c, 6);
  if (map.amount == null) return;
  var dateIso = ctx.year + '-' + ((ctx.month || 1) < 10 ? '0' : '') + (ctx.month || 1) + '-25T12:00:00';
  var blank = 0;
  for (var i = r + 1; i < vals.length; i++) {
    var row = vals[i];
    var amt = cellAmount_(row[map.amount]);
    var who = map.payer != null ? String(row[map.payer] || '').trim() : '';
    var src = map.merchant != null ? String(row[map.merchant] || '').trim() : '';
    if (!amt && !who && !src) { blank++; if (blank >= 3) break; continue; }
    blank = 0;
    if (/^(합계|총계|소계)/.test(who) || /^(합계|총계|소계)/.test(src) || !amt) continue;
    out.push({ '일시': dateIso, '유형': '수입', '금액': amt, '가맹점': src, '카테고리': '수입', '항목': '', '결제인': who, '정산': '', '계획': '', '원문': ctx.sheet });
  }
}

// ---------------------------------------------------------------- 드라이브 백업
/**
 * 거래·설정·사전 탭을 CSV 로 드라이브의 "가계부 백업/<시트 이름>" 폴더에 저장한다.
 * 시트 자체에도 버전 기록이 있지만, 실수로 탭을 지우거나 수식이 꼬였을 때를 위한 별도 사본이다.
 * installBackupTrigger() 를 한 번 실행하면 매일 새벽 자동으로 돌고, 최근 60개만 남긴다.
 */
function backupToDrive() {
  setup();
  var ss = SpreadsheetApp.getActive();
  var root = getOrCreateFolder_(DriveApp.getRootFolder(), '가계부 백업');
  var folder = getOrCreateFolder_(root, ss.getName());
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmm');
  APP_SHEETS_.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    var vals = sh.getDataRange().getDisplayValues();
    var csv = vals.map(function (r) { return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(','); }).join('\n');
    folder.createFile(stamp + '_' + name + '.csv', '﻿' + csv, MimeType.CSV);
  });
  // 오래된 백업 정리 (파일 60개 초과분)
  var files = [], it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  for (var i = 60; i < files.length; i++) files[i].setTrashed(true);
  Logger.log('백업 완료: ' + folder.getUrl());
  return folder.getUrl();
}

function getOrCreateFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** 매일 04시 백업 트리거를 건다. 편집기에서 한 번만 실행. */
function installBackupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'backupToDrive') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('backupToDrive').timeBased().everyDays(1).atHour(4).create();
  Logger.log('백업 트리거 설치됨');
}

// ---------------------------------------------------------------- 시트 메뉴
function onOpen() {
  SpreadsheetApp.getUi().createMenu('가계부 앱')
    .addItem('초기 설정(탭 만들기)', 'setup')
    .addItem('기존 월별 시트 → 거래 탭 이관', 'migrateLegacyMenu')
    .addItem('이관 다시 하기 (이관 행 지우고 재실행)', 'migrateLegacyAgainMenu')
    .addItem('사전 다시 만들기', 'rebuildDict')
    .addItem('사이클 열 글자로 고치기', 'fixCycleColumnMenu')
    .addSeparator()
    .addItem('세이프 박스 탭 → 통장 이관', 'migrateSafeBoxMenu')
    .addItem('대출 상환 표 → 부채 이관', 'migrateLoanMenu')
    .addItem('영수증 탭 → 품목 이관', 'migrateReceiptsMenu')
    .addItem('고정지출 표 → 고정 항목 이관', 'migrateFixedCostsMenu')
    .addSeparator()
    .addItem('지금 드라이브로 백업', 'backupMenu')
    .addItem('매일 자동 백업 켜기', 'installBackupTrigger')
    .addSeparator()
    .addItem('서버 업데이트 (GitHub 최신 코드로)', 'updateServerMenu')
    .addItem('자동 업데이트 켜기 (매시간)', 'installUpdateTriggerMenu')
    .addToUi();
}
/** 거래 탭의 사이클 열이 날짜로 저장된 것을 "yyyy-mm" 글자로 되돌린다. 앱은 읽을 때 알아서 처리하지만 시트에서 보기 좋게 하려면 한 번 실행. */
function fixCycleColumn() {
  setup();
  var sh = txSheet_();
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var rng = sh.getRange(2, COL['사이클'] + 1, last - 1, 1);
  var vals = rng.getValues().map(function (r) { return [cycleStr_(r[0])]; });
  rng.setNumberFormat('@');
  rng.setValues(vals);
  return vals.length;
}
function fixCycleColumnMenu() {
  var n = fixCycleColumn();
  SpreadsheetApp.getUi().alert('완료', '사이클 ' + n + '칸을 글자로 고쳤습니다.', SpreadsheetApp.getUi().ButtonSet.OK);
}
function backupMenu() {
  var url = backupToDrive();
  SpreadsheetApp.getUi().alert('백업 완료', '드라이브 폴더: ' + url, SpreadsheetApp.getUi().ButtonSet.OK);
}
function migrateLegacyMenu() {
  var ui = SpreadsheetApp.getUi();
  try {
    var log = migrateLegacy(false);
    ui.alert('이관 결과', (log || []).join('\n'), ui.ButtonSet.OK);
  } catch (e) { ui.alert('이관 중단', String(e.message || e), ui.ButtonSet.OK); }
}
function migrateLegacyAgainMenu() {
  var ui = SpreadsheetApp.getUi();
  var ans = ui.alert('이관 다시 하기', '거래 탭에서 출처가 "이관"인 행을 모두 지우고 월별 시트를 다시 읽어옵니다.\n앱에서 직접 넣은 거래는 그대로 남습니다. 설정 탭의 LEDGER_TYPE 을 먼저 확인하세요.\n계속할까요?', ui.ButtonSet.YES_NO);
  if (ans !== ui.Button.YES) return;
  try {
    var log = migrateLegacy(true);
    ui.alert('이관 결과', (log || []).join('\n'), ui.ButtonSet.OK);
  } catch (e) { ui.alert('이관 중단', String(e.message || e), ui.ButtonSet.OK); }
}

// ================================================================ v3: 정산 기록·통장·부채·이벤트·품목·사이클 예산·카테고리 정리
// 탭 이름과 열. 모두 setup() 이 자동으로 만든다. 열 순서는 아래 배열이 기준이다 (시트에서 열을 옮기지 말 것).
var SHEET_SET = '정산';       // 정산 기록 (공동): 누가 누구에게 얼마를 보냈나. 상태 열림 = 아직 마감 전, 마감 = 정산 완료로 묶임
var SHEET_ACC = '통장';       // 통장(공금·비상금 등) 목록
var SHEET_ACCTX = '통장거래'; // 통장 입금/출금 기록
var SHEET_DEBT = '부채';      // 대출
var SHEET_EVT = '이벤트';     // 여행 등 묶어서 보는 태그
var SHEET_ITEM = '품목';      // 영수증 세부 품목 (거래 하나에 여러 줄)
var SHEET_BUD = '예산';       // 사이클별 예산 (개인). 카테고리 빈칸 = 총액
var SCOLS = ['id', '일시', '사이클', '보낸사람', '받는사람', '금액', '메모', '태그', '상태', '등록'];
var ACOLS = ['id', '이름', '종류', '소유', '메모', '활성', '등록'];
var ATCOLS = ['id', '일시', '통장', '구분', '금액', '메모', '거래id', '등록'];
var DCOLS = ['id', '이름', '기관', '원금', '연이율', '월상환금', '시작일', '총회차', '납입회차', '소유', '메모', '활성', '등록'];
var ECOLS = ['id', '이름', '시작일', '종료일', '메모', '상태', '등록'];
var ICOLS = ['id', '거래id', '품목', '수량', '금액', '등록'];
var BCOLS = ['사이클', '카테고리', '금액', '수정'];
var TEXT_COLS_ = { '사이클': 1, '시작일': 1, '종료일': 1, '통장': 1 };   // 시트가 날짜로 바꾸지 못하게 글자 서식을 거는 열
var DATE_COLS_ = { '일시': 1, '등록': 1, '수정': 1 };
var APP_SHEETS_ = [SHEET_TX, SHEET_CFG, SHEET_DICT, SHEET_REC, SHEET_SET, SHEET_ACC, SHEET_ACCTX, SHEET_DEBT, SHEET_EVT, SHEET_ITEM, SHEET_BUD];
var TAB_DEFS_ = [[SHEET_SET, SCOLS], [SHEET_ACC, ACOLS], [SHEET_ACCTX, ATCOLS], [SHEET_DEBT, DCOLS], [SHEET_EVT, ECOLS], [SHEET_ITEM, ICOLS], [SHEET_BUD, BCOLS]];

function setupV3_() {
  var ss = SpreadsheetApp.getActive();
  TAB_DEFS_.forEach(function (def) {
    var name = def[0], cols = def[1];
    var sh = ss.getSheetByName(name);
    if (sh) return;
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
    cols.forEach(function (c, i) {
      var col = String.fromCharCode(65 + i);
      if (TEXT_COLS_[c]) sh.getRange(col + ':' + col).setNumberFormat('@');
      else if (c === '금액' || c === '원금' || c === '월상환금') sh.getRange(col + ':' + col).setNumberFormat('#,##0');
      else if (DATE_COLS_[c]) sh.getRange(col + ':' + col).setNumberFormat('yyyy-mm-dd hh:mm');
    });
  });
  // 거래 탭에 v3 열(분담, 태그)이 없으면 머리글만 덧붙인다. 기존 행은 빈칸 = 기본값.
  var tx = ss.getSheetByName(SHEET_TX);
  if (tx) {
    var head = tx.getRange(1, 1, 1, COLS.length).getValues()[0];
    for (var i = 0; i < COLS.length; i++) if (String(head[i] || '') !== COLS[i]) tx.getRange(1, i + 1).setValue(COLS[i]).setFontWeight('bold');
  }
}

// ---- 공용 표 읽기/쓰기 (id 가 첫 열인 탭)
function tabRead_(name, cols) {
  var key = 'tab:' + name;
  if (CACHE_[key]) return CACHE_[key];
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  var out = [];
  if (sh && sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, cols.length).getValues().forEach(function (row) {
      if (row[0] === '' || row[0] === null || row[0] === undefined) return;
      var o = {};
      cols.forEach(function (c, i) {
        var v = row[i];
        if (v instanceof Date) v = TEXT_COLS_[c] ? isoLocal_(v).substring(0, c === '사이클' ? 7 : 10) : isoLocal_(v);
        o[c] = v === undefined || v === null ? '' : v;
      });
      out.push(o);
    });
  }
  CACHE_[key] = out;
  return out;
}
function tabRowIndex_(name, id) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return -1;
}
function tabWrite_(name, cols, o, rowIndex) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  var r = rowIndex > 0 ? rowIndex : sh.getLastRow() + 1;
  cols.forEach(function (c, i) { if (TEXT_COLS_[c]) sh.getRange(r, i + 1).setNumberFormat('@'); });
  sh.getRange(r, 1, 1, cols.length).setValues([cols.map(function (c) {
    var v = o[c];
    if (v === undefined || v === null) return '';
    if (DATE_COLS_[c] && v) return new Date(v);
    return v;
  })]);
  CACHE_['tab:' + name] = null;
  return o;
}
function tabUpsert_(name, cols, o, prefix) {
  var r = o.id ? tabRowIndex_(name, o.id) : -1;
  if (r < 0) { o.id = (prefix || '') + newId_(); o['등록'] = isoLocal_(new Date()); }
  else if (!o['등록']) { var cur = tabRead_(name, cols).filter(function (x) { return x.id === o.id; })[0]; o['등록'] = cur ? cur['등록'] : isoLocal_(new Date()); }
  return tabWrite_(name, cols, o, r);
}
function tabDelete_(name, id) {
  var r = tabRowIndex_(name, id);
  if (r < 0) return false;
  SpreadsheetApp.getActive().getSheetByName(name).deleteRow(r);
  CACHE_['tab:' + name] = null;
  return true;
}
function amount_(v) { return Math.round(Number(String(v === undefined || v === null ? '' : v).replace(/[^\d.-]/g, '')) || 0); }
function day_(v) { v = String(v || ''); return v.length >= 10 ? v.substring(0, 10) : v; }

// ---------------------------------------------------------------- 분담 비율과 잔액 (공동)
// 설정 SPLIT_RATIO = "50,50" (MEMBERS 순서). 거래의 분담 칸: 빈칸 = 설정 비율, 이름 = 그 사람이 전액 부담, "60:40" = 그 거래만 다른 비율.
function splitRatio_() {
  var m = split_(cfg_('MEMBERS'));
  var r = split_(cfg_('SPLIT_RATIO') || '').map(Number);
  var sum = r.reduce(function (a, b) { return a + b; }, 0);
  if (r.length !== m.length || r.some(isNaN) || !sum) { r = m.map(function () { return 1; }); sum = m.length; }
  var out = {};
  m.forEach(function (name, i) { out[name] = r[i] / sum; });
  return out;
}
function shareOf_(tx, member, members, ratio) {
  var s = String(tx['분담'] || '').trim();
  if (!s) return ratio[member] || 0;
  if (members.indexOf(s) >= 0) return s === member ? 1 : 0;
  var parts = s.split(/[:\/]/).map(Number);
  if (parts.length === members.length && !parts.some(isNaN)) { var sum = parts.reduce(function (a, b) { return a + b; }, 0); return sum ? parts[members.indexOf(member)] / sum : ratio[member] || 0; }
  return ratio[member] || 0;
}
// 미정산 거래(정산=X)와 열린 정산 기록을 합쳐 "지금 누가 누구에게 얼마를 줘야 하나"를 계산한다
function balance_() {
  var members = split_(cfg_('MEMBERS'));
  var ratio = splitRatio_();
  var net = {}, paid = {}, share = {};
  members.forEach(function (m) { net[m] = 0; paid[m] = 0; share[m] = 0; });
  var openTx = 0, openTxSum = 0;
  allTx_().forEach(function (o) {
    if (o['유형'] !== '지출' || o['정산'] !== 'X' || o['상태'] === '취소') return;
    openTx++; openTxSum += o['금액'];
    var p = o['결제인'];
    if (net[p] === undefined) { net[p] = 0; paid[p] = 0; share[p] = 0; }
    paid[p] += o['금액'];
    members.forEach(function (m) { var s = o['금액'] * shareOf_(o, m, members, ratio); share[m] += s; });
  });
  Object.keys(net).forEach(function (m) { net[m] = paid[m] - (share[m] || 0); });
  var payments = tabRead_(SHEET_SET, SCOLS).filter(function (s) { return s['상태'] !== '마감'; });
  var paySum = 0;
  payments.forEach(function (s) { var a = amount_(s['금액']); paySum += a; if (net[s['보낸사람']] !== undefined) net[s['보낸사람']] += a; if (net[s['받는사람']] !== undefined) net[s['받는사람']] -= a; });
  var remaining = null;
  if (members.length === 2) {
    var d = Math.round(net[members[0]]);
    if (d !== 0) remaining = { from: d > 0 ? members[1] : members[0], to: d > 0 ? members[0] : members[1], amount: Math.abs(d) };
  } else {
    // 셋 이상: 가장 많이 내야 하는 사람 → 가장 많이 받아야 하는 사람 (한 번에 하나씩)
    var ks = Object.keys(net).sort(function (a, b) { return net[a] - net[b]; });
    var lo = ks[0], hi = ks[ks.length - 1];
    if (Math.round(net[lo]) < 0 && Math.round(net[hi]) > 0) remaining = { from: lo, to: hi, amount: Math.round(Math.min(-net[lo], net[hi])) };
  }
  return { net: net, paid: paid, share: share, remaining: remaining, openTx: openTx, openTxSum: openTxSum, openPayments: payments.length, openPaymentsSum: paySum, ratio: ratio };
}
function settlementsRead_() {
  var log = tabRead_(SHEET_SET, SCOLS).slice();
  log.sort(function (a, b) { return a['일시'] < b['일시'] ? 1 : -1; });
  return { balance: balance_(), log: log.slice(0, 100), total: log.length };
}
// 정산 기록 추가. 남은 금액이 0 이 되면 자동으로 마감한다(미정산 거래 → 정산됨, 열린 기록 → 마감).
function settlePay_(req) {
  var members = split_(cfg_('MEMBERS'));
  var from = String(req.from || '').trim(), to = String(req.to || '').trim();
  if (members.indexOf(from) < 0 || members.indexOf(to) < 0 || from === to) throw new Error('보낸 사람과 받는 사람을 확인하세요');
  var amt = amount_(req.amount);
  if (amt <= 0) throw new Error('금액을 입력하세요');
  var when = req.date ? (String(req.date).length === 10 ? req.date + 'T12:00:00' : String(req.date).substring(0, 19)) : isoLocal_(new Date());
  var o = { '일시': when, '사이클': LedgerParser.cycleMonth(when, startDay_()), '보낸사람': from, '받는사람': to, '금액': amt, '메모': String(req.memo || '').trim(), '태그': String(req.tag || '').trim(), '상태': '열림' };
  tabUpsert_(SHEET_SET, SCOLS, o, 's');
  var bal = balance_();
  var closed = false;
  if (!bal.remaining) { settleClose_(); closed = true; bal = balance_(); }
  return { payment: o, balance: bal, closed: closed };
}
// 정산 완료: 남은 금액이 있으면 그만큼 보낸 것으로 기록하고, 미정산 거래와 열린 기록을 모두 마감한다
function settleFinish_(req) {
  var bal = balance_();
  var payment = null;
  if (bal.remaining) {
    var when = isoLocal_(new Date());
    payment = { '일시': when, '사이클': LedgerParser.cycleMonth(when, startDay_()), '보낸사람': bal.remaining.from, '받는사람': bal.remaining.to, '금액': bal.remaining.amount, '메모': String((req && req.memo) || '정산 완료').trim(), '태그': '', '상태': '열림' };
    tabUpsert_(SHEET_SET, SCOLS, payment, 's');
  }
  var n = settleClose_();
  return { payment: payment, settledTx: n, balance: balance_() };
}
function settleClose_() {
  var n = settle_();   // 모든 미정산 지출 → O
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_SET);
  var last = sh.getLastRow();
  if (last >= 2) {
    var rng = sh.getRange(2, 1, last - 1, SCOLS.length);
    var vals = rng.getValues(); var changed = false;
    for (var i = 0; i < vals.length; i++) if (vals[i][0] && String(vals[i][SCOLS.indexOf('상태')]) !== '마감') { vals[i][SCOLS.indexOf('상태')] = '마감'; changed = true; }
    if (changed) rng.setValues(vals);
  }
  CACHE_['tab:' + SHEET_SET] = null; CACHE_.tx = null;
  return n;
}
function settleDelete_(id) {
  var row = tabRead_(SHEET_SET, SCOLS).filter(function (s) { return s.id === id; })[0];
  if (!row) return false;
  if (row['상태'] === '마감') throw new Error('마감된 정산 기록은 지울 수 없습니다');
  return tabDelete_(SHEET_SET, id);
}

// ---------------------------------------------------------------- 통장 (공금·비상금)
function accountsRead_() {
  var accs = tabRead_(SHEET_ACC, ACOLS);
  var txs = tabRead_(SHEET_ACCTX, ATCOLS).slice();
  txs.sort(function (a, b) { return a['일시'] < b['일시'] ? 1 : -1; });
  var bal = {};
  txs.forEach(function (t) { var a = amount_(t['금액']); bal[t['통장']] = (bal[t['통장']] || 0) + (t['구분'] === '출금' ? -a : a); });
  return {
    accounts: accs.map(function (a) { return Object.assign({}, a, { balance: bal[a.id] || 0 }); }),
    log: txs.slice(0, 100), total: txs.length
  };
}
function accountSave_(item) {
  var o = {};
  ACOLS.forEach(function (c) { o[c] = item[c] === undefined || item[c] === null ? '' : item[c]; });
  o['이름'] = String(o['이름'] || '').trim();
  if (!o['이름']) throw new Error('통장 이름을 입력하세요');
  o['종류'] = String(o['종류'] || '공금').trim();
  o['소유'] = String(o['소유'] || '').trim();
  o['활성'] = o['활성'] === 'N' ? 'N' : 'Y';
  o['메모'] = String(o['메모'] || '').trim();
  return tabUpsert_(SHEET_ACC, ACOLS, o, 'a');
}
function accountDelete_(id) {
  var used = tabRead_(SHEET_ACCTX, ATCOLS).some(function (t) { return t['통장'] === id; });
  if (used) throw new Error('기록이 있는 통장은 지울 수 없습니다. 대신 끄세요');
  return tabDelete_(SHEET_ACC, id);
}
function accountTxAdd_(tx) {
  var accs = tabRead_(SHEET_ACC, ACOLS);
  if (!accs.some(function (a) { return a.id === tx['통장']; })) throw new Error('통장을 고르세요');
  var amt = amount_(tx['금액']);
  if (amt <= 0) throw new Error('금액을 입력하세요');
  var when = tx['일시'] ? (String(tx['일시']).length === 10 ? tx['일시'] + 'T12:00:00' : String(tx['일시']).substring(0, 19)) : isoLocal_(new Date());
  var o = { '일시': when, '통장': tx['통장'], '구분': tx['구분'] === '출금' ? '출금' : '입금', '금액': amt, '메모': String(tx['메모'] || '').trim(), '거래id': String(tx['거래id'] || '') };
  return tabUpsert_(SHEET_ACCTX, ATCOLS, o, 't');
}

// ---------------------------------------------------------------- 부채 (대출)
// 원리금균등 기준. 연이율 r(연%), 월이율 i = r/1200. 월상환금 M = P·i·(1+i)^n / ((1+i)^n − 1).
// k 회 납입 뒤 잔여 원금 = P·(1+i)^k − M·((1+i)^k − 1)/i. 납입회차를 비워 두면 시작일부터 지난 달 수로 본다.
function debtCalc_(d) {
  var P = amount_(d['원금']), r = Number(d['연이율']) || 0, i = r / 1200;
  var n = Number(d['총회차']) || 0, M = amount_(d['월상환금']);
  if (!n && M && P) n = i > 0 ? Math.ceil(-Math.log(1 - P * i / M) / Math.log(1 + i)) : Math.ceil(P / M);
  if (!M && n && P) M = i > 0 ? Math.round(P * i * Math.pow(1 + i, n) / (Math.pow(1 + i, n) - 1)) : Math.round(P / n);
  var start = day_(d['시작일']);
  var k = d['납입회차'] === '' || d['납입회차'] === null || d['납입회차'] === undefined ? monthsBetween_(start, isoLocal_(new Date()).substring(0, 10)) : Number(d['납입회차']) || 0;
  if (n) k = Math.min(n, Math.max(0, k));
  var remaining = i > 0 ? P * Math.pow(1 + i, k) - M * (Math.pow(1 + i, k) - 1) / i : P - M * k;
  remaining = Math.max(0, Math.round(remaining));
  if (n && k >= n) remaining = 0;
  return { principal: P, rate: r, monthly: M, months: n, paid: k, remaining: remaining, progress: n ? k / n : 0, totalInterest: n && M ? M * n - P : 0,
    nextDue: start ? addMonths_(start, k + 1) : '', endDate: start && n ? addMonths_(start, n) : '' };
}
function monthsBetween_(a, b) {
  if (!a || !b) return 0;
  var pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  var m = (pb[0] - pa[0]) * 12 + (pb[1] - pa[1]);
  if (pb[2] < pa[2]) m -= 1;
  return Math.max(0, m);
}
function addMonths_(day, n) {
  var p = day.split('-').map(Number);
  var d = new Date(p[0], p[1] - 1 + n, 1);
  var last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  var dd = Math.min(p[2], last);
  return d.getFullYear() + '-' + (d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1) + '-' + (dd < 10 ? '0' : '') + dd;
}
function debtsRead_() {
  return tabRead_(SHEET_DEBT, DCOLS).map(function (d) { return Object.assign({}, d, { calc: debtCalc_(d) }); });
}
function debtSave_(item) {
  var o = {};
  DCOLS.forEach(function (c) { o[c] = item[c] === undefined || item[c] === null ? '' : item[c]; });
  o['이름'] = String(o['이름'] || '').trim();
  if (!o['이름']) throw new Error('이름을 입력하세요');
  o['원금'] = amount_(o['원금']);
  if (!o['원금']) throw new Error('원금을 입력하세요');
  o['연이율'] = Number(String(o['연이율']).replace(/[^\d.]/g, '')) || 0;
  o['월상환금'] = amount_(o['월상환금']);
  o['총회차'] = Number(o['총회차']) || '';
  o['납입회차'] = o['납입회차'] === '' ? '' : (Number(o['납입회차']) || 0);
  o['시작일'] = day_(o['시작일']);
  if (!o['월상환금'] && !o['총회차']) throw new Error('월상환금 또는 총회차 중 하나는 입력하세요');
  o['활성'] = o['활성'] === 'N' ? 'N' : 'Y';
  ['기관', '소유', '메모'].forEach(function (c) { o[c] = String(o[c] || '').trim(); });
  tabUpsert_(SHEET_DEBT, DCOLS, o, 'd');
  return Object.assign({}, o, { calc: debtCalc_(o) });
}

// ---------------------------------------------------------------- 이벤트 (여행 등 태그로 묶어 보기)
function eventsRead_() {
  var evs = tabRead_(SHEET_EVT, ECOLS);
  var byTag = {};
  allTx_().forEach(function (o) {
    var t = String(o['태그'] || '').trim(); if (!t || o['상태'] === '취소') return;
    var e = byTag[t] || (byTag[t] = { expense: 0, income: 0, count: 0, byPayer: {}, byCategory: {} });
    e.count++;
    if (o['유형'] === '수입') { e.income += o['금액']; return; }
    e.expense += o['금액'];
    e.byPayer[o['결제인'] || '?'] = (e.byPayer[o['결제인'] || '?'] || 0) + o['금액'];
    e.byCategory[o['카테고리'] || '미분류'] = (e.byCategory[o['카테고리'] || '미분류'] || 0) + o['금액'];
  });
  var payByTag = {};
  tabRead_(SHEET_SET, SCOLS).forEach(function (s) { var t = String(s['태그'] || '').trim(); if (!t) return; (payByTag[t] = payByTag[t] || []).push(s); });
  return evs.map(function (e) {
    var st = byTag[e['이름']] || { expense: 0, income: 0, count: 0, byPayer: {}, byCategory: {} };
    return Object.assign({}, e, { stats: st, payments: payByTag[e['이름']] || [] });
  });
}
function eventSave_(item) {
  var o = {};
  ECOLS.forEach(function (c) { o[c] = item[c] === undefined || item[c] === null ? '' : item[c]; });
  o['이름'] = String(o['이름'] || '').trim();
  if (!o['이름']) throw new Error('이벤트 이름을 입력하세요');
  o['시작일'] = day_(o['시작일']); o['종료일'] = day_(o['종료일']);
  o['상태'] = o['상태'] === '마감' ? '마감' : '진행';
  o['메모'] = String(o['메모'] || '').trim();
  return tabUpsert_(SHEET_EVT, ECOLS, o, 'e');
}

// ---------------------------------------------------------------- 품목 (영수증 세부)
function itemsRead_(txId) {
  return tabRead_(SHEET_ITEM, ICOLS).filter(function (it) { return String(it['거래id']) === String(txId); });
}
function itemCounts_() {
  var out = {};
  tabRead_(SHEET_ITEM, ICOLS).forEach(function (it) { out[it['거래id']] = (out[it['거래id']] || 0) + 1; });
  return out;
}
// 거래 하나의 품목을 통째로 바꾼다 (지우고 다시 씀)
function itemsSave_(txId, items) {
  if (!txId) throw new Error('거래를 먼저 저장하세요');
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_ITEM);
  var last = sh.getLastRow();
  var keep = [];
  if (last >= 2) keep = sh.getRange(2, 1, last - 1, ICOLS.length).getValues().filter(function (row) { return row[0] && String(row[ICOLS.indexOf('거래id')]) !== String(txId); });
  var now = new Date();
  var fresh = (items || []).map(function (it) {
    var name = String(it['품목'] || '').trim(); if (!name) return null;
    return ['i' + newId_(), String(txId), name, Number(it['수량']) || 1, amount_(it['금액']), now];
  }).filter(Boolean);
  if (last >= 2) sh.getRange(2, 1, last - 1, ICOLS.length).clearContent();
  var all = keep.concat(fresh);
  if (all.length) sh.getRange(2, 1, all.length, ICOLS.length).setValues(all);
  CACHE_['tab:' + SHEET_ITEM] = null;
  return itemsRead_(txId);
}

// ---------------------------------------------------------------- 사이클별 예산 (개인)
// 예산 탭: 사이클, 카테고리(빈칸 = 총액), 금액. 없으면 설정 탭의 BUDGET_TOTAL / BUDGET_카테고리 를 쓴다.
function budgetFor_(cycle) {
  var pc = publicConfig_();
  var out = { total: pc.budgetTotal, byCategory: Object.assign({}, pc.budgets), isOverride: false, overrides: {} };
  tabRead_(SHEET_BUD, BCOLS).forEach(function (b) {
    if (cycleStr_(b['사이클']) !== cycle) return;
    var cat = String(b['카테고리'] || '').trim();
    var amt = amount_(b['금액']);
    if (!cat) { out.total = amt || null; out.isOverride = true; }
    else { out.byCategory[cat] = amt; out.overrides[cat] = amt; }
  });
  return out;
}
function budgetSave_(req) {
  var cycle = cycleStr_(req.cycle || currentCycle_());
  var cat = String(req.category || '').trim();
  var amt = req.amount === '' || req.amount === null || req.amount === undefined ? '' : amount_(req.amount);
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_BUD);
  var last = sh.getLastRow();
  var r = -1;
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 2).getValues();
    for (var i = 0; i < vals.length; i++) if (cycleStr_(vals[i][0]) === cycle && String(vals[i][1] || '').trim() === cat) { r = i + 2; break; }
  }
  if (amt === '') { if (r > 0) sh.deleteRow(r); }
  else {
    if (r < 0) r = last + 1;
    sh.getRange(r, 1).setNumberFormat('@');
    sh.getRange(r, 1, 1, BCOLS.length).setValues([[cycle, cat, amt, new Date()]]);
  }
  CACHE_['tab:' + SHEET_BUD] = null;
  return budgetFor_(cycle);
}
// 최근 사이클 실적으로 다음 예산을 제안한다: 고정 수입 − 고정 지출, 최근 3사이클 평균 지출
function budgetSuggest_(cycle) {
  var tr = trend_(cycle, 4).slice(0, 3);
  var n = tr.filter(function (t) { return t.count; }).length || 1;
  var avg = Math.round(tr.reduce(function (a, t) { return a + t.expense; }, 0) / n);
  var inc = 0, exp = 0;
  readRecurring_().forEach(function (r) { if (r['활성'] === 'N') return; if (r['유형'] === '수입') inc += r['금액']; else exp += r['금액']; });
  return { avgExpense: avg, fixedIncome: inc, fixedExpense: exp, free: inc - exp };
}

// ---------------------------------------------------------------- 카테고리 정리 (이름 바꾸기 = 합치기)
function categoryStats_() {
  var counts = {}, sums = {};
  allTx_().forEach(function (o) { if (o['유형'] === '수입') return; var c = o['카테고리'] || ''; counts[c] = (counts[c] || 0) + 1; sums[c] = (sums[c] || 0) + o['금액']; });
  var cats = split_(cfg_('CATEGORIES'));
  Object.keys(counts).forEach(function (c) { if (c && cats.indexOf(c) < 0) cats.push(c); });
  return cats.map(function (c) { return { name: c, count: counts[c] || 0, sum: sums[c] || 0, inConfig: split_(cfg_('CATEGORIES')).indexOf(c) >= 0 }; })
    .concat(counts[''] ? [{ name: '', count: counts[''], sum: sums[''], inConfig: false }] : []);
}
function renameCategory_(from, to) {
  from = String(from || '').trim(); to = String(to || '').trim();
  if (!to) throw new Error('새 이름을 입력하세요');
  if (from === to) return { tx: 0 };
  var ss = SpreadsheetApp.getActive();
  var n = 0;
  // 거래
  var sh = txSheet_(); var last = sh.getLastRow();
  if (last >= 2) {
    var rng = sh.getRange(2, COL['카테고리'] + 1, last - 1, 1); var vals = rng.getValues(); var ch = false;
    for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) === from) { vals[i][0] = to; n++; ch = true; }
    if (ch) rng.setValues(vals);
  }
  // 고정
  var rs = recSheet_(); var rl = rs.getLastRow();
  if (rl >= 2) { var rr = rs.getRange(2, RCOL['카테고리'] + 1, rl - 1, 1); var rv = rr.getValues(); var rc = false; for (var j = 0; j < rv.length; j++) if (String(rv[j][0]) === from) { rv[j][0] = to; rc = true; } if (rc) rr.setValues(rv); }
  // 사전: 같은 가맹점이 두 번 생기면 횟수를 합친다
  var ds = ss.getSheetByName(SHEET_DICT); var dl = ds.getLastRow();
  if (dl >= 2) {
    var dv = ds.getRange(2, 1, dl - 1, 3).getValues(); var map = {}; var order = [];
    dv.forEach(function (r) { if (!r[0]) return; var c = String(r[1]) === from ? to : String(r[1]); var k = String(r[0]); if (!map[k]) { map[k] = [k, c, Number(r[2]) || 0]; order.push(k); } else { map[k][1] = c; map[k][2] += Number(r[2]) || 0; } });
    ds.getRange(2, 1, dl - 1, 3).clearContent();
    var rows = order.map(function (k) { return map[k]; });
    if (rows.length) ds.getRange(2, 1, rows.length, 3).setValues(rows);
  }
  // 예산 탭
  var bs = ss.getSheetByName(SHEET_BUD); var bl = bs.getLastRow();
  if (bl >= 2) { var br = bs.getRange(2, 2, bl - 1, 1); var bv = br.getValues(); var bc = false; for (var q = 0; q < bv.length; q++) if (String(bv[q][0]) === from) { bv[q][0] = to; bc = true; } if (bc) br.setValues(bv); }
  // 설정 CATEGORIES, BUDGET_<이름>
  var cs = ss.getSheetByName(SHEET_CFG); var cv = cs.getDataRange().getValues();
  for (var k = 1; k < cv.length; k++) {
    var key = String(cv[k][0]).trim();
    if (key === 'CATEGORIES') { var list = split_(cv[k][1]).filter(function (c) { return c !== from; }); if (list.indexOf(to) < 0) list.push(to); cs.getRange(k + 1, 2).setValue(list.join(',')); }
    if (key === 'BUDGET_' + from) cs.getRange(k + 1, 1).setValue('BUDGET_' + to);
  }
  CACHE_ = {};
  return { tx: n, from: from, to: to };
}

// ---------------------------------------------------------------- 옛 탭 → 새 탭 이관 (시트 메뉴)
// 세이프 박스 탭: "연번 | 연도 | 날짜 | 항목 | 금액 | 메모" 블록을 통장거래로. 항목(지민비상금/공금)이 통장 이름이 된다. 음수 = 출금.
function migrateSafeBox(force) {
  setup(); CACHE_ = {};
  var ss = SpreadsheetApp.getActive();
  var done = tabRead_(SHEET_ACCTX, ATCOLS).filter(function (t) { return String(t['메모']).indexOf('[이관]') === 0; });
  if (done.length && !force) throw new Error('이미 이관된 통장거래가 ' + done.length + '건 있습니다');
  if (done.length && force) done.forEach(function (t) { tabDelete_(SHEET_ACCTX, t.id); });
  var log = [];
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name.indexOf('세이프') < 0 && name.indexOf('비상금') < 0 && name.indexOf('통장') !== 0) return;
    if (APP_SHEETS_.indexOf(name) >= 0) return;
    var vals = sh.getDataRange().getValues();
    var head = -1, ci = {};
    for (var r = 0; r < vals.length && head < 0; r++) for (var c = 0; c < vals[r].length; c++) if (String(vals[r][c]).trim() === '연번') { head = r; for (var k = c; k < vals[r].length; k++) ci[String(vals[r][k]).trim()] = k; break; }
    if (head < 0) { log.push(name + ': 연번 머리글 없음'); return; }
    var n = 0, year = new Date().getFullYear(), prevDate = null;
    for (var i = head + 1; i < vals.length; i++) {
      var row = vals[i];
      var acc = String(row[ci['항목']] || '').trim(); var amt = cellAmount_(row[ci['금액']]);
      if (!acc || !amt) continue;
      var ym = /(\d{4})/.exec(String(row[ci['연도']] || '')); if (ym) year = Number(ym[1]);
      var date = cellDate_(row[ci['날짜']], { year: year }, prevDate) || (year + '-01-01T12:00:00'); prevDate = date;
      var account = accountByName_(acc);
      var memo = String(row[ci['메모 사항']] || row[ci['메모']] || '').trim();
      tabUpsert_(SHEET_ACCTX, ATCOLS, { '일시': date, '통장': account.id, '구분': amt < 0 ? '출금' : '입금', '금액': Math.abs(amt), '메모': '[이관] ' + memo, '거래id': '' }, 't');
      n++;
    }
    log.push(name + ': ' + n + '건');
  });
  var acc = accountsRead_();
  acc.accounts.forEach(function (a) { log.push(a['이름'] + ' 잔액 ' + a.balance.toLocaleString() + '원'); });
  log.push('옛 탭 상단의 잔액과 다르면 출금이 양수로 적혀 있던 것입니다. 앱의 통장 화면에서 해당 건을 고치세요.');
  Logger.log(log.join('\n'));
  return log;
}
// 연도가 들어 있는 날짜 칸 (Date 객체 또는 "2024/07/02"). cellDate_ 는 탭 이름 연도로 덮어쓰므로 여기선 쓰지 않는다.
function fullDate_(v) {
  if (v instanceof Date) return isoLocal_(v).substring(0, 10) + 'T12:00:00';
  var m = /(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/.exec(String(v || ''));
  return m ? m[1] + '-' + (m[2].length < 2 ? '0' : '') + m[2] + '-' + (m[3].length < 2 ? '0' : '') + m[3] + 'T12:00:00' : null;
}
function accountByName_(name) {
  var hit = tabRead_(SHEET_ACC, ACOLS).filter(function (a) { return a['이름'] === name; })[0];
  if (hit) return hit;
  var owner = split_(cfg_('MEMBERS')).filter(function (m) { return name.indexOf(m) >= 0; })[0] || '';
  return accountSave_({ '이름': name, '종류': name.indexOf('비상') >= 0 ? '비상금' : (name.indexOf('저축') >= 0 ? '저축' : '공금'), '소유': owner, '활성': 'Y' });
}
// "대출 상환 표" 탭: A열 이름표 / B열 값 (대출일자, 대출기관, 대출 원금, 이율, 상환방식, 요상환 금액, 월상환금) → 부채 탭
function migrateLoan(force) {
  setup(); CACHE_ = {};
  var ss = SpreadsheetApp.getActive();
  var log = [];
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name.indexOf('대출') < 0 || APP_SHEETS_.indexOf(name) >= 0) return;
    var vals = sh.getDataRange().getValues();
    var kv = {};
    for (var r = 0; r < vals.length; r++) { var k = String(vals[r][0] || '').trim().replace(/\s*\[.*\]$/, ''); if (k && kv[k] === undefined) kv[k] = vals[r][1]; }
    var P = cellAmount_(kv['대출 원금'] || kv['원금']);
    if (!P) { log.push(name + ': 원금 없음'); return; }
    var owner = split_(cfg_('MEMBERS')).filter(function (m) { return name.indexOf(m) >= 0; })[0] || '';
    var title = (owner ? owner + ' ' : '') + '대출' + (kv['대출기관'] ? ' (' + String(kv['대출기관']).trim() + ')' : '');
    var exist = tabRead_(SHEET_DEBT, DCOLS).filter(function (d) { return d['이름'] === title; })[0];
    if (exist && !force) { log.push(name + ': 이미 있음 (' + title + ')'); return; }
    var M = cellAmount_(kv['월상환금']), total = cellAmount_(kv['요상환 금액'] || kv['총상환액']);
    var start = fullDate_(kv['대출일자'] || kv['대출일']);
    var item = { id: exist ? exist.id : '', '이름': title, '기관': String(kv['대출기관'] || '').trim(), '원금': P, '연이율': Number(String(kv['이율'] || kv['이율 [%]'] || kv['연이율'] || '').replace(/[^\d.]/g, '')) || 0,
      '월상환금': M, '시작일': start ? start.substring(0, 10) : '', '총회차': M && total ? Math.round(total / M) : '', '납입회차': '', '소유': owner, '메모': String(kv['상환방식'] || '').trim(), '활성': 'Y' };
    var saved = debtSave_(item);
    log.push(name + ' → ' + title + ': 원금 ' + P.toLocaleString() + '원, ' + saved.calc.months + '회, 잔여 ' + saved.calc.remaining.toLocaleString() + '원');
  });
  Logger.log(log.join('\n'));
  return log;
}
// "영수증" 탭: 구입처 | 구입 날짜 | 구매 항목 | 가격. "총계" 행이 한 장의 끝. 같은 날짜·같은 금액(총계)의 거래를 찾아 품목으로 붙인다.
function migrateReceipts(force) {
  setup(); CACHE_ = {};
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName('영수증');
  if (!sh) throw new Error('"영수증" 탭이 없습니다');
  var vals = sh.getDataRange().getValues();
  var ci = {}; for (var c = 0; c < vals[0].length; c++) ci[String(vals[0][c]).trim()] = c;
  if (ci['구매 항목'] === undefined || ci['가격'] === undefined) throw new Error('영수증 탭 머리글(구입처, 구입 날짜, 구매 항목, 가격)을 찾지 못했습니다');
  var groups = [], cur = null;
  for (var r = 1; r < vals.length; r++) {
    var row = vals[r]; var name = String(row[ci['구매 항목']] || '').trim(); var price = cellAmount_(row[ci['가격']]);
    var store = String(row[ci['구입처']] || '').trim(); var date = fullDate_(row[ci['구입 날짜']]) || (cur ? cur.date : null);
    if (!name && !price) { cur = null; continue; }
    if (!cur || (store && cur.store !== store) || (date && cur.date !== date)) { cur = { store: store, date: date, items: [], total: 0 }; groups.push(cur); }
    if (name === '총계' || name === '합계') { cur.total = price; cur = null; continue; }
    cur.items.push({ '품목': name, '수량': 1, '금액': price });
  }
  var have = itemCounts_();
  var tx = allTx_();
  var ok = 0, miss = [];
  groups.forEach(function (g) {
    if (!g.items.length) return;
    var total = g.total || g.items.reduce(function (a, it) { return a + it['금액']; }, 0);
    var dk = g.date ? g.date.substring(0, 10) : '';
    var hit = tx.filter(function (o) { return o['유형'] === '지출' && String(o['일시']).substring(0, 10) === dk && o['금액'] === total; })[0]
      || tx.filter(function (o) { return o['유형'] === '지출' && String(o['일시']).substring(0, 10) === dk && LedgerParser.normalizeMerchant(o['가맹점']) === LedgerParser.normalizeMerchant(g.store); })[0];
    if (!hit) { miss.push(dk + ' ' + g.store + ' ' + total.toLocaleString() + '원'); return; }
    if (have[hit.id] && !force) return;
    itemsSave_(hit.id, g.items); ok++;
  });
  var log = ['영수증 ' + groups.length + '장 중 ' + ok + '장을 거래에 붙임'];
  if (miss.length) log.push('거래를 못 찾은 영수증 ' + miss.length + '장: ' + miss.slice(0, 15).join(' / ') + (miss.length > 15 ? ' …' : ''));
  Logger.log(log.join('\n'));
  return log;
}
function migrateSafeBoxMenu() { menuRun_('세이프 박스 → 통장 이관', function () { return migrateSafeBox(false); }); }
function migrateLoanMenu() { menuRun_('대출 표 → 부채 이관', function () { return migrateLoan(false); }); }
function migrateReceiptsMenu() { menuRun_('영수증 → 품목 이관', function () { return migrateReceipts(false); }); }
function menuRun_(title, fn) {
  var ui = SpreadsheetApp.getUi();
  try { var log = fn(); ui.alert(title, (log || []).join('\n'), ui.ButtonSet.OK); }
  catch (e) { ui.alert(title + ' 중단', String(e.message || e), ui.ButtonSet.OK); }
}

// ================================================================ 서버 자동 업데이트 (Apps Script API 로 자기 자신을 갱신)
// GitHub 의 backend/Code.gs, backend/Parser.gs 를 받아 이 프로젝트의 코드를 바꾸고, 새 버전을 만들어 기존 웹앱 배포에 연결한다.
// 한 번만 준비: (1) https://script.google.com/home/usersettings 에서 "Google Apps Script API" 켜기
//              (2) appsscript.json 에 oauthScopes (backend/appsscript.json 참고)  (3) 편집기에서 updateServer 한 번 실행해 권한 허용
// 그 뒤로는 시트 메뉴 "서버 업데이트" 또는 installUpdateTrigger() 로 매시간 자동.
var UPDATE_BASE = 'https://raw.githubusercontent.com/DeokWooKim-ulpl/budget-books/main/backend/';
var UPDATE_FILES = [['Code', 'Code.gs'], ['Parser', 'Parser.gs']];

function updateServer(force) {
  var log = [];
  var token = ScriptApp.getOAuthToken();
  var scriptId = ScriptApp.getScriptId();
  var api = 'https://script.googleapis.com/v1/projects/' + scriptId;
  function call(method, url, body) {
    var res = UrlFetchApp.fetch(url, { method: method, contentType: 'application/json', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token }, payload: body ? JSON.stringify(body) : undefined });
    var code = res.getResponseCode(); var text = res.getContentText();
    if (code >= 300) throw new Error('Apps Script API ' + code + ': ' + text.substring(0, 300) + (code === 403 ? '\n→ https://script.google.com/home/usersettings 에서 Apps Script API 를 켰는지, appsscript.json 에 script.projects / script.deployments 권한이 있는지 확인' : ''));
    return text ? JSON.parse(text) : {};
  }
  // 1) GitHub 에서 새 코드
  var fresh = {};
  UPDATE_FILES.forEach(function (f) {
    var r = UrlFetchApp.fetch(UPDATE_BASE + f[1] + '?t=' + Date.now(), { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) throw new Error('GitHub 에서 ' + f[1] + ' 을 받지 못했습니다 (' + r.getResponseCode() + ')');
    fresh[f[0]] = r.getContentText();
  });
  var m = /var API_VERSION = (\d+)/.exec(fresh.Code);
  var newVer = m ? Number(m[1]) : 0;
  var stamp = (/var SERVER_BUILD = '([^']*)'/.exec(fresh.Code) || [])[1] || '';
  log.push('GitHub 버전 ' + newVer + (stamp ? ' (' + stamp + ')' : '') + ' / 현재 ' + API_VERSION + (typeof SERVER_BUILD !== 'undefined' ? ' (' + SERVER_BUILD + ')' : ''));
  // 2) 현재 프로젝트 내용 (manifest 등은 그대로 두고 Code/Parser 만 바꾼다)
  var content = call('get', api + '/content');
  var files = content.files || [];
  var same = UPDATE_FILES.every(function (f) { var cur = files.filter(function (x) { return x.name === f[0]; })[0]; return cur && cur.source === fresh[f[0]]; });
  if (same && !force) { log.push('이미 최신입니다. 바꾼 것 없음'); Logger.log(log.join('\n')); return log; }
  var known = {};
  files = files.map(function (x) { if (fresh[x.name] !== undefined) { known[x.name] = true; return { name: x.name, type: 'SERVER_JS', source: fresh[x.name] }; } return { name: x.name, type: x.type, source: x.source }; });
  UPDATE_FILES.forEach(function (f) { if (!known[f[0]]) files.push({ name: f[0], type: 'SERVER_JS', source: fresh[f[0]] }); });
  if (!files.some(function (x) { return x.type === 'JSON'; })) throw new Error('appsscript.json(manifest) 을 찾지 못해 중단');
  call('put', api + '/content', { files: files });
  log.push('코드 교체: ' + UPDATE_FILES.map(function (f) { return f[0]; }).join(', '));
  // 3) 새 버전
  var ver = call('post', api + '/versions', { description: '자동 업데이트 v' + newVer + ' ' + stamp + ' ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') });
  log.push('새 버전 ' + ver.versionNumber);
  // 4) 기존 웹앱 배포(HEAD 제외)를 새 버전으로
  var deps = (call('get', api + '/deployments').deployments || []).filter(function (d) { return d.deploymentConfig && d.deploymentConfig.versionNumber; });
  if (!deps.length) throw new Error('배포가 없습니다. 편집기에서 배포 → 새 배포(웹 앱) 를 한 번 해 두세요');
  deps.forEach(function (d) {
    call('put', api + '/deployments/' + d.deploymentId, { deploymentConfig: { scriptId: scriptId, versionNumber: ver.versionNumber, manifestFileName: 'appsscript', description: d.deploymentConfig.description || '가계부 앱' } });
    log.push('배포 ' + d.deploymentId.substring(0, 12) + '… → 버전 ' + ver.versionNumber);
  });
  log.push('완료. /exec 주소에서 version ' + newVer + ' 확인');
  Logger.log(log.join('\n'));
  return log;
}
function updateServerMenu() { menuRun_('서버 업데이트', function () { return updateServer(false); }); }
function updateServerForceMenu() { menuRun_('서버 업데이트 (강제)', function () { return updateServer(true); }); }
/** 매시간 GitHub 를 확인해 새 코드가 있으면 자동으로 갱신·배포한다. 편집기에서 한 번만 실행. */
function installUpdateTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'updateServerAuto') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('updateServerAuto').timeBased().everyHours(1).create();
  Logger.log('자동 업데이트 트리거 설치됨 (매시간)');
  return ['자동 업데이트: 매시간 GitHub 확인'];
}
function installUpdateTriggerMenu() { menuRun_('자동 업데이트 켜기', installUpdateTrigger); }
function updateServerAuto() { try { updateServer(false); } catch (e) { Logger.log('자동 업데이트 실패: ' + e); } }

// ================================================================ 관리 액션 (PIN 으로 보호. 앱이 아니라 운영자가 API 로 쓴다)
// migrate: what = legacy | safebox | loan | receipts | fixed, force = true 면 다시.  setConfig: 설정 탭 값 바꾸기 (PIN 제외).  updateServer: GitHub 최신 코드로 자기 갱신.
function admin_(req) {
  switch (req.action) {
    case 'migrate': {
      var fn = { legacy: migrateLegacy, safebox: migrateSafeBox, loan: migrateLoan, receipts: migrateReceipts, fixed: migrateFixedCosts }[req.what];
      if (!fn) throw new Error('what 은 legacy | safebox | loan | receipts | fixed');
      return { ok: true, log: fn(!!req.force) };
    }
    case 'setConfig': {
      var key = String(req.key || '').trim();
      if (!key || key === 'PIN') throw new Error('바꿀 수 없는 키');
      var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_CFG);
      var vals = sh.getDataRange().getValues(); var r = -1;
      for (var i = 1; i < vals.length; i++) if (String(vals[i][0]).trim() === key) { r = i + 1; break; }
      if (r < 0) { r = sh.getLastRow() + 1; sh.getRange(r, 1).setValue(key); }
      sh.getRange(r, 2).setNumberFormat('@').setValue(req.value === undefined || req.value === null ? '' : String(req.value));
      CACHE_ = {};
      return { ok: true, key: key, value: String(req.value === undefined ? '' : req.value), config: publicConfig_() };
    }
    case 'updateServer': return { ok: true, log: updateServer(!!req.force) };
    case 'recurringPurge': {   // 메모가 memoPrefix 로 시작하는 고정 항목을 한 번에 지운다 (잘못된 이관 되돌리기)
      var pre = String(req.memoPrefix || ''); if (!pre) throw new Error('memoPrefix 필요');
      var sh = recSheet_(); var last = sh.getLastRow(); if (last < 2) return { ok: true, deleted: 0 };
      var vals = sh.getRange(2, 1, last - 1, RCOLS.length).getValues();
      var keep = vals.filter(function (row) { return !(row[0] && String(row[RCOL['메모']]).indexOf(pre) === 0); });
      sh.getRange(2, 1, last - 1, RCOLS.length).clearContent();
      if (keep.length) sh.getRange(2, 1, keep.length, RCOLS.length).setValues(keep);
      CACHE_.rec = null;
      return { ok: true, deleted: vals.length - keep.length, remaining: keep.length };
    }
    case 'health': return { ok: true, version: API_VERSION, build: SERVER_BUILD, tabs: SpreadsheetApp.getActive().getSheets().map(function (s) { return s.getName(); }), triggers: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }) };
  }
  return null;
}

// "고정지출비용" 표 → 고정 탭. 머리글에 카테고리·금액과 (지출처 또는 지출 일자) 가 있는 블록을 찾는다.
// 이름 = 지출처(없으면 카테고리), 일 = "매월 25일" 에서, 소유 = 블록 위쪽 6행 안에 멤버 이름이 있으면 그 사람. 같은 이름·금액이 이미 있으면 건너뜀.
function migrateFixedCosts(force) {
  setup(); CACHE_ = {};
  var ss = SpreadsheetApp.getActive();
  var members = split_(cfg_('MEMBERS')); var type = cfg_('LEDGER_TYPE'); var startDay = startDay_();
  var have = readRecurring_();
  var log = [], n = 0, skipped = 0;
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (APP_SHEETS_.indexOf(name) >= 0) return;
    var vals = sh.getDataRange().getValues();
    for (var r = 0; r < vals.length; r++) {
      var ci = {};
      for (var c = 0; c < vals[r].length; c++) { var h = String(vals[r][c]).trim(); if (h) ci[h] = c; }
      var cat = ci['카테고리'], amt = ci['금액'], store = ci['지출처'] !== undefined ? ci['지출처'] : ci['구매처'];
      var dayCol = ci['지출 일자'] !== undefined ? ci['지출 일자'] : (ci['예상 지출일자'] !== undefined ? ci['예상 지출일자'] : ci['지출일자']);
      // 고정지출 표만: 지출처 열이 있고, 거래 표(지출일자·구매처·세부내역·항목·결제인)가 아니어야 한다
      if (cat === undefined || amt === undefined || ci['지출처'] === undefined) continue;
      if (ci['지출일자'] !== undefined || ci['구매처'] !== undefined || ci['세부내역'] !== undefined || ci['항목'] !== undefined || ci['결제인'] !== undefined) continue;
      var owner = members[0];
      for (var up = r - 1; up >= Math.max(0, r - 6); up--) { var line = vals[up].join(' '); var hit = members.filter(function (m) { return line.indexOf(m) >= 0; })[0]; if (hit) { owner = hit; break; } }
      var cnt = 0;
      for (var i = r + 1; i < vals.length; i++) {
        var row = vals[i];
        var amount = cellAmount_(row[amt]); var category = String(row[cat] || '').trim(); var st = store !== undefined ? String(row[store] || '').trim() : '';
        if (!amount && !category && !st) break;
        var itemName = st || category;
        if (!amount || !itemName || /합계|총계/.test(String(row[0]) + category + st)) continue;
        var dm = dayCol !== undefined ? /(\d{1,2})\s*일/.exec(String(row[dayCol] || '')) : null;
        var day = dm ? Number(dm[1]) : startDay;
        var memo = ['[이관] ' + name, dayCol !== undefined && row[dayCol] ? String(row[dayCol]).trim() : '', ci['지출 위치'] !== undefined ? String(row[ci['지출 위치']] || '').trim() : ''].filter(Boolean).join(' · ');
        if (!force && have.some(function (x) { return x['이름'] === itemName && x['금액'] === amount; })) { skipped++; continue; }
        saveRecurring_({ '유형': '지출', '이름': itemName, '금액': amount, '카테고리': category, '결제인': owner, '일': day, '계획': 'Y', '활성': 'Y', '메모': memo });
        n++; cnt++;
      }
      if (cnt) log.push(name + ' (' + owner + '): ' + cnt + '건');
      r += cnt;
    }
  });
  log.push('고정 항목 ' + n + '건 추가' + (skipped ? ', 이미 있어 건너뜀 ' + skipped + '건' : ''));
  if (n) log.push('앱 → 더보기 → 고정 항목에서 금액·날짜를 확인하고, 홈의 "거래에 반영"으로 이번 사이클에 넣으세요.');
  Logger.log(log.join('\n'));
  return log;
}
function migrateFixedCostsMenu() { menuRun_('고정지출 표 → 고정 항목 이관', function () { return migrateFixedCosts(false); }); }
