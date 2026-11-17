/* test-csp.html 전용 스크립트 (CSP 가 인라인 스크립트를 막으므로 외부 파일). 점검이 끝나면 두 파일 모두 삭제해도 됩니다. */
(function () {
  var KEY = "wces4uwwx1";
  var out = document.getElementById("out"), sum = document.getElementById("sum");
  var t0 = Date.now(), lines = [], violations = [];
  function log(s) { lines.push("+" + String(Date.now() - t0).padStart(5) + "ms  " + s); out.textContent = lines.join("\n"); }
  document.addEventListener("securitypolicyviolation", function (e) {
    var v = e.violatedDirective + " ← " + (e.blockedURI || "(inline)") + (e.sourceFile ? "  @" + e.sourceFile.split("/").pop() + ":" + e.lineNumber : "");
    violations.push(v); log("★ CSP 위반: " + v);
  });
  window.addEventListener("error", function (e) { log("JS 오류 → " + e.message); });
  window.navermap_authFailure = function () { log("★ 네이버 인증 실패 (CSP 와 무관: NCP 등록 확인)"); };
  log("페이지: " + location.href);

  function load(src, integrity) {
    return new Promise(function (res, rej) {
      var s = document.createElement("script"); s.src = src; s.async = true;
      if (integrity) { s.integrity = integrity; s.crossOrigin = "anonymous"; }
      s.onload = res; s.onerror = function () { rej(new Error("load failed: " + src)); }; document.head.appendChild(s);
    });
  }
  function css(href, integrity) {
    return new Promise(function (res) { var l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; if (integrity) { l.integrity = integrity; l.crossOrigin = "anonymous"; } l.onload = res; l.onerror = res; document.head.appendChild(l); });
  }
  var R = { naverTiles: 0, naverOk: false, leafletTiles: 0, leafletOk: false };

  // A. 네이버
  load("https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=" + KEY).then(function () {
    var tries = 0;
    (function wait() {
      if (window.naver && window.naver.maps && window.naver.maps.Map) {
        try {
          var N = window.naver.maps, m = new N.Map(document.getElementById("mA"), { center: new N.LatLng(37.6255, 127.08), zoom: 15 });
          N.Event.addListener(m, "tilesloaded", function () { R.naverOk = true; });
          log("네이버 지도 객체 생성");
        } catch (e) { log("★ 네이버 지도 생성 오류: " + e.message); }
        return;
      }
      if (++tries > 40) return log("★ naver.maps.Map 없음");
      setTimeout(wait, 200);
    })();
  }).catch(function (e) { log("★ " + e.message); });

  // B. Leaflet (SRI)
  css("https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", "sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=")
    .then(function () { return load("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="); })
    .then(function () {
      var L = window.L, m = L.map("mB").setView([37.6255, 127.08], 15);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).on("load", function () { R.leafletOk = true; }).addTo(m);
      log("Leaflet 로드 성공 (SRI 통과)");
    }).catch(function (e) { log("★ Leaflet 로드 실패(SRI 불일치 또는 차단): " + e.message); });

  setTimeout(function () {
    ["mA", "mB"].forEach(function (id) {
      var imgs = Array.prototype.slice.call(document.getElementById(id).querySelectorAll("img"));
      var n = imgs.filter(function (i) { return i.complete && i.naturalWidth > 0; }).length;
      if (id === "mA") R.naverTiles = n; else R.leafletTiles = n;
      log(id + ": 타일 이미지 로드 " + n + "개");
    });
    var okA = R.naverOk || R.naverTiles > 0, okB = R.leafletOk || R.leafletTiles > 0;
    var head = "네이버 지도 " + (okA ? "정상 ✅" : "실패 ❌") + " · OSM 대체 지도 " + (okB ? "정상 ✅" : "실패 ❌") + " · CSP 위반 " + violations.length + "건";
    var verdict = okA && okB && !violations.length ? "결론: 이 CSP 로 index.html 을 교체해도 됩니다."
      : violations.length ? "결론: 위 '★ CSP 위반' 줄의 도메인을 index.html CSP 의 해당 지시어에 추가한 뒤 다시 점검. (그대로 보내 주면 고쳐 줄게요)"
      : "결론: CSP 위반은 없는데 지도가 안 그려짐 → 네트워크·NCP 등록 문제. 이 화면 그대로 보내 주기.";
    sum.textContent = head + "\n" + verdict; sum.className = okA && okB && !violations.length ? "ok" : "bad";
    log("=== 점검 끝 ===");
  }, 12000);

  document.getElementById("copy").onclick = function () {
    var txt = sum.textContent + "\n\n" + lines.join("\n"), btn = document.getElementById("copy");
    function sel() { var r = document.createRange(); r.selectNodeContents(out); var s = getSelection(); s.removeAllRanges(); s.addRange(r); btn.textContent = "선택됨 — Ctrl+C 로 복사"; }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(function () { btn.textContent = "복사됨 — 채팅에 붙여넣기"; }, sel); else sel();
  };
})();
