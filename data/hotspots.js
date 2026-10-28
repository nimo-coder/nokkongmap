// 노꽁 핫스팟 데이터 — 시민 제보를 팀이 검증한 뒤 올리는 파일입니다.
// server/aggregate_hotspots.py 가 제보 시트(CSV)에서 이 파일을 만들어 줍니다. 직접 편집해도 됩니다.
// 필드: id, name, lat, lng, count(제보 건수), aiAvg(AI 추정 꽁초 평균, 없으면 null), updated(YYYY-MM-DD)
// 값을 바꾸면 index.html 의 data/hotspots.js?v= 숫자를 올려 주세요.
const HOTSPOTS = [
  // { id: "h-001", name: "공릉역 2번 출구 버스정류장", lat: 37.62530, lng: 127.07280, count: 4, aiAvg: 18, updated: "2026-11-01" },
];
