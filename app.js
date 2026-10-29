/* =====================================================================
   노꽁 지도 app.js  v2.3 (2026-10-28)
   중간점검 피드백 반영: 팝업 노출 정보 최소화·입력값 소독, 네이버 지도 API 전환(OSM 자동 대체),
   제보 사진 기기 내 축소·EXIF 제거, 제보 횟수 제한, AI 추론은 서버(Apps Script)에서만 호출.
   ===================================================================== */
"use strict";

/* =========================================================
   1) 설정 — 이 블록만 고치면 됩니다
   ========================================================= */
const CONFIG = {
  // 네이버 클라우드 플랫폼 > Maps > Application 에서 발급한 Client ID (ncpKeyId).
  // 비워 두면 OpenStreetMap(Leaflet)으로 자동 대체됩니다. 키는 등록한 웹 서비스 URL에서만 동작하므로 공개돼도 됩니다.
  NAVER_KEY_ID: "wces4uwwx1",
  // 키 파라미터 이름. 새 'Maps' 상품(Application Services > Maps)에서 발급한 키는 "ncpKeyId",
  // 옛 'AI·NAVER API' 메뉴에서 발급한 키는 "ncpClientId". 인증 실패가 계속되면 이 값을 바꿔 보세요.
  NAVER_KEY_PARAM: "ncpKeyId",

  // 제보 수신 서버(server/Code.gs 를 Apps Script 웹앱으로 배포한 URL). 비우면 브라우저에만 저장.
  REPORT_ENDPOINT: "",

  SHOW_DEMO: false,                                   // 예시 핀 표시 여부
  START: { lat: 37.6255, lng: 127.0800, zoom: 15 },   // 공릉동
  BOUNDS: { sw: [37.595, 127.02], ne: [37.715, 127.14] }, // 노원구 대략 경계
  MIN_ZOOM: 13,
  MAX_FIT_ZOOM: 17,

  // 제보 제한 (브라우저 기준). 서버에서도 한 번 더 제한합니다.
  REPORT_MIN_INTERVAL_MS: 60 * 1000,
  REPORT_DAILY_MAX: 20,

  // 사진: 기기에서 축소 후 전송. 재인코딩 과정에서 EXIF(촬영 위치·기기 정보)가 제거됩니다.
  IMAGE_MAX_EDGE: 1024,
  IMAGE_QUALITY: 0.8,
  IMAGE_MAX_BYTES: 600 * 1024,

  NAME_MAX: 40,
  NOTE_MAX: 200,
  REQUEST_TIMEOUT_MS: 15000,
};

/* =========================================================
   2) 데이터
   data/points.js   → DATA     : 구청 자료·답사로 만든 꽁초함(bin)·흡연부스(booth)
   data/hotspots.js → HOTSPOTS : 제보를 팀이 검증해 올린 핫스팟(hotspot). server/aggregate_hotspots.py 로 생성
   브라우저 localStorage       : 내 제보(mine). 이 기기에서만 보이고, 서버로 보낸 것은 팀이 검증한 뒤 핫스팟으로 올라옵니다.
   ========================================================= */
