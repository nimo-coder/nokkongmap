/* =====================================================================
   노꽁 제보 수신 서버 v3.1 — Google Apps Script 웹앱 (server/Code.gs)   2026-11-18
   v3.1: 제보 종류는 hotspot(무단투기 현장)·bin(구청 꽁초함) 둘뿐('need' 사각지대 항목 삭제), 사진은 종류와 관계없이 필수
   역할: 현장 사진 제보 JSON 받기 → 검증·봇 방지·횟수 제한 → 사진을 비공개 드라이브에 저장
         → AI 객체 탐지(Roboflow Serverless API)로 꽁초 개수·밀집도 추정 → 시트 기록 → 결과 반환
         + 관리자 대시보드 시트 자동 생성(buildDashboard) + 주간 리포트 메일(sendWeeklyReport)
   비밀값(API 키·시크릿)은 전부 '스크립트 속성'에만 둡니다. 브라우저 코드(app.js)에는 어떤 키도 없습니다.

   배포 순서
   1. 구글 시트 새로 만들기(공유: 링크 공개 금지, 팀원만 편집자로 초대) → 확장 프로그램 > Apps Script → 이 파일 전체 붙여넣기 → 저장
   2. 프로젝트 설정(톱니) > 스크립트 속성
        SHEET_ID             시트 URL 의 /d/ 와 /edit 사이 문자열
        DRIVE_FOLDER_ID      (권장) 사진 저장 폴더 ID. 폴더 공유는 '제한됨'으로. 비우면 사진은 AI 분석에만 쓰고 저장하지 않음
        AI_PROVIDER          none | roboflow
        ROBOFLOW_MODEL       예: nokkong-butts/3   (Roboflow 프로젝트의 Deploy 탭 > Model ID)
        ROBOFLOW_API_KEY     Roboflow Settings > API Keys 의 Private API Key
        ROBOFLOW_CONFIDENCE  (선택) 기본 0.4
        DENSITY_THRESHOLDS   (선택) "5,15" → 1~5 낮음, 6~15 보통, 16+ 높음
        PHOTO_REQUIRED       (선택) true(기본) | false  — 모든 제보(핫스팟·구청 꽁초함)에 사진 필수 여부
        DAILY_MAX            (선택) 하루 최대 제보 수. 기본 500
        TURNSTILE_SECRET     (선택) Cloudflare Turnstile Secret Key. app.js 의 TURNSTILE_SITE_KEY 와 짝
        ADMIN_EMAIL          (선택) 주간 리포트 받을 메일. 쉼표로 여러 명
   3. 에디터에서 selfTest 를 한 번 실행해 권한 승인 → setupTriggers 를 한 번 실행(대시보드 매일 07:00 갱신, 월요일 09:00 주간 메일)
   4. 배포 > 새 배포 > 웹 앱 → 실행 사용자 '나', 액세스 권한 '모든 사용자' → URL 을 app.js CONFIG.REPORT_ENDPOINT 에 붙여넣기
      코드를 고치면 '배포 관리 > 새 버전' 으로 다시 배포해야 반영됩니다.
   ===================================================================== */

var LIMITS = {
  NAME_MAX: 40,
  BODY_MAX_BYTES: 1.5 * 1024 * 1024,     // 사진 600KB → base64 약 800KB
  PER_MIN_PER_DEVICE: 2,
  DAILY_MAX_DEFAULT: 500,
  IMAGE_MIN_BYTES: 3 * 1024,             // 너무 작은 '사진'은 실제 촬영이 아닐 가능성
};
var BOUNDS = { minLat: 37.595, maxLat: 37.715, minLng: 127.02, maxLng: 127.14 };   // 노원구 대략 경계
var SHEET_NAME = "reports_v3", DASH_NAME = "dashboard";
var HEADER = ["timestamp", "id", "type", "name", "lat", "lng", "takenAt", "takenSrc", "hour", "weekday", "hasPhoto", "photoFileId", "aiCount", "aiDensity", "aiStatus", "aiRaw", "device", "status", "reviewer", "note"];
var COL = {}; HEADER.forEach(function (k, i) { COL[k] = i; });

function doGet() {
  // 조회 API 는 일부러 없습니다. 제보 내용은 시트에서만 봅니다.
  return json_({ ok: true });
}

