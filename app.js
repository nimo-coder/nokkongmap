/* =====================================================================
   노꽁 지도 app.js  v3.1 (2026-11-18)
   11/18 요구사항 5건 반영: ① 지도 위 '내 위치로 이동' 버튼 ② 길찾기를 카카오맵 → 네이버 지도(앱 스킴 + 웹 URL)로
   ③ 모든 제보에 사진 필수(없으면 전송 불가) ④ 제보 종류 라디오 2개 — '꽁초가 많이 버려져 있어요(핫스팟)' / '구청 꽁초함이 여기 있어요'
   ⑤ '꽁초함이 필요한 곳(사각지대)' 항목 삭제(기기에 남은 옛 제보는 핫스팟으로 변환). 그 밖에 v3.0 의 EXIF 촬영시각·위치 자동 입력,
   서버 AI 꽁초 개수·밀집도, QR 딥링크(#at=위도,경도 / #report), CSP 2단계, Turnstile(선택)은 그대로.
   보안 원칙: 브라우저 코드에 비밀값 없음(네이버 Client ID는 도메인 제한 공개키) · 사용자 입력은 textContent 로만 표시 · 내 위치는 전송하지 않음.
   ===================================================================== */
"use strict";

/* =========================================================
   1) 설정 — 이 블록만 고치면 됩니다
   ========================================================= */
const CONFIG = {
  // 네이버 클라우드 플랫폼 > Maps > Application 의 Client ID (ncpKeyId). 등록한 웹 서비스 URL에서만 동작하므로 공개돼도 됩니다.
  NAVER_KEY_ID: "wces4uwwx1",
  NAVER_KEY_PARAM: "ncpKeyId",            // 옛 AI·NAVER API 키면 "ncpClientId"

  // 제보 수신 서버(server/Code.gs 를 Apps Script 웹앱으로 배포한 URL). 비우면 제보가 이 기기에만 저장됩니다.
  REPORT_ENDPOINT: "https://script.google.com/macros/s/AKfycbykEtaaQ5VPv7vtapxOQjZDUGFpDl0lGp25xdj5ZhHhpaFhatiusYoF21HXa8CSAquB/exec",
  // 네이버 지도 앱 연동(URL Scheme)의 appname — 모바일 웹은 페이지 주소를 넣습니다
  APP_URL: "https://nimo-coder.github.io/nokkongmap",
  ME_ZOOM: 16,                            // '내 위치로 이동' 때 확대 수준
  // Cloudflare Turnstile 사이트 키(선택). 서버 스크립트 속성 TURNSTILE_SECRET 과 짝. 비우면 봇 방지 없이 동작.
  TURNSTILE_SITE_KEY: "",

  SHOW_DEMO: false,
  START: { lat: 37.6255, lng: 127.0800, zoom: 15 },        // 공릉동
  BOUNDS: { sw: [37.595, 127.02], ne: [37.715, 127.14] },  // 노원구 대략 경계
  MIN_ZOOM: 13,
  MAX_FIT_ZOOM: 17,

  REPORT_MIN_INTERVAL_MS: 60 * 1000,      // 브라우저 기준 제한. 서버에서도 한 번 더 제한
  REPORT_DAILY_MAX: 20,
  PHOTO_STALE_DAYS: 30,                   // 촬영일이 이보다 오래된 사진은 안내만 하고 받음

  IMAGE_MAX_EDGE: 1024,                   // 기기에서 축소 후 전송(재인코딩으로 EXIF 제거)
  IMAGE_QUALITY: 0.8,
  IMAGE_MAX_BYTES: 600 * 1024,

  NAME_MAX: 40,
  REQUEST_TIMEOUT_MS: 20000,

  // Leaflet(OSM 대체 지도) — 파일 무결성(SRI) 확인 후 실행
  LEAFLET_JS: { src: "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", integrity: "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" },
  LEAFLET_CSS: { href: "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", integrity: "sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" },
};

/* =========================================================
   2) 데이터
   data/points.js   → DATA     : 구청 자료·답사로 만든 꽁초함(bin)·흡연부스(booth)
   data/hotspots.js → HOTSPOTS : 제보를 팀이 검증해 올린 핫스팟. needBin=true 면 '꽁초함 설치 후보'
   localStorage                : 내 제보(mine). 이 기기에서만 보임
   ========================================================= */
const POINTS = (typeof DATA !== "undefined" ? DATA : []).filter(d => d && d.inScope !== false && d.type !== "hotspot");
const TEAM_HOTSPOTS = (typeof HOTSPOTS !== "undefined" ? HOTSPOTS : []).map(h => Object.assign({ type: "hotspot", verified: true }, h));
const DEMO = [
  { id: "demo-1", type: "bin", name: "예시 꽁초함 A", lat: 37.6262, lng: 127.0794, demo: true },
  { id: "demo-2", type: "bin", name: "예시 꽁초함 B", lat: 37.6239, lng: 127.0732, demo: true },
  { id: "demo-3", type: "hotspot", name: "예시 핫스팟", lat: 37.6281, lng: 127.0892, demo: true, count: 25, needBin: true },
];
const LABEL = { bin: "꽁", booth: "부", hotspot: "!", mine: "나" };
const TYPE_NAME = { bin: "꽁초함", booth: "흡연부스·흡연구역", hotspot: "무단투기 현장 제보" };
const REPORT_KINDS = [                               // 제보 종류 라디오 (④·⑤)
  { mode: "hotspot", label: "꽁초가 많이 버려져 있어요 (핫스팟)" },
  { mode: "bin",     label: "구청 꽁초함이 여기 있어요" },
];
const DENSITY_NAME = { low: "낮음", mid: "보통", high: "높음" };

/* =========================================================
   3) 공통 유틸 — DOM 생성(문자열 삽입 금지), 소독, 토스트
   ========================================================= */
