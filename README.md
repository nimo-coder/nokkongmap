# 노꽁 — 노원구 꽁초함 지도

노원구 공릉동 일대의 담배꽁초 수거함·흡연부스 위치를 보여 주고, 가장 가까운 꽁초함을 찾아 주며, 무단투기 핫스팟과 꽁초함이 필요한 곳을 시민이 제보하는 웹 지도입니다. 담배 필터는 플라스틱이고 길에 버린 꽁초는 빗물받이를 거쳐 하천과 바다로 흘러간다는 사실을 알리는 서울여자대학교 바롬종합설계프로젝트 팀 과제입니다.

사이트: https://nimo-coder.github.io/nokkongmap/

## 기능

- 꽁초함(주황) · 흡연부스·흡연구역(파랑) · 무단투기 핫스팟(빨강, 팀 검증) 핀과 레이어 켜고 끄기
- 내 위치에서 가장 가까운 꽁초함(자료가 없으면 흡연부스) 거리·도보 시간, 카카오맵 길찾기
- 제보: 지도에서 위치 지정 → 종류·장소 이름·메모·사진(선택) → 팀 시트로 전송. 사진은 기기에서 축소하고 촬영 정보(EXIF)를 지운 뒤 보내며, 서버에서 AI가 꽁초 개수를 추정합니다(참고값)
- 위치 정보는 기기 안에서만 계산하고 전송하지 않습니다. 이름·연락처 등 개인정보는 받지 않습니다

## 구조

```
index.html                  화면·스타일 (데이터·앱 스크립트를 불러옴)
app.js                      앱 로직: 지도 어댑터(네이버 지도 API v3 / OSM 대체), 제보, 사진 축소, 횟수 제한
data/points.js              꽁초함·흡연부스 데이터 (구청 자료·답사)
data/hotspots.js            팀이 검증한 핫스팟 (server/aggregate_hotspots.py 로 생성)
server/Code.gs              제보 수신 Apps Script 웹앱 (시트 기록 · 비공개 사진 저장 · AI 추론 호출)
server/aggregate_hotspots.py 제보 시트 CSV → hotspots.js + 구청 제안용 CSV
docs/feedback-2026-10.md    중간점검 피드백 반영 내용 (보안 · AI 기법 · 서버 구조 · 지도 API)
```

## 설정

`app.js` 맨 위 `CONFIG`만 고칩니다.

| 키 | 값 |
|---|---|
| `NAVER_KEY_ID` | 네이버 클라우드 플랫폼 Maps > Application 의 Client ID. 비우면 OpenStreetMap으로 표시 |
| `REPORT_ENDPOINT` | `server/Code.gs` 를 웹앱으로 배포한 URL. 비우면 제보가 브라우저에만 저장 |

AI 추론 키 등 비밀 값은 브라우저 코드에 넣지 않고 Apps Script 스크립트 속성에만 둡니다. 자세한 배포 순서는 `server/Code.gs` 상단 주석을 보세요.

## 데이터 갱신

- 꽁초함·흡연부스를 추가하면 `data/points.js`에 같은 형식으로 넣고, `index.html`의 `data/points.js?v=` 숫자를 하나 올립니다(브라우저 캐시 갱신).
- 핫스팟: 제보 시트를 CSV로 내려받아 `python3 server/aggregate_hotspots.py reports.csv` → 생성된 `data/hotspots.js`를 올리고 `?v=` 숫자를 올립니다.

## 데이터 출처

- 흡연부스·흡연구역: 서울특별시 노원구 흡연시설현황(2026년 4월 기준), 현장 답사
- 지도: NAVER Maps API v3 (대체 시 © OpenStreetMap contributors)
