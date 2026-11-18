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
var SERVER_BUILD = '2026-11-18a';   // 코드를 고칠 때마다 올린다. 자동 업데이트가 GitHub 와 비교할 때 쓰고 doGet 응답에도 보인다.

// 고정 탭 열. 일 = 매달 며칠에 나가는지(1~31). 계획 = 개인 장부에서 계획 지출로 넣을지(Y/N). 활성 = N 이면 반영하지 않음.
var RCOLS = ['id', '유형', '이름', '금액', '카테고리', '결제인', '일', '계획', '활성', '메모', '등록', '수정', '분담'];   // 분담(v3.1, 공동): 반영될 거래의 분담 (빈칸=같이, 이름=그 사람 전액)
var RCOL = {};
RCOLS.forEach(function (c, i) { RCOL[c] = i; });

// 분담(v3): 공동 장부에서 빈칸 = 설정 비율(SPLIT_RATIO), 이름 = 그 사람 전액 부담, "60:40" = 이 거래만 다른 비율. 태그(v3): 이벤트 이름.
var COLS = ['id', '일시', '사이클', '유형', '금액', '가맹점', '카테고리', '항목', '결제인', '정산', '계획', '출처', '상태', '원문', '등록', '수정', '분담', '태그'];
var COL = {};
COLS.forEach(function (c, i) { COL[c] = i; });

// 글자로만 다뤄야 하는 열 묶음 [첫 열 이름, 열 수]. 시트는 "2026-10"·"1987"·"1/2"·"60:40" 같은 글자를 날짜·숫자·시간으로 바꿔 저장하므로, 쓰기 전에 글자 서식(@)을 건다.
var TX_TEXT_RANGES_ = [['사이클', 1], ['가맹점', 4], ['원문', 1], ['분담', 2]];     // 거래: C / F:I(가맹점·카테고리·항목·결제인) / N / Q:R(분담·태그)
var REC_TEXT_RANGES_ = [['이름', 1], ['카테고리', 2], ['메모', 1], ['분담', 1]];   // 고정: C / E:F(카테고리·결제인) / J / M
function textFormat_(sh, ranges, colOf, r, n) { ranges.forEach(function (x) { sh.getRange(r, colOf[x[0]] + 1, n, x[1]).setNumberFormat('@'); }); }
function textA1_(ranges, colOf) { return ranges.map(function (x) { return String.fromCharCode(65 + colOf[x[0]]) + ':' + String.fromCharCode(65 + colOf[x[0]] + x[1] - 1); }); }   // → ['C:C', 'F:I', …] (열 전체)
// 여러 줄을 통째로 다시 쓰기 전에(이관 다시 하기, 고정 항목 한꺼번에 지우기) 값을 다듬는다: 글자 열에 이미 날짜·시간으로 바뀌어 저장돼 있던 칸은 보이던 글자로(사이클 칸은 "yyyy-mm") 바꾼다.
// 글자 서식을 건 칸에 날짜 값을 그대로 쓰면 46024 같은 숫자로 보이게 된다. 글자·숫자·빈칸은 손대지 않는다. vals = getValues(), shown = 같은 범위의 getDisplayValues()
function textRows_(vals, shown, ranges, colOf) {
  ranges.forEach(function (x) {
    for (var c = colOf[x[0]]; c < colOf[x[0]] + x[1]; c++) for (var i = 0; i < vals.length; i++) if (vals[i][c] instanceof Date) vals[i][c] = x[0] === '사이클' ? cycleStr_(vals[i][c]) : shown[i][c];
  });
  return vals;
}

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
  eventSave: 1, eventDelete: 1, itemsSave: 1, budgetSave: 1, renameCategory: 1, migrate: 1, setConfig: 1, updateServer: 1, recurringPurge: 1, accountTransfer: 1, accountTxUpdate: 1,
  groupSave: 1, groupDelete: 1, groupItemSave: 1, groupItemDelete: 1, groupPaySave: 1, groupPayDelete: 1 };

function handle_(req) {
  CACHE_ = {}; PROPS_ = null;
  try {
    // setup()(탭·머리글 확인, 시트 호출 십여 번)은 이 빌드로 한 번 끝냈으면 읽기 요청에서는 건너뛴다 (setupDone_). 쓰기 요청은 전처럼 매번 돌린다.
    // 건너뛰었는데 설정 탭이 없으면(시트에서 지움) 그 자리에서 setup 을 돌린다. 다른 탭이 없어서 읽기가 깨지면 readOut_ 가 setup 뒤 한 번 더 읽는다.
    var write = !!WRITE_ACTIONS_[req.action];
    var skipped = !write && setupDone_();
    if (!skipped) setup();
    else { cfgAll_(); if (CACHE_.noCfg) { skipped = false; CACHE_ = {}; setup(); } }
    if (!cfg_('PIN')) return json_({ ok: false, error: '설정 탭에 PIN 이 없습니다. 시트의 설정 탭에서 A열이 PIN 인 줄의 B열에 PIN 을 넣어 주세요 (그 줄이 없으면 맨 아래에 새로 적으세요)' });   // PIN 칸을 비웠거나 PIN 줄이 없어진 시트: PIN 없이(또는 0000 으로) 열리지 않게 막는다
    if (!pinEq_(req.pin, cfg_('PIN'))) return json_({ ok: false, error: 'pin' });
    // 읽기는 잠금 없이 바로 처리한다. 잠금은 시트를 고치는 요청끼리만 줄을 세운다.
    if (!write) return readOut_(req, skipped);
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
        case 'applyRecurring': { var ap = applyRecurring_(req.cycle || currentCycle_(), req.ids, req.amounts, req.updateDefault); return json_({ ok: true, added: ap.length, rows: ap }); }
        // ---- v3
        case 'settlePay': return json_(Object.assign({ ok: true }, settlePay_(req)));
        case 'settleFinish': return json_(Object.assign({ ok: true }, settleFinish_(req)));
        case 'settleDelete': return json_({ ok: true, deleted: settleDelete_(req.id), balance: balance_() });
        case 'accountSave': return json_({ ok: true, item: accountSave_(req.item || {}), accounts: accountsRead_() });
        case 'accountDelete': return json_({ ok: true, deleted: accountDelete_(req.id, !!req.cascade), accounts: accountsRead_() });
        case 'accountTxUpdate': return json_({ ok: true, item: accountTxUpdate_(req.id, req.tx || {}), accounts: accountsRead_() });
        case 'accountTxAdd': return json_({ ok: true, item: accountTxAdd_(req.tx || {}), accounts: accountsRead_() });
        case 'accountTxDelete': return json_({ ok: true, deleted: accountTxDelete_(req.id), accounts: accountsRead_() });
        case 'accountTransfer': return json_({ ok: true, item: accountTransfer_(req), accounts: accountsRead_() });
        case 'groupSave': return json_({ ok: true, item: groupSave_(req.item || {}), groups: groupsRead_() });
        case 'groupDelete': return json_({ ok: true, deleted: groupDelete_(req.id), groups: groupsRead_() });
        case 'groupItemSave': return json_({ ok: true, item: groupItemSave_(req.item || {}), groups: groupsRead_() });
        case 'groupItemDelete': return json_({ ok: true, deleted: tabDelete_(SHEET_GRPI, req.id), groups: groupsRead_() });
        case 'groupPaySave': return json_({ ok: true, item: groupPaySave_(req.item || {}), groups: groupsRead_() });
        case 'groupPayDelete': return json_({ ok: true, deleted: tabDelete_(SHEET_GRPP, req.id), groups: groupsRead_() });
        case 'debtSave': return json_({ ok: true, item: debtSave_(req.item || {}), debts: debtsRead_() });
        case 'debtDelete': return json_({ ok: true, deleted: tabDelete_(SHEET_DEBT, req.id), debts: debtsRead_() });
        case 'eventSave': return json_({ ok: true, item: eventSave_(req.item || {}), events: eventsRead_() });
        case 'eventDelete': return json_({ ok: true, deleted: tabDelete_(SHEET_EVT, req.id), events: eventsRead_() });
        case 'itemsSave': return json_({ ok: true, items: itemsSave_(req.txId, req.items || []) });
        case 'budgetSave': return json_({ ok: true, budget: budgetSave_(req) });
        case 'renameCategory': return json_(Object.assign({ ok: true }, renameCategory_(req.from, req.to), { categories: categoryStats_(), config: publicConfig_() }));
        case 'migrate': case 'setConfig': case 'updateServer': case 'recurringPurge': return json_(admin_(req));
      }
    } finally { dataChanged_(); lock.releaseLock(); }   // 쓰기가 끝나면(실패해도) 데이터 버전을 바꿔 저장해 둔 읽기 응답을 버린다 → 바로 다음 bootstrap 은 새로 계산한다
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
      var ar = accountsRead_(); out.accounts = ar.accounts; out.accountsSum = ar.sum;
      out.debts = debtsRead_();
      out.events = eventsRead_();
      out.groups = groupsRead_().filter(function (g) { return g['상태'] !== '마감'; }).slice(0, 5);
      out.itemCounts = itemCounts_();
      if (cfg_('LEDGER_TYPE') === 'shared') { var st = settlementsRead_(); out.balance = st.balance; out.settlements = st.log.slice(0, 20); }
      else { out.budget = budgetFor_(cycle); out.budgetSuggest = budgetSuggest_(cycle); }
      return out;
    }
    // ---- v3
    case 'settlements': return Object.assign({ ok: true }, settlementsRead_());
    case 'accounts': return Object.assign({ ok: true }, accountsRead_());
    case 'accountLog': return Object.assign({ ok: true, id: req.id }, accountLog_(req.id));
    case 'debts': return { ok: true, debts: debtsRead_() };
    case 'events': return { ok: true, events: eventsRead_() };
    case 'groups': return { ok: true, groups: groupsRead_() };
    case 'items': return { ok: true, items: itemsRead_(req.txId) };
    case 'budget': { var bc = req.cycle || currentCycle_(); return { ok: true, cycle: bc, budget: budgetFor_(bc), suggest: budgetSuggest_(bc) }; }
    case 'categories': return { ok: true, categories: categoryStats_() };
    case 'health': case 'readTab': return admin_(req);
    default: return { ok: false, error: 'unknown action' };
  }
}

function json_(obj) { return textOut_(JSON.stringify(obj)); }
function textOut_(s) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON); }

// ---------------------------------------------------------------- 읽기 응답 재사용 (속도)
// 스크립트 속성(PropertiesService): SETUP_BUILD = setup() 을 마친 SERVER_BUILD, DATA_VER = 시트를 고친 요청·메뉴·트리거가 끝날 때마다 바뀌는 값.
// 요청마다 한 번만 읽는다 (PROPS_). 읽지 못하면 PROPS_OK_ = false → setup 은 매번 돌리고 응답은 저장하지 않는다 (전과 같다).
var PROPS_ = null, PROPS_OK_ = false;
function props_() {
  if (PROPS_ === null) { try { PROPS_ = PropertiesService.getScriptProperties().getProperties() || {}; PROPS_OK_ = true; } catch (e) { PROPS_ = {}; PROPS_OK_ = false; } }
  return PROPS_;
}
function propSet_(k, v) {
  try { PropertiesService.getScriptProperties().setProperty(k, v); if (PROPS_) PROPS_[k] = v; return true; } catch (e) { return false; }
}
function setupDone_() { return props_().SETUP_BUILD === SERVER_BUILD && PROPS_OK_; }
// 시트를 고친 뒤 부른다: 쓴 내용을 먼저 시트에 내보내고(flush) 데이터 버전을 바꾼다. 순서가 바뀌면 다른 요청이 새 버전으로 옛 내용을 읽어 저장할 수 있다.
function dataChanged_() {
  try { SpreadsheetApp.flush(); } catch (e) { }
  propSet_('DATA_VER', new Date().getTime().toString(36) + Math.random().toString(36).substring(2, 6));
}