const POINTS = (typeof DATA !== "undefined" ? DATA : []).filter(d => d && d.inScope !== false && d.type !== "hotspot");
const TEAM_HOTSPOTS = (typeof HOTSPOTS !== "undefined" ? HOTSPOTS : []).map(h => Object.assign({ type: "hotspot", verified: true }, h));
const DEMO = [
  { id: "demo-1", type: "bin", name: "예시 꽁초함 A", lat: 37.6262, lng: 127.0794, demo: true },
  { id: "demo-2", type: "bin", name: "예시 꽁초함 B", lat: 37.6239, lng: 127.0732, demo: true },
  { id: "demo-3", type: "hotspot", name: "예시 핫스팟", lat: 37.6281, lng: 127.0892, demo: true, count: 25 },
];
const LABEL = { bin: "꽁", booth: "부", hotspot: "!", mine: "나" };
const TYPE_NAME = { bin: "꽁초함", booth: "흡연부스·흡연구역", hotspot: "무단투기 핫스팟", need: "꽁초함 필요 지점" };

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
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
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
function mapNote(msg, ms = 8000) {
  const n = $("mapnote"); n.textContent = msg || ""; n.style.display = msg ? "block" : "none";
  clearTimeout(noteTimer); if (msg) noteTimer = setTimeout(() => { n.style.display = "none"; }, ms);
}
function fmtDist(m) { return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`; }
function haversine(a, b) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function pinHtml(cls, label) {            // 상수만 들어가므로 문자열 조립 허용
  return `<div class="pin ${cls}"><span>${label}</span></div>`;
}
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = src; s.async = true;
    s.onload = res; s.onerror = () => rej(new Error("script load failed: " + src));
    document.head.appendChild(s);
  });
}
function loadCss(href) {
  return new Promise(res => { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; l.onload = res; l.onerror = res; document.head.appendChild(l); });
}

/* =========================================================
   4) 지도 어댑터 — 네이버 지도 API v3 (기본) / Leaflet+OSM (대체)
   앱 코드는 아래 7개 메서드만 사용합니다.
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

  // 감시: 12초 안에 타일이 하나도 그려지지 않으면(인증 지연·네트워크·렌더링 문제) OSM으로 교체합니다.
  let tilesOk = false;
  try { N.Event.addListener(nmap, "tilesloaded", () => { tilesOk = true; }); } catch (e) {}   // 'init'은 인증 전에도 발생하므로 세지 않음
  setTimeout(() => {
    const imgs = Array.from(el.querySelectorAll("img"));
    const loaded = imgs.filter(i => i.complete && i.naturalWidth > 0).length;
    console.info("[노꽁] 네이버 지도 상태 — 타일 이미지 " + imgs.length + "개 중 " + loaded + "개 로드, 이벤트 " + (tilesOk ? "수신" : "없음"));
    if (!tilesOk && loaded === 0 && map && map.provider === "naver") {
      switchToLeaflet("네이버 지도가 12초 안에 그려지지 않아 OpenStreetMap으로 표시합니다. F12 콘솔의 [노꽁] 메시지를 확인하세요.");
    }
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
      nmap.fitBounds(new N.LatLngBounds(ll(Math.min(a.lat, b.lat), Math.min(a.lng, b.lng)), ll(Math.max(a.lat, b.lat), Math.max(a.lng, b.lng))),
        { top: 70, right: 50, bottom: 120, left: 50 });
      if (nmap.getZoom() > CONFIG.MAX_FIT_ZOOM) nmap.setZoom(CONFIG.MAX_FIT_ZOOM);
    },
    setView(lat, lng, zoom) { nmap.morph(ll(lat, lng), zoom); },
  };
}

async function createLeafletMap(el) {
  await loadCss("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css");
  await loadScript("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js");
  const L = window.L;
  const map = L.map(el, { zoomControl: false, minZoom: CONFIG.MIN_ZOOM, maxBounds: [CONFIG.BOUNDS.sw, CONFIG.BOUNDS.ne], maxBoundsViscosity: 1 })
    .setView([CONFIG.START.lat, CONFIG.START.lng], CONFIG.START.zoom);
  L.control.zoom({ position: "topright" }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
  const icon = (html, w, h, ax, ay) => L.divIcon({ className: "", html, iconSize: [w, h], iconAnchor: [ax, ay] });
  return {
    provider: "leaflet",
    addMarker({ lat, lng, html, w = 26, hh = 26, ax = 13, ay = 26, title, onClick }) {
      const m = L.marker([lat, lng], { icon: icon(html, w, hh, ax, ay), title: title || "" }).addTo(map);
      if (onClick) m.on("click", onClick);
      return {
        setVisible: v => { v ? m.addTo(map) : m.remove(); },
        setHtml: nh => m.setIcon(icon(nh, w, hh, ax, ay)),
        setPos: (la, ln) => m.setLatLng([la, ln]),
        remove: () => m.remove(),
      };
    },
    onClick(cb) { map.on("click", e => cb(e.latlng.lat, e.latlng.lng)); },
    fitTwo(a, b) { map.fitBounds([[a.lat, a.lng], [b.lat, b.lng]], { paddingTopLeft: [50, 70], paddingBottomRight: [50, 120], maxZoom: CONFIG.MAX_FIT_ZOOM }); },
    setView(lat, lng, zoom) { map.setView([lat, lng], zoom); },
  };
}

async function createMap(el) {
  if (!CONFIG.NAVER_KEY_ID) {
    mapNote("네이버 지도 키가 아직 없어 OpenStreetMap으로 표시합니다. (app.js CONFIG.NAVER_KEY_ID)");
    return createLeafletMap(el);
  }
  // 인증 실패(키·도메인 미등록) 시 네이버 SDK가 호출하는 전역 함수. 스크립트 로드 전에 정의해야 합니다.
  // 인증은 SDK 로드 뒤 비동기로 진행되므로, 지도가 이미 만들어진 뒤에 실패가 올 수도 있습니다 → 그때는 OSM으로 교체.
  const naverOk = new Promise((res, rej) => {
    window.navermap_authFailure = () => {
      console.error("[노꽁] 네이버 지도 인증 실패(401). 바로 위 네이버 SDK 메시지의 'URI:'가 NCP 콘솔 > Maps > Application > 인증 정보의 'Web 서비스 URL'(" + location.origin + ")과 같은 도메인인지, Client ID가 " + (CONFIG.NAVER_KEY_PARAM || "ncpKeyId") + "용 키인지 확인하세요.");
      if (map) switchToLeaflet("네이버 지도 인증에 실패해 OpenStreetMap으로 표시합니다. NCP 콘솔의 웹 서비스 URL(" + location.origin + ") 등록을 확인하세요.");
      else rej(new Error("naver auth failed"));
    };
    loadScript("https://oapi.map.naver.com/openapi/v3/maps.js?" + (CONFIG.NAVER_KEY_PARAM || "ncpKeyId") + "=" + encodeURIComponent(CONFIG.NAVER_KEY_ID)).then(() => {
      let tries = 0;
      (function wait() {
        if (window.naver && window.naver.maps && window.naver.maps.Map) return res();
        if (++tries > 40) return rej(new Error("naver sdk timeout"));
        setTimeout(wait, 200);
      })();
    }).catch(rej);
  });
  try {
    await naverOk;
    return createNaverMap(el);
  } catch (e) {
    console.warn("[노꽁] 네이버 지도 사용 불가 → OSM 대체:", e.message);
    mapNote(/auth/.test(e.message)
      ? "네이버 지도 인증에 실패해 OpenStreetMap으로 표시합니다. NCP 콘솔의 웹 서비스 URL 등록을 확인하세요."
      : "네이버 지도를 불러오지 못해 OpenStreetMap으로 표시합니다. 네트워크를 확인해 주세요.");
    el.innerHTML = "";
    return createLeafletMap(el);
  }
}

// 네이버 지도를 이미 띄운 뒤 인증 실패·오류가 나면 같은 자리에 OSM 지도를 다시 그립니다.
let switching = false;
async function switchToLeaflet(reason) {
  if (switching || (map && map.provider === "leaflet")) return;
  switching = true;
  console.warn("[노꽁] " + reason);
  mapNote(reason, 15000);
  for (const rec of markers.values()) { try { rec.handle.remove(); } catch (e) { /* 죽은 지도 객체 */ } }
  markers.clear();
  if (meMarker) { try { meMarker.remove(); } catch (e) {} meMarker = null; }
  if (pickMarker) { try { pickMarker.remove(); } catch (e) {} pickMarker = null; }
  const el = $("map");
  el.innerHTML = ""; el.removeAttribute("style"); el.className = "";   // 네이버 SDK가 남긴 인라인 스타일·클래스 제거
  try {
    map = await createLeafletMap(el);
    map.onClick(onMapClick);
    render();
  } catch (e) {
    console.error(e); mapNote("지도를 불러오지 못했어요. 새로고침해 주세요.");
  } finally { switching = false; }
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
// 기기 토큰: 서버 쪽 1분 제한용 무작위 문자열. 개인정보·광고식별자와 무관하고, 브라우저 데이터를 지우면 사라집니다.
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
let map;                                   // 어댑터
const markers = new Map();                 // id → { handle, item, layer }
const layerOn = { bin: true, booth: true, hotspot: true, mine: true };

function layerOf(item) { return item.mine ? "mine" : item.type; }
function iconFor(item, nearest = false) {
  const layer = layerOf(item);
  const cls = [layer, item.demo ? "demo" : "", nearest ? "nearest" : ""].join(" ").trim();
  return pinHtml(cls, LABEL[layer]);
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
  const mineChip = document.querySelector('.chip[data-layer="mine"]');
  mineChip.hidden = myReports.length === 0;
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
function closeSheet() { sheet.classList.remove("open"); cancelPick(); }
$("btnClose").addEventListener("click", closeSheet);

// 외부 공개용 보기: 이름·종류·확인 여부·한 줄 설명만. 출처 메모·좌표 정확도·입력일 같은 내부 필드는 화면에 내지 않습니다.
function publicView(item) {
  const kind = item.mine ? `내 제보 · ${TYPE_NAME[item.reportType] || TYPE_NAME[item.type]}` : (item.kind || TYPE_NAME[item.type]);
  const line = item.mine ? (item.note || "") : [item.address, item.indoor, item.areaM2 ? `${item.areaM2}㎡` : null].filter(Boolean).join(" · ");
  let badge = null;
  if (item.demo) badge = { cls: "warn", text: "예시" };
  else if (item.mine) badge = { cls: item.sent ? "ok" : "warn", text: item.sent ? "팀에 전달됨" : "이 기기에만 저장됨" };
  else if (item.type === "hotspot") badge = { cls: "ok", text: `제보 ${item.count || "-"}건 · 팀 검증` };
  else badge = item.verified ? { cls: "ok", text: "위치 확인됨" } : { cls: "warn", text: "위치 확인 필요" };
  return { kind, line, badge };
}
function kakaoLink(item) { return `https://map.kakao.com/link/to/${encodeURIComponent(item.name)},${item.lat},${item.lng}`; }

function showItem(item, distM) {
  const v = publicView(item);
  const nodes = [
    h("h2", { text: item.name }),
    h("p", { class: "meta" }, v.kind, h("span", { class: `tag ${v.badge.cls}`, text: v.badge.text })),
  ];
  if (distM != null) nodes.push(h("div", { class: "dist" }, fmtDist(distM), h("small", { text: `걸어서 약 ${Math.max(1, Math.round(distM / 80))}분` })));
  if (v.line) nodes.push(h("p", { text: v.line }));
  if (item.mine && item.aiCount != null) nodes.push(h("p", { text: `AI 추정 꽁초 ${item.aiCount}개 (참고용, 팀이 사진으로 확인합니다)` }));
  if (item.mine && !item.sent && CONFIG.REPORT_ENDPOINT) {
    nodes.push(h("div", { class: "row" }, h("button", { class: "btn btn-primary", type: "button", onclick: () => resend(item) }, "팀에 다시 보내기")));
  } else if (!item.mine) {
    nodes.push(h("div", { class: "row" }, h("a", { class: "btn btn-primary", href: kakaoLink(item), target: "_blank", rel: "noopener noreferrer" }, "카카오맵으로 길찾기")));
  }
  openSheet(...nodes);
}

/* =========================================================
   7) 내 위치 → 가장 가까운 꽁초함 (위치는 기기 안에서만 계산)
   ========================================================= */
let meMarker = null, lastNearestId = null;
$("btnLocate").addEventListener("click", () => {
  const btn = $("btnLocate");
  if (!navigator.geolocation) { toast("이 브라우저는 위치를 지원하지 않아요."); return; }
  btn.disabled = true; btn.textContent = "위치 확인 중…";
  const done = () => { btn.disabled = false; btn.textContent = "가장 가까운 꽁초함 찾기"; };
  navigator.geolocation.getCurrentPosition(pos => {
    done();
    const me = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    if (meMarker) meMarker.remove();
    meMarker = map.addMarker({ lat: me.lat, lng: me.lng, html: '<div class="me"></div>', w: 16, hh: 16, ax: 8, ay: 8, title: "내 위치" });
    let pool = allItems().filter(d => d.type === "bin" && !d.demo && !d.mine);
    let note = "";
    if (!pool.length) { pool = allItems().filter(d => d.type === "booth" && !d.mine); note = "꽁초함 자료를 모으는 중이라 가장 가까운 흡연부스를 보여드려요."; }
    if (!pool.length) { toast("등록된 시설이 아직 없어요."); map.setView(me.lat, me.lng, 16); return; }
    let best = null, bestD = Infinity;
    for (const b of pool) { const d = haversine(me, b); if (d < bestD) { bestD = d; best = b; } }
    const prev = markers.get(lastNearestId); if (prev) prev.handle.setHtml(iconFor(prev.item));
    const rec = markers.get(best.id); if (rec) { rec.handle.setHtml(iconFor(best, true)); lastNearestId = best.id; }
    map.fitTwo(me, best);
    if (note) toast(note, 3500);
    showItem(best, bestD);
  }, err => {
    done();
    toast(err.code === 1 ? "위치 권한을 허용하면 가까운 꽁초함을 찾아 드려요." : "위치를 가져오지 못했어요. 다시 시도해 주세요.");
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
});

/* =========================================================
   8) 제보 — 지도 탭 → 폼 → (사진 축소) → 저장 → 서버 전송
   ========================================================= */
let reportMode = false, pick = null, pickMarker = null, pendingImage = null;
function cancelPick() { reportMode = false; pick = null; pendingImage = null; if (pickMarker) { pickMarker.remove(); pickMarker = null; } }

$("btnReport").addEventListener("click", () => {
  const limited = rateLimitCheck(); if (limited) { toast(limited, 3500); return; }
  reportMode = true;
  openSheet(h("h2", { text: "제보" }), h("p", { class: "meta", text: "지도에서 위치를 한 번 눌러 주세요." }),
    h("p", { text: "꽁초함이 있는 곳, 있어야 하는데 없는 곳, 꽁초가 많이 버려진 곳을 알려 주세요." }));
});

function onMapClick(lat, lng) {
  if (!reportMode) return;
  pick = { lat: +lat.toFixed(5), lng: +lng.toFixed(5) };   // 소수 5자리 ≈ 1m. 더 정밀한 값은 저장하지 않음
  if (pickMarker) pickMarker.setPos(pick.lat, pick.lng);
  else pickMarker = map.addMarker({ lat: pick.lat, lng: pick.lng, html: '<div class="pick"></div>', w: 14, hh: 14, ax: 7, ay: 7, title: "제보 위치" });
  pendingImage = null;

  const sel = h("select", { id: "rType", required: true },
    h("option", { value: "bin", text: "꽁초함이 여기 있어요" }),
    h("option", { value: "hotspot", text: "꽁초가 많이 버려져 있어요 (핫스팟)" }),
    h("option", { value: "need", text: "꽁초함이 필요한 곳이에요 (사각지대)" }));
  const name = h("input", { id: "rName", type: "text", maxlength: CONFIG.NAME_MAX, required: true, placeholder: "예: 공릉역 2번 출구 앞 버스정류장", autocomplete: "off" });
  const note = h("textarea", { id: "rNote", maxlength: CONFIG.NOTE_MAX, placeholder: "예: 꽁초 30개 정도, 빗물받이 바로 옆" });
  const photo = h("input", { id: "rPhoto", type: "file", accept: "image/*", capture: "environment" });
  const preview = h("img", { class: "preview", alt: "", hidden: true });
  const progress = h("div", { class: "progress" });
  const hp = h("input", { class: "hp", type: "text", name: "website", tabindex: "-1", autocomplete: "off", "aria-hidden": "true" }); // 봇이 채우는 함정 칸
  const consent = h("input", { type: "checkbox", id: "rConsent", required: true });
  const submit = h("button", { class: "btn btn-primary", type: "submit" }, "제보 보내기");
  const form = h("form", { id: "reportForm", novalidate: true },
    h("label", { for: "rType", text: "어떤 제보인가요?" }), sel,
    h("label", { for: "rName", text: "장소 이름" }), name,
    h("label", { for: "rNote", text: "메모 (선택)" }), note,
    h("label", { for: "rPhoto", text: "사진 (선택)" }), photo, preview, progress,
    h("p", { class: "hint", text: "사진은 기기에서 1024px 이하로 줄이고 촬영 정보(EXIF)를 지운 뒤 보냅니다. 사람 얼굴·차량 번호판이 나오지 않게 찍어 주세요. 사진은 팀만 확인하고 지도에 공개하지 않습니다." }),
    hp,
    h("label", { class: "consent" }, consent, "입력한 내용과 지도에 표시한 위치가 노꽁 팀에 전달되는 것에 동의합니다. 이름·연락처 등 개인정보는 받지 않습니다."),
    h("div", { class: "row" }, submit, h("button", { class: "btn btn-secondary", type: "button", onclick: closeSheet }, "취소")));

  photo.addEventListener("change", async () => {
    const f = photo.files && photo.files[0]; pendingImage = null; preview.hidden = true; progress.textContent = "";
    if (!f) return;
    if (!/^image\//.test(f.type)) { progress.textContent = "이미지 파일만 올릴 수 있어요."; photo.value = ""; return; }
    progress.textContent = "사진 줄이는 중…";
    try {
      pendingImage = await shrinkImage(f);
      preview.src = pendingImage.dataUrl; preview.hidden = false;
      progress.textContent = `사진 준비됨 · ${pendingImage.width}×${pendingImage.height} · 약 ${Math.round(pendingImage.bytes / 1024)}KB`;
    } catch (e) { progress.textContent = "사진을 처리하지 못했어요. 사진 없이 제보할 수 있어요."; photo.value = ""; }
  });

  form.addEventListener("submit", async ev => {
    ev.preventDefault();
    if (hp.value) { closeSheet(); return; }                                  // 봇 → 조용히 무시
    const limited = rateLimitCheck(); if (limited) { toast(limited, 3500); return; }
    const type = ["bin", "hotspot", "need"].includes(sel.value) ? sel.value : "hotspot";
    const nm = clean(name.value, CONFIG.NAME_MAX), nt = clean(note.value, CONFIG.NOTE_MAX);
    if (nm.length < 2) { name.focus(); toast("장소 이름을 2자 이상 적어 주세요."); return; }
    if (!consent.checked) { consent.focus(); toast("전달 동의에 체크해 주세요."); return; }
    if (!pick) { toast("지도에서 위치를 눌러 주세요."); return; }

    const item = {
      id: "r-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: type === "need" ? "hotspot" : type, reportType: type,
      name: nm, note: nt, lat: pick.lat, lng: pick.lng,
      hasPhoto: !!pendingImage, sent: false, aiCount: null, aiStatus: null,
      created: new Date().toISOString(),
    };
    submit.disabled = true; submit.textContent = "보내는 중…";
    rateLimitTick();
    myReports.push(item); store.set(REPORT_KEY, myReports);       // 사진은 기기에 남기지 않음
    const image = pendingImage; cancelPick(); render();
    const result = await sendReport(item, image);
    submit.disabled = false; submit.textContent = "제보 보내기";
    applyResult(item, result);
    closeSheet();
    if (!CONFIG.REPORT_ENDPOINT) toast("이 기기에 저장했어요. (제보 서버가 아직 연결되지 않았어요)", 3500);
    else if (result && result.ok) toast(result.ai && result.ai.count != null ? `제보 고마워요. AI 추정 꽁초 ${result.ai.count}개` : "제보 고마워요. 팀이 확인한 뒤 지도에 반영해요.", 3500);
    else toast("서버에 보내지 못해 이 기기에 저장했어요. 핀을 눌러 다시 보낼 수 있어요.", 4000);
  });

  openSheet(h("h2", { text: "제보" }), h("p", { class: "meta", text: "지도에 표시한 위치로 보냅니다. 핀을 옮기려면 지도를 다시 눌러 주세요." }), form);
}

function applyResult(item, result) {
  if (result && result.ok) {
    item.sent = true; item.serverId = result.id || null;
    if (result.ai) { item.aiCount = result.ai.count ?? null; item.aiStatus = result.ai.status || null; }
  }
  store.set(REPORT_KEY, myReports); render();
}
async function resend(item) {
  toast("다시 보내는 중…", 1500);
  const result = await sendReport(item, null);
  applyResult(item, result);
  toast(result && result.ok ? "팀에 전달했어요." : "아직 보내지 못했어요. 잠시 뒤 다시 시도해 주세요.", 3000);
}

// 서버로는 아래 필드만 보냅니다. 위치 권한으로 얻은 '내 위치'는 포함하지 않습니다.
async function sendReport(item, image) {
  if (!CONFIG.REPORT_ENDPOINT) return null;
  const payload = {
    v: 2, id: item.id, device: deviceToken, type: item.reportType, name: item.name, note: item.note, lat: item.lat, lng: item.lng, created: item.created,
    image: image ? image.dataUrl : null,
  };
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), CONFIG.REQUEST_TIMEOUT_MS);
  try {
    // Content-Type을 text/plain으로 두면 preflight 없이 Apps Script 웹앱이 받습니다.
    const res = await fetch(CONFIG.REPORT_ENDPOINT, { method: "POST", body: JSON.stringify(payload), signal: ctrl.signal, headers: { "Content-Type": "text/plain;charset=utf-8" } });
    const data = await res.json().catch(() => ({ ok: res.ok }));
    return data;
  } catch (e) {
    console.warn("[노꽁] 제보 전송 실패:", e.message);
    return null;
  } finally { clearTimeout(timer); }
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

/* =========================================================
   9) 내 제보 내려받기 — 주소 끝에 #export 를 붙이면 버튼이 나타납니다 (이 기기의 제보만, 사진 없음)
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
  } catch (e) {
    console.error(e);
    mapNote("지도를 불러오지 못했어요. 네트워크를 확인한 뒤 새로고침해 주세요.");
  }
})();