const $ = id => document.getElementById(id);
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
function clean(s, max) {
  return String(s || "")
    .replace(/<[^>]*>/g, "")                 // 태그 제거
    .replace(/https?:\/\/\S+/gi, "[링크]")    // 주소 제거(스팸·피싱 방지)
    .replace(/[\u0000-\u001F\u007F]/g, " ")   // 제어문자 제거
    .replace(/\s+/g, " ").trim().slice(0, max);
}
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("toast"); t.textContent = msg; t.style.display = "block";
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.display = "none"; }, ms);
}
let noteTimer;
function mapNote(msg, ms = 8000) {           // ms = 0 이면 닫을 때까지 유지
  const n = $("mapnote"); n.textContent = msg || ""; n.style.display = msg ? "block" : "none";
  clearTimeout(noteTimer); if (msg && ms) noteTimer = setTimeout(() => { n.style.display = "none"; }, ms);
}
function fmtDist(m) { return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`; }
function fmtTaken(iso) { return iso ? iso.replace("T", " ").slice(0, 16) : ""; }
function localIso(ms) {                      // 기기 시각 → "YYYY-MM-DDTHH:MM:SS" (EXIF와 같은 형식, 시간대 없음)
  const d = new Date(ms), p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function haversine(a, b) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function inBounds(lat, lng) { const b = CONFIG.BOUNDS; return lat >= b.sw[0] && lat <= b.ne[0] && lng >= b.sw[1] && lng <= b.ne[1]; }
function pinHtml(cls, label) { return `<div class="pin ${cls}"><span>${label}</span></div>`; }   // 상수만 들어감
function loadScript(src, integrity) {
  return new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = src; s.async = true;
    if (integrity) { s.integrity = integrity; s.crossOrigin = "anonymous"; }
    s.onload = res; s.onerror = () => rej(new Error("script load failed: " + src));
    document.head.appendChild(s);
  });
}
function loadCss(href, integrity) {
  return new Promise(res => {
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = href;
    if (integrity) { l.integrity = integrity; l.crossOrigin = "anonymous"; }
    l.onload = res; l.onerror = res; document.head.appendChild(l);
  });
}
// CSP 가 무언가를 막으면 콘솔에 남깁니다(지도 공급자 도메인 누락 진단용).
document.addEventListener("securitypolicyviolation", e => console.warn("[노꽁] CSP 차단:", e.blockedURI, "(" + e.violatedDirective + ")"));

/* =========================================================
   4) 지도 어댑터 — 네이버 지도 API v3 (기본) / Leaflet+OSM (대체)
   ========================================================= */
function createNaverMap(el) {
  const N = window.naver.maps;
  const ll = (lat, lng) => new N.LatLng(lat, lng);
  const nmap = new N.Map(el, {
    center: ll(CONFIG.START.lat, CONFIG.START.lng), zoom: CONFIG.START.zoom, minZoom: CONFIG.MIN_ZOOM,
    maxBounds: new N.LatLngBounds(ll(...CONFIG.BOUNDS.sw), ll(...CONFIG.BOUNDS.ne)),
    zoomControl: true, zoomControlOptions: { position: N.Position.TOP_RIGHT },
    mapDataControl: false, scaleControl: false,
  });
  const icon = (html, w, h, ax, ay) => ({ content: html, size: new N.Size(w, h), anchor: new N.Point(ax, ay) });

  // 보정: SDK 가 컨테이너에 position:relative 를 inline 으로 써서 높이가 0 이 되는 레이아웃이면 부모를 채우도록 고침
  requestAnimationFrame(() => {
    if (el.clientHeight >= 50) return;
    el.style.width = "100%"; el.style.height = "100%";
    try { nmap.setSize(new N.Size(el.clientWidth, el.clientHeight)); } catch (e) {}
    console.warn("[노꽁] 지도 영역 높이가 0 이라 보정했습니다. index.html 의 #map CSS 를 확인하세요.");
  });
  // 감시: 12초 안에 타일이 하나도 그려지지 않으면 OSM으로 교체
  let tilesOk = false;
  try { N.Event.addListener(nmap, "tilesloaded", () => { tilesOk = true; }); } catch (e) {}
  setTimeout(() => {
    const imgs = Array.from(el.querySelectorAll("img"));
    const loaded = imgs.filter(i => i.complete && i.naturalWidth > 0).length;
    console.info("[노꽁] 네이버 지도 상태 — 타일 이미지 " + imgs.length + "개 중 " + loaded + "개 로드, 이벤트 " + (tilesOk ? "수신" : "없음"));
    if (!tilesOk && loaded === 0 && map && map.provider === "naver") switchToLeaflet("네이버 지도가 12초 안에 그려지지 않아 OpenStreetMap으로 표시합니다. F12 콘솔의 [노꽁] 메시지를 확인하세요.");
  }, 12000);

  return {
    provider: "naver",
    addMarker({ lat, lng, html, w = 26, hh = 26, ax = 13, ay = 26, title, onClick }) {
      const m = new N.Marker({ position: ll(lat, lng), map: nmap, title: title || "", icon: icon(html, w, hh, ax, ay) });
      if (onClick) N.Event.addListener(m, "click", onClick);
      return {
        setVisible: v => m.setVisible(!!v),
        setHtml: nh => m.setIcon(icon(nh, w, hh, ax, ay)),
        setPos: (la, ln) => m.setPosition(ll(la, ln)),
        remove: () => m.setMap(null),
      };
    },
    onClick(cb) { N.Event.addListener(nmap, "click", e => cb(e.coord.lat(), e.coord.lng())); },
    fitTwo(a, b) {
      nmap.fitBounds(new N.LatLngBounds(ll(Math.min(a.lat, b.lat), Math.min(a.lng, b.lng)), ll(Math.max(a.lat, b.lat), Math.max(a.lng, b.lng))), { top: 70, right: 50, bottom: 120, left: 50 });
      if (nmap.getZoom() > CONFIG.MAX_FIT_ZOOM) nmap.setZoom(CONFIG.MAX_FIT_ZOOM);
    },
    setView(lat, lng, zoom) { nmap.morph(ll(lat, lng), zoom); },
  };
}

async function createLeafletMap(el) {
  await loadCss(CONFIG.LEAFLET_CSS.href, CONFIG.LEAFLET_CSS.integrity);
  await loadScript(CONFIG.LEAFLET_JS.src, CONFIG.LEAFLET_JS.integrity);
  const L = window.L;
  const lmap = L.map(el, { zoomControl: false, minZoom: CONFIG.MIN_ZOOM, maxBounds: [CONFIG.BOUNDS.sw, CONFIG.BOUNDS.ne], maxBoundsViscosity: 1 })
    .setView([CONFIG.START.lat, CONFIG.START.lng], CONFIG.START.zoom);
  L.control.zoom({ position: "topright" }).addTo(lmap);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(lmap);
  const icon = (html, w, h, ax, ay) => L.divIcon({ className: "", html, iconSize: [w, h], iconAnchor: [ax, ay] });
  return {
    provider: "leaflet",
    addMarker({ lat, lng, html, w = 26, hh = 26, ax = 13, ay = 26, title, onClick }) {
      const m = L.marker([lat, lng], { icon: icon(html, w, hh, ax, ay), title: title || "" }).addTo(lmap);
      if (onClick) m.on("click", onClick);
      return {
        setVisible: v => { v ? m.addTo(lmap) : m.remove(); },
        setHtml: nh => m.setIcon(icon(nh, w, hh, ax, ay)),
        setPos: (la, ln) => m.setLatLng([la, ln]),
        remove: () => m.remove(),
      };
    },
    onClick(cb) { lmap.on("click", e => cb(e.latlng.lat, e.latlng.lng)); },
    fitTwo(a, b) { lmap.fitBounds([[a.lat, a.lng], [b.lat, b.lng]], { paddingTopLeft: [50, 70], paddingBottomRight: [50, 120], maxZoom: CONFIG.MAX_FIT_ZOOM }); },
    setView(lat, lng, zoom) { lmap.setView([lat, lng], zoom); },
  };
}

async function createMap(el) {
  if (!CONFIG.NAVER_KEY_ID) { mapNote("네이버 지도 키가 없어 OpenStreetMap으로 표시합니다. (app.js CONFIG.NAVER_KEY_ID)"); return createLeafletMap(el); }
  const naverOk = new Promise((res, rej) => {
    window.navermap_authFailure = () => {   // 인증은 SDK 로드 뒤 비동기 → 지도가 만들어진 뒤 실패가 올 수 있음
      console.error("[노꽁] 네이버 지도 인증 실패(401). NCP 콘솔 > Maps > Application 의 Web 서비스 URL(" + location.origin + ")과 키 종류(" + CONFIG.NAVER_KEY_PARAM + ")를 확인하세요.");
      if (map) switchToLeaflet("네이버 지도 인증에 실패해 OpenStreetMap으로 표시합니다.");
      else rej(new Error("naver auth failed"));
    };
    loadScript("https://oapi.map.naver.com/openapi/v3/maps.js?" + CONFIG.NAVER_KEY_PARAM + "=" + encodeURIComponent(CONFIG.NAVER_KEY_ID)).then(() => {
      let tries = 0;
      (function wait() {
        if (window.naver && window.naver.maps && window.naver.maps.Map) return res();
        if (++tries > 40) return rej(new Error("naver sdk timeout"));
        setTimeout(wait, 200);
      })();
    }).catch(rej);
  });
  try { await naverOk; return createNaverMap(el); }
  catch (e) {
    console.warn("[노꽁] 네이버 지도 사용 불가 → OSM 대체:", e.message);
    mapNote(/auth/.test(e.message) ? "네이버 지도 인증에 실패해 OpenStreetMap으로 표시합니다." : "네이버 지도를 불러오지 못해 OpenStreetMap으로 표시합니다.");
    el.innerHTML = "";
    return createLeafletMap(el);
  }
}

let switching = false;
async function switchToLeaflet(reason) {
  if (switching || (map && map.provider === "leaflet")) return;
  switching = true;
  console.warn("[노꽁] " + reason); mapNote(reason, 15000);
  for (const rec of markers.values()) { try { rec.handle.remove(); } catch (e) {} }
  markers.clear();
  if (meMarker) { try { meMarker.remove(); } catch (e) {} meMarker = null; }
  if (rep && rep.marker) { try { rep.marker.remove(); } catch (e) {} rep.marker = null; }
  const el = $("map");
  el.innerHTML = ""; el.removeAttribute("style"); el.className = "";
  try { map = await createLeafletMap(el); map.onClick(onMapClick); render(); }
  catch (e) { console.error(e); mapNote("지도를 불러오지 못했어요. 새로고침해 주세요."); }
  finally { switching = false; }
}

/* =========================================================
   5) 내 제보 저장(이 기기) · 횟수 제한
   ========================================================= */
const REPORT_KEY = "nokkong_reports_v2", RL_KEY = "nokkong_rl_v1", DEVICE_KEY = "nokkong_device_v1";
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 사생활 모드 등 */ } },
};
let myReports = store.get(REPORT_KEY, []);
(function migrateLegacy() {                          // ⑤ v2 의 '꽁초함이 필요한 곳(need)' 제보를 핫스팟으로 변환
  let changed = false;
  for (const r of myReports) { if (r.type === "need" || r.reportType === "need") { r.type = "hotspot"; r.reportType = "hotspot"; changed = true; } }
  if (changed) store.set(REPORT_KEY, myReports);
})();
const deviceToken = (() => { let t = store.get(DEVICE_KEY, null); if (!t) { t = Math.random().toString(36).slice(2, 10) + Date.now().toString(36); store.set(DEVICE_KEY, t); } return String(t).replace(/[^a-z0-9]/gi, "").slice(0, 32); })();
function rateLimitCheck() {
  const now = Date.now(), day = new Date().toISOString().slice(0, 10);
  const rl = store.get(RL_KEY, { last: 0, day, count: 0 });
  if (rl.day !== day) { rl.day = day; rl.count = 0; }
  if (now - rl.last < CONFIG.REPORT_MIN_INTERVAL_MS) return `제보는 1분에 한 번만 받을 수 있어요. ${Math.ceil((CONFIG.REPORT_MIN_INTERVAL_MS - (now - rl.last)) / 1000)}초 뒤에 다시 시도해 주세요.`;
  if (rl.count >= CONFIG.REPORT_DAILY_MAX) return "오늘은 제보를 충분히 받았어요. 내일 다시 부탁드려요.";
  return null;
}
function rateLimitTick() {
  const day = new Date().toISOString().slice(0, 10);
  const rl = store.get(RL_KEY, { last: 0, day, count: 0 });
  if (rl.day !== day) { rl.day = day; rl.count = 0; }
  rl.last = Date.now(); rl.count += 1; store.set(RL_KEY, rl);
}

/* =========================================================
   6) 화면 — 핀, 통계, 레이어 토글, 시트
   ========================================================= */
let map;
const markers = new Map();
const layerOn = { bin: true, booth: true, hotspot: true, mine: true };
function layerOf(item) { return item.mine ? "mine" : item.type; }
function iconFor(item, nearest = false) {
  const layer = layerOf(item);
  return pinHtml([layer, item.demo ? "demo" : "", nearest ? "nearest" : ""].join(" ").trim(), LABEL[layer]);
}
function allItems() {
  const mine = myReports.map(r => Object.assign({ mine: true }, r));
  return POINTS.concat(TEAM_HOTSPOTS, CONFIG.SHOW_DEMO ? DEMO : [], mine);
}
function render() {
  for (const rec of markers.values()) rec.handle.remove();
  markers.clear();
  for (const item of allItems()) {
    const layer = layerOf(item);
    const handle = map.addMarker({ lat: item.lat, lng: item.lng, html: iconFor(item), title: item.name, onClick: () => showItem(item) });
    handle.setVisible(layerOn[layer]);
    markers.set(item.id, { handle, item, layer });
  }
  const real = allItems().filter(d => !d.demo && !d.mine);
  const n = t => real.filter(d => d.type === t).length;
  const stats = $("stats"); stats.textContent = "";
  stats.append("꽁초함 ", h("b", { text: n("bin") }), " · 흡연부스 ", h("b", { text: n("booth") }), " · 핫스팟 ", h("b", { text: n("hotspot") }));
  document.querySelector('.chip[data-layer="mine"]').hidden = myReports.length === 0;
}
document.querySelectorAll(".chip").forEach(btn => {
  btn.addEventListener("click", () => {
    const on = btn.getAttribute("aria-pressed") !== "true";
    btn.setAttribute("aria-pressed", String(on));
    layerOn[btn.dataset.layer] = on;
    for (const rec of markers.values()) if (rec.layer === btn.dataset.layer) rec.handle.setVisible(on);
  });
});

const sheet = $("sheet"), sheetBody = $("sheetBody");
function openSheet(...nodes) { sheetBody.textContent = ""; sheetBody.append(...nodes); sheet.classList.add("open"); }
function closeSheet() { sheet.classList.remove("open"); cancelReport(); }
$("btnClose").addEventListener("click", closeSheet);

// 외부 공개용 보기: 이름·종류·확인 여부·한 줄 설명만. 출처 메모·좌표 정확도·입력일 같은 내부 필드는 화면에 내지 않습니다.
function publicView(item) {
  const kind = item.mine ? `내 제보 · ${TYPE_NAME[item.reportType] || TYPE_NAME[item.type]}` : (item.kind || TYPE_NAME[item.type]);
  const line = item.mine ? (item.note || "") : [item.address, item.indoor, item.areaM2 ? `${item.areaM2}㎡` : null].filter(Boolean).join(" · ");
  let badge, extra = null;
  if (item.demo) badge = { cls: "warn", text: "예시" };
  else if (item.mine) badge = { cls: item.sent ? "ok" : "warn", text: item.sent ? "팀에 전달됨" : "이 기기에만 저장됨" };
  else if (item.type === "hotspot") {
    badge = { cls: "ok", text: `제보 ${item.count || "-"}건 · 팀 검증` };
    if (item.needBin) extra = { cls: "warn", text: item.nearestBinM != null ? `꽁초함 설치 후보 · 가장 가까운 꽁초함 ${fmtDist(item.nearestBinM)}` : "꽁초함 설치 후보" };
  }
  else badge = item.verified ? { cls: "ok", text: "위치 확인됨" } : { cls: "warn", text: "위치 확인 필요" };
  return { kind, line, badge, extra };
}
// ② 네이버 지도 길찾기 — 모바일은 네이버 지도 앱(URL Scheme, 미설치 시 스토어/웹으로), PC 는 네이버 지도 웹 길찾기
let lastMe = null;                                   // 마지막으로 확인한 내 위치(또는 QR 지점). 출발지로 씁니다
function mercator(lat, lng) {                        // 네이버 지도 웹 URL 은 EPSG:3857(m) 좌표를 씁니다
  const R = 20037508.34;
  return { x: lng * R / 180, y: Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180) * R / 180 };
}
function naverRoute(item, start) {
  const dname = encodeURIComponent(item.name || "꽁초함"), app = encodeURIComponent(CONFIG.APP_URL);
  const q = (start ? `slat=${start.lat}&slng=${start.lng}&sname=${encodeURIComponent("내 위치")}&` : "") + `dlat=${item.lat}&dlng=${item.lng}&dname=${dname}&appname=${app}`;
  const g = mercator(item.lat, item.lng), s = start ? mercator(start.lat, start.lng) : null;
  const web = `https://map.naver.com/p/directions/${s ? `${s.x.toFixed(1)},${s.y.toFixed(1)},${encodeURIComponent("내 위치")},,` : "-"}/${g.x.toFixed(1)},${g.y.toFixed(1)},${dname},,/-/walk`;
  return {
    web,
    ios: `nmap://route/walk?${q}`,
    android: `intent://route/walk?${q}#Intent;scheme=nmap;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;package=com.nhn.android.nmap;S.browser_fallback_url=${encodeURIComponent(web)};end`,
  };
}
function openNaverRoute(item, ev) {
  const ua = navigator.userAgent, links = naverRoute(item, lastMe);
  if (/Android/i.test(ua)) { ev.preventDefault(); location.href = links.android; return; }          // 앱 없으면 Play 스토어/웹으로 자동 대체
  if (/iPhone|iPad|iPod/i.test(ua)) {
    ev.preventDefault();
    const t0 = Date.now(); location.href = links.ios;                                               // 앱이 열리면 페이지가 숨겨짐
    setTimeout(() => { if (!document.hidden && Date.now() - t0 < 2500) location.href = links.web; }, 1500);
    return;
  }
  // PC: 기본 동작(a 태그) — 새 탭으로 웹 길찾기
}