function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  try {
    var raw = (e && e.postData && e.postData.contents) || "";
    if (!raw) return json_({ ok: false, error: "empty" });
    if (raw.length > LIMITS.BODY_MAX_BYTES) return json_({ ok: false, error: "too_large" });
    var p; try { p = JSON.parse(raw); } catch (err) { return json_({ ok: false, error: "bad_json" }); }

    // ---- 1. 검증 (브라우저에서 한 번, 여기서 한 번 더) ----
    var type = String(p.type || "");                                          // hotspot(무단투기 현장) | bin(구청 꽁초함). 'need'(사각지대)는 2026-11-18 삭제
    if (["hotspot", "bin"].indexOf(type) < 0) return json_({ ok: false, error: "bad_type" });
    var lat = Number(p.lat), lng = Number(p.lng);
    if (!(lat >= BOUNDS.minLat && lat <= BOUNDS.maxLat && lng >= BOUNDS.minLng && lng <= BOUNDS.maxLng)) return json_({ ok: false, error: "out_of_area" });
    lat = Math.round(lat * 1e5) / 1e5; lng = Math.round(lng * 1e5) / 1e5;
    var name = clean_(p.name, LIMITS.NAME_MAX) || (type === "bin" ? "꽁초함" : "무단투기 현장");
    if (type === "bin" && name.length < 2) return json_({ ok: false, error: "bad_name" });
    var clientId = String(p.id || "").replace(/[^a-z0-9\-]/gi, "").slice(0, 40);
    var device = String(p.device || "").replace(/[^a-z0-9]/gi, "").slice(0, 32);

    var imageB64 = "", hasPhoto = false;
    if (typeof p.image === "string" && p.image.indexOf("data:image/jpeg;base64,") === 0) {
      imageB64 = p.image.slice("data:image/jpeg;base64,".length).replace(/[^A-Za-z0-9+\/=]/g, "");
      hasPhoto = imageB64.length * 0.75 >= LIMITS.IMAGE_MIN_BYTES;
    }
    var photoRequired = (props.getProperty("PHOTO_REQUIRED") || "true") !== "false";   // ③ 모든 제보에 사진 필수(기본)
    if (photoRequired && !hasPhoto) return json_({ ok: false, error: "photo_required" });

    // 촬영 시각: 기기가 EXIF(또는 파일 시각)에서 읽어 보낸 값. 형식이 어긋나면 버리고 서버 시각 사용
    var takenAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(p.takenAt || "") ? p.takenAt : "";
    var takenSrc = ["exif", "file"].indexOf(p.takenSrc) >= 0 && takenAt ? p.takenSrc : "server";
    var now = new Date(), when = now;
    if (takenAt) {                                                           // 기기 시각은 한국 시간대로 간주
      var t = takenAt.split(/[-T:]/).map(Number);
      when = new Date(Date.UTC(t[0], t[1] - 1, t[2], t[3] - 9, t[4], t[5]));
    }
    if (isNaN(when.getTime()) || when > new Date(now.getTime() + 36e5) || when < new Date(2020, 0, 1)) { when = now; takenAt = ""; takenSrc = "server"; }
    var hour = Number(Utilities.formatDate(when, "Asia/Seoul", "H"));
    var weekday = Utilities.formatDate(when, "Asia/Seoul", "u");            // 1=월 … 7=일

    // ---- 2. 봇 방지 (Turnstile 시크릿이 설정된 경우에만) ----
    var secret = props.getProperty("TURNSTILE_SECRET");
    if (secret && !verifyTurnstile_(secret, p.cf)) return json_({ ok: false, error: "captcha" });

    // ---- 3. 횟수 제한 ----
    var cache = CacheService.getScriptCache();
    if (device) {
      var k = "dev:" + device, n = Number(cache.get(k) || 0);
      if (n >= LIMITS.PER_MIN_PER_DEVICE) return json_({ ok: false, error: "rate_limited" });
      cache.put(k, String(n + 1), 60);
    }
    var day = Utilities.formatDate(now, "Asia/Seoul", "yyyy-MM-dd");
    var dailyMax = Number(props.getProperty("DAILY_MAX") || LIMITS.DAILY_MAX_DEFAULT);
    var lock = LockService.getScriptLock(); lock.waitLock(5000);
    try {
      var dayKey = "count:" + day, cnt = Number(props.getProperty(dayKey) || 0);
      if (cnt >= dailyMax) return json_({ ok: false, error: "daily_limit" });
      props.setProperty(dayKey, String(cnt + 1));
    } finally { lock.releaseLock(); }

    // ---- 4. 사진 저장 (비공개 폴더) ----
    var photoFileId = "";
    if (hasPhoto) {
      var folderId = props.getProperty("DRIVE_FOLDER_ID");
      if (folderId) {
        try {
          var blob = Utilities.newBlob(Utilities.base64Decode(imageB64), "image/jpeg", "nokkong-" + day + "-" + (clientId || "x") + ".jpg");
          photoFileId = DriveApp.getFolderById(folderId).createFile(blob).getId();
        } catch (err) { photoFileId = "save_error"; }
      }
    }

    // ---- 5. AI 추정 (사진이 있을 때만, 서버에서만 호출) ----
    var ai = { count: null, density: null, status: hasPhoto ? "skipped" : "no_photo", raw: "" };
    if (hasPhoto && (props.getProperty("AI_PROVIDER") || "none") === "roboflow") {
      ai = roboflowCount_(imageB64, props);
      if (ai.count != null) ai.density = density_(ai.count, props);
    }

    // ---- 6. 기록 ----
    var sheet = getSheet_(props);
    var row = []; row[COL.timestamp] = now; row[COL.id] = clientId; row[COL.type] = type; row[COL.name] = name;
    row[COL.lat] = lat; row[COL.lng] = lng; row[COL.takenAt] = takenAt ? takenAt.replace("T", " ") : ""; row[COL.takenSrc] = takenSrc;
    row[COL.hour] = hour; row[COL.weekday] = weekday; row[COL.hasPhoto] = hasPhoto; row[COL.photoFileId] = photoFileId;
    row[COL.aiCount] = ai.count; row[COL.aiDensity] = ai.density || ""; row[COL.aiStatus] = ai.status; row[COL.aiRaw] = ai.raw;
    row[COL.device] = device; row[COL.status] = "new"; row[COL.reviewer] = ""; row[COL.note] = "";
    sheet.appendRow(row);
    return json_({ ok: true, id: clientId, ai: { count: ai.count, density: ai.density, status: ai.status } });
  } catch (err) {
    return json_({ ok: false, error: "server_error" });    // 내부 메시지는 돌려주지 않음
  }
}