// bootstrap·list(사이클 하나)·summary 응답(JSON 글자)을 스크립트 캐시(CacheService)에 잠깐 저장해 두고 같은 요청에 그대로 돌려준다.
// 키 = 요청 + SERVER_BUILD + 데이터 버전(DATA_VER) + 스프레드시트 파일의 마지막 수정 시각(사람이 시트를 직접 고친 것) + 장부 종류 + 지금 사이클·오늘 날짜 + 요청 값.
// 응답에 사용자별로 달라지는 값은 없다 (PIN 은 하나, 응답은 시트 내용과 날짜로만 정해진다). PIN 은 이 앞에서 확인한다.
// 값이 100KB 를 넘으면 저장하지 않는다. 속성·드라이브·캐시를 읽거나 쓰지 못하면 저장·재사용 없이 전처럼 계산한다.
var RESP_CACHE_ = { bootstrap: 1, list: 1, summary: 1 };
var RESP_TTL_ = 300;          // 초. 안전망 (사람이 고친 것이 드라이브 수정 시각에 늦게 잡혀도 5분 안에는 새로 읽는다)
var RESP_MAX_ = 100000;       // 바이트 (CacheService 값 한도 100KB)
function hash_(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
function respKey_(req) {
  if (!RESP_CACHE_[req.action]) return null;
  var cyc = req.cycle;
  if (cyc !== undefined && cyc !== null && cyc !== '' && typeof cyc !== 'string') return null;
  if (req.action === 'list' && cyc === 'all') return null;   // 거래 전체는 너무 커서 저장할 수 없다
  var ver = props_().DATA_VER || '-';
  if (!PROPS_OK_) return null;
  var upd;
  try { upd = DriveApp.getFileById(SpreadsheetApp.getActive().getId()).getLastUpdated().getTime(); } catch (e) { return null; }
  if (!(upd > 0)) return null;
  var cfgSig; try { cfgSig = hash_(JSON.stringify(cfgAll_())); } catch (e) { return null; }   // 설정 탭은 요청마다 읽으므로, 시트에서 설정을 고치면 드라이브 수정 시각을 기다리지 않고 바로 새로 계산한다
  var key = ['r1', req.action, SERVER_BUILD, ver, upd, cfgSig, cfg_('LEDGER_TYPE'), currentCycle_(), isoLocal_(new Date()).substring(0, 10),
    req.action === 'list' ? (req.includeUnconfirmed !== false ? 'u' : 'c') : '', cyc || ''].join('|');
  return key.length <= 250 ? key : null;
}
function utf8Len_(s, max) {
  var n = 0;
  for (var i = 0; i < s.length && n <= max; i++) { var c = s.charCodeAt(i); n += c < 0x80 ? 1 : (c < 0x800 ? 2 : (c >= 0xD800 && c <= 0xDBFF ? (i++, 4) : 3)); }
  return n;
}
function readOut_(req, skipped) {
  var key = respKey_(req), s = null;
  if (key) { try { s = CacheService.getScriptCache().get(key); } catch (e) { s = null; } }
  if (s) return textOut_(s);
  var out;
  try { out = read_(req); }
  catch (err) { if (!skipped) throw err; CACHE_ = {}; setup(); key = null; out = read_(req); }   // setup 을 건너뛴 사이 탭이 없어졌으면 만들고 다시 읽는다 (읽기는 몇 번 해도 같다)
  s = JSON.stringify(out);
  if (key && out && out.ok && utf8Len_(s, RESP_MAX_) <= RESP_MAX_) { try { CacheService.getScriptCache().put(key, s, RESP_TTL_); } catch (e) { } }
  return textOut_(s);
}

// PIN 비교. 설정 탭에 "0412" 를 치면 시트가 숫자 412 로 바꿔 저장하므로, 숫자뿐인 PIN 은 앞자리 0 을 떼고 비교한다.
function pinEq_(a, b) {
  a = String(a || ''); b = String(b === undefined || b === null ? '' : b);
  if (a === b) return true;
  return /^\d+$/.test(a) && /^\d+$/.test(b) && a.replace(/^0+(?=\d)/, '') === b.replace(/^0+(?=\d)/, '');
}

// ---------------------------------------------------------------- 설정
function setup() {
  var ss = SpreadsheetApp.getActive();
  var changed = false;   // 탭을 만들었거나 머리글을 덧붙였는가 → 끝에 데이터 버전을 바꾼다
  var tx = ss.getSheetByName(SHEET_TX);
  if (!tx) {
    changed = true;
    tx = ss.insertSheet(SHEET_TX);
    tx.getRange(1, 1, 1, COLS.length).setValues([COLS]).setFontWeight('bold');
    tx.setFrozenRows(1);
    tx.getRange('B:B').setNumberFormat('yyyy-mm-dd hh:mm');
    textA1_(TX_TEXT_RANGES_, COL).forEach(function (a1) { tx.getRange(a1).setNumberFormat('@'); });   // 사이클 "2026-10", 가맹점 "1987", 메모 "1/2", 분담 "60:40" 이 날짜·숫자·시간으로 바뀌지 않게 글자 서식
    tx.getRange('E:E').setNumberFormat('#,##0');
    tx.getRange('O:P').setNumberFormat('yyyy-mm-dd hh:mm');
  }
  var cfg = ss.getSheetByName(SHEET_CFG);
  if (!cfg) {
    changed = true;
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
    cfg.getRange('B:B').setNumberFormat('@');   // PIN "0412" 가 숫자 412 로 바뀌지 않게 값 열은 글자 서식
    cfg.getRange(1, 1, rows.length, 3).setValues(rows);
    cfg.getRange(1, 1, 1, 3).setFontWeight('bold');
    cfg.setColumnWidth(2, 400);
  }
  var dict = ss.getSheetByName(SHEET_DICT);
  if (!dict) {
    changed = true;
    dict = ss.insertSheet(SHEET_DICT);
    dict.getRange(1, 1, 1, 3).setValues([['가맹점(정규화)', '카테고리', '횟수']]).setFontWeight('bold');
    dict.setFrozenRows(1);
  }
  var rec = ss.getSheetByName(SHEET_REC);
  if (!rec) {
    changed = true;
    rec = ss.insertSheet(SHEET_REC);
    rec.getRange(1, 1, 1, RCOLS.length).setValues([RCOLS]).setFontWeight('bold');
    rec.setFrozenRows(1);
    rec.getRange('D:D').setNumberFormat('#,##0');
    rec.getRange('K:L').setNumberFormat('yyyy-mm-dd hh:mm');
    textA1_(REC_TEXT_RANGES_, RCOL).forEach(function (a1) { rec.getRange(a1).setNumberFormat('@'); });   // 이름·메모 "1/2", 분담 "60:40" 이 날짜·시간으로 바뀌지 않게
  }
  // 고정 탭에 v3.1 열(분담)이 없으면 머리글만 덧붙인다
  var rh = rec.getRange(1, 1, 1, RCOLS.length).getValues()[0];
  for (var ri = 0; ri < RCOLS.length; ri++) if (String(rh[ri] || '') !== RCOLS[ri]) { rec.getRange(1, ri + 1).setValue(RCOLS[ri]).setFontWeight('bold'); changed = true; }
  if (setupV3_()) changed = true;
  if (changed) dataChanged_();
  if (props_().SETUP_BUILD !== SERVER_BUILD) propSet_('SETUP_BUILD', SERVER_BUILD);   // 이 빌드로 setup 을 마쳤다 → 다음 읽기 요청부터 건너뛴다 (handle_)
}

function cfgAll_() {
  if (CACHE_.cfg) return CACHE_.cfg;
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_CFG);
  var out = {};
  Object.keys(DEFAULT_CFG).forEach(function (k) { out[k] = k === 'PIN' ? '' : DEFAULT_CFG[k]; });   // PIN 은 기본값으로 되돌리지 않는다 (PIN 줄이 지워진 시트가 공개된 기본값 0000 으로 열리지 않게). 0000 은 setup() 이 설정 탭을 처음 만들 때만 적는다
  if (!sh) { CACHE_.noCfg = true; return out; }
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
    categoryRules: rules_(),   // 설정 탭 CATEGORY_RULES 를 [[키워드, 카테고리], …] 로 (적힌 순서 그대로). 앱이 자기 기본 목록 대신 쓴다 (2026-11 RB4, G39)
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
  o['결제인'] = String(o['결제인']).trim();   // "덕우 " 처럼 공백이 붙은 이름이 다른 사람으로 계산되지 않게
  if (cfg_('LEDGER_TYPE') === 'shared') o['결제인'] = payer_(o['결제인'], split_(cfg_('MEMBERS')));   // 공동: 시트에 "김덕우"·"지민폰" 으로 적힌 줄도 구성원 이름으로 읽는다 → 요약·이벤트·정산이 모두 같은 이름을 쓴다 (읽을 때만, 시트는 고치지 않는다)
  o['사이클'] = cycleStr_(o['사이클']);
  if (o['유형'] === '수입' && o['정산'] === 'X') o['정산'] = '';   // 수입은 정산 대상이 아니다 (예전에 X 로 저장된 수입이 "미정산"으로 보이지 않게)
  return o;
}

// 시트가 "2026-10" 을 날짜(2026-10-01)로 바꿔 저장해 두었어도 항상 "yyyy-mm" 글자로 돌려준다
function cycleStr_(v) {
  if (v instanceof Date) v = isoLocal_(v);
  var m = /^(\d{4})-(\d{2})/.exec(String(v || ''));
  return m ? m[1] + '-' + m[2] : String(v || '');
}