function showItem(item, distM) {
  const v = publicView(item);
  const nodes = [
    h("h2", { text: item.name }),
    h("p", { class: "meta" }, v.kind, h("span", { class: `tag ${v.badge.cls}`, text: v.badge.text }), v.extra && h("span", { class: `tag ${v.extra.cls}`, text: v.extra.text })),
  ];
  if (distM != null) nodes.push(h("div", { class: "dist" }, fmtDist(distM), h("small", { text: `걸어서 약 ${Math.max(1, Math.round(distM / 80))}분` })));
  if (v.line) nodes.push(h("p", { text: v.line }));
  if (item.type === "hotspot" && !item.mine && item.aiAvg != null) nodes.push(h("p", { class: "hint", text: `제보 사진 AI 추정 꽁초 평균 ${item.aiAvg}개 (참고값)` }));
  if (item.mine && item.takenAt) nodes.push(h("p", { class: "hint", text: `촬영 ${fmtTaken(item.takenAt)}` }));
  if (item.mine && item.aiCount != null) nodes.push(h("p", { text: `AI 추정 꽁초 ${item.aiCount}개${item.aiDensity ? ` · 밀집도 ${DENSITY_NAME[item.aiDensity] || item.aiDensity}` : ""} (참고용, 팀이 사진으로 확인합니다)` }));
  if (item.mine && !item.sent && CONFIG.REPORT_ENDPOINT) nodes.push(h("div", { class: "row" }, h("button", { class: "btn btn-primary", type: "button", onclick: () => resend(item) }, "팀에 다시 보내기")));
  else if (!item.mine) nodes.push(h("div", { class: "row" }, h("a", { class: "btn btn-primary", href: naverRoute(item, lastMe).web, target: "_blank", rel: "noopener noreferrer", onclick: ev => openNaverRoute(item, ev) }, "네이버 지도로 길찾기")));
  openSheet(...nodes);
}