/* ---------- AI: Roboflow Serverless Cloud API (객체 탐지) ----------
   모델: Roboflow 에서 TACO 의 cigarette 클래스 + 공릉동 사진을 라벨링해 학습·배포한 것, 또는 Universe 공개 모델 ID.
   요청: POST https://serverless.roboflow.com/{model}/{version}?confidence=0.4  (키는 Authorization 헤더, 이미지는 multipart file)
   응답: { predictions: [{ x, y, width, height, confidence, class, class_id }], image: { width, height } }                  */
function roboflowCount_(imageB64, props) {
  var model = props.getProperty("ROBOFLOW_MODEL"), key = props.getProperty("ROBOFLOW_API_KEY");
  if (!model || !key) return { count: null, density: null, status: "not_configured", raw: "" };
  var conf = Number(props.getProperty("ROBOFLOW_CONFIDENCE") || 0.4);
  try {
    var bytes = Utilities.base64Decode(imageB64);
    var url = "https://serverless.roboflow.com/" + model + "?confidence=" + conf;
    var res = UrlFetchApp.fetch(url, {
      method: "post", headers: { Authorization: "Bearer " + key },
      payload: { file: Utilities.newBlob(bytes, "image/jpeg", "report.jpg") },   // multipart/form-data
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {   // 구형 채널(쿼리 키 + base64 본문)로 한 번 더
      res = UrlFetchApp.fetch(url + "&api_key=" + encodeURIComponent(key), { method: "post", contentType: "application/x-www-form-urlencoded", payload: imageB64, muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) return { count: null, density: null, status: "http_" + res.getResponseCode(), raw: res.getContentText().slice(0, 200) };
    }
    var body = JSON.parse(res.getContentText());
    var preds = body.predictions || [];
    var butts = preds.filter(function (q) { return /cig|butt|꽁초/i.test(q["class"] || ""); });
    var classes = {}; preds.forEach(function (q) { classes[q["class"]] = 1; });
    if (!butts.length && preds.length && Object.keys(classes).length === 1) butts = preds;   // 단일 클래스 모델이면 전부 꽁초
    var conf2 = butts.length ? butts.reduce(function (s, q) { return s + (q.confidence || 0); }, 0) / butts.length : 0;
    return { count: butts.length, density: null, status: "ok",
      raw: JSON.stringify({ n: preds.length, butts: butts.length, meanConf: Math.round(conf2 * 100) / 100, img: body.image || null, ms: body.time || null }) };
  } catch (err) {
    return { count: null, density: null, status: "error", raw: String(err).slice(0, 120) };
  }
}
function density_(count, props) {
  var t = String(props.getProperty("DENSITY_THRESHOLDS") || "5,15").split(",").map(Number);
  if (!count) return "none";
  return count <= t[0] ? "low" : count <= t[1] ? "mid" : "high";
}

/* ---------- Cloudflare Turnstile 서버 검증 ---------- */
function verifyTurnstile_(secret, token) {
  if (!token) return false;
  try {
    var res = UrlFetchApp.fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "post", payload: { secret: secret, response: String(token).slice(0, 2048) }, muteHttpExceptions: true,
    });
    return JSON.parse(res.getContentText()).success === true;
  } catch (err) { return false; }
}

/* ---------- 시트 ---------- */
function getSs_(props) { var id = props.getProperty("SHEET_ID"); return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet(); }
function getSheet_(props) {
  var ss = getSs_(props), sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) { sh = ss.insertSheet(SHEET_NAME); }
  if (sh.getLastRow() === 0) { sh.appendRow(HEADER); sh.setFrozenRows(1); }
  return sh;
}
function clean_(s, max) {
  return String(s || "").replace(/<[^>]*>/g, "").replace(/https?:\/\/\S+/gi, "[링크]").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

/* =====================================================================
   관리자 대시보드 — 'dashboard' 시트를 다시 씁니다 (수동 실행 또는 매일 트리거)
   KPI · 일별 건수(30일) · 시간대별 · 요일별 · 핫스팟 후보 TOP 15(50m 격자) · 검토 대기 목록
   ===================================================================== */
function buildDashboard() {
  var props = PropertiesService.getScriptProperties(), ss = getSs_(props), src = getSheet_(props);
  var rows = src.getLastRow() > 1 ? src.getRange(2, 1, src.getLastRow() - 1, HEADER.length).getValues() : [];
  var S = summarize_(rows);
  var dash = ss.getSheetByName(DASH_NAME) || ss.insertSheet(DASH_NAME);
  dash.clear(); dash.getCharts().forEach(function (c) { dash.removeChart(c); });
  var out = [];
  out.push(["노꽁 제보 대시보드", "갱신 " + Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd HH:mm")]);
  out.push([]);
  out.push(["지표", "값"]);
  out.push(["전체 제보", S.total]); out.push(["최근 7일", S.last7]); out.push(["최근 30일", S.last30]);
  out.push(["현장 사진 제보(hotspot)", S.hotspots]); out.push(["꽁초함 위치 제보(bin)", S.bins]);
  out.push(["사진 첨부 비율", S.total ? Math.round(S.withPhoto / S.total * 100) + "%" : "-"]);
  out.push(["AI 추정 꽁초 평균(장당)", S.aiN ? Math.round(S.aiSum / S.aiN * 10) / 10 : "-"]);
  out.push(["밀집도 높음 제보", S.high]); out.push(["검토 대기(new)", S.pending]); out.push(["검증 완료(verified)", S.verified]);
  out.push([]);
  var dailyStart = out.length + 1;
  out.push(["날짜(최근 30일)", "제보 수", "AI 꽁초 합계"]);
  S.daily.forEach(function (d) { out.push([d.day, d.n, d.ai]); });
  var dailyEnd = out.length;
  out.push([]);
  out.push(["시간대", "제보 수"]); S.byHour.forEach(function (n, hr) { out.push([hr + "시", n]); });
  out.push([]);
  out.push(["요일", "제보 수"]); ["월", "화", "수", "목", "금", "토", "일"].forEach(function (w, i) { out.push([w, S.byWeekday[i + 1] || 0]); });
  out.push([]);
  out.push(["핫스팟 후보 TOP 15 (50m 격자)", "제보 수", "AI 꽁초 평균", "밀집도 높음", "마지막 제보", "대표 설명", "위도", "경도", "지도 링크"]);
  S.cells.slice(0, 15).forEach(function (c) {
    out.push([c.key, c.n, c.aiN ? Math.round(c.aiSum / c.aiN * 10) / 10 : "", c.high, c.last, c.name, c.lat, c.lng, "https://map.naver.com/p?c=" + c.lng + "," + c.lat + ",17,0,0,0,dh"]);
  });
  out.push([]);
  out.push(["검토 대기 최근 20건", "시각", "종류", "설명", "AI 꽁초", "밀집도", "사진", "행 번호"]);
  S.pendingRows.slice(0, 20).forEach(function (r) { out.push(["", r.ts, r.type, r.name, r.ai, r.density, r.photo ? "https://drive.google.com/file/d/" + r.photo + "/view" : "", r.rowNo]); });
  var width = Math.max.apply(null, out.map(function (r) { return r.length; }));
  out = out.map(function (r) { while (r.length < width) r.push(""); return r; });
  dash.getRange(1, 1, out.length, width).setValues(out);
  dash.getRange(1, 1).setFontWeight("bold").setFontSize(14);
  dash.setColumnWidth(1, 220);
  if (dailyEnd > dailyStart) {
    var chart = dash.newChart().setChartType(Charts.ChartType.COLUMN)
      .addRange(dash.getRange(dailyStart, 1, dailyEnd - dailyStart + 1, 2))
      .setPosition(3, 4, 0, 0).setOption("title", "일별 제보 수 (최근 30일)").setOption("legend", { position: "none" }).build();
    dash.insertChart(chart);
  }
}

function summarize_(rows) {
  var now = new Date(), d7 = new Date(now - 7 * 864e5), d30 = new Date(now - 30 * 864e5);
  var S = { total: 0, last7: 0, last30: 0, hotspots: 0, bins: 0, withPhoto: 0, aiSum: 0, aiN: 0, high: 0, pending: 0, verified: 0,
    byHour: [], byWeekday: {}, daily: [], cells: [], pendingRows: [] };
  for (var i = 0; i < 24; i++) S.byHour.push(0);
  var dayMap = {}, cellMap = {};
  for (var dd = 29; dd >= 0; dd--) { var k = Utilities.formatDate(new Date(now - dd * 864e5), "Asia/Seoul", "MM-dd"); dayMap[k] = { day: k, n: 0, ai: 0 }; }
  rows.forEach(function (r, idx) {
    var ts = r[COL.timestamp] instanceof Date ? r[COL.timestamp] : new Date(r[COL.timestamp]);
    if (isNaN(ts.getTime())) return;
    var status = String(r[COL.status] || "new");
    if (status === "rejected") return;
    S.total++; if (ts >= d7) S.last7++; if (ts >= d30) S.last30++;
    if (r[COL.type] === "hotspot") S.hotspots++; else S.bins++;
    if (r[COL.hasPhoto] === true || r[COL.hasPhoto] === "TRUE") S.withPhoto++;
    var ai = r[COL.aiCount]; if (ai !== "" && ai != null && !isNaN(Number(ai))) { S.aiSum += Number(ai); S.aiN++; }
    if (r[COL.aiDensity] === "high") S.high++;
    if (status === "new") { S.pending++; S.pendingRows.push({ ts: Utilities.formatDate(ts, "Asia/Seoul", "MM-dd HH:mm"), type: r[COL.type], name: r[COL.name], ai: ai, density: r[COL.aiDensity], photo: r[COL.photoFileId], rowNo: idx + 2 }); }
    if (status === "verified") S.verified++;
    var hr = Number(r[COL.hour]); if (hr >= 0 && hr < 24) S.byHour[hr]++;
    var wd = Number(r[COL.weekday]); S.byWeekday[wd] = (S.byWeekday[wd] || 0) + 1;
    var dk = Utilities.formatDate(ts, "Asia/Seoul", "MM-dd"); if (dayMap[dk]) { dayMap[dk].n++; dayMap[dk].ai += Number(ai) || 0; }
    if (r[COL.type] === "hotspot") {                                     // 50m 격자 집계 (위도 0.00045°, 경도 0.00057° ≈ 50m)
      var glat = Math.round(Number(r[COL.lat]) / 0.00045) * 0.00045, glng = Math.round(Number(r[COL.lng]) / 0.00057) * 0.00057;
      var ck = glat.toFixed(5) + "," + glng.toFixed(5);
      var c = cellMap[ck] || (cellMap[ck] = { key: ck, n: 0, aiSum: 0, aiN: 0, high: 0, last: "", lat: +glat.toFixed(5), lng: +glng.toFixed(5), name: "" });
      c.n++; if (ai !== "" && ai != null && !isNaN(Number(ai))) { c.aiSum += Number(ai); c.aiN++; } if (r[COL.aiDensity] === "high") c.high++;
      var dstr = Utilities.formatDate(ts, "Asia/Seoul", "yyyy-MM-dd"); if (dstr > c.last) c.last = dstr;
      if (!c.name && r[COL.name] && r[COL.name] !== "무단투기 현장") c.name = r[COL.name];
    }
  });
  S.daily = Object.keys(dayMap).map(function (k) { return dayMap[k]; });
  S.cells = Object.keys(cellMap).map(function (k) { return cellMap[k]; }).sort(function (a, b) { return b.n - a.n || b.aiSum - a.aiSum; });
  S.pendingRows.reverse();
  return S;
}

/* ---------- 주간 리포트 메일 (월요일 09:00 트리거) ---------- */
function sendWeeklyReport() {
  var props = PropertiesService.getScriptProperties(), to = props.getProperty("ADMIN_EMAIL");
  if (!to) return;
  buildDashboard();
  var src = getSheet_(props);
  var rows = src.getLastRow() > 1 ? src.getRange(2, 1, src.getLastRow() - 1, HEADER.length).getValues() : [];
  var S = summarize_(rows);
  var lines = [
    "노꽁 주간 제보 리포트 (" + Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd") + ")", "",
    "최근 7일 제보: " + S.last7 + "건 (전체 " + S.total + "건, 검토 대기 " + S.pending + "건)",
    "AI 추정 꽁초 평균: " + (S.aiN ? Math.round(S.aiSum / S.aiN * 10) / 10 : "-") + "개/장, 밀집도 높음 " + S.high + "건", "",
    "핫스팟 후보 TOP 5",
  ];
  S.cells.slice(0, 5).forEach(function (c, i) { lines.push((i + 1) + ". " + (c.name || c.key) + " — 제보 " + c.n + "건, AI 평균 " + (c.aiN ? Math.round(c.aiSum / c.aiN * 10) / 10 : "-") + ", 마지막 " + c.last); });
  var peak = S.byHour.indexOf(Math.max.apply(null, S.byHour));
  lines.push("", "가장 많은 시간대: " + peak + "시", "시트: " + getSs_(props).getUrl() + " (dashboard 탭)");
  MailApp.sendEmail({ to: to, subject: "[노꽁] 주간 제보 리포트 — 최근 7일 " + S.last7 + "건", body: lines.join("\n") });
}

/* ---------- 트리거: 한 번만 실행 ---------- */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (["buildDashboard", "sendWeeklyReport"].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("buildDashboard").timeBased().everyDays(1).atHour(7).inTimezone("Asia/Seoul").create();
  ScriptApp.newTrigger("sendWeeklyReport").timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).inTimezone("Asia/Seoul").create();
}

/* 에디터에서 한 번 실행: 권한 승인 + 설정 확인 */
function selfTest() {
  var props = PropertiesService.getScriptProperties();
  var sh = getSheet_(props);
  Logger.log("sheet ok: " + sh.getParent().getName() + " / rows " + sh.getLastRow());
  var folderId = props.getProperty("DRIVE_FOLDER_ID");
  if (folderId) Logger.log("folder ok: " + DriveApp.getFolderById(folderId).getName());
  Logger.log("AI_PROVIDER = " + (props.getProperty("AI_PROVIDER") || "none") + ", model = " + (props.getProperty("ROBOFLOW_MODEL") || "-"));
  Logger.log("TURNSTILE = " + (props.getProperty("TURNSTILE_SECRET") ? "on" : "off") + ", PHOTO_REQUIRED = " + (props.getProperty("PHOTO_REQUIRED") || "true"));
  buildDashboard(); Logger.log("dashboard ok");
}

/* 샘플 사진으로 AI 호출만 시험: 스크립트 속성 TEST_FILE_ID(드라이브 파일 ID)가 있으면 그 사진, 없으면 사진 폴더의 가장 최근 파일 → 로그에 개수 */
function testRoboflow() {
  var props = PropertiesService.getScriptProperties();
  var fileId = props.getProperty("TEST_FILE_ID");
  if (!fileId) {
    var it = DriveApp.getFolderById(props.getProperty("DRIVE_FOLDER_ID")).getFiles(), latest = null;
    while (it.hasNext()) { var f = it.next(); if (!latest || f.getDateCreated() > latest.getDateCreated()) latest = f; }
    if (!latest) { Logger.log("사진 폴더가 비어 있습니다. 사진을 하나 올리거나 TEST_FILE_ID 속성을 넣으세요."); return; }
    fileId = latest.getId(); Logger.log("시험 사진: " + latest.getName());
  }
  var b64 = Utilities.base64Encode(DriveApp.getFileById(fileId).getBlob().getBytes());
  var r = roboflowCount_(b64, props); r.density = r.count != null ? density_(r.count, props) : null;
  Logger.log(JSON.stringify(r));
}
