/* =====================================================================
   노꽁 제보 수신 서버 — Google Apps Script 웹앱 (server/Code.gs)
   역할: 제보 JSON(+축소 사진) 받기 → 검증·횟수 제한 → 시트에 한 줄 기록 → (선택) 사진을 비공개 드라이브 폴더에 저장
         → (선택) AI 추론 서버(Roboflow 등)에 사진을 보내 꽁초 개수 추정 → 결과 반환
   API 키는 이 파일이 아니라 '스크립트 속성'에만 둡니다. 브라우저 코드(app.js)에는 어떤 키도 없습니다.

   배포 순서
   1. 구글 시트 새로 만들기 → 1행에 헤더: timestamp | id | type | name | note | lat | lng | hasPhoto | photoFileId | aiCount | aiStatus | aiRaw | device | status
   2. 확장 프로그램 > Apps Script → 기본 Code.gs 내용을 지우고 이 파일 전체를 붙여넣기 → 저장
   3. 프로젝트 설정(톱니) > 스크립트 속성에 추가
        SHEET_ID         : 시트 URL 가운데 /d/와 /edit 사이의 긴 문자열
        DRIVE_FOLDER_ID  : (선택) 사진을 저장할 드라이브 폴더 ID. 비우면 사진은 AI 추론에만 쓰고 저장하지 않음
        AI_PROVIDER      : none | roboflow
        ROBOFLOW_MODEL   : (roboflow일 때) 예: nokkong-cigarette/2   ← Roboflow 프로젝트 ID/버전
        ROBOFLOW_API_KEY : (roboflow일 때) Roboflow Private API Key
        DAILY_MAX        : (선택) 하루 최대 제보 수. 기본 500
   4. 배포 > 새 배포 > 유형 '웹 앱' → 실행 사용자 '나', 액세스 권한 '모든 사용자' → 배포 → URL 복사
   5. app.js 의 CONFIG.REPORT_ENDPOINT 에 그 URL 붙여넣기
   코드를 고친 뒤에는 '배포 관리 > 새 버전'으로 다시 배포해야 반영됩니다.
   ===================================================================== */

var LIMITS = {
  NAME_MAX: 40, NOTE_MAX: 200,
  BODY_MAX_BYTES: 1.5 * 1024 * 1024,   // 요청 본문 상한 (사진 600KB → base64 약 800KB)
  PER_MIN_PER_DEVICE: 2,               // 같은 기기(무작위 토큰)에서 1분에 2건
  DAILY_MAX_DEFAULT: 500,
};
var BOUNDS = { minLat: 37.595, maxLat: 37.715, minLng: 127.02, maxLng: 127.14 }; // 노원구 대략 경계
var SHEET_NAME = "reports";

function doGet() {
  // 조회 기능은 일부러 없습니다. 제보 내용은 시트에서만 봅니다.
  return json_({ ok: true, service: "nokkong-report", time: new Date().toISOString() });
}