/* =========================================================
   7) 가장 가까운 꽁초함 — 내 위치(기기 안에서만 계산) 또는 QR 딥링크 #at=위도,경도
   ========================================================= */
let meMarker = null, lastNearestId = null;
function showMe(me, label) {                          // 파란 점(내 위치) 표시. 기기 안에서만 씀
  if (meMarker) meMarker.remove();
  meMarker = map.addMarker({ lat: me.lat, lng: me.lng, html: '<div class="me"></div>', w: 16, hh: 16, ax: 8, ay: 8, title: label || "내 위치" });
  lastMe = { lat: me.lat, lng: me.lng };
}
function findNearestFrom(me, label) {
  showMe(me, label);
  let pool = allItems().filter(d => d.type === "bin" && !d.demo && !d.mine), note = "";
  if (!pool.length) { pool = allItems().filter(d => d.type === "booth" && !d.mine); note = "꽁초함 자료를 모으는 중이라 가장 가까운 흡연부스를 보여드려요."; }
  if (!pool.length) { toast("등록된 시설이 아직 없어요."); map.setView(me.lat, me.lng, 16); return; }
  let best = null, bestD = Infinity;
  for (const b of pool) { const d = haversine(me, b); if (d < bestD) { bestD = d; best = b; } }
  const prev = markers.get(lastNearestId); if (prev) prev.handle.setHtml(iconFor(prev.item));
  const rec = markers.get(best.id); if (rec) { rec.handle.setHtml(iconFor(best, true)); lastNearestId = best.id; }
  map.fitTwo(me, best);
  if (note) toast(note, 3500);
  showItem(best, bestD);
}
function getPosition() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error("unsupported"));
    navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }), rej, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  });
}
$("btnLocate").addEventListener("click", async () => {
  const btn = $("btnLocate");
  btn.disabled = true; btn.textContent = "위치 확인 중…";
  try { findNearestFrom(await getPosition()); }
  catch (err) { toast(err && err.code === 1 ? "위치 권한을 허용하면 가까운 꽁초함을 찾아 드려요." : "위치를 가져오지 못했어요. 다시 시도해 주세요."); }
  finally { btn.disabled = false; btn.textContent = "가장 가까운 꽁초함 찾기"; }
});
// ① 지도 위 '내 위치로 이동' 버튼 — 현재 GPS 위치로 지도를 옮기고 파란 점을 찍습니다(가장 가까운 찾기와 별개)
$("btnMe").addEventListener("click", async () => {
  const btn = $("btnMe"); btn.disabled = true; btn.classList.add("busy");
  try {
    const p = await getPosition();
    showMe(p);
    map.setView(p.lat, p.lng, CONFIG.ME_ZOOM);
    if (!inBounds(p.lat, p.lng)) toast("지금 위치가 노원구 밖이에요. 지도는 노원구 안까지만 움직여요.", 3500);
    else if (p.acc > 100) toast(`위치 오차가 약 ${Math.round(p.acc)}m예요.`, 2500);
  } catch (err) { toast(err && err.code === 1 ? "위치 권한을 허용하면 내 위치로 이동할 수 있어요." : "위치를 가져오지 못했어요. 다시 시도해 주세요."); }
  finally { btn.disabled = false; btn.classList.remove("busy"); }
});
// 현장 QR 스티커용: https://nimo-coder.github.io/nokkongmap/#at=37.6255,127.0800 → 그 지점 기준으로 바로 안내
//                  https://nimo-coder.github.io/nokkongmap/#report          → 제보 화면 바로 열기
function handleDeepLink() {
  const m = /^#at=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(location.hash);
  if (m) { const lat = +m[1], lng = +m[2]; if (inBounds(lat, lng)) findNearestFrom({ lat, lng }, "QR 지점"); return; }
  if (location.hash === "#report") startReport("hotspot");
}

