/*
 * LedgerParser — 토스 결제 화면 OCR 텍스트 / 결제 알림 문구를 거래 레코드로 바꾸는 규칙 파서.
 * LLM 없이 동작한다. 브라우저(PWA)와 Apps Script 양쪽에서 같은 파일을 쓴다.
 *   - web/assets/parser.js  (원본)
 *   - apps-script/Parser.gs (복사본, tools/sync.sh 로 동기화)
 */
var LedgerParser = (function () {
  'use strict';

  var STOP_WORDS = [
    '결제', '승인', '완료', '취소', '출금', '입금', '이체', '송금', '사용', '거래',
    '토스', '토스뱅크', '토스페이', '토스카드', '토스뱅크카드',
    '카드', '체크카드', '신용카드', '일시불', '할부', '누적', '잔액', '한도', '적립', '포인트', '할인', '캐시백',
    '영수증', '거래내역', '상세', '내역', '메모', '카테고리', '확인', '공유', '문의', '뒤로', '닫기', '더보기',
    '결제수단', '결제일', '승인번호', '가맹점', '매출전표', '전표',
    'LTE', '5G', 'KT', 'SKT', 'LG U+', 'Wi-Fi'
  ];

  var CARD_ISSUERS = ['KB국민', 'KB', '국민', '신한', '삼성', '현대', '롯데', '우리', '하나', 'NH농협', '농협', 'BC', '비씨', '씨티', '카카오뱅크', '케이뱅크', '토스뱅크', '토스'];

  function normalizeSpaces(s) {
    return String(s || '').replace(/[ \t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  }

  function toLines(text) {
    return String(text || '').split(/\r?\n/).map(normalizeSpaces).filter(function (l) { return l.length > 0; });
  }

  function parseNumber(s) {
    var n = parseInt(String(s).replace(/[^\d]/g, ''), 10);
    return isNaN(n) ? null : n;
  }

  // ---- 금액 ---------------------------------------------------------------
  // 후보: "-4,500원", "4,500 원", "₩4,500". 잔액/한도/적립 줄은 감점, 결제/승인 줄과 음수 표기는 가점.
  function parseAmount(text) {
    var lines = toLines(text);
    var best = null;
    var re = /(-|−|–)?\s*(?:₩\s*)?(\d{1,3}(?:,\d{3})+|\d{3,9})\s*(원|KRW|₩)?/g;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(line)) !== null) {
        var hasUnit = !!m[3] || /₩/.test(m[0]);
        if (!hasUnit) continue;                         // 단위 없는 숫자는 승인번호/전화번호일 수 있다
        var value = parseNumber(m[2]);
        if (!value || value < 10 || value > 100000000) continue;
        var score = 0;
        if (m[1]) score += 3;                           // 음수 표기 = 지출
        if (/결제|승인|출금|지출|사용/.test(line)) score += 2;
        if (/잔액|한도|적립|포인트|할인|캐시백|누적|이번 달|이번달|합계/.test(line)) score -= 5;
        if (best === null) score += 1;                  // 첫 등장 가점
        if (/^\s*(-|−|–)?\s*(?:₩\s*)?[\d,]+\s*원\s*$/.test(line)) score += 2; // 금액만 적힌 줄(토스 상세 화면의 큰 글자)
        var cand = { amount: value, line: i, score: score, negative: !!m[1] };
        if (best === null || cand.score > best.score) best = cand;
      }
    }
    return best;
  }

  // ---- 날짜 ---------------------------------------------------------------
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function toISO(y, mo, d, h, mi) {
    return y + '-' + pad2(mo) + '-' + pad2(d) + 'T' + pad2(h || 0) + ':' + pad2(mi || 0) + ':00';
  }

  function parseTime(text) {
    var m = /(오전|오후)?\s*(\d{1,2})\s*:\s*(\d{2})/.exec(text);
    if (!m) return null;
    var h = parseInt(m[2], 10), mi = parseInt(m[3], 10);
    if (m[1] === '오후' && h < 12) h += 12;
    if (m[1] === '오전' && h === 12) h = 0;
    if (h > 23 || mi > 59) return null;
    return { h: h, mi: mi };
  }

  // now: 기준 시각(Date). 연도 없는 날짜가 미래면 작년으로 본다.
  function parseDate(text, now) {
    now = now || new Date();
    var lines = toLines(text);
    var full = /(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*일?/;
    var short1 = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/;
    var short2 = /(^|[^\d:])(\d{1,2})[./](\d{1,2})(?![\d./])/;   // 01/01, 1.1 (시각 12:34 와 구분)
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/잔액|한도/.test(line)) continue;
      var m = full.exec(line);
      var y, mo, d;
      if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
      else if ((m = short1.exec(line))) { mo = +m[1]; d = +m[2]; }
      else if ((m = short2.exec(line))) { mo = +m[2]; d = +m[3]; }
      else continue;
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      if (!y) {
        y = now.getFullYear();
        var cand = new Date(y, mo - 1, d);
        if (cand.getTime() - now.getTime() > 2 * 86400000) y -= 1;
      }
      var t = parseTime(line) || parseTime(lines[i + 1] || '') || { h: 0, mi: 0 };
      return { iso: toISO(y, mo, d, t.h, t.mi), line: i, hasTime: !!(parseTime(line) || parseTime(lines[i + 1] || '')) };
    }
    return null;
  }

  // ---- 가맹점 -------------------------------------------------------------
  function isNoise(line) {
    if (line.length < 2 || line.length > 40) return true;
    if (/^[\d\s:.\-/%+,₩원]+$/.test(line)) return true;              // 숫자/기호만
    if (/\d{1,3}(,\d{3})+\s*원|\d+\s*원|₩/.test(line)) return true;    // 금액 줄
    if (/\d{4}\s*[.\-/년]\s*\d{1,2}|\d{1,2}\s*월\s*\d{1,2}\s*일|\d{1,2}:\d{2}/.test(line)) return true; // 날짜/시각
    for (var i = 0; i < STOP_WORDS.length; i++) {
      if (line === STOP_WORDS[i]) return true;
    }
    if (/^(결제|승인)\s*(완료|취소|내역|상세)?$/.test(line)) return true;
    if (/(결제|승인)\s*(완료|취소)/.test(line) && line.length <= 8) return true;
    if (/^(토스|토스뱅크|토스페이)/.test(line) && line.length <= 10) return true;
    if (/^\d{1,3}%$/.test(line)) return true;
    return false;
  }

  function parseMerchant(text, hints) {
    hints = hints || {};
    var lines = toLines(text);
    var skip = {};
    if (hints.amountLine != null) skip[hints.amountLine] = true;
    if (hints.dateLine != null) skip[hints.dateLine] = true;
    var cands = [];
    for (var i = 0; i < lines.length; i++) {
      if (skip[i]) continue;
      var l = lines[i].replace(/^[•·\-–—*>]+\s*/, '');
      if (isNoise(l)) continue;
      var score = 0;
      if (hints.amountLine != null && i < hints.amountLine) score += 2;     // 토스 상세 화면: 가맹점이 금액 위에 있다
      if (hints.amountLine != null && Math.abs(i - hints.amountLine) <= 2) score += 1;
      if (/[가-힣]/.test(l)) score += 1;
      if (/^[A-Z][A-Za-z\s&'.-]+$/.test(l) && l.length > 3) score += 1;      // 영문 브랜드명
      if (/님|안녕|이용해|감사합니다/.test(l)) score -= 3;
      cands.push({ name: l, line: i, score: score - i * 0.01 });            // 동점이면 위쪽 줄
    }
    if (cands.length === 0) return null;
    cands.sort(function (a, b) { return b.score - a.score; });
    return cands[0];
  }

  // ---- 가맹점명 정규화 ----------------------------------------------------
  function normalizeMerchant(name) {
    var s = String(name || '');
    s = s.replace(/\([^)]*\)/g, ' ');
    s = s.replace(/\[[^\]]*\]/g, ' ');
    s = s.replace(/(주식회사|\(주\)|㈜|유한회사|\(유\))/g, ' ');
    s = s.replace(/\s*[가-힣A-Za-z0-9]{1,8}점$/, '');            // "OO점" 지점명
    s = s.replace(/\s*(본점|직영점|지점)$/, '');
    s = s.replace(/[^\p{L}\p{N}]+/gu, ' ');
    s = normalizeSpaces(s).toLowerCase().replace(/ /g, '');
    return s;
  }

  // dict: { normalizedMerchant: category }, rules: [[keyword, category], ...]
  function guessCategory(merchant, dict, rules) {
    var key = normalizeMerchant(merchant);
    if (!key) return null;
    dict = dict || {};
    if (dict[key]) return { category: dict[key], how: 'exact' };
    var keys = Object.keys(dict);
    var bestKey = null;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.length < 2) continue;
      if (key.indexOf(k) >= 0 || k.indexOf(key) >= 0) {
        if (bestKey === null || k.length > bestKey.length) bestKey = k;
      }
    }
    if (bestKey) return { category: dict[bestKey], how: 'fuzzy' };
    rules = rules || [];
    for (var j = 0; j < rules.length; j++) {
      var kw = normalizeMerchant(rules[j][0]);
      if (kw && key.indexOf(kw) >= 0) return { category: rules[j][1], how: 'rule' };
    }
    return null;
  }

  // ---- 사이클 월 (예: 25일 시작 → 4월 25일~5월 24일 = "2024-04") ---------------
  function cycleMonth(dateIso, startDay) {
    startDay = startDay || 25;
    var d = new Date(dateIso);
    var y = d.getFullYear(), m = d.getMonth();
    if (d.getDate() < startDay) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
    return y + '-' + pad2(m + 1);
  }

  function cycleRange(cycle, startDay) {
    startDay = startDay || 25;
    var p = cycle.split('-');
    var start = new Date(+p[0], +p[1] - 1, startDay);
    var end = new Date(+p[0], +p[1], startDay);   // exclusive
    return { start: start, end: end };
  }

  // ---- 스크린샷 OCR 텍스트 → 거래 ------------------------------------------
  function parseScreenshot(text, opts) {
    opts = opts || {};
    var now = opts.now || new Date();
    var amount = parseAmount(text);
    var date = parseDate(text, now);
    var merchant = parseMerchant(text, { amountLine: amount && amount.line, dateLine: date && date.line });
    var confidence = 0;
    if (amount) confidence += 0.5;
    if (merchant) confidence += 0.3;
    if (date) confidence += 0.2;
    return {
      amount: amount ? amount.amount : null,
      merchant: merchant ? merchant.name : '',
      date: date ? date.iso : toISO(now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes()),
      dateGuessed: !date,
      type: amount && !amount.negative && /입금|수입|받았/.test(text) ? '수입' : '지출',
      confidence: confidence,
      raw: text
    };
  }

  // ---- 결제 알림 문구 → 거래 ---------------------------------------------
  // 예) "[토스] 스타벅스 4,500원 결제 완료"
  //     "KB국민카드 승인 홍*동 4,500원 일시불 01/01 12:34 스타벅스"
  //     "토스뱅크 체크카드 출금 4,500원 스타벅스 잔액 123,456원"
  function parseNotification(text, opts) {
    opts = opts || {};
    var now = opts.now || new Date();
    var t = normalizeSpaces(String(text || '').replace(/\r?\n/g, ' '));
    var amount = parseAmount(t);
    var date = parseDate(t, now);
    var rest = t;
    rest = rest.replace(/\[[^\]]*\]/g, ' ');
    rest = rest.replace(/(-|−|–)?\s*(?:₩\s*)?\d{1,3}(?:,\d{3})+\s*(원|KRW)?/g, ' ').replace(/(-|−|–)?\s*(?:₩\s*)?\d{3,9}\s*(원|KRW)/g, ' ');
    rest = rest.replace(/\d{4}\s*[.\-/년]\s*\d{1,2}\s*[.\-/월]\s*\d{1,2}\s*일?/g, ' ');
    rest = rest.replace(/\d{1,2}\s*월\s*\d{1,2}\s*일/g, ' ').replace(/(^|\s)\d{1,2}[./]\d{1,2}(?=\s|$)/g, ' ');
    rest = rest.replace(/(오전|오후)?\s*\d{1,2}:\d{2}(:\d{2})?/g, ' ');
    rest = rest.replace(/[가-힣]\*+[가-힣]?/g, ' ');                       // 마스킹된 이름 홍*동
    rest = rest.replace(/누적\s*\S*/g, ' ').replace(/잔액\s*\S*/g, ' ');
    for (var i = 0; i < CARD_ISSUERS.length; i++) {
      rest = rest.replace(new RegExp(CARD_ISSUERS[i] + '(카드|뱅크|페이)?', 'g'), ' ');
    }
    var words = rest.split(' ').filter(function (w) {
      if (!w) return false;
      if (STOP_WORDS.indexOf(w) >= 0) return false;
      if (/^(결제|승인|출금|입금|사용|이체)(완료|취소|되었습니다|됐어요|했어요)?$/.test(w)) return false;
      if (/^(완료|취소|일시불|체크|신용|해외|국내|승인번호|가맹점)$/.test(w)) return false;
      if (/^\d+(개월|회)$/.test(w)) return false;
      if (/^[\d\-:/.,()]+$/.test(w)) return false;
      return true;
    });
    var merchant = words.join(' ').trim();
    var cancelled = /취소/.test(t);
    var income = /입금|받았|수입/.test(t) && !/출금|결제|승인/.test(t);
    return {
      amount: amount ? amount.amount : null,
      merchant: merchant,
      date: date ? date.iso : toISO(now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes()),
      dateGuessed: !date,
      type: income ? '수입' : '지출',
      cancelled: cancelled,
      confidence: (amount ? 0.6 : 0) + (merchant ? 0.4 : 0),
      raw: text
    };
  }

  return {
    toLines: toLines,
    parseAmount: parseAmount,
    parseDate: parseDate,
    parseMerchant: parseMerchant,
    normalizeMerchant: normalizeMerchant,
    guessCategory: guessCategory,
    cycleMonth: cycleMonth,
    cycleRange: cycleRange,
    parseScreenshot: parseScreenshot,
    parseNotification: parseNotification
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LedgerParser;