// 거래 한 줄을 r 행에 쓴다. 글자 열(사이클·가맹점·항목·분담 …)은 글자 서식으로 고정해 날짜·숫자·시간으로 바뀌는 것을 막는다.
function writeTxRow_(sh, r, o) {
  textFormat_(sh, TX_TEXT_RANGES_, COL, r, 1);
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

// 날짜 → "yyyy-MM-ddTHH:mm:ss" (스크립트 시간대). 거래를 읽을 때 줄마다 세 번씩 불리므로, 구글 서비스 호출(Session·Utilities) 없이 JS 의 지역 시각으로 직접 만든다.
// 실행마다 처음 한 번만 두 방법의 결과를 견주어 보고, 다르면(JS 의 시간대가 스크립트 시간대와 다른 환경) 전처럼 Utilities.formatDate 를 쓴다 → 어느 쪽이든 결과는 전과 같다.
var ISO_TZ_ = null, ISO_JS_ = false;
function isoJs_(d) {
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function isoLocal_(d) {
  if (ISO_TZ_ === null) { ISO_TZ_ = Session.getScriptTimeZone(); var n = new Date(); ISO_JS_ = Utilities.formatDate(n, ISO_TZ_, "yyyy-MM-dd'T'HH:mm:ss") === isoJs_(n); }
  return ISO_JS_ ? isoJs_(d) : Utilities.formatDate(d, ISO_TZ_, "yyyy-MM-dd'T'HH:mm:ss");
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
  // 받은 카테고리는 앞뒤 공백을 뗀다 (앱 밖에서 들어온 "식비 " 가 "식비" 와 다른 카테고리가 되지 않게). 받지 않은 칸은 손대지 않는다 → 시트에 이미 있는 줄은 그대로 (2026-11 RB4)
  if (Object.prototype.hasOwnProperty.call(tx, '카테고리')) o['카테고리'] = String(tx['카테고리'] === undefined || tx['카테고리'] === null ? '' : tx['카테고리']).trim();
  if (!o['일시']) o['일시'] = isoLocal_(new Date());
  o['일시'] = String(o['일시']).length === 10 ? o['일시'] + 'T12:00:00' : String(o['일시']).substring(0, 19);
  if (isNaN(new Date(o['일시']).getTime())) throw new Error('날짜를 확인하세요');   // 날짜로 읽히지 않으면 사이클이 "NaN-NaN" 인 줄이 생긴다
  o['사이클'] = LedgerParser.cycleMonth(o['일시'], startDay_());
  o['유형'] = o['유형'] || '지출';
  o['금액'] = Math.round(Number(String(o['금액']).replace(/[^\d.-]/g, '')) || 0);
  o['가맹점'] = String(o['가맹점'] || '').trim();
  o['항목'] = String(o['항목'] || '').trim();
  var type = cfg_('LEDGER_TYPE');
  if (type === 'shared') {
    var mem = split_(cfg_('MEMBERS'));
    o['결제인'] = payer_(o['결제인'], mem) || (existing ? '' : mem[0] || '');   // 새 거래에 결제인이 없으면 첫 구성원. 이미 있는 줄의 빈 결제인(시트에서 적은 줄 등)은 고르기 전까지 빈칸으로 둔다
    // 자동 수집이 결제인을 몰라 넣어 둔 안내 문구(ingest_ 의 '결제인 확인 필요'): 결제인이 구성원으로 정해지면 지운다 (사용자가 적은 다른 메모는 그대로).
    // 아직 구성원이 아닌 미확인 거래는 '확인'으로 넘기지 않고 미확인으로 둔다 → 홈의 확인 목록에 남는다. 메모가 비어 있으면 같은 안내 문구를 넣어 이유를 보여 준다.
    if (mem.indexOf(o['결제인']) >= 0) { if (o['항목'] === '결제인 확인 필요') o['항목'] = ''; }
    else if (existing && existing['상태'] === '미확인' && mem.length && (o['상태'] || '확인') === '확인') { o['상태'] = '미확인'; if (!o['항목']) o['항목'] = '결제인 확인 필요'; }
    o['정산'] = o['유형'] === '수입' ? '' : (o['정산'] === 'O' ? 'O' : 'X');   // 수입은 정산 대상이 아니므로 빈칸
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

// 앱이 거래를 만들 때 붙여 보낸 id("c" + 영숫자)가 있으면 그 id 로 저장한다. 같은 id 의 줄이 이미 있으면 새로 쓰지 않고 그 줄을 돌려준다
// → 서버는 저장했는데 응답이 끊겨 앱이 같은 거래를 다시 보내도 한 줄만 남는다. id 를 안 보내는 옛 앱·자동 수집·고정 반영은 전과 같다.
function addTx_(tx) {
  var sh = txSheet_();
  var cid = /^c[0-9a-z]{8,30}$/.test(String(tx.id || '')) ? String(tx.id) : '';
  if (cid) { var dupRow = findRowIndex_(cid); if (dupRow > 0) return rowToObj_(sh.getRange(dupRow, 1, 1, COLS.length).getValues()[0]); }
  var o = normalizeTx_(tx, null);
  o.id = cid || newId_();
  var now = isoLocal_(new Date());
  o['등록'] = now; o['수정'] = now;
  writeTxRow_(sh, sh.getLastRow() + 1, o);
  CACHE_.tx = null;
  if (o['상태'] === '확인' && o['유형'] === '지출') learn_(o['가맹점'], o['카테고리']);   // 사전은 지출만 배운다 (rebuildDict 와 같은 기준). 수입 "이자"를 배우면 지출 "이자카야"가 수입으로 분류된다
  return o;
}

// 앱은 방금 저장한 거래에 서버 id 를 받기 전까지 임시 id("tmp-…")를 쓴다. 그 id 로 고치거나 지우려는 요청은 지워진 거래가 아니라 아직 저장 중인 거래다.
function savingMsg_(id) { return /^tmp-/.test(String(id)) ? '아직 저장 중인 거래입니다. 잠시 뒤 다시 시도하세요' : ''; }

function updateTx_(id, tx) {
  var r = findRowIndex_(id);
  if (r < 0) throw new Error(savingMsg_(id) || '이미 지워진 거래입니다');
  var sh = txSheet_();
  var cur = rowToObj_(sh.getRange(r, 1, 1, COLS.length).getValues()[0]);
  // 앱의 수정 화면은 날짜만 고를 수 있어 시각을 항상 12:00:00 으로 보낸다. 날짜가 그대로면 저장돼 있던 시각을 지킨다. 카테고리만 고쳐도 알림 시각이 12:00 으로 바뀌면
  // 자동 수집(ingest_)이 그 줄을 '아직 알림과 짝짓지 않은 앱 입력 줄'로 보고 같은 날의 다음 결제 알림을 그 줄에 붙여 버린다. 날짜를 바꾸면 전처럼 그 날 12:00.
  var d = String(tx['일시'] || '');
  if ((d.length === 10 || /T12:00:00$/.test(d)) && d.substring(0, 10) === String(cur['일시']).substring(0, 10)) { tx = Object.assign({}, tx); delete tx['일시']; }
  var o = normalizeTx_(tx, cur);
  o.id = cur.id; o['등록'] = cur['등록']; o['수정'] = isoLocal_(new Date());
  writeTxRow_(sh, r, o);
  CACHE_.tx = null;
  if (o['상태'] === '확인' && o['유형'] === '지출') learn_(o['가맹점'], o['카테고리']);
  return o;
}

function deleteTx_(id) {
  var r = findRowIndex_(id);
  if (r < 0) { if (savingMsg_(id)) throw new Error(savingMsg_(id)); return false; }
  txSheet_().deleteRow(r);
  CACHE_.tx = null;
  if (findRowIndex_(id) < 0 && itemCounts_()[String(id)]) itemsSave_(id, []);   // 그 거래의 품목 줄도 같이 지운다 (같은 id 의 줄이 또 남아 있으면 그대로 둔다)
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

// 자주 쓰는 가맹점. 최근 90일 횟수에 무게를 두고(score), 마지막 금액·카테고리를 같이 준다 → 앱의 빠른 입력 칩
function recentMerchants_() {
  var rows = allTx_().filter(function (o) { return o['가맹점'] && o['상태'] !== '취소' && o['출처'] !== '고정'; });
  rows.sort(function (a, b) { return a['일시'] < b['일시'] ? 1 : -1; });
  var cut90 = isoLocal_(new Date(Date.now() - 90 * 86400000)), cut365 = isoLocal_(new Date(Date.now() - 365 * 86400000));
  var stat = {}, order = [];
  rows.forEach(function (o) {
    var m = o['가맹점']; var st = stat[m];
    if (!st) { st = stat[m] = { name: m, category: o['카테고리'], lastAmount: o['금액'], lastDate: o['일시'], type: o['유형'], count: 0, recent: 0, cats: {} }; order.push(m); }
    st.count++; if (o['일시'] >= cut90) st.recent++; if (o['일시'] >= cut365) st.cats[o['카테고리'] || ''] = (st.cats[o['카테고리'] || ''] || 0) + 1;
  });
  return order.map(function (m) {
    var st = stat[m]; var best = st.category;
    Object.keys(st.cats).forEach(function (c) { if (c && (!best || st.cats[c] > (st.cats[best] || 0))) best = c; });
    return { name: st.name, category: best, lastAmount: st.lastAmount, lastDate: st.lastDate, type: st.type, count: st.count, recent: st.recent, score: st.recent * 3 + Math.min(st.count, 30) * 0.3 + (order.indexOf(m) < 10 ? 2 : 0) };
  }).sort(function (a, b) { return b.score - a.score; }).slice(0, 60);
}

// ---------------------------------------------------------------- 정산 (공동)
function settle_(cycle) {
  var sh = txSheet_();
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var rng = sh.getRange(2, 1, last - 1, COLS.length);
  var vals = rng.getValues();
  var n = 0, members = split_(cfg_('MEMBERS'));
  for (var i = 0; i < vals.length; i++) {
    var o = rowToObj_(vals[i]);
    if (o['유형'] !== '지출' || o['정산'] !== 'X') continue;
    if (members.indexOf(payer_(o['결제인'], members)) < 0) continue;   // 결제인을 알 수 없는 거래는 정산 계산에서 빠졌으므로(balance_) 마감하지 않고 미정산으로 남긴다
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
  var key = LedgerParser.normalizeMerchant(parsed.merchant), at = new Date(parsed.date).getTime(), day = String(parsed.date).substring(0, 10);
  var gap = function (o) { return Math.abs(new Date(o['일시']).getTime() - at); };
  var same = allTx_().filter(function (o) { return o['금액'] === parsed.amount && LedgerParser.normalizeMerchant(o['가맹점']) === key; });
  // 공동 장부: 기기 이름(device)이 비었거나 구성원이 아니면 누가 냈는지 알 수 없다. 첫 구성원이 낸 것으로 조용히 넣지 않고, 결제인을 "?"(또는 받은 글자 그대로)로 둔 '미확인' 거래로 넣는다
  // → 홈의 확인 목록에 뜨고, 결제인을 고르기 전까지 정산 계산에서 빠진다 (balance_ 의 unknownPayers).
  var who = String(req.payer || req.device || '').trim(), mem = split_(cfg_('MEMBERS'));
  var whoOk = cfg_('LEDGER_TYPE') !== 'shared' || mem.indexOf(payer_(who, mem)) >= 0;
  var mine = cfg_('LEDGER_TYPE') === 'shared' && whoOk ? payer_(who, mem) : '';   // 공동 장부에서 알림을 보낸 기기가 구성원이면 그 이름. 빈 글자면 결제인을 가리지 않는다 (개인 장부, 누구 폰인지 모르는 알림)
  if (parsed.cancelled) {
    // 취소 알림: 같은 금액·가맹점·유형(결제 취소면 지출 줄만) 가운데 알림 시각에서 가장 가까운(앞뒤 31일 안) 살아 있는 거래 하나를 취소 표시한다. 시트의 줄 순서가 아니라 날짜로 고른다.
    // 공동 장부에서 알림을 보낸 기기가 구성원이면 그 사람이 낸 거래를 먼저 고른다 (덕우 폰의 취소 알림이 날짜가 더 가까운 지민의 거래를 취소하지 않게).
    // 가장 가까운 줄이 방금(10분 안) 취소된 줄이면 같은 취소 알림이 두 번 온 것으로 보고 다른 거래를 더 취소하지 않는다 (누구 폰에서 왔든, 그리고 그 사람이 낸 줄 가운데서도).
    var cand = same.filter(function (o) { return o['유형'] === parsed.type; });
    var near = cand.filter(function (o) { return gap(o) <= 31 * 86400000; })
      .sort(function (x, y) { return gap(x) - gap(y) || (x['상태'] === '취소') - (y['상태'] === '취소'); });
    var nowT = new Date(isoLocal_(new Date())).getTime();
    var hot = function (o) { return o['상태'] === '취소' && nowT - new Date(o['수정']).getTime() < 10 * 60 * 1000; };
    var first = near.filter(function (o) { return o['상태'] !== '취소' || hot(o); })[0];   // 오래전에 취소된 줄은 건너뛴다
    if (first && hot(first)) return first;
    if (mine) near = near.filter(function (o) { return o['결제인'] === mine; }).concat(near.filter(function (o) { return o['결제인'] !== mine; }));
    for (var i = 0; i < near.length; i++) {
      if (near[i]['상태'] !== '취소') return updateTx_(near[i].id, { '상태': '취소', '항목': (near[i]['항목'] ? near[i]['항목'] + ' ' : '') + '(결제취소)' });
      if (hot(near[i])) return near[i];
    }
    // 31일 안에 같은 금액·가맹점 거래가 하나도 없을 때만 더 오래된 거래를 본다: 살아 있는 것이 딱 한 건이면 그것을 취소한다 (숙소·항공권처럼 미리 결제한 것).
    // 여러 건이면(매일 사는 같은 값 커피) 어느 것인지 알 수 없으므로 건드리지 않는다.
    var old = near.length ? [] : cand.filter(function (o) { return o['상태'] !== '취소'; });
    return old.length === 1 ? updateTx_(old[0].id, { '상태': '취소', '항목': (old[0]['항목'] ? old[0]['항목'] + ' ' : '') + '(결제취소)' }) : null;
  }
  if (!parsed.amount) throw new Error('amount not found');
  // 중복 방지 (1) 알림끼리: 같은 금액·가맹점이 10분 안에 이미 있으면 무시. 취소된 줄은 중복으로 보지 않는다 (결제 → 취소 → 다시 결제).
  // 중복 방지 (2) 앱에서 넣은 거래(직접 입력·캡처·글자 공유)는 시각이 항상 12:00:00 이라 10분으로는 가릴 수 없다 → 같은 날·같은 유형이고, 공동 장부에서 알림을 보낸 기기가 구성원이면 결제인도 같을 때 같은 결제로 본다.
  //   한 줄은 알림 한 번하고만 짝짓는다: 짝지으면 그 줄의 일시를 알림 시각으로 바꿔 둔다 (pairTx_) → 같은 날 같은 곳에서 같은 값을 또 결제한 알림은 새 줄로 들어간다.
  //   자동 수집이 넣는 줄은 12:00:00 이 되지 않게 1초를 더해(when) 앱에서 넣은 줄과 섞이지 않게 한다. 가맹점을 못 읽은 알림은 짝짓지 않는다.
  var typed = function (o) { return /T12:00:00$/.test(String(o['일시'])); };
  var when = typed({ '일시': parsed.date }) ? String(parsed.date).substring(0, 17) + '01' : parsed.date;
  var live = same.filter(function (o) { return o['상태'] !== '취소'; });
  var dup = live.filter(function (o) { return !typed(o) && gap(o) < 10 * 60 * 1000; });
  if (dup.length) return dup[0];
  var pair = key ? live.filter(function (o) { return typed(o) && o['유형'] === parsed.type && (!mine || o['결제인'] === mine) && String(o['일시']).substring(0, 10) === day; }) : [];
  if (pair.length) return pairTx_(pair[0], when);
  var guess = LedgerParser.guessCategory(parsed.merchant, readDict_(), rules_());
  if (!guess) { var llm = llmClassify_(parsed.merchant, text); if (llm) guess = { category: llm, how: 'llm' }; }
  var minConf = Number(cfg_('AUTO_CONFIRM_MIN_CONFIDENCE')) || 0.9;
  var confirmed = parsed.confidence >= minConf && guess && (guess.how === 'exact' || guess.how === 'fuzzy');
  return addTx_({
    '일시': when,
    '유형': parsed.type,
    '금액': parsed.amount,
    '가맹점': parsed.merchant,
    '카테고리': guess ? guess.category : '',
    '항목': whoOk ? '' : '결제인 확인 필요',
    '결제인': whoOk ? who : (who || '?'),
    '출처': req.source || '알림',
    '상태': confirmed && whoOk ? '확인' : '미확인',
    '원문': text.substring(0, 500)
  });
}
// 앱에서 넣은 줄을 알림과 짝짓는다: 그 줄의 일시 칸(과 수정 시각)만 알림 시각으로 바꾼다. 날짜는 같으므로 사이클·금액·정산은 그대로이고, 다른 칸은 다시 쓰지 않는다 (사전·정산 기록도 건드리지 않는다).
function pairTx_(o, when) {
  var r = findRowIndex_(o.id);
  if (r < 0) return o;
  var sh = txSheet_(), now = isoLocal_(new Date());
  sh.getRange(r, COL['일시'] + 1).setValue(new Date(when));
  sh.getRange(r, COL['수정'] + 1).setValue(new Date(now));
  CACHE_.tx = null;
  return Object.assign({}, o, { '일시': when, '수정': now });
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
  var out = [], last = sh ? sh.getLastRow() : 0;
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, RCOLS.length).getValues().forEach(function (row) {
      if (!row[0]) return;
      var o = {};
      RCOLS.forEach(function (c, i) { var v = row[i]; if (v instanceof Date) v = isoLocal_(v); o[c] = v === undefined || v === null ? '' : v; });
      o['금액'] = Number(o['금액']) || 0;
      o['일'] = Math.min(31, Math.max(1, Math.round(Number(o['일'])) || 1));   // 시트에 15.5 처럼 적혀 있어도 날짜가 깨지지 않게 반올림
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
  o['일'] = Math.min(31, Math.max(1, Math.round(Number(o['일'])) || 1));
  o['계획'] = cfg_('LEDGER_TYPE') === 'personal' ? (o['계획'] === 'N' ? 'N' : 'Y') : '';
  o['활성'] = o['활성'] === 'N' ? 'N' : 'Y';
  o['메모'] = String(o['메모'] || '').trim();
  o['분담'] = cfg_('LEDGER_TYPE') === 'shared' ? String(o['분담'] || '').trim() : '';
  var now = isoLocal_(new Date());
  var r = -1;
  if (o.id) {
    var last = sh.getLastRow();
    if (last >= 2) { var ids = sh.getRange(2, 1, last - 1, 1).getValues(); for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(o.id)) { r = i + 2; break; } }
  }
  if (r < 0) { o.id = 'r' + newId_(); o['등록'] = now; r = sh.getLastRow() + 1; }
  else { var cur = sh.getRange(r, RCOL['등록'] + 1).getValue(); o['등록'] = cur instanceof Date ? isoLocal_(cur) : (cur || now); }
  o['수정'] = now;
  textFormat_(sh, REC_TEXT_RANGES_, RCOL, r, 1);
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

// amounts: {id: 이번 달 금액} — 월급·전기료처럼 달마다 다른 항목은 반영할 때 그 달 금액으로. updateDefault: [id] 면 고정 탭의 기본 금액도 그 값으로 바꾼다.
function applyRecurring_(cycle, ids, amounts, updateDefault) {
  var due = dueRecurring_(cycle);
  if (ids && ids.length) due = due.filter(function (r) { return ids.indexOf(r.id) >= 0; });
  amounts = amounts || {}; updateDefault = updateDefault || [];
  return due.map(function (r) {
    var amt = amount_(amounts[r.id]); if (amt <= 0) amt = r['금액'];
    if (amt !== r['금액'] && updateDefault.indexOf(r.id) >= 0) saveRecurring_(Object.assign({}, r, { '금액': amt }));
    return addTx_({
      '일시': recurringDate_(r, cycle), '유형': r['유형'], '금액': amt, '가맹점': r['이름'], '카테고리': r['카테고리'],
      '항목': r['메모'], '결제인': r['결제인'], '계획': r['계획'], '출처': '고정', '상태': '확인', '원문': recurringKey_(r.id), '분담': r['분담'] || ''
    });
  });
}

// ---------------------------------------------------------------- 사전
function readDict_() {
  if (CACHE_.dict) return CACHE_.dict;
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_DICT);
  var out = {}, last = sh ? sh.getLastRow() : 0;
  if (last >= 2) sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) { if (r[0] && r[1]) out[String(r[0])] = String(r[1]); });
  CACHE_.dict = out;
  return out;
}

function learn_(merchant, category) {
  var key = LedgerParser.normalizeMerchant(merchant);
  if (!key || !category) return;
  CACHE_.dict = null;
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
function rebuildDict() { try { return rebuildDictRun_(); } finally { dataChanged_(); } }   // 시트 메뉴·편집기·관리 액션에서 부른다. 끝나면(실패해도) 저장해 둔 읽기 응답을 버린다
function rebuildDictRun_() {
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
  CACHE_.dict = null;
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
 * 다시 하면 이관 행을 모두 지우고 옛 탭에서 새로 읽으므로, 이관 뒤 앱에서 고친 내용(취소·금액·태그·정산)과 그 거래의 품목이 사라진다.
 * 그래서 고친 이관 행(품목을 붙인 행 포함)이 있으면 force=true 로는 중단하고, force='discard' (시트 메뉴 "이관 다시 하기"가 경고를 보여 준 뒤 쓰는 값)일 때만 진행한다.
 * 다시 할 때는 옛 탭을 먼저 읽는다. 읽은 것이 없거나(옛 탭을 지웠거나 이름에서 연도를 뺌), 이관 행이 온 옛 탭이 없어졌거나, 직전 드라이브 백업이 안 되면 아무것도 지우지 않고 중단한다.
 */
function migrateLegacy(force) { try { return migrateLegacyRun_(force); } finally { dataChanged_(); } }   // 시트 메뉴·편집기·관리 액션에서 부른다. 끝나면(실패해도) 저장해 둔 읽기 응답을 버린다
function migrateLegacyRun_(force) {
  setup();
  CACHE_ = {};
  var ss = SpreadsheetApp.getActive();
  var existing = allTx_().filter(function (o) { return o['출처'] === '이관'; });
  if (existing.length && !force) throw new Error('이미 이관된 행이 ' + existing.length + '개 있습니다. 다시 하려면 메뉴의 "이관 다시 하기"를 쓰세요');
  var log = [], tabLog = [], redo = existing.length && force;
  if (redo) {
    var edited = editedMigratedCount_(existing);
    if (edited && force !== 'discard') throw new Error('이관 뒤 앱에서 고친 이관 행이 최소 ' + edited + '건 있습니다(취소·금액·태그·정산·품목 등). 다시 이관하면 그 수정과 품목이 모두 사라지고, 지웠던 이관 행도 다시 생깁니다. 그래도 하려면 시트 메뉴 "이관 다시 하기"를 쓰세요 (API 는 force 에 "discard")');
  }
  var type = cfg_('LEDGER_TYPE');
  var startDay = startDay_();
  var out = [];
  var now = new Date();

  // 옛 탭은 이관 행을 지우기 전에 먼저 읽는다 (읽을 것이 없는데 지우기부터 하면 이관 거래가 통째로 사라진다)
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (APP_SHEETS_.indexOf(name) >= 0) return;
    var ym = /(\d{2,4})\s*년(?:\s*(\d{1,2})\s*월)?/.exec(name);
    if (!ym) { tabLog.push(name + ': 연도 없음, 건너뜀'); return; }
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
    tabLog.push(name + ': ' + (out.length - before) + '건');
  });

  if (redo) {
    // 아무것도 지우기 전에 확인한다. (1) 옛 탭에서 읽은 거래가 없다 (2) 지금 있는 이관 행이 온 옛 탭(원문 칸의 탭 이름)이 시트에 없다 → 지우면 다시 들어오지 않으므로 중단
    var from = {}; existing.forEach(function (o) { var t = String(o['원문'] || ''); from[t] = (from[t] || 0) + 1; });
    var gone = Object.keys(from).filter(function (t) { return /\d{2,4}\s*년/.test(t) && !ss.getSheetByName(t); });
    if (!out.length) throw new Error('옛 월별 탭에서 읽은 거래가 없어 중단했습니다. 아무것도 지우지 않았습니다. 옛 탭(이름에 "2025년"·"26년 1월"처럼 연도가 있는 탭)을 지웠거나 이름을 바꿨으면 되돌린 뒤 다시 하세요');
    if (gone.length) throw new Error('이관 거래가 온 옛 탭이 없어 중단했습니다: ' + gone.map(function (t) { return '"' + t + '" (' + from[t] + '건)'; }).join(', ') + '. 아무것도 지우지 않았습니다. 이대로 다시 이관하면 이 거래들은 지워지기만 하고 다시 들어오지 않습니다. 탭을 되살리거나 이름을 되돌린 뒤 다시 하세요');
    // 지우기 전에 드라이브에 한 번 백업해 둔다. 백업이 안 되면 지우지 않고 중단한다 (확인 창이 "백업을 해 둔다"고 알린 뒤이므로, 백업 없이 수정 내용을 지우지 않는다).
    try { log.push('다시 이관하기 전 백업: ' + backupToDrive()); }
    catch (e) { throw new Error('드라이브 백업을 하지 못해 중단했습니다. 아무것도 지우지 않았습니다 (' + String(e && e.message || e).substring(0, 80) + '). 시트 메뉴 "지금 드라이브로 백업"이 되는지 확인한 뒤 다시 하세요'); }
    var itemsBefore = tabRead_(SHEET_ITEM, ICOLS).length;
    removeMigratedRows_();   // 앱에서 직접 넣은 거래는 남기고 이관 행(과 그 품목)만 지운 뒤 다시 넣는다
    var itemsGone = itemsBefore - tabRead_(SHEET_ITEM, ICOLS).length;
    if (itemsGone > 0) log.push('지운 이관 거래에 붙어 있던 품목 ' + itemsGone + '줄도 지웠습니다 (영수증 탭에서 온 품목은 메뉴 "영수증 탭 → 품목 이관"으로 다시 붙일 수 있습니다)');
  }
  log = log.concat(tabLog);

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
  textFormat_(sh, TX_TEXT_RANGES_, COL, startRow, rows.length);
  sh.getRange(startRow, 1, rows.length, COLS.length).setValues(rows);
  CACHE_.tx = null;
  rebuildDict();
  log.push('합계 ' + rows.length + '건 이관');
  Logger.log(log.join('\n'));
  return log;
}

// 이관 뒤 앱에서 고친 이관 행 수 (수정 시각이 등록 시각과 다르거나, 취소·미확인이거나, 태그·분담이 붙었거나, 품목이 붙은 행 — 품목만 붙이면 거래 줄의 수정 시각은 그대로다).
// 카테고리 이름 바꾸기로 바뀐 행과 지운 행은 알 수 없으므로 실제보다 적게 셀 수 있다.
function editedMigratedCount_(rows) {
  var items = itemCounts_();
  return rows.filter(function (o) { return String(o['수정']) !== String(o['등록']) || o['상태'] !== '확인' || o['태그'] || o['분담'] || items[o.id]; }).length;
}

// 출처가 '이관'인 행만 지운다 (수동/알림/스크린샷으로 넣은 거래는 보존). 지운 거래에 붙어 있던 품목 줄도 같이 지운다 (다시 이관하면 거래 id 가 바뀌어 주인 없는 줄로 남는다).
function removeMigratedRows_() {
  var sh = txSheet_();
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var all = sh.getRange(2, 1, last - 1, COLS.length);
  var vals = textRows_(all.getValues(), all.getDisplayValues(), TX_TEXT_RANGES_, COL);
  var keep = vals.filter(function (row) { return String(row[COL['출처']]) !== '이관'; });
  var gone = {}, kept = {};
  vals.forEach(function (row) { if (row[0] === '') return; if (String(row[COL['출처']]) === '이관') gone[String(row[0])] = true; else kept[String(row[0])] = true; });
  all.clearContent();
  // 남는 줄(앱에서 넣은 거래)은 위로 당겨져 다시 쓰인다. 그 자리는 글자 서식이 없던 이관 줄 자리일 수 있으므로 쓰기 전에 글자 서식을 건다 (가맹점 "1987", 메모 "1/2", 분담 "60:40" 이 숫자·날짜·시간으로 바뀌지 않게)
  if (keep.length) { textFormat_(sh, TX_TEXT_RANGES_, COL, 2, keep.length); sh.getRange(2, 1, keep.length, COLS.length).setValues(keep); }
  if (Object.keys(gone).length) itemsRewrite_(function (txId) { return !gone[txId] || kept[txId]; }, []);   // 같은 id 의 줄이 남아 있으면 그 품목은 그대로 둔다
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
  // 제목은 블록의 왼쪽 끝 칸에 있으므로, 머리글 열에서 왼쪽으로 가장 가까운 것을 쓴다 (옆 블록 제목을 집지 않게)
  for (var up2 = 1; up2 <= 3 && r - up2 >= 0; up2++) {
    var trow = vals[r - up2] || [];
    for (var k2 = Math.min(c + 4, trow.length - 1); k2 >= 0; k2--) {
      var bt = /(\d{4})\s*년\s*(\d{1,2})\s*월/.exec(String(trow[k2] || ''));
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
  // 표의 끝: 합계·총계 줄, 바로 아래에 붙은 다른 표의 머리글 줄, 그리고 수입자·수입원이 둘 다 빈 줄 가운데 합계 줄(합계 글자가 연번 칸에 있거나, 글자 없이 금액만 있는 줄)과 빈 줄이 두 줄 이어진 곳.
  // 예전에는 빈 줄이 3개 이어질 때까지 읽어서 합계 줄과 아래의 고정지출 표까지 수입으로 들어갔다. 빈 줄 한 줄은 표 가운데를 띄워 쓴 것일 수 있으므로 건너뛰고 이어서 읽는다 (그 아래가 합계·머리글이면 거기서 끝난다).
  // 수입자·수입원이 비어도 연번에 번호가 있고 금액이 있는 줄은 그 표의 줄로 읽는다 (이름 없이 금액만 적은 수입).
  var heads = ['연번', '수입자', '수입원', '금액', '카테고리', '지출처', '지출일자', '구매처', '세부내역', '항목', '결제인'];
  var cell = function (row, k) { return k != null ? String(row[k] || '').trim() : ''; };
  var blank = 0;
  for (var i = r + 1; i < vals.length; i++) {
    var row = vals[i];
    var amt = cellAmount_(row[map.amount]);
    var who = cell(row, map.payer), src = cell(row, map.merchant), seq = cell(row, map.seq);
    if (/^(합계|총계)/.test(who) || /^(합계|총계)/.test(src)) break;
    if ([seq, who, src, cell(row, map.amount)].some(function (t) { return heads.indexOf(t) >= 0; })) break;
    if (!who && !src) {
      if (/^(합계|총계)/.test(seq) || (amt && !/^\d+$/.test(seq))) break;
      if (!amt) { if (++blank >= 2) break; continue; }
    }
    blank = 0;
    if (/^소계/.test(who) || /^소계/.test(src) || !amt) continue;
    out.push({ '일시': dateIso, '유형': '수입', '금액': amt, '가맹점': src, '카테고리': '수입', '항목': '', '결제인': who, '정산': '', '계획': '', '원문': ctx.sheet });
  }
}

// ---------------------------------------------------------------- 드라이브 백업
/**
 * 앱이 쓰는 탭 전부(APP_SHEETS_)를 탭마다 CSV 하나씩 드라이브의 "가계부 백업/<시트 이름>" 폴더에 저장한다.
 * 시트 자체에도 버전 기록이 있지만, 실수로 탭을 지우거나 수식이 꼬였을 때를 위한 별도 사본이다.
 * installBackupTrigger() 를 한 번 실행하면 매일 새벽 자동으로 돌고, 최근 60일치만 남긴다 (그보다 오래된 파일은 드라이브 휴지통으로).
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
  // 오래된 백업 정리: 파일 수가 아니라 날짜(파일 이름 앞의 yyyyMMdd) 기준으로 최근 60일치를 남긴다. 한 번에 탭마다 파일이 하나씩 생기므로 파일 60개로 세면 나흘치밖에 안 남는다.
  // 백업 파일 이름(yyyyMMdd-HHmm_탭.csv)이 아닌 파일과 이미 휴지통에 있는 파일은 건드리지 않는다.
  var files = [], days = {}, it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next(), m = /^(\d{8})-\d{4}_/.exec(f.getName());
    if (!m || f.isTrashed()) continue;
    files.push([m[1], f]); days[m[1]] = 1;
  }
  var keep = Object.keys(days).sort().reverse().slice(0, 60);
  var cutoff = keep.length ? keep[keep.length - 1] : '';
  files.forEach(function (p) { if (p[0] < cutoff) p[1].setTrashed(true); });
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
    .addItem('글자 열 서식·사이클 칸 고치기', 'fixCycleColumnMenu')
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
    .addItem('서버 업데이트 (강제로 다시 배포)', 'updateServerForceMenu')
    .addItem('자동 업데이트 켜기 (매시간)', 'installUpdateTriggerMenu')
    .addToUi();
}
/**
 * (1) 거래·고정 탭의 글자 열(가맹점·항목·분담·태그 …)과 설정 탭의 값 열에 글자 서식을 건다. 이미 있던 시트에서 한 번 실행하면, 그 뒤로 시트에 직접 치는
 *     PIN "0412"·분담 "60:40"·메모 "1/2" 가 숫자·시간·날짜로 바뀌지 않는다. 이미 바뀌어 저장된 칸은 되돌리지 못하므로 그 칸만 다시 친다.
 * (2) 거래 탭의 사이클 열이 날짜로 저장된 것을 "yyyy-mm" 글자로 되돌린다 (적혀 있던 달 그대로, 다시 계산하지 않는다). 앱은 읽을 때 알아서 처리하지만 시트에서 보기 좋게.
 */
function fixCycleColumn() { try { return fixCycleColumnRun_(); } finally { dataChanged_(); } }   // 시트 메뉴·편집기·관리 액션에서 부른다. 끝나면(실패해도) 저장해 둔 읽기 응답을 버린다
function fixCycleColumnRun_() {
  setup();
  var sh = txSheet_();
  var vals = textColumns_(sh, TX_TEXT_RANGES_, COL, COLS.length, COL['사이클']);
  textColumns_(recSheet_(), REC_TEXT_RANGES_, RCOL, RCOLS.length, -1);
  SpreadsheetApp.getActive().getSheetByName(SHEET_CFG).getRange('B:B').setNumberFormat('@');
  if (!vals.length) return 0;
  sh.getRange(2, COL['사이클'] + 1, vals.length, 1).setValues(vals.map(function (r) { return [cycleStr_(r[COL['사이클']])]; }));
  return vals.length;
}
// 글자 열 전체에 글자 서식을 건다. 그 열에 이미 날짜·시간으로 바뀌어 저장된 칸은 보이던 그대로 글자로 바꾼다 (서식만 바꾸면 46024 같은 숫자로 보인다). 서식을 바꾸기 전에 읽은 값을 돌려준다.
function textColumns_(sh, ranges, colOf, ncols, skipCol) {
  var last = sh.getLastRow();
  var vals = last < 2 ? [] : sh.getRange(2, 1, last - 1, ncols).getValues(), shown = last < 2 ? [] : sh.getRange(2, 1, last - 1, ncols).getDisplayValues();
  textA1_(ranges, colOf).forEach(function (a1) { sh.getRange(a1).setNumberFormat('@'); });
  ranges.forEach(function (x) {
    for (var c = colOf[x[0]]; c < colOf[x[0]] + x[1]; c++) for (var i = 0; i < vals.length; i++) if (c !== skipCol && vals[i][c] instanceof Date) sh.getRange(i + 2, c + 1).setValue(shown[i][c]);
  });
  return vals;
}
function fixCycleColumnMenu() {
  var n = fixCycleColumn();
  SpreadsheetApp.getUi().alert('완료', '글자 열(가맹점·항목·분담·태그, 설정 값)에 글자 서식을 걸고, 사이클 ' + n + '칸을 글자로 고쳤습니다.\n이미 숫자·날짜로 바뀐 칸(예: PIN 412, 분담 시간값)은 그 칸만 다시 입력하세요.', SpreadsheetApp.getUi().ButtonSet.OK);
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
  try {
    setup(); CACHE_ = {};
    var edited = editedMigratedCount_(allTx_().filter(function (o) { return o['출처'] === '이관'; }));
    var ans = ui.alert('이관 다시 하기', '거래 탭에서 출처가 "이관"인 행을 모두 지우고 월별 시트를 다시 읽어옵니다.\n앱에서 직접 넣은 거래는 그대로 남습니다. 설정 탭의 LEDGER_TYPE 을 먼저 확인하세요.\n\n' +
      '주의: 이관된 거래를 앱에서 고친 내용(취소·금액·카테고리·태그·정산)과 그 거래의 품목은 모두 사라지고, 지웠던 이관 거래도 다시 생깁니다.' +
      (edited ? '\n지금 앱에서 고쳤거나 품목을 붙인 이관 거래가 최소 ' + edited + '건 있습니다.' : '') + '\n지우기 전에 드라이브에 백업을 한 번 해 둡니다. 백업이 안 되거나 옛 월별 탭을 읽지 못하면 아무것도 지우지 않고 멈춥니다.\n\n계속할까요?', ui.ButtonSet.YES_NO);
    if (ans !== ui.Button.YES) return;
    var log = migrateLegacy('discard');
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
var ACOLS = ['id', '이름', '종류', '소유', '메모', '활성', '등록', '목표금액', '목표일'];   // 목표금액(v3.1): 목돈·저축 목표. 비우면 잔액만 관리
var ATCOLS = ['id', '일시', '통장', '구분', '금액', '메모', '거래id', '등록'];
var DCOLS = ['id', '이름', '기관', '원금', '연이율', '월상환금', '시작일', '총회차', '납입회차', '소유', '메모', '활성', '등록'];
var ECOLS = ['id', '이름', '시작일', '종료일', '메모', '상태', '등록'];
var ICOLS = ['id', '거래id', '품목', '수량', '금액', '등록'];
var BCOLS = ['사이클', '카테고리', '금액', '수정'];
var SHEET_GRP = '모임';         // 회식·학회 등 여러 명이 나눠 내는 정산 (v3.1)
var SHEET_GRPI = '모임항목';
var SHEET_GRPP = '모임납입';
var GCOLS = ['id', '이름', '날짜', '참여자', '메모', '상태', '등록'];                       // 참여자: 쉼표 구분. 상태 진행|마감
var GICOLS = ['id', '모임id', '일자', '항목', '금액', '낸사람', '참여자', '메모', '등록'];   // 참여자 빈칸 = 모임 전원
var GPCOLS = ['id', '모임id', '일자', '보낸사람', '받는사람', '금액', '메모', '등록'];
var TEXT_COLS_ = { '사이클': 1, '시작일': 1, '종료일': 1, '통장': 1, '날짜': 1, '일자': 1, '목표일': 1 };   // 시트가 날짜로 바꾸지 못하게 글자 서식을 거는 열
var DATE_COLS_ = { '일시': 1, '등록': 1, '수정': 1 };
var APP_SHEETS_ = [SHEET_TX, SHEET_CFG, SHEET_DICT, SHEET_REC, SHEET_SET, SHEET_ACC, SHEET_ACCTX, SHEET_DEBT, SHEET_EVT, SHEET_ITEM, SHEET_BUD, SHEET_GRP, SHEET_GRPI, SHEET_GRPP];
var TAB_DEFS_ = [[SHEET_SET, SCOLS], [SHEET_ACC, ACOLS], [SHEET_ACCTX, ATCOLS], [SHEET_DEBT, DCOLS], [SHEET_EVT, ECOLS], [SHEET_ITEM, ICOLS], [SHEET_BUD, BCOLS], [SHEET_GRP, GCOLS], [SHEET_GRPI, GICOLS], [SHEET_GRPP, GPCOLS]];

function setupV3_() {
  var ss = SpreadsheetApp.getActive(), changed = false;
  TAB_DEFS_.forEach(function (def) {
    var name = def[0], cols = def[1];
    var sh = ss.getSheetByName(name);
    if (sh) {   // 이미 있는 탭에 열이 늘었으면 머리글만 덧붙인다 (기존 행은 빈칸 = 기본값)
      var hd = sh.getRange(1, 1, 1, cols.length).getValues()[0];
      for (var hi = 0; hi < cols.length; hi++) if (String(hd[hi] || '') !== cols[hi]) { sh.getRange(1, hi + 1).setValue(cols[hi]).setFontWeight('bold'); changed = true; }
      return;
    }
    changed = true;
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
    for (var i = 0; i < COLS.length; i++) if (String(head[i] || '') !== COLS[i]) { tx.getRange(1, i + 1).setValue(COLS[i]).setFontWeight('bold'); changed = true; }
  }
  return changed;
}

// ---- 공용 표 읽기/쓰기 (id 가 첫 열인 탭)
function tabRead_(name, cols) {
  var key = 'tab:' + name;
  if (CACHE_[key]) return CACHE_[key];
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  var out = [], last = sh ? sh.getLastRow() : 0;
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, cols.length).getValues().forEach(function (row) {
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
  if (parts.length === members.length && !parts.some(function (p) { return isNaN(p) || p < 0; })) { var sum = parts.reduce(function (a, b) { return a + b; }, 0); return sum ? parts[members.indexOf(member)] / sum : ratio[member] || 0; }   // 음수 비율("-1:2")은 잘못 적은 것으로 보고 설정 비율로
  return ratio[member] || 0;
}
// 결제인 이름 맞추기 (공동): 앞뒤 공백을 떼고, 구성원 이름이 하나만 들어 있는 글자("김덕우", "지민폰")는 그 구성원으로 본다. 그 밖의 이름은 그대로 돌려준다.
function payer_(v, members) {
  v = String(v === undefined || v === null ? '' : v).trim();
  if (!v || members.indexOf(v) >= 0) return v;
  var hit = members.filter(function (m) { return v.indexOf(m) >= 0; });
  return hit.length === 1 ? hit[0] : v;
}
// 미정산 거래(정산=X)와 열린 정산 기록을 합쳐 "지금 누가 누구에게 얼마를 줘야 하나"를 계산한다
function balance_() {
  var members = split_(cfg_('MEMBERS'));
  var ratio = splitRatio_();
  var net = {}, paid = {}, share = {};
  members.forEach(function (m) { net[m] = 0; paid[m] = 0; share[m] = 0; });
  var openTx = 0, openTxSum = 0, unknown = { count: 0, sum: 0, names: [] };
  allTx_().forEach(function (o) {
    if (o['유형'] !== '지출' || o['정산'] !== 'X' || o['상태'] === '취소') return;
    var p = payer_(o['결제인'], members);
    // 결제인이 구성원이 아니면(빈칸·오타·다른 이름) 누가 냈는지 알 수 없다. 예전에는 둘째 구성원이 낸 것처럼 계산돼 방향이 뒤집혔다 → 계산에서 빼고 unknownPayers 로 알린다.
    if (members.indexOf(p) < 0) { unknown.count++; unknown.sum += o['금액']; if (unknown.names.indexOf(p || '(빈칸)') < 0) unknown.names.push(p || '(빈칸)'); return; }
    openTx++; openTxSum += o['금액'];
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
  return { net: net, paid: paid, share: share, remaining: remaining, openTx: openTx, openTxSum: openTxSum, openPayments: payments.length, openPaymentsSum: paySum, ratio: ratio, unknownPayers: unknown };
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
// req.expect = { from, to, amount }: 앱이 확인 창에 보여 준 금액. 그 사이 금액이 바뀌었으면(상대방 입력·자동 수집) 기록·마감하지 않고 알린다. expect 를 안 보내는 옛 앱은 전과 같다.
function settleFinish_(req) {
  var bal = balance_();
  var ex = req && req.expect;
  if (ex) { var rm = bal.remaining;
    if (!rm || rm.from !== String(ex.from) || rm.to !== String(ex.to) || rm.amount !== amount_(ex.amount)) throw new Error('그 사이 정산 금액이 바뀌었습니다. 새 금액을 확인하고 다시 눌러 주세요'); }
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
  var bal = {}, monthly = {}, first = {};
  var today = isoLocal_(new Date()).substring(0, 10), thisYm = today.substring(0, 7);
  var from6 = addMonths_(thisYm + '-01', -6).substring(0, 7);   // 월평균에 쓸 수 있는 가장 이른 달 (이번 달에 기록이 아직 없으면 지난달까지 6개월을 본다)
  txs.forEach(function (t) {
    var a = amount_(t['금액']); var signed = t['구분'] === '출금' ? -a : a;
    bal[t['통장']] = (bal[t['통장']] || 0) + signed;
    var d = String(t['일시']).substring(0, 10), ym = d.substring(0, 7);
    if (d > today) return;   // 오늘 이후 날짜로 적어 둔 기록은 잔액에는 넣고 월평균(적립 속도)에서는 뺀다
    if (!first[t['통장']] || ym < first[t['통장']]) first[t['통장']] = ym;
    if (ym >= from6) { var m = monthly[t['통장']] || (monthly[t['통장']] = {}); m[ym] = (m[ym] || 0) + signed; }
  });
  var accounts = accs.map(function (a) {
    var b = bal[a.id] || 0; var m = monthly[a.id] || {};
    // 월평균 순적립: 끝 달 = 이번 달(이번 달 기록이 아직 없으면 지난달 → 달이 바뀐 직후 평균이 뚝 떨어지지 않는다), 거기서 거꾸로 6개월.
    // 첫 기록이 그 안에 있는 새 통장은 첫 달을 시작 잔액(옮겨 적은 돈)으로 보고 그다음 달부터 센 달 수로 나눈다. 셀 달이 없으면 0 (계산 불가).
    // avgMonths = 월평균을 낸 달 수(0~6). 0 이면 "적립이 없다"가 아니라 "아직 셀 달이 없다"(첫 달뿐인 새 통장)는 뜻 → 앱이 문구를 가려 쓸 수 있게 같이 준다.
    // (첫 달의 입금이 첫 적립인지 옮겨 적은 기존 잔액인지는 기록만으로 알 수 없어, 첫 달뿐일 때의 월평균은 0 으로 둔다)
    var end = m[thisYm] !== undefined ? thisYm : addMonths_(thisYm + '-01', -1).substring(0, 7);
    var start = addMonths_(end + '-01', -5).substring(0, 7), f = first[a.id] || '';
    if (f >= start) start = addMonths_(f + '-01', 1).substring(0, 7);
    var months = start > end ? 0 : monthsBetween_(start + '-01', end + '-01') + 1;
    var net6 = Object.keys(m).reduce(function (x, k) { return k >= start && k <= end ? x + m[k] : x; }, 0);
    var avg = months ? Math.round(net6 / months) : 0;
    var goal = null; var target = amount_(a['목표금액']);
    if (target > 0) {
      var remaining = Math.max(0, target - b), due = day_(a['목표일']);
      var eta = remaining > 0 && avg > 0 ? Math.ceil(remaining / avg) : null;
      // progress 는 0~1 (잔액이 마이너스여도 0). 목표일이 이미 지났으면 "목표일까지 매달" 금액은 없다(null)
      goal = { target: target, remaining: remaining, progress: Math.max(0, Math.min(1, b / target)), avgMonthly: avg, avgMonths: months, etaMonths: eta, etaDate: eta ? addMonths_(today, eta) : (remaining === 0 ? today : ''), dueDate: due,
        neededMonthly: due && due >= today && remaining > 0 ? Math.ceil(remaining / Math.max(1, monthsBetween_(today, due))) : null };
    }
    return Object.assign({}, a, { balance: b, monthly: m, avgMonthly: avg, avgMonths: months, goal: goal });
  });
  var sum = 0; accounts.forEach(function (a) { if (a['활성'] !== 'N') sum += a.balance; });
  return { accounts: accounts, sum: sum, log: txs.slice(0, 100), total: txs.length };
}
// 통장 사이 이체: 출금 + 입금 두 줄을 같은 메모로 넣는다. 두 줄의 거래id 칸에 같은 묶음 표시('xfer:…')를 넣어, 한쪽을 고치거나 지울 때 짝도 같이 처리한다 (xferPair_)
function accountTransfer_(req) {
  var accs = tabRead_(SHEET_ACC, ACOLS);
  var from = String(req.from || ''), to = String(req.to || '');
  if (!accs.some(function (a) { return a.id === from; }) || !accs.some(function (a) { return a.id === to; }) || from === to) throw new Error('보내는 통장과 받는 통장을 확인하세요');
  var amt = amount_(req.amount); if (amt <= 0) throw new Error('금액을 입력하세요');
  var when = req.date ? (String(req.date).length === 10 ? req.date + 'T12:00:00' : String(req.date).substring(0, 19)) : isoLocal_(new Date());
  var nameOf = function (id) { return (accs.filter(function (a) { return a.id === id; })[0] || {})['이름'] || id; };
  var memo = '[이체] ' + String(req.memo || '').trim(), link = 'xfer:' + newId_();
  var out = tabUpsert_(SHEET_ACCTX, ATCOLS, { '일시': when, '통장': from, '구분': '출금', '금액': amt, '메모': memo + ' → ' + nameOf(to), '거래id': link }, 't');
  tabUpsert_(SHEET_ACCTX, ATCOLS, { '일시': when, '통장': to, '구분': '입금', '금액': amt, '메모': memo + ' ← ' + nameOf(from), '거래id': link }, 't');
  return out;
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
  o['목표금액'] = amount_(o['목표금액']) || '';
  o['목표일'] = day_(o['목표일']);
  return tabUpsert_(SHEET_ACC, ACOLS, o, 'a');
}
// cascade 가 true 면 입출금 기록도 같이 지운다 (주머니를 정리할 때). 아니면 기록이 있으면 막는다.
function accountDelete_(id, cascade) {
  var txs = tabRead_(SHEET_ACCTX, ATCOLS).filter(function (t) { return t['통장'] === id; });
  if (txs.length && !cascade) throw new Error('기록이 ' + txs.length + '건 있는 통장입니다. 기록까지 지우려면 확인하세요');
  if (txs.length) {
    var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_ACCTX); var last = sh.getLastRow();
    var vals = sh.getRange(2, 1, last - 1, ATCOLS.length).getValues();
    var keep = vals.filter(function (row) { return String(row[ATCOLS.indexOf('통장')]) !== String(id); });
    sh.getRange(2, 1, last - 1, ATCOLS.length).clearContent();
    if (keep.length) sh.getRange(2, 1, keep.length, ATCOLS.length).setValues(keep);
    CACHE_['tab:' + SHEET_ACCTX] = null;
  }
  return tabDelete_(SHEET_ACC, id);
}
// 이체의 짝 줄을 찾는다. 새 이체는 거래id 가 같은 'xfer:…' 인 줄. 이 표시가 없는 옛 이체는 두 줄이 accountTransfer_ 가 적은 모양 그대로일 때만 짝으로 본다:
// 둘 다 거래id 가 빈칸, 일시·금액이 같고, 한쪽은 출금 '[이체] 메모 → 받는 통장 이름', 다른 쪽은 그 통장의 입금 '[이체] 메모 ← 보내는 통장 이름' (서로의 통장을 가리킨다).
// 시트의 줄 순서는 보지 않는다 (통장거래 탭을 정렬했어도 엉뚱한 줄을 집지 않는다). 그런 줄이 없으면 (메모를 고쳤거나 통장 이름을 바꾼 옛 이체) 짝이 없는 것으로 보고 전처럼 한 줄만 다룬다.
// 여러 줄이면 모두 같은 통장의 줄일 때만(같은 날 같은 금액·같은 메모로 두 번 이체해 내용이 똑같은 줄) 그 가운데 하나를 쓰고, 통장이 갈리면 짝이 없는 것으로 본다.
function xferPair_(cur) {
  if (!cur) return null;
  var all = tabRead_(SHEET_ACCTX, ATCOLS), link = String(cur['거래id'] || '');
  if (link.indexOf('xfer:') === 0) { var hit = all.filter(function (t) { return t.id !== cur.id && String(t['거래id']) === link; }); return hit.length === 1 ? hit[0] : null; }
  var other = cur['구분'] === '출금' ? '입금' : (cur['구분'] === '입금' ? '출금' : '');
  if (link || !other) return null;
  var accs = tabRead_(SHEET_ACC, ACOLS), nameOf = function (id) { return String((accs.filter(function (a) { return a.id === id; })[0] || {})['이름'] || id); };
  var legs = function (out, inn) {   // out = 출금 줄, inn = 입금 줄
    var mo = String(out['메모'] || ''), tail = ' → ' + nameOf(inn['통장']), at = mo.length - tail.length;
    return at > 0 && /^\[이체\]/.test(mo.substring(0, at)) && mo.substring(at) === tail && String(inn['메모'] || '') === mo.substring(0, at) + ' ← ' + nameOf(out['통장']);
  };
  var cand = all.filter(function (t) {
    return t.id !== cur.id && !t['거래id'] && t['구분'] === other && t['통장'] !== cur['통장'] && t['일시'] === cur['일시'] && amount_(t['금액']) === amount_(cur['금액']) && (other === '입금' ? legs(cur, t) : legs(t, cur));
  });
  return cand.length && cand.every(function (t) { return t['통장'] === cand[0]['통장']; }) ? cand[0] : null;
}
// 입출금 기록 한 줄 삭제. 이체 줄이면 짝 줄도 같이 지운다 (한쪽만 지우면 통장 합계가 달라진다)
function accountTxDelete_(id) {
  var pair = xferPair_(tabRead_(SHEET_ACCTX, ATCOLS).filter(function (t) { return t.id === id; })[0]);
  var ok = tabDelete_(SHEET_ACCTX, id);
  if (ok && pair) tabDelete_(SHEET_ACCTX, pair.id);
  return ok;
}
// 입출금 기록 한 줄 수정 (날짜·구분·금액·메모). 이체 줄이면 짝 줄의 금액·날짜도 같이 맞추고, 입금/출금과 통장은 바꾸지 않는다
function accountTxUpdate_(id, tx) {
  var cur = tabRead_(SHEET_ACCTX, ATCOLS).filter(function (t) { return t.id === id; })[0];
  if (!cur) throw new Error('기록을 찾지 못했습니다');
  var pair = xferPair_(cur);   // 고치기 전 값으로 찾는다
  var o = Object.assign({}, cur);
  if (tx['금액'] !== undefined) { var a = amount_(tx['금액']); if (a <= 0) throw new Error('금액을 입력하세요'); o['금액'] = a; }
  if (tx['구분'] !== undefined) o['구분'] = tx['구분'] === '출금' ? '출금' : '입금';
  if (tx['일시'] !== undefined && tx['일시']) o['일시'] = String(tx['일시']).length === 10 ? tx['일시'] + 'T12:00:00' : String(tx['일시']).substring(0, 19);
  if (tx['메모'] !== undefined) o['메모'] = String(tx['메모'] || '').trim();
  if (tx['통장'] !== undefined && tx['통장']) o['통장'] = String(tx['통장']);
  // 묶음 표시가 없던 옛 이체는 짝을 찾은 이때 두 줄에 표시를 넣어 둔다 → 그 뒤로는 메모를 고쳐도, 통장 이름을 바꿔도 짝이 풀리지 않는다 (다른 줄은 건드리지 않는다)
  if (pair) { o['구분'] = cur['구분']; o['통장'] = cur['통장']; if (!o['거래id']) o['거래id'] = 'xfer:' + newId_(); }
  tabWrite_(SHEET_ACCTX, ATCOLS, o, tabRowIndex_(SHEET_ACCTX, id));
  var pr = pair ? tabRowIndex_(SHEET_ACCTX, pair.id) : -1;
  if (pr > 0) tabWrite_(SHEET_ACCTX, ATCOLS, Object.assign({}, pair, { '금액': o['금액'], '일시': o['일시'], '거래id': o['거래id'] }), pr);
  return o;
}
// 통장 하나의 전체 기록 (최신순) + 연도별 합계
function accountLog_(id) {
  var txs = tabRead_(SHEET_ACCTX, ATCOLS).filter(function (t) { return t['통장'] === id; }).slice();
  txs.sort(function (a, b) { return a['일시'] < b['일시'] ? -1 : (a['일시'] > b['일시'] ? 1 : (a['등록'] < b['등록'] ? -1 : 1)); });
  var bal = 0; txs.forEach(function (t) { var a = amount_(t['금액']); bal += t['구분'] === '출금' ? -a : a; t.balance = bal; });
  var years = {};
  txs.forEach(function (t) { var y = String(t['일시']).substring(0, 4); var yy = years[y] || (years[y] = { year: y, in: 0, out: 0, count: 0 }); yy.count++; if (t['구분'] === '출금') yy.out += amount_(t['금액']); else yy.in += amount_(t['금액']); });
  txs.reverse();
  return { log: txs, years: Object.keys(years).sort().reverse().map(function (y) { return years[y]; }) };
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
  var solved = !n && M > 0 && P > 0;   // 총회차를 비워 월상환금에서 회차를 구했는가
  // 이자만 내는 대출(총회차 없이 월상환금이 한 달 이자 이하, 예: 전세대출): 끝나는 회차를 계산할 수 없다. 회차·진행률·총 이자는 0, 완납 예정은 빈칸으로 주고 endless 로 알린다
  // (계산을 그대로 하면 회차가 Infinity·NaN 이 되어 응답에 null 이, 완납 예정에 "NaN-NaN-NaN" 이 나간다)
  var endless = solved && i > 0 && M <= Math.round(P * i);   // 한 달 이자는 원 단위로 견준다 (1.5억·5.1% 의 이자 637,500원이 계산에서는 637,499.9999999999 로 나온다)
  if (!n && M && P && !endless) n = i > 0 ? Math.ceil(-Math.log(1 - P * i / M) / Math.log(1 + i)) : Math.ceil(P / M);
  if (!M && n && P) M = i > 0 ? Math.round(P * i * Math.pow(1 + i, n) / (Math.pow(1 + i, n) - 1)) : Math.round(P / n);
  var start = day_(d['시작일']);
  var k = d['납입회차'] === '' || d['납입회차'] === null || d['납입회차'] === undefined ? monthsBetween_(start, isoLocal_(new Date()).substring(0, 10)) : Number(d['납입회차']) || 0;
  if (n) k = Math.min(n, Math.max(0, k));
  if (endless) k = Math.max(0, k) || 0;
  var remaining = i > 0 ? P * Math.pow(1 + i, k) - M * (Math.pow(1 + i, k) - 1) / i : P - M * k;
  remaining = Math.max(0, Math.round(remaining));
  if (n && k >= n) remaining = 0;
  // 총 이자 = 낸 돈 − 원금. 회차를 월상환금에서 구한 대출은 올림한 회차라 마지막 달에는 남은 만큼만 낸다 (한 달치를 통째로 더하면 무이자 대출에도 이자가 생긴다)
  var interest = n && M ? Math.max(0, M * n - P) : 0;
  if (!i && !amount_(d['월상환금'])) interest = 0;   // 무이자 대출을 총회차로만 넣은 경우: 월상환금은 원 단위로 반올림해 구한 값일 뿐이라 이자가 없다 (반올림 때문에 8원·40원이 나왔다)
  if (solved && n > 0 && isFinite(n)) {
    var bal = i > 0 ? P * Math.pow(1 + i, n - 1) - M * (Math.pow(1 + i, n - 1) - 1) / i : P - M * (n - 1);   // 마지막 납입 전 잔여 원금
    interest = Math.max(0, Math.round(M * (n - 1) + Math.max(0, bal) * (1 + i) - P));
  }
  return { principal: P, rate: r, monthly: M, months: n, paid: endless ? 0 : k, remaining: remaining, progress: n ? k / n : 0, totalInterest: interest,
    nextDue: start ? addMonths_(start, k + 1) : '', endDate: start && n ? addMonths_(start, n) : '', endless: endless };
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
// 이벤트 이름이 바뀌면 거래 탭과 정산 탭의 태그 칸에 적힌 옛 이름을 새 이름으로 바꾼다 (태그는 이벤트 id 가 아니라 이름으로 이어져 있다).
// 옛 이름과 똑같은 칸만, 그 칸만 고친다. 새 이름이 "11/2" 같은 글자여도 날짜로 바뀌지 않게 글자 서식을 먼저 건다.
function renameTag_(from, to) {
  var n = 0;
  [[txSheet_(), COL['태그']], [SpreadsheetApp.getActive().getSheetByName(SHEET_SET), SCOLS.indexOf('태그')]].forEach(function (x) {
    var sh = x[0], last = sh ? sh.getLastRow() : 0; if (last < 2) return;
    var v = sh.getRange(2, x[1] + 1, last - 1, 1).getValues();
    for (var i = 0; i < v.length; i++) if (String(v[i][0]).trim() === from) { sh.getRange(i + 2, x[1] + 1).setNumberFormat('@').setValue(to); n++; }
  });
  CACHE_.tx = null; CACHE_['tab:' + SHEET_SET] = null;
  return n;
}
function eventSave_(item) {
  var o = {};
  ECOLS.forEach(function (c) { o[c] = item[c] === undefined || item[c] === null ? '' : item[c]; });
  o['이름'] = String(o['이름'] || '').trim();
  if (!o['이름']) throw new Error('이벤트 이름을 입력하세요');
  o['시작일'] = day_(o['시작일']); o['종료일'] = day_(o['종료일']);
  o['상태'] = o['상태'] === '마감' ? '마감' : '진행';
  o['메모'] = String(o['메모'] || '').trim();
  var nameOf = function (e) { return String(e['이름'] || '').trim(); };
  var others = tabRead_(SHEET_EVT, ECOLS).filter(function (e) { return e.id !== o.id; });
  var prev = o.id ? tabRead_(SHEET_EVT, ECOLS).filter(function (e) { return e.id === o.id; })[0] : null;
  var old = prev ? nameOf(prev) : '';
  // 새로 만들거나 이름을 바꿀 때만 같은 이름을 막는다 (이미 같은 이름이 둘 있는 시트에서도 이름을 그대로 둔 수정·마감은 된다)
  if (old !== o['이름'] && others.some(function (e) { return nameOf(e) === o['이름']; })) throw new Error('같은 이름의 이벤트가 이미 있습니다');
  var saved = tabUpsert_(SHEET_EVT, ECOLS, o, 'e');
  if (old && old !== o['이름'] && !others.some(function (e) { return nameOf(e) === old; })) renameTag_(old, o['이름']);   // 옛 이름을 쓰는 이벤트가 또 있으면 태그는 그 이벤트 것으로 남긴다
  return saved;
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
// 품목 탭에서 keepTx(거래id) 가 false 인 줄을 빼고 fresh 줄을 맨 아래에 붙인다 (id 가 빈 줄도 전처럼 뺀다).
// 탭 전체를 지우고 다시 쓰지 않는다: 위에서부터 그대로인 줄은 손대지 않고, 달라지는 첫 줄부터만 먼저 쓴 다음 남는 꼬리 줄을 비운다
// → 새 거래의 품목은 맨 아래에 붙이기만 하고, 쓰기 도중에 실행이 끊겨도 다른 거래의 품목이 사라지지 않는다.
function itemsRewrite_(keepTx, fresh) {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_ITEM);
  var last = sh ? sh.getLastRow() : 0, tc = ICOLS.indexOf('거래id');
  var vals = last >= 2 ? sh.getRange(2, 1, last - 1, ICOLS.length).getValues() : [];
  var ok = function (row) { return row[0] && keepTx(String(row[tc])); };
  var at = 0; while (at < vals.length && ok(vals[at])) at++;
  var tail = vals.slice(at).filter(ok).concat(fresh);
  if (tail.length) sh.getRange(at + 2, 1, tail.length, ICOLS.length).setValues(tail);
  var left = vals.length - at - tail.length;
  if (left > 0) sh.getRange(at + 2 + tail.length, 1, left, ICOLS.length).clearContent();
  CACHE_['tab:' + SHEET_ITEM] = null;
}
// 거래 하나의 품목을 통째로 바꾼다 (그 거래의 줄을 빼고 새 줄을 붙인다)
function itemsSave_(txId, items) {
  if (!txId) throw new Error('거래를 먼저 저장하세요');
  var now = new Date();
  var fresh = (items || []).map(function (it) {
    var name = String(it['품목'] || '').trim(); if (!name) return null;
    return ['i' + newId_(), String(txId), name, Number(it['수량']) || 1, amount_(it['금액']), now];
  }).filter(Boolean);
  if (fresh.length && findRowIndex_(txId) < 0) throw new Error('이미 지워진 거래입니다');   // 없는 거래에 품목만 남지 않게 (품목을 비우는 것은 허용)
  itemsRewrite_(function (id) { return id !== String(txId); }, fresh);
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
  if (amt !== '' && amt < 0) throw new Error('예산은 0 이상으로 입력하세요');
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_BUD);
  var last = sh.getLastRow();
  var r = -1, same = [];
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 2).getValues();
    for (var i = 0; i < vals.length; i++) if (cycleStr_(vals[i][0]) === cycle && String(vals[i][1] || '').trim() === cat) same.push(i + 2);
  }
  // 같은 (사이클, 카테고리) 줄이 여러 개인 시트(예전에 카테고리를 합친 경우): budgetFor_ 가 읽는 줄은 맨 아래 줄이므로 그 줄을 고친다 (첫 줄을 고치면 저장해도 값이 안 바뀐다).
  // 지울 때는 그 예산의 줄을 모두 지운다 (한 줄만 지우면 가려져 있던 옛 금액이 다시 나온다).
  if (same.length) r = same[same.length - 1];
  if (amt === '') { for (var x = same.length - 1; x >= 0; x--) sh.deleteRow(same[x]); }
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
// 설정의 CATEGORY_RULES("키워드:카테고리;…")에서 옛 카테고리로 가던 규칙만 새 카테고리로 돌린다. 나머지 규칙은 적힌 그대로 둔다.
function rulesRename_(s, from, to) {
  if (!from) return String(s || '');
  return String(s || '').split(';').map(function (p) { var kv = p.split(':'); return kv.length === 2 && kv[1].trim() === from ? kv[0].trim() + ':' + to : p; }).join(';');
}
function renameCategory_(from, to) {
  // 시트에서 손으로 적어 앞뒤에 공백이 붙은 이름("식비 ")은 앱의 카테고리 정리에 "식비" 와 따로 나온다. 그 줄의 '바꾸기'는 공백까지 똑같이 적힌 칸만 바꾼다
  // (예전에는 공백을 떼고 처리해서, 고른 "식비 " 는 그대로 두고 진짜 "식비" 를 통째로 바꾸고 그 예산 줄까지 합쳐 지웠다). 이때 진짜 "식비" 의 예산·분류 규칙·목록 자리는 건드리지 않는다 (cat 이 빈칸).
  // "식비 " → "식비" 로 바꾸면 공백 붙은 줄이 진짜 이름으로 정리된다.
  var raw = String(from || '');
  from = raw.trim(); to = String(to || '').trim();
  var cat = raw === from ? from : '';   // 예산 탭·설정 탭에서 다룰 옛 이름
  if (!to) throw new Error('새 이름을 입력하세요');
  if (raw === to) return { tx: 0 };
  if (/[,;:]/.test(to)) throw new Error('카테고리 이름에 쉼표(,)·콜론(:)·세미콜론(;)은 쓸 수 없습니다');   // 설정의 CATEGORIES 는 쉼표로, CATEGORY_RULES 는 ; 과 : 으로 나눠 읽는다 → 이름이 둘로 쪼개지거나 규칙이 깨진다
  var ss = SpreadsheetApp.getActive();
  var n = 0;
  // 거래
  var sh = txSheet_(); var last = sh.getLastRow();
  if (last >= 2) {
    var rng = sh.getRange(2, COL['카테고리'] + 1, last - 1, 1); var vals = rng.getValues(); var ch = false;
    for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) === raw) { vals[i][0] = to; n++; ch = true; }
    if (ch) rng.setValues(vals);
  }
  // 고정
  var rs = recSheet_(); var rl = rs.getLastRow();
  if (rl >= 2) { var rr = rs.getRange(2, RCOL['카테고리'] + 1, rl - 1, 1); var rv = rr.getValues(); var rc = false; for (var j = 0; j < rv.length; j++) if (String(rv[j][0]) === raw) { rv[j][0] = to; rc = true; } if (rc) rr.setValues(rv); }
  // 사전: 같은 가맹점이 두 번 생기면 횟수를 합친다
  var ds = ss.getSheetByName(SHEET_DICT); var dl = ds.getLastRow();
  if (dl >= 2) {
    var dv = ds.getRange(2, 1, dl - 1, 3).getValues(); var map = {}; var order = [];
    dv.forEach(function (r) { if (!r[0]) return; var c = String(r[1]) === raw ? to : String(r[1]); var k = String(r[0]); if (!map[k]) { map[k] = [k, c, Number(r[2]) || 0]; order.push(k); } else { map[k][1] = c; map[k][2] += Number(r[2]) || 0; } });
    ds.getRange(2, 1, dl - 1, 3).clearContent();
    var rows = order.map(function (k) { return map[k]; });
    if (rows.length) ds.getRange(2, 1, rows.length, 3).setValues(rows);
  }
  // 예산 탭: 옛 이름 줄의 카테고리 칸만 새 이름으로 바꾼다. 같은 사이클에 새 이름의 예산이 이미 있으면(합치기) 두 금액을 더해 그 줄에 적고 옛 이름 줄은 지운다
  // (합치면 지출도 더해진다. 같은 줄이 둘 남으면 줄 순서에 따라 값이 달라지고 예산을 고쳐도 안 바뀐다). 다른 줄·사이클 칸은 다시 쓰지 않는다. 옛 이름이 빈칸이면 총액 줄이므로 건드리지 않는다.
  var bs = ss.getSheetByName(SHEET_BUD); var bl = bs.getLastRow();
  if (cat && bl >= 2) {
    var bv = bs.getRange(2, 1, bl - 1, 3).getValues(); var keep = {}, src = {}, gone = [];
    bv.forEach(function (b, q) {
      var bcat = String(b[1]).trim(), bk = cycleStr_(b[0]);
      if (bcat === to && /^\d{4}-\d{2}$/.test(bk)) keep[bk] = q;   // 새 이름 줄이 여럿이면 맨 아래 줄 (budgetFor_ 가 읽는 줄)
      if (bcat === cat) (src[bk] = src[bk] || []).push(q);
    });
    Object.keys(src).forEach(function (bk) {
      var rows = src[bk];
      if (keep[bk] === undefined) { rows.forEach(function (q) { bs.getRange(q + 2, 2).setNumberFormat('@').setValue(to); }); return; }
      // 순서: 옛 이름 줄부터 (새 이름, 합계)로 바꾸고 → 새 이름 줄에 합계 → 맨 끝에 옛 줄 삭제. 삭제 전에 실행이 끊겨도 옛 이름 줄이 남지 않으므로, 다시 눌렀을 때 금액이 한 번 더 더해지지 않는다
      // (예전에는 새 이름 줄에 합계를 먼저 적어서, 끊긴 뒤 다시 하면 10만 + 20만이 40만이 됐다). 끊긴 채 남은 줄은 값이 같은 겹친 줄이라 보이는 예산은 합계 그대로다.
      var sum = amount_(bv[keep[bk]][2]) + amount_(bv[rows[rows.length - 1]][2]);
      rows.forEach(function (q) { bs.getRange(q + 2, 2).setNumberFormat('@'); bs.getRange(q + 2, 2, 1, 2).setValues([[to, sum]]); });
      bs.getRange(keep[bk] + 2, 3).setValue(sum);
      gone = gone.concat(rows);
    });
    gone.sort(function (a, b) { return b - a; }).forEach(function (q) { bs.deleteRow(q + 2); });   // 아래 줄부터 지워야 줄 번호가 밀리지 않는다
  }
  // 설정 CATEGORIES(옛 이름의 자리에 새 이름 → 칩 순서 유지), CATEGORY_RULES, BUDGET_<이름>
  var cs = ss.getSheetByName(SHEET_CFG); var cv = cs.getDataRange().getValues();
  var hasRules = false, budOk = cat && cat !== 'TOTAL' && to !== 'TOTAL', budTo = -1, budFrom = [];   // BUDGET_TOTAL 은 카테고리 예산이 아니라 총액
  for (var k = 1; k < cv.length; k++) {
    var key = String(cv[k][0]).trim();
    if (key === 'CATEGORIES') {
      var list = split_(cv[k][1]); var at = list.indexOf(cat);
      if (at >= 0 && list.indexOf(to) < 0) list[at] = to;
      list = list.filter(function (c) { return c !== cat; }); if (list.indexOf(to) < 0) list.push(to);
      cs.getRange(k + 1, 2).setValue(list.join(','));
    }
    if (key === 'CATEGORY_RULES') { hasRules = true; var nr = rulesRename_(cv[k][1], cat, to); if (nr !== String(cv[k][1])) cs.getRange(k + 1, 2).setNumberFormat('@').setValue(nr); }
    if (budOk && key === 'BUDGET_' + to) budTo = k + 1;
    if (budOk && key === 'BUDGET_' + cat) budFrom.push(k + 1);
  }
  // 규칙 줄이 없는 시트(기본 규칙을 쓰는 중)에서 기본 규칙의 카테고리를 바꿨으면, 바뀐 규칙을 설정 탭에 새 줄로 적는다
  if (cat && !hasRules) { var dr = rulesRename_(DEFAULT_CFG.CATEGORY_RULES, cat, to); if (dr !== DEFAULT_CFG.CATEGORY_RULES) cs.appendRow(['CATEGORY_RULES', dr, '키워드:카테고리;... 사전에 없을 때 쓰는 규칙']); }
  // BUDGET_<옛 이름>: 새 이름의 줄이 없으면 전처럼 키 이름만 바꾼다. 이미 있으면 두 금액을 더해 그 줄에 적고 옛 줄은 지운다 (같은 키가 두 줄이면 아래 줄 값이 위 줄을 덮는다)
  if (budTo < 0) budFrom.forEach(function (r) { cs.getRange(r, 1).setValue('BUDGET_' + to); });
  else if (budFrom.length) {
    var fv = cv[budFrom[budFrom.length - 1] - 1][1];
    if (String(fv).trim() !== '') {   // 예산 탭과 같은 순서: 옛 줄부터 (새 키, 합계)로 바꾼 다음 새 줄에 합계 → 지우기 전에 끊겨도 다시 눌렀을 때 또 더해지지 않는다
      var bsum = String(amount_(cv[budTo - 1][1]) + amount_(fv));
      budFrom.forEach(function (r) { cs.getRange(r, 2).setNumberFormat('@'); cs.getRange(r, 1, 1, 2).setValues([['BUDGET_' + to, bsum]]); });
      cs.getRange(budTo, 2).setNumberFormat('@').setValue(bsum);
    }
    for (var d = budFrom.length - 1; d >= 0; d--) cs.deleteRow(budFrom[d]);
  }
  CACHE_ = {};
  return { tx: n, from: from, to: to };
}

// ---------------------------------------------------------------- 모임 정산: 여러 명이 나눠 내기 (회식·학회·여행)
// 각자 부담 = 참여한 항목 금액 ÷ 참여자 수. 낸 돈 = 자기가 계산한 항목 + 보낸 납입. 순액 = 낸 돈 − 부담. 양수면 받을 사람, 음수면 줄 사람.
function uniq_(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }
function groupCalc_(g, items, pays) {
  var members = uniq_(split_(g['참여자']));   // 같은 이름을 두 번 적어도 한 사람으로
  var paid = {}, share = {}, net = {};
  members.forEach(function (m) { paid[m] = 0; share[m] = 0; });
  var total = 0;
  items.forEach(function (it) {
    var amt = amount_(it['금액']); total += amt;
    var who = String(it['낸사람'] || '').trim(); if (who) { if (paid[who] === undefined) { paid[who] = 0; share[who] = 0; } paid[who] += amt; }
    var parts = uniq_(split_(it['참여자'])); if (!parts.length) parts = members;
    parts.forEach(function (m) { if (share[m] === undefined) { paid[m] = 0; share[m] = 0; } share[m] += amt / parts.length; });
  });
  pays.forEach(function (p) { var a = amount_(p['금액']); if (paid[p['보낸사람']] !== undefined) paid[p['보낸사람']] += a; if (paid[p['받는사람']] !== undefined) paid[p['받는사람']] -= a; });
  Object.keys(paid).forEach(function (m) { net[m] = Math.round(paid[m] - (share[m] || 0)); });
  // 누가 누구에게: 가장 많이 줄 사람 → 가장 많이 받을 사람 (greedy)
  var debt = Object.keys(net).filter(function (m) { return net[m] < 0; }).map(function (m) { return { m: m, v: -net[m] }; }).sort(function (a, b) { return b.v - a.v; });
  var cred = Object.keys(net).filter(function (m) { return net[m] > 0; }).map(function (m) { return { m: m, v: net[m] }; }).sort(function (a, b) { return b.v - a.v; });
  var transfers = []; var i = 0, j = 0;
  while (i < debt.length && j < cred.length) { var x = Math.min(debt[i].v, cred[j].v); if (x > 0) transfers.push({ from: debt[i].m, to: cred[j].m, amount: x }); debt[i].v -= x; cred[j].v -= x; if (debt[i].v <= 0) i++; if (cred[j].v <= 0) j++; }
  return { members: Object.keys(paid), total: total, paid: paid, share: share, net: net, transfers: transfers, count: items.length };
}
function groupsRead_() {
  var items = tabRead_(SHEET_GRPI, GICOLS), pays = tabRead_(SHEET_GRPP, GPCOLS);
  return tabRead_(SHEET_GRP, GCOLS).map(function (g) {
    var its = items.filter(function (it) { return it['모임id'] === g.id; }).sort(function (a, b) { return a['일자'] < b['일자'] ? -1 : 1; });
    var ps = pays.filter(function (p) { return p['모임id'] === g.id; });
    return Object.assign({}, g, { items: its, payments: ps, calc: groupCalc_(g, its, ps) });
  }).sort(function (a, b) { return a['날짜'] < b['날짜'] ? 1 : -1; });
}
function groupSave_(item) {
  var o = {}; GCOLS.forEach(function (c) { o[c] = item[c] === undefined || item[c] === null ? '' : item[c]; });
  o['이름'] = String(o['이름'] || '').trim(); if (!o['이름']) throw new Error('모임 이름을 입력하세요');
  o['참여자'] = uniq_(split_(o['참여자'])).join(','); if (!o['참여자']) throw new Error('참여자를 쉼표로 넣으세요');
  o['날짜'] = day_(o['날짜']) || isoLocal_(new Date()).substring(0, 10);
  o['상태'] = o['상태'] === '마감' ? '마감' : '진행'; o['메모'] = String(o['메모'] || '').trim();
  return tabUpsert_(SHEET_GRP, GCOLS, o, 'g');
}
function groupItemSave_(item) {
  var o = {}; GICOLS.forEach(function (c) { o[c] = item[c] === undefined || item[c] === null ? '' : item[c]; });
  if (!tabRead_(SHEET_GRP, GCOLS).some(function (g) { return g.id === o['모임id']; })) throw new Error('모임을 먼저 만드세요');
  o['금액'] = amount_(o['금액']); if (o['금액'] <= 0) throw new Error('금액을 입력하세요');
  o['항목'] = String(o['항목'] || '').trim() || '항목'; o['낸사람'] = String(o['낸사람'] || '').trim();
  o['참여자'] = uniq_(split_(o['참여자'])).join(','); o['일자'] = day_(o['일자']) || isoLocal_(new Date()).substring(0, 10); o['메모'] = String(o['메모'] || '').trim();
  return tabUpsert_(SHEET_GRPI, GICOLS, o, 'gi');
}
function groupPaySave_(item) {
  var o = {}; GPCOLS.forEach(function (c) { o[c] = item[c] === undefined || item[c] === null ? '' : item[c]; });
  if (!tabRead_(SHEET_GRP, GCOLS).some(function (g) { return g.id === o['모임id']; })) throw new Error('모임을 먼저 만드세요');
  o['금액'] = amount_(o['금액']); if (o['금액'] <= 0) throw new Error('금액을 입력하세요');
  if (!o['보낸사람'] || !o['받는사람'] || o['보낸사람'] === o['받는사람']) throw new Error('보낸 사람과 받는 사람을 확인하세요');
  o['일자'] = day_(o['일자']) || isoLocal_(new Date()).substring(0, 10); o['메모'] = String(o['메모'] || '').trim();
  return tabUpsert_(SHEET_GRPP, GPCOLS, o, 'gp');
}
function groupDelete_(id) {
  tabRead_(SHEET_GRPI, GICOLS).filter(function (it) { return it['모임id'] === id; }).forEach(function (it) { tabDelete_(SHEET_GRPI, it.id); });
  tabRead_(SHEET_GRPP, GPCOLS).filter(function (p) { return p['모임id'] === id; }).forEach(function (p) { tabDelete_(SHEET_GRPP, p.id); });
  return tabDelete_(SHEET_GRP, id);
}

// ---------------------------------------------------------------- 옛 탭 → 새 탭 이관 (시트 메뉴)
// 세이프 박스 탭: "연번 | 연도 | 날짜 | 항목 | 금액 | 메모" 블록을 통장거래로. 항목(지민비상금/공금)이 통장 이름이 된다. 음수 = 출금.
function migrateSafeBox(force) { try { return migrateSafeBoxRun_(force); } finally { dataChanged_(); } }   // 시트 메뉴·편집기·관리 액션에서 부른다. 끝나면(실패해도) 저장해 둔 읽기 응답을 버린다
function migrateSafeBoxRun_(force) {
  setup(); CACHE_ = {};
  var ss = SpreadsheetApp.getActive();
  var done = tabRead_(SHEET_ACCTX, ATCOLS).filter(function (t) { return String(t['메모']).indexOf('[이관]') === 0; });
  if (done.length && !force) throw new Error('이미 이관된 통장거래가 ' + done.length + '건 있습니다');
  if (done.length && force) done.forEach(function (t) { tabDelete_(SHEET_ACCTX, t.id); });
  var log = [];
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name.indexOf('세이프') < 0 && name.indexOf('비상금') < 0 && name.indexOf('통장') !== 0 && name.indexOf('목돈') < 0) return;
    if (APP_SHEETS_.indexOf(name) >= 0) return;
    var vals = sh.getDataRange().getValues();
    var head = -1, ci = {};
    for (var r = 0; r < vals.length && head < 0; r++) for (var c = 0; c < vals[r].length; c++) if (String(vals[r][c]).trim() === '연번') { var cand = blockHeaders_(vals[r], c); if (cand['항목'] !== undefined && cand['금액'] !== undefined) { head = r; ci = cand; break; } }
    if (head < 0) { log.push(name + ': 연번·항목·금액 머리글 없음'); return; }
    var n = 0, year = new Date().getFullYear(), prevDate = null;
    for (var i = head + 1; i < vals.length; i++) {
      var row = vals[i];
      var acc = String(row[ci['항목']] || '').trim(); var amt = cellAmount_(row[ci['금액']]);
      if (!acc || !amt) continue;
      var ym = /(\d{4})/.exec(String(row[ci['연도']] || '')); if (ym) year = Number(ym[1]);
      var rawD = row[ci['날짜']]; var mo = /^(\d{1,2})\s*월$/.exec(String(rawD || '').trim());
      var date = mo ? year + '-' + (mo[1].length < 2 ? '0' : '') + mo[1] + '-25T12:00:00' : (cellDate_(rawD, { year: year }, prevDate) || (year + '-01-01T12:00:00')); prevDate = date;
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
// 머리글 행에서 c0 부터 오른쪽으로 빈칸 전까지 {머리글: 열}. 같은 행에 표가 여러 개면 각 표만 따로 읽기 위해 쓴다 (먼저 나온 머리글 우선)
function blockHeaders_(row, c0) {
  var ci = {};
  for (var k = c0; k < row.length; k++) { var h = String(row[k]).trim(); if (!h) break; if (ci[h] === undefined) ci[h] = k; }
  return ci;
}
function accountByName_(name) {
  var hit = tabRead_(SHEET_ACC, ACOLS).filter(function (a) { return a['이름'] === name; })[0];
  if (hit) return hit;
  var owner = split_(cfg_('MEMBERS')).filter(function (m) { return name.indexOf(m) >= 0; })[0] || '';
  return accountSave_({ '이름': name, '종류': name.indexOf('비상') >= 0 ? '비상금' : (cfg_('LEDGER_TYPE') === 'personal' || name.indexOf('저축') >= 0 ? '저축' : '공금'), '소유': owner, '활성': 'Y' });
}
// "대출 상환 표" 탭: A열 이름표 / B열 값 (대출일자, 대출기관, 대출 원금, 이율, 상환방식, 요상환 금액, 월상환금) → 부채 탭
function migrateLoan(force) { try { return migrateLoanRun_(force); } finally { dataChanged_(); } }   // 시트 메뉴·편집기·관리 액션에서 부른다. 끝나면(실패해도) 저장해 둔 읽기 응답을 버린다
function migrateLoanRun_(force) {
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
function migrateReceipts(force) { try { return migrateReceiptsRun_(force); } finally { dataChanged_(); } }   // 시트 메뉴·편집기·관리 액션에서 부른다. 끝나면(실패해도) 저장해 둔 읽기 응답을 버린다
function migrateReceiptsRun_(force) {
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
  // 거래 하나에는 영수증 한 장만 붙인다 (itemsSave_ 는 통째 교체라, 두 장이 같은 거래를 집으면 나중 장이 앞 장의 품목을 지운다).
  // 같은 날짜 거래 가운데 총액·가맹점이 모두 같은 것 → 총액만 같은 것 → 가맹점만 같은 것 순으로 세 번 돌며, 다른 영수증이 이미 차지한 거래는 건너뛴다. 남는 거래가 없으면 '못 찾은 영수증'.
  // 세 번째(가맹점만 같은 것, 할인 등으로 총액이 다른 경우)는 영수증 총액과 거래 금액의 차이가 작은 짝부터 맺는다 (영수증이 적힌 순서대로 집으면, 같은 날 같은 가게에서 두 번 결제했을 때 두 장이 서로 바뀌어 붙는다).
  var ok = 0, miss = [], used = {}, pick = [];
  var nm = function (s) { return LedgerParser.normalizeMerchant(s); };
  var info = groups.map(function (g) { return { total: g.total || g.items.reduce(function (a, it) { return a + it['금액']; }, 0), dk: g.date ? g.date.substring(0, 10) : '', m: nm(g.store) }; });
  var free = function (o, q) { return !used[o.id] && o['유형'] === '지출' && String(o['일시']).substring(0, 10) === q.dk; };
  [function (o, q) { return o['금액'] === q.total && nm(o['가맹점']) === q.m; },
   function (o, q) { return o['금액'] === q.total; }].forEach(function (test) {
    groups.forEach(function (g, gi) {
      if (pick[gi] || !g.items.length) return;
      var q = info[gi];
      var hit = tx.filter(function (o) { return free(o, q) && test(o, q); })[0];
      if (hit) { used[hit.id] = true; pick[gi] = hit; }
    });
  });
  var pairs = [];
  groups.forEach(function (g, gi) {
    if (pick[gi] || !g.items.length) return;
    var q = info[gi];
    tx.forEach(function (o, ti) { if (free(o, q) && nm(o['가맹점']) === q.m) pairs.push([Math.abs(o['금액'] - q.total), gi, ti]); });
  });
  pairs.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; }).forEach(function (p) {
    var o = tx[p[2]];
    if (pick[p[1]] || used[o.id]) return;
    used[o.id] = true; pick[p[1]] = o;
  });
  groups.forEach(function (g, gi) {
    if (!g.items.length) return;
    var hit = pick[gi];
    if (!hit) { miss.push(info[gi].dk + ' ' + g.store + ' ' + info[gi].total.toLocaleString() + '원'); return; }
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
  // 받은 내용이 서버 코드가 아니면(빈 파일, 오류 페이지) 교체하지 않는다. 그대로 넣으면 웹앱도 자동 업데이트도 멈춘다
  if (!stamp || !/function\s+doPost\s*\(/.test(fresh.Code) || !/function\s+updateServer\s*\(/.test(fresh.Code) || fresh.Parser.indexOf('LedgerParser') < 0) throw new Error('GitHub 에서 받은 코드가 이상해 중단했습니다 (Code.gs 에 doPost·updateServer·SERVER_BUILD, Parser.gs 에 LedgerParser 가 있어야 합니다)');
  // 2) 현재 프로젝트 내용 (manifest 등은 그대로 두고 Code/Parser 만 바꾼다)
  var content = call('get', api + '/content');
  var files = content.files || [];
  var same = UPDATE_FILES.every(function (f) { var cur = files.filter(function (x) { return x.name === f[0]; })[0]; return cur && cur.source === fresh[f[0]]; });
  var reuse = 0;   // 이 빌드로 이미 만들어 둔 버전 번호 (있으면 새 버전을 만들지 않는다)
  if (same && !force) {
    // 코드가 같아도 웹앱 배포가 이 빌드로 만든 버전인지 확인한다 (버전 설명에 "v3 2026-11-04e " 처럼 빌드가 적혀 있다).
    // 지난 실행이 코드 교체 뒤 버전 만들기·배포 바꾸기에서 실패했으면 코드는 이미 새것이라, 예전에는 계속 "이미 최신"이라며 웹앱을 옛 버전에 두었다 → 그 단계만 다시 한다.
    // 그때 만들어 둔 버전이 있으면 그 버전을 쓴다 (배포 바꾸기가 계속 실패해도 버전이 한 시간에 하나씩 늘지 않게).
    // 배포된 버전이 자동 업데이트가 만든 것이 아니거나(손으로 만든 버전) 확인하지 못하면(API 오류) 전처럼 최신으로 본다.
    var stale = false;
    try {
      var mark = 'v' + newVer + ' ' + stamp + ' ', top = 0;
      // true = 이 빌드로 만든 버전, false = 자동 업데이트가 다른 빌드로 만든 버전, null = 알 수 없음 (손으로 만든 버전, 없는 버전, 확인 실패)
      var made = function (n) { try { var desc = String(call('get', api + '/versions/' + n).description || ''); return desc.indexOf(mark) >= 0 ? true : (desc.indexOf('자동 업데이트 v') >= 0 ? false : null); } catch (e) { return null; } };
      (call('get', api + '/deployments').deployments || []).forEach(function (d) {
        var n = d.deploymentConfig && d.deploymentConfig.versionNumber; if (!n) return;
        var hit = made(n); top = Math.max(top, n);
        if (hit) reuse = Math.max(reuse, n); else if (hit === false) stale = true;
      });
      if (stale) for (var pn = top + 1; pn <= top + 10; pn++) if (made(pn)) reuse = pn;
    } catch (e) { stale = false; }
    if (!stale) { log.push('이미 최신입니다. 바꾼 것 없음'); Logger.log(log.join('\n')); return log; }
    log.push('코드는 최신인데 웹앱 배포가 옛 버전입니다 → 버전·배포만 다시');
  } else {
    var known = {};
    files = files.map(function (x) { if (fresh[x.name] !== undefined) { known[x.name] = true; return { name: x.name, type: 'SERVER_JS', source: fresh[x.name] }; } return { name: x.name, type: x.type, source: x.source }; });
    UPDATE_FILES.forEach(function (f) { if (!known[f[0]]) files.push({ name: f[0], type: 'SERVER_JS', source: fresh[f[0]] }); });
    if (!files.some(function (x) { return x.type === 'JSON'; })) throw new Error('appsscript.json(manifest) 을 찾지 못해 중단');
    call('put', api + '/content', { files: files });
    log.push('코드 교체: ' + UPDATE_FILES.map(function (f) { return f[0]; }).join(', '));
  }
  // 3) 새 버전 (이 빌드로 만들어 둔 버전이 있으면 그 버전)
  var ver = reuse ? { versionNumber: reuse } : call('post', api + '/versions', { description: '자동 업데이트 v' + newVer + ' ' + stamp + ' ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') });
  log.push((reuse ? '만들어 둔 버전 ' : '새 버전 ') + ver.versionNumber);
  // 4) 기존 웹앱 배포(HEAD 제외)를 새 버전으로
  var deps = (call('get', api + '/deployments').deployments || []).filter(function (d) { return d.deploymentConfig && d.deploymentConfig.versionNumber; });
  if (!deps.length) throw new Error('배포가 없습니다. 편집기에서 배포 → 새 배포(웹 앱) 를 한 번 해 두세요');
  deps.forEach(function (d) {
    if (d.deploymentConfig.versionNumber === ver.versionNumber) return;   // 이미 이 버전
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
// 자동 업데이트를 잠시 끄는 스위치: 설정 탭에 AUTO_UPDATE / off 를 적으면 매시간 실행(updateServerAuto)은 아무것도 하지 않고 끝난다.
// 새 서버가 문제여서 "배포 관리"에서 앞 버전으로 되돌려 둔 동안, 자동 업데이트가 한 시간 안에 다시 새 버전으로 바꿔 놓지 않게 하는 용도다.
// 줄이 없거나 비어 있거나 다른 값이면 켜짐 (기본). 시트 메뉴·API 의 수동 "서버 업데이트"(updateServer)는 이 값과 상관없이 동작한다. 설정을 읽지 못하면 그 시간은 건너뛴다.
function autoUpdateOff_() { return /^(off|false|no|0|끔|꺼짐)$/i.test(String(cfg_('AUTO_UPDATE') || '').trim()); }
function updateServerAuto() {
  try {
    CACHE_ = {};
    if (autoUpdateOff_()) { Logger.log('자동 업데이트 꺼짐: 설정 탭의 AUTO_UPDATE 가 off 입니다. 다시 켜려면 그 값을 지우세요'); return; }
    updateServer(false);
  } catch (e) { Logger.log('자동 업데이트 실패: ' + e); }
}

// ================================================================ 관리 액션 (PIN 으로 보호. 앱이 아니라 운영자가 API 로 쓴다)
// migrate: what = legacy | safebox | loan | receipts | fixed, force = true 면 다시.  setConfig: 설정 탭 값 바꾸기 (PIN·LLM_* 제외).  updateServer: GitHub 최신 코드로 자기 갱신.
function admin_(req) {
  switch (req.action) {
    case 'migrate': {
      var fn = { legacy: migrateLegacy, safebox: migrateSafeBox, loan: migrateLoan, receipts: migrateReceipts, fixed: migrateFixedCosts }[req.what];
      if (!fn) throw new Error('what 은 legacy | safebox | loan | receipts | fixed');
      return { ok: true, log: fn(req.force === 'discard' ? 'discard' : !!req.force) };   // 'discard' 는 legacy 재이관에서 "앱에서 고친 이관 행을 버려도 된다"는 뜻 (migrateLegacy). 다른 이관은 true 와 같다
    }
    case 'setConfig': {
      var key = String(req.key || '').trim();
      if (!key || /^(PIN$|LLM_)/.test(key)) throw new Error('바꿀 수 없는 키');   // 비밀(PIN)과 밖으로 보내는 주소·키(LLM_ENDPOINT·LLM_KEY·LLM_MODEL)는 시트의 설정 탭에서만 바꾼다
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
      var all = sh.getRange(2, 1, last - 1, RCOLS.length);
      var vals = all.getValues();
      var drop = vals.map(function (row) { return !!(row[0] && String(row[RCOL['메모']]).indexOf(pre) === 0); });   // 지울 줄은 값을 다듬기 전에 고른다
      var keep = textRows_(vals, all.getDisplayValues(), REC_TEXT_RANGES_, RCOL).filter(function (row, i) { return !drop[i]; });
      all.clearContent();
      if (keep.length) { textFormat_(sh, REC_TEXT_RANGES_, RCOL, 2, keep.length); sh.getRange(2, 1, keep.length, RCOLS.length).setValues(keep); }   // 남는 줄이 위로 당겨져 다시 쓰인다 → 글자 서식을 먼저 건다 (removeMigratedRows_ 와 같다)
      CACHE_.rec = null;
      return { ok: true, deleted: vals.length - keep.length, remaining: keep.length };
    }
    case 'health': return { ok: true, version: API_VERSION, build: SERVER_BUILD, autoUpdate: autoUpdateOff_() ? 'off' : 'on', tabs: SpreadsheetApp.getActive().getSheets().map(function (s) { return { name: s.getName(), rows: s.getLastRow(), cols: s.getLastColumn() }; }), triggers: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }) };
    case 'readTab': {   // 운영자용: 탭 내용을 그대로 읽는다 (옛 탭 점검·이관 설계에 씀). 표시값(displayValues) 기준, 빈 행은 뺀다
      var sh = SpreadsheetApp.getActive().getSheetByName(String(req.name || ''));
      if (!sh) throw new Error('탭 없음: ' + req.name);
      var lr = sh.getLastRow(), lc = sh.getLastColumn(); if (!lr || !lc) return { ok: true, name: req.name, rows: [] };
      var r0 = Math.max(1, Number(req.from) || 1), n = Math.min(lr - r0 + 1, Number(req.limit) || 400);
      var vals = sh.getRange(r0, 1, n, lc).getDisplayValues();
      var out = []; vals.forEach(function (row, i) { if (row.some(function (c) { return c !== ''; })) out.push([r0 + i].concat(row)); });
      if (String(req.name) === SHEET_CFG) out.forEach(function (row) { if (/^(PIN|LLM_KEY)$/.test(String(row[1]).trim()) && row[2] !== '') row[2] = '(가림)'; });   // 설정 탭의 비밀 값은 돌려주지 않는다
      return { ok: true, name: req.name, lastRow: lr, lastCol: lc, rows: out };
    }
  }
  return null;
}

// "고정지출비용" 표 → 고정 탭. 머리글에 카테고리·금액과 (지출처 또는 지출 일자) 가 있는 블록을 찾는다.
// 이름 = 지출처(없으면 카테고리), 일 = "매월 25일" 에서, 소유 = 블록 위쪽 6행 안에 멤버 이름이 있으면 그 사람. 같은 이름·금액이 이미 있으면 건너뜀.
function migrateFixedCosts(force) { try { return migrateFixedCostsRun_(force); } finally { dataChanged_(); } }   // 시트 메뉴·편집기·관리 액션에서 부른다. 끝나면(실패해도) 저장해 둔 읽기 응답을 버린다
function migrateFixedCostsRun_(force) {
  setup(); CACHE_ = {};
  var ss = SpreadsheetApp.getActive();
  var members = split_(cfg_('MEMBERS')); var type = cfg_('LEDGER_TYPE'); var startDay = startDay_();
  var have = readRecurring_();
  var log = [], n = 0, skipped = 0;
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (APP_SHEETS_.indexOf(name) >= 0) return;
    if (/\d{2,4}\s*년/.test(name)) return;   // 월별 기록 탭(2024년, 26년 1월 …) 안의 고정지출 표는 그 달의 지출 기록이지 템플릿이 아니다
    var vals = sh.getDataRange().getValues();
    for (var r = 0; r < vals.length; r++) {
     var starts = []; for (var c0 = 0; c0 < vals[r].length; c0++) { var hh = String(vals[r][c0]).trim(); if (hh === '연번' || (hh === '카테고리' && (c0 === 0 || !String(vals[r][c0 - 1]).trim()))) starts.push(c0); }
     for (var si = 0; si < starts.length; si++) {
      var ci = blockHeaders_(vals[r], starts[si]);
      var cat = ci['카테고리'], amt = ci['금액'], store = ci['지출처'] !== undefined ? ci['지출처'] : ci['구매처'];
      var dayCol = ci['지출 일자'] !== undefined ? ci['지출 일자'] : (ci['예상 지출일자'] !== undefined ? ci['예상 지출일자'] : ci['지출일자']);
      // 고정지출 표만: 지출처 열이 있고, 거래 표(지출일자·구매처·세부내역·항목·결제인)가 아니어야 한다
      if (cat === undefined || amt === undefined || ci['지출처'] === undefined) continue;
      if (ci['지출일자'] !== undefined || ci['구매처'] !== undefined || ci['세부내역'] !== undefined || ci['항목'] !== undefined || ci['결제인'] !== undefined) continue;
      var owner = members[0];
      // 표 위쪽(같은 열 범위)에서 멤버 이름을 찾는다. 두 사람 표가 나란히 있으면 각자 자기 표의 제목을 본다
      var cEnd = Math.max.apply(null, Object.keys(ci).map(function (k) { return ci[k]; }));
      for (var up = r - 1; up >= 0 && !(up < r - 12); up--) { var line = vals[up].slice(Math.max(0, starts[si] - 1), cEnd + 2).join(' '); var hit = members.filter(function (m) { return line.indexOf(m) >= 0; })[0]; if (hit) { owner = hit; break; } }
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
        saveRecurring_({ '유형': '지출', '이름': itemName, '금액': amount, '카테고리': category, '결제인': owner, '일': day, '계획': 'Y', '활성': 'Y', '메모': memo, '분담': type === 'shared' ? owner : '' });
        n++; cnt++;
      }
      if (cnt) log.push(name + ' (' + owner + '): ' + cnt + '건');
     }
    }
  });
  log.push('고정 항목 ' + n + '건 추가' + (skipped ? ', 이미 있어 건너뜀 ' + skipped + '건' : ''));
  if (n) log.push('앱 → 더보기 → 고정 항목에서 금액·날짜를 확인하고, 홈의 "거래에 반영"으로 이번 사이클에 넣으세요.');
  Logger.log(log.join('\n'));
  return log;
}
function migrateFixedCostsMenu() { menuRun_('고정지출 표 → 고정 항목 이관', function () { return migrateFixedCosts(false); }); }