/* =========================================================
   8) 제보 — 종류 라디오 2개(핫스팟 / 구청 꽁초함) · 사진 필수 · 위치 · 설명 · 동의
   흐름: 종류 선택 → 사진(필수, EXIF 촬영시각·위치 자동 입력) → 위치 확인(내 위치 / 지도) → 설명 → 보내기
   ========================================================= */
let rep = null;            // 진행 중인 제보: { mode, image, exif, pick, marker, picking, ui, cf }
let turnstileLoading = null;
function cancelReport() {
  if (rep && rep.marker) { try { rep.marker.remove(); } catch (e) {} }
  rep = null; mapNote("");
}
function setPick(lat, lng, how) {
  if (!rep) return;
  rep.pick = { lat: +lat.toFixed(5), lng: +lng.toFixed(5) };   // 소수 5자리 ≈ 1m. 더 정밀한 값은 저장하지 않음
  if (rep.marker) rep.marker.setPos(rep.pick.lat, rep.pick.lng);
  else rep.marker = map.addMarker({ lat: rep.pick.lat, lng: rep.pick.lng, html: '<div class="pick"></div>', w: 14, hh: 14, ax: 7, ay: 7, title: "제보 위치" });
  const outside = !inBounds(rep.pick.lat, rep.pick.lng);
  rep.ui.loc.textContent = (how === "exif" ? "사진의 위치 정보를 사용했어요" : how === "gps" ? "현재 위치를 사용했어요" : "지도에서 고른 위치예요")
    + (outside ? " · 노원구 밖이라 받을 수 없어요" : "") + " (핀을 옮기려면 '지도에서 고르기')";
  rep.ui.loc.className = outside ? "hint bad" : "hint ok";
  updateSubmit();
}
// ③ 유효성 검사: 사진(모든 종류 필수)·위치(노원구 안)·동의, 구청 꽁초함은 장소 이름 2자 이상. 하나라도 빠지면 보내기 버튼 비활성
function validateReport() {
  if (!rep) return { ok: false };
  if (!rep.image) return { ok: false, msg: "사진을 넣어 주세요. 사진 없이는 제보할 수 없어요." };
  if (!rep.pick) return { ok: false, msg: "위치를 지정해 주세요." };
  if (!inBounds(rep.pick.lat, rep.pick.lng)) return { ok: false, msg: "노원구 안의 위치만 받을 수 있어요." };
  if (rep.mode === "bin" && clean(rep.ui.name.value, CONFIG.NAME_MAX).length < 2) return { ok: false, msg: "꽁초함이 있는 장소 이름을 2자 이상 적어 주세요." };
  if (!rep.ui.consent.checked) return { ok: false, msg: "전달 동의에 체크해 주세요." };
  if (CONFIG.TURNSTILE_SITE_KEY && CONFIG.REPORT_ENDPOINT && !rep.cf) return { ok: false, msg: "봇 방지 확인을 기다려 주세요." };
  return { ok: true };
}
function updateSubmit() { if (rep) rep.ui.submit.disabled = !validateReport().ok; }
function onMapClick(lat, lng) {
  if (!rep || !rep.picking) return;
  rep.picking = false;
  setPick(lat, lng, "map");
  mapNote("");
  sheet.classList.add("open");
}