function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  try {
    var raw = (e && e.postData && e.postData.contents) || "";
    if (!raw) return json_({ ok: false, error: "empty" });
    if (raw.length > LIMITS.BODY_MAX_BYTES) return json_({ ok: false, error: "too_large" });

    var p; try { p = JSON.parse(raw); } catch (err) { return json_({ ok: false, error: "bad_json" }); }

    // ---- 검증 (브라우저에서 한 번, 여기서 한 번 더) ----
    var type = ["bin", "hotspot", "need"].indexOf(p.type) >= 0 ? p.type : null;
    if (!type) return json_({ ok: false, error: "bad_type" });
    var lat = Number(p.lat), lng = Number(p.lng);
    if (!(lat >= BOUNDS.minLat && lat <= BOUNDS.maxLat && lng >= BOUNDS.minLng && lng <= BOUNDS.maxLng)) return json_({ ok: false, error: "out_of_area" });
    lat = Math.round(lat * 1e5) / 1e5; lng = Math.round(lng * 1e5) / 1e5;   // 약 1m 단위로 저장
    var name = clean_(p.name, LIMITS.NAME_MAX), note = clean_(p.note, LIMITS.NOTE_MAX);
    if (name.length < 2) return json_({ ok: false, error: "bad_name" });
    var clientId = String(p.id || "").replace(/[^a-z0-9\-]/gi, "").slice(0, 40);
    var device = String(p.device || "").replace(/[^a-z0-9]/gi, "").slice(0, 32);

    // ---- 횟수 제한 ----
    var cache = CacheService.getScriptCache();
    if (device) {
      var k = "dev:" + device, n = Number(cache.get(k) || 0);
      if (n >= LIMITS.PER_MIN_PER_DEVICE) return json_({ ok: false, error: "rate_limited" });
      cache.put(k, String(n + 1), 60);
    }
    var day = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd");
    var dailyMax = Number(props.getProperty("DAILY_MAX") || LIMITS.DAILY_MAX_DEFAULT);
    var lock = LockService.getScriptLock(); lock.waitLock(5000);
    try {
      var dayKey = "count:" + day, cnt = Number(props.getProperty(dayKey) || 0);
      if (cnt >= dailyMax) return json_({ ok: false, error: "daily_limit" });
      props.setProperty(dayKey, String(cnt + 1));
    } finally { lock.releaseLock(); }

    // ---- 사진 ----
    var photoFileId = "", imageB64 = "", hasPhoto = false;
    if (p.image && typeof p.image === "string" && p.image.indexOf("data:image/jpeg;base64,") === 0) {
      imageB64 = p.image.slice("data:image/jpeg;base64,".length);
      hasPhoto = true;
      var folderId = props.getProperty("DRIVE_FOLDER_ID");
      if (folderId) {
        try {
          var blob = Utilities.newBlob(Utilities.base64Decode(imageB64), "image/jpeg", "nokkong-" + day + "-" + (clientId || "x") + ".jpg");
          photoFileId = DriveApp.getFolderById(folderId).createFile(blob).getId();   // 폴더 공유 설정을 따르므로 비공개 유지
        } catch (err) { photoFileId = "save_error"; }
      }
    }

    // ---- AI 추정 (사진이 있을 때만, 서버에서만 호출) ----
    var ai = { count: null, status: hasPhoto ? "skipped" : "no_photo", raw: "" };
    if (hasPhoto && (props.getProperty("AI_PROVIDER") || "none") === "roboflow") ai = roboflowCount_(imageB64, props);

    // ---- 기록 ----
    var sheet = getSheet_(props);
    sheet.appendRow([new Date(), clientId, type, name, note, lat, lng, hasPhoto, photoFileId, ai.count, ai.status, ai.raw, device, "new"]);
    return json_({ ok: true, id: clientId, ai: { count: ai.count, status: ai.status } });
  } catch (err) {
    return json_({ ok: false, error: "server_error" });   // 내부 메시지는 돌려주지 않음
  }
}

/* Roboflow Hosted Inference: POST base64 이미지 → predictions 배열. 꽁초 클래스만 셉니다.
   모델은 Roboflow에서 TACO의 cigarette 클래스 + 공릉동 사진으로 학습해 배포(Deploy)한 것을 씁니다. */
function roboflowCount_(imageB64, props) {
  var model = props.getProperty("ROBOFLOW_MODEL"), key = props.getProperty("ROBOFLOW_API_KEY");
  if (!model || !key) return { count: null, status: "not_configured", raw: "" };
  try {
    var url = "https://detect.roboflow.com/" + model + "?api_key=" + encodeURIComponent(key) + "&confidence=40&overlap=30";
    var res = UrlFetchApp.fetch(url, { method: "post", contentType: "application/x-www-form-urlencoded", payload: imageB64, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return { count: null, status: "http_" + res.getResponseCode(), raw: "" };
    var body = JSON.parse(res.getContentText());
    var preds = body.predictions || [];
    var butts = preds.filter(function (q) { return /cig|butt|꽁초/i.test(q["class"] || ""); });
    var conf = butts.length ? butts.reduce(function (s, q) { return s + (q.confidence || 0); }, 0) / butts.length : 0;
    return { count: butts.length, status: "ok", raw: JSON.stringify({ n: preds.length, butts: butts.length, meanConf: Math.round(conf * 100) / 100 }) };
  } catch (err) {
    return { count: null, status: "error", raw: "" };
  }
}

function getSheet_(props) {
  var id = props.getProperty("SHEET_ID");
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  if (sh.getLastRow() === 0) sh.appendRow(["timestamp", "id", "type", "name", "note", "lat", "lng", "hasPhoto", "photoFileId", "aiCount", "aiStatus", "aiRaw", "device", "status"]);
  return sh;
}

function clean_(s, max) {
  return String(s || "")
    .replace(/<[^>]*>/g, "")
    .replace(/https?:\/\/\S+/gi, "[링크]")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, max);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* 에디터에서 한 번 실행해 권한을 승인하고 시트·드라이브 연결을 확인하는 용도 */
function selfTest() {
  var props = PropertiesService.getScriptProperties();
  var sh = getSheet_(props);
  Logger.log("sheet ok: " + sh.getParent().getName() + " / rows " + sh.getLastRow());
  var folderId = props.getProperty("DRIVE_FOLDER_ID");
  if (folderId) Logger.log("folder ok: " + DriveApp.getFolderById(folderId).getName());
  Logger.log("AI_PROVIDER = " + (props.getProperty("AI_PROVIDER") || "none"));
}