$("btnReport").addEventListener("click", () => startReport("hotspot"));

function startReport(mode) {
  const limited = rateLimitCheck(); if (limited) { toast(limited, 3500); return; }
  cancelReport();
  rep = { mode: mode === "bin" ? "bin" : "hotspot", image: null, exif: null, pick: null, marker: null, picking: false, cf: null, takenAt: null, takenSrc: "none", ui: {} };
  const ui = rep.ui;

  // ④·⑤ 어떤 제보인가요? — 라디오 2개 (사각지대 항목 없음)
  ui.radios = REPORT_KINDS.map(k => h("input", { type: "radio", name: "rKind", id: "rKind-" + k.mode, value: k.mode, checked: rep.mode === k.mode ? true : null,
    onchange: () => { rep.mode = k.mode; applyMode(); updateSubmit(); } }));
  const kindBox = h("div", { class: "kinds", role: "radiogroup", "aria-label": "어떤 제보인가요?" },
    REPORT_KINDS.map((k, i) => h("label", { class: "kind", for: "rKind-" + k.mode }, ui.radios[i], h("span", { text: k.label }))));

  ui.photo = h("input", { id: "rPhoto", type: "file", accept: "image/*", capture: "environment", required: true, "aria-required": "true" });
  ui.preview = h("img", { class: "preview", alt: "", hidden: true });
  ui.photoInfo = h("div", { class: "progress" });
  ui.loc = h("div", { class: "hint", text: "사진에 위치 정보가 있으면 자동으로 채워져요." });
  ui.nameLabel = h("label", { for: "rName" });
  ui.name = h("input", { id: "rName", type: "text", maxlength: CONFIG.NAME_MAX, autocomplete: "off", oninput: updateSubmit });
  ui.consent = h("input", { type: "checkbox", id: "rConsent", onchange: updateSubmit });
  ui.consentText = h("span");
  ui.hp = h("input", { class: "hp", type: "text", name: "website", tabindex: "-1", autocomplete: "off", "aria-hidden": "true" });  // 봇이 채우는 함정 칸
  ui.submit = h("button", { class: "btn btn-primary", type: "submit", disabled: true }, "제보 보내기");
  ui.cfBox = h("div", { class: "cf" });
  ui.title = h("h2"); ui.desc = h("p", { class: "meta" });
  const btnGps = h("button", { class: "btn btn-secondary small", type: "button", onclick: async () => {
    btnGps.disabled = true; btnGps.textContent = "위치 확인 중…";
    try { const p = await getPosition(); setPick(p.lat, p.lng, "gps"); if (p.acc > 50) toast(`위치 오차가 약 ${Math.round(p.acc)}m예요. 핀이 어긋났으면 지도에서 옮겨 주세요.`, 3500); }
    catch (e) { toast(e && e.code === 1 ? "위치 권한을 허용하거나 지도에서 골라 주세요." : "위치를 가져오지 못했어요. 지도에서 골라 주세요."); }
    finally { btnGps.disabled = false; btnGps.textContent = "내 위치로"; }
  } }, "내 위치로");
  const btnMap = h("button", { class: "btn btn-secondary small", type: "button", onclick: () => {
    rep.picking = true; sheet.classList.remove("open");
    mapNote("지도를 한 번 눌러 제보 위치를 지정해 주세요. (핀을 찍으면 입력 화면으로 돌아와요)", 0);
  } }, "지도에서 고르기");

  // 종류에 따라 문구만 바꾸고 사진·위치 입력값은 유지
  function applyMode() {
    const hot = rep.mode === "hotspot";
    ui.title.textContent = hot ? "무단투기 현장 제보" : "구청 꽁초함 위치 제보";
    ui.desc.textContent = hot ? "꽁초가 버려진 현장을 찍어 보내 주세요. 모이면 핫스팟으로 표시하고 구청에 꽁초함 설치를 제안합니다."
                              : "노원구청이 설치한 꽁초함(초록 통)을 찍어 보내 주세요. 지도에 없는 곳이면 확인 후 추가합니다.";
    ui.nameLabel.textContent = hot ? "3. 장소 설명 (선택)" : "3. 장소 이름 (필수)";
    ui.name.placeholder = hot ? "예: 공릉역 2번 출구 버스정류장 뒤" : "예: ○○편의점 앞 기둥 옆";
    ui.consentText.textContent = hot ? "사진과 표시한 위치가 노꽁 팀에 전달되는 것에 동의합니다. 이름·연락처 등 개인정보는 받지 않습니다."
                                     : "사진·장소 이름과 표시한 위치가 노꽁 팀에 전달되는 것에 동의합니다. 이름·연락처 등 개인정보는 받지 않습니다.";
  }

  const form = h("form", { id: "reportForm", novalidate: true },
    h("label", { text: "어떤 제보인가요?" }), kindBox,
    h("label", { for: "rPhoto", text: "1. 사진 (필수)" }), ui.photo, ui.preview, ui.photoInfo,
    h("p", { class: "hint", text: "사진은 기기에서 1024px 이하로 줄이고 촬영 정보(EXIF)를 지운 뒤 보냅니다. 촬영 시각·위치는 자동 입력에만 쓰고 전송하지 않습니다. 사람 얼굴·차량 번호판이 나오지 않게 찍어 주세요. 사진은 팀만 확인합니다." }),
    h("label", { text: "2. 위치" }), h("div", { class: "row tight" }, btnGps, btnMap), ui.loc,
    ui.nameLabel, ui.name,
    ui.hp, ui.cfBox,
    h("label", { class: "consent" }, ui.consent, ui.consentText),
    h("div", { class: "row" }, ui.submit, h("button", { class: "btn btn-secondary", type: "button", onclick: closeSheet }, "취소")));
  applyMode();

  ui.photo.addEventListener("change", async () => {
    const f = ui.photo.files && ui.photo.files[0];
    rep.image = null; rep.exif = null; rep.takenAt = null; rep.takenSrc = "none"; ui.preview.hidden = true; ui.photoInfo.textContent = ""; updateSubmit();
    if (!f) return;
    if (!/^image\//.test(f.type)) { ui.photoInfo.textContent = "이미지 파일만 올릴 수 있어요."; ui.photo.value = ""; return; }
    ui.photoInfo.textContent = "사진 확인 중…";
    try {
      const [img, exif] = await Promise.all([shrinkImage(f), readExif(f)]);
      rep.image = img; rep.exif = exif;
      if (exif.takenAt) { rep.takenAt = exif.takenAt; rep.takenSrc = "exif"; }
      else if (f.lastModified) { rep.takenAt = localIso(f.lastModified); rep.takenSrc = "file"; }
      ui.preview.src = img.dataUrl; ui.preview.hidden = false;
      const parts = [`${img.width}×${img.height}`, `약 ${Math.round(img.bytes / 1024)}KB`];
      if (rep.takenAt) parts.unshift((rep.takenSrc === "exif" ? "촬영 " : "파일 시각 ") + fmtTaken(rep.takenAt));
      ui.photoInfo.textContent = "사진 준비됨 · " + parts.join(" · ");
      if (rep.takenAt && (Date.now() - new Date(rep.takenAt).getTime()) > CONFIG.PHOTO_STALE_DAYS * 864e5) ui.photoInfo.textContent += ` · ${CONFIG.PHOTO_STALE_DAYS}일 넘은 사진이에요(최근 사진이면 더 정확해요)`;
      if (exif.lat != null && !rep.pick) {
        if (inBounds(exif.lat, exif.lng)) setPick(exif.lat, exif.lng, "exif");
        else ui.loc.textContent = "사진의 위치가 노원구 밖이라 쓰지 않았어요. 위치를 지정해 주세요.";
      }
    } catch (e) {
      ui.photoInfo.textContent = "사진을 처리하지 못했어요. 다른 사진으로 시도해 주세요."; ui.photo.value = "";
    }
    updateSubmit();
  });

  form.addEventListener("submit", async ev => {
    ev.preventDefault();
    if (ui.hp.value) { closeSheet(); return; }                                 // 봇 → 조용히 무시
    const limited = rateLimitCheck(); if (limited) { toast(limited, 3500); return; }
    const v = validateReport(); if (!v.ok) { updateSubmit(); toast(v.msg || "입력을 확인해 주세요.", 3500); return; }   // ③ 사진 없으면 여기서 막힘
    const mode = rep.mode, hot = mode === "hotspot";
    const nm = clean(ui.name.value, CONFIG.NAME_MAX) || (hot ? "무단투기 현장" : "구청 꽁초함");
    const item = {
      id: "r-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: mode, reportType: mode, name: nm, note: "", lat: rep.pick.lat, lng: rep.pick.lng,
      takenAt: rep.takenAt, takenSrc: rep.takenSrc, hasPhoto: true,
      sent: false, aiCount: null, aiDensity: null, aiStatus: null, created: new Date().toISOString(),
    };
    ui.submit.disabled = true; ui.submit.textContent = "보내는 중…";
    rateLimitTick();
    myReports.push(item); store.set(REPORT_KEY, myReports);                 // 사진은 기기에 남기지 않음
    const image = rep.image, cf = rep.cf; cancelReport(); render();
    const result = await sendReport(item, image, cf);
    applyResult(item, result);
    sheet.classList.remove("open");
    if (!CONFIG.REPORT_ENDPOINT) toast("이 기기에 저장했어요. (제보 서버가 아직 연결되지 않았어요)", 3500);
    else if (result && result.ok) toast(result.ai && result.ai.count != null ? `제보 고마워요. AI 추정 꽁초 ${result.ai.count}개${result.ai.density ? ` · 밀집도 ${DENSITY_NAME[result.ai.density] || ""}` : ""}` : "제보 고마워요. 팀이 확인한 뒤 지도에 반영해요.", 4000);
    else toast(result && result.error === "photo_required" ? "사진이 필요한 제보예요." : "서버에 보내지 못해 이 기기에 저장했어요. 핀을 눌러 다시 보낼 수 있어요.", 4000);
  });

  openSheet(ui.title, ui.desc, form);
  mountTurnstile();
}

// Cloudflare Turnstile(선택): 사이트 키가 있을 때만 위젯을 붙이고 토큰을 제보와 함께 보냅니다.
function mountTurnstile() {
  if (!CONFIG.TURNSTILE_SITE_KEY || !CONFIG.REPORT_ENDPOINT || !rep) return;
  const box = rep.ui.cfBox;
  const renderWidget = () => { if (!rep || !window.turnstile) return; window.turnstile.render(box, { sitekey: CONFIG.TURNSTILE_SITE_KEY, callback: t => { if (rep) { rep.cf = t; updateSubmit(); } }, "expired-callback": () => { if (rep) { rep.cf = null; updateSubmit(); } } }); };
  if (window.turnstile) return renderWidget();
  turnstileLoading = turnstileLoading || loadScript("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
  turnstileLoading.then(renderWidget).catch(() => { box.textContent = "봇 방지 모듈을 불러오지 못했어요. 새로고침해 주세요."; });
}

function applyResult(item, result) {
  if (result && result.ok) {
    item.sent = true; item.serverId = result.id || null;
    if (result.ai) { item.aiCount = result.ai.count ?? null; item.aiDensity = result.ai.density || null; item.aiStatus = result.ai.status || null; }
  }
  store.set(REPORT_KEY, myReports); render();
}
async function resend(item) {
  toast("다시 보내는 중…", 1500);
  const result = await sendReport(item, null, null);    // 사진은 기기에 보관하지 않으므로 재전송은 위치·설명만(서버 설정에 따라 거절될 수 있음)
  applyResult(item, result);
  toast(result && result.ok ? "팀에 전달했어요." : (result && result.error === "photo_required" ? "사진이 필요한 제보라 다시 보낼 수 없어요. 새로 제보해 주세요." : "아직 보내지 못했어요. 잠시 뒤 다시 시도해 주세요."), 3500);
}

// 서버로는 아래 필드만 보냅니다. 위치 권한으로 얻은 '내 위치'는 (제보 위치로 쓰겠다고 고른 경우 외에는) 포함하지 않습니다.
async function sendReport(item, image, cf) {
  if (!CONFIG.REPORT_ENDPOINT) return null;
  const payload = {
    v: 3, id: item.id, device: deviceToken, type: item.reportType, name: item.name, lat: item.lat, lng: item.lng, created: item.created,
    takenAt: item.takenAt || null, takenSrc: item.takenSrc || "none",
    image: image ? image.dataUrl : null, imgW: image ? image.width : null, imgH: image ? image.height : null,
    cf: cf || null,
  };
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), CONFIG.REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(CONFIG.REPORT_ENDPOINT, { method: "POST", body: JSON.stringify(payload), signal: ctrl.signal, headers: { "Content-Type": "text/plain;charset=utf-8" } });  // text/plain → preflight 없음
    return await res.json().catch(() => ({ ok: res.ok }));
  } catch (e) { console.warn("[노꽁] 제보 전송 실패:", e.message); return null; }
  finally { clearTimeout(timer); }
}

// 기기에서 사진 축소: 긴 변 1024px, JPEG 재인코딩(EXIF 제거), 600KB 이하가 될 때까지 품질 낮춤
async function shrinkImage(file) {
  let bmp = null;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { /* 구형 브라우저 */ }
  const src = bmp || await new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = URL.createObjectURL(file); });
  const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight;
  const scale = Math.min(1, CONFIG.IMAGE_MAX_EDGE / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale)), hgt = Math.max(1, Math.round(sh * scale));
  const c = document.createElement("canvas"); c.width = w; c.height = hgt;
  c.getContext("2d").drawImage(src, 0, 0, w, hgt);
  if (bmp && bmp.close) bmp.close();
  let q = CONFIG.IMAGE_QUALITY, dataUrl = c.toDataURL("image/jpeg", q);
  while (dataUrl.length * 0.75 > CONFIG.IMAGE_MAX_BYTES && q > 0.4) { q = +(q - 0.1).toFixed(1); dataUrl = c.toDataURL("image/jpeg", q); }
  return { dataUrl, width: w, height: hgt, bytes: Math.round(dataUrl.length * 0.75) };
}

// 기기에서 사진의 촬영 시각(DateTimeOriginal)과 GPS만 읽는 최소 EXIF 파서 (JPEG APP1). 값은 자동 입력에만 쓰고 원본은 전송하지 않습니다.
// 반환: { takenAt: "YYYY-MM-DDTHH:MM:SS" | null, lat, lng }  — 읽기 실패·HEIC·PNG 는 전부 null
async function readExif(file) {
  const out = { takenAt: null, lat: null, lng: null };
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return out;
    let p = 2, tiff = -1;
    while (p + 4 <= v.byteLength) {
      if (v.getUint8(p) !== 0xFF) break;
      const marker = v.getUint8(p + 1), len = v.getUint16(p + 2);
      if (marker === 0xE1 && p + 10 <= v.byteLength && v.getUint32(p + 4) === 0x45786966) { tiff = p + 10; break; }   // "Exif"
      if (marker === 0xDA) break;
      p += 2 + len;
    }
    if (tiff < 0 || tiff + 8 > v.byteLength) return out;
    const le = v.getUint16(tiff) === 0x4949;
    const u16 = o => v.getUint16(o, le), u32 = o => v.getUint32(o, le);
    if (u16(tiff + 2) !== 42) return out;
    const ifdEntries = off => {
      const m = new Map();
      if (off < 8 || tiff + off + 2 > v.byteLength) return m;
      const n = u16(tiff + off);
      for (let i = 0; i < n && i < 200; i++) {
        const e = tiff + off + 2 + i * 12; if (e + 12 > v.byteLength) break;
        m.set(u16(e), { type: u16(e + 2), count: u32(e + 4), at: e + 8 });
      }
      return m;
    };
    const ascii = ent => {
      const at = ent.count <= 4 ? ent.at : tiff + u32(ent.at);
      let s = ""; for (let i = 0; i < ent.count && at + i < v.byteLength; i++) { const c = v.getUint8(at + i); if (!c) break; s += String.fromCharCode(c); }
      return s;
    };
    const rational3 = ent => {
      const at = tiff + u32(ent.at); if (ent.type !== 5 || ent.count < 3 || at + 24 > v.byteLength) return null;
      const r = i => { const d = u32(at + i * 8 + 4); return d ? u32(at + i * 8) / d : 0; };
      return r(0) + r(1) / 60 + r(2) / 3600;
    };
    const ifd0 = ifdEntries(u32(tiff + 4));
    const exifPtr = ifd0.get(0x8769), gpsPtr = ifd0.get(0x8825);
    if (exifPtr) {
      const dto = ifdEntries(u32(exifPtr.at)).get(0x9003);
      const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(dto ? ascii(dto) : "");
      if (m && +m[1] >= 2000 && +m[1] <= 2100) out.takenAt = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
    }
    if (gpsPtr) {
      const g = ifdEntries(u32(gpsPtr.at));
      const la = g.get(2) && rational3(g.get(2)), ln = g.get(4) && rational3(g.get(4));
      if (la != null && ln != null && la <= 90 && ln <= 180 && (la || ln)) {
        out.lat = (g.get(1) && ascii(g.get(1)).toUpperCase() === "S") ? -la : la;
        out.lng = (g.get(3) && ascii(g.get(3)).toUpperCase() === "W") ? -ln : ln;
      }
    }
  } catch (e) { /* 손상된 파일 등 */ }
  return out;
}

/* =========================================================
   9) 내 제보 내려받기 — 주소 끝에 #export (이 기기의 제보만, 사진 없음)
   ========================================================= */
function setupExport() {
  if (location.hash !== "#export") return;
  const b = h("button", { class: "btn btn-secondary", type: "button", onclick: () => {
    const blob = new Blob([JSON.stringify(myReports, null, 2)], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: "nokkong-my-reports.json" }); document.body.append(a); a.click(); a.remove();
  } }, "내 제보 내려받기");
  document.querySelector(".actions").append(b);
}

/* =========================================================
   10) 시작
   ========================================================= */
(async function main() {
  try {
    map = await createMap($("map"));
    map.onClick(onMapClick);
    render();
    setupExport();
    handleDeepLink();
    window.addEventListener("hashchange", handleDeepLink);
  } catch (e) {
    console.error(e);
    mapNote("지도를 불러오지 못했어요. 네트워크를 확인한 뒤 새로고침해 주세요.");
  }
})();
