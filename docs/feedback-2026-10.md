# 중간점검 피드백 반영 (2026-10-28, v2)

중간점검(10/14) 때 받은 네 가지 피드백을 어떻게 반영했는지, 남은 일은 무엇인지 정리한 문서다. 최종발표 때 "피드백 → 조치" 슬라이드의 원료로 쓴다.

| 피드백 | 반영 | 파일 |
|---|---|---|
| 1. 팝업 메시지·보안 재점검 | 팝업은 공개용 필드만 표시, 모든 입력값 소독, 사진 EXIF 제거, 제보 횟수 제한, 키는 서버에만 | `app.js`, `index.html` |
| 2. AI 객체 인식 기법·데이터셋 검토 | 핫스팟 분석에는 '객체 검출(개수)'이 맞다는 결론, 공개 데이터셋 3종·오픈 모델 4종 검토, 3단계 계획 | 이 문서 2절, `server/Code.gs` |
| 3. 서버 부하·통신 구조 | 읽기는 정적 파일(서버 호출 0), 쓰기는 제보당 요청 1번, 사진은 기기에서 축소, 집계는 주 1회 오프라인 | 이 문서 3절, `server/Code.gs`, `server/aggregate_hotspots.py` |
| 4. 지도 API를 네이버로 변경 | 네이버 지도 API v3 기본, 키·도메인 문제 시 OpenStreetMap 자동 대체 | `app.js` 4절 |

---

## 1. 팝업 메시지와 보안

### 1-1. 팝업(하단 시트)에 보이는 정보를 공개용으로 줄였다

| 항목 | 이전(v1) | 지금(v2) |
|---|---|---|
| 시설 이름·종류 | 표시 | 표시 |
| 출처 문구("구청 데이터", "이미지(스크린샷)") | 표시 | 표시 안 함 |
| 좌표 정확도 메모("역 중심 좌표(출구 미상)") | 표시 | "위치 확인됨 / 위치 확인 필요" 배지로만 |
| 입력일·내부 메모·id | 표시 | 표시 안 함 |
| 제보 화면의 위도·경도 숫자 | 표시 | 표시 안 함 (지도에 빨간 점으로만) |
| 다른 사람의 제보 | 없음(원래 기기별 저장) | 팀이 검증해 `data/hotspots.js`에 올린 것만 "제보 N건 · 팀 검증"으로 표시 |
| 하단 안내 띠의 팀명 | 표시 | 삭제. 데이터 출처(노원구청)와 위치 정보 미전송 안내만 |

내부 필드(`source`, `accuracy`, `note`, `date`)는 `data/points.js`에 그대로 두되 화면에는 내지 않는다. 저장소 자체가 공개이므로 "숨긴다"가 아니라 "일반 이용자 화면에서는 보이지 않는다"가 정확한 표현이다.

### 1-2. 코드 수준 조치

- **XSS 차단**: 이름·메모 등 사용자가 입력한 값은 `innerHTML`로 넣지 않고 DOM 노드(`textContent`)로만 만든다. 입력값은 저장 전에 태그·URL·제어문자를 지우고 길이를 자른다(이름 40자, 메모 200자). 서버(`Code.gs`)에서 같은 소독을 한 번 더 한다.
- **좌표 정밀도**: 제보 위치는 소수점 5자리(약 1m)로만 저장한다. '내 위치' 버튼으로 얻은 위치는 기기 안에서 거리 계산에만 쓰고 어디에도 보내지 않는다.
- **사진**: 기기에서 긴 변 1024px·JPEG로 다시 인코딩한다. 이 과정에서 촬영 위치·기기 정보(EXIF)가 제거된다. 사진은 브라우저에 남기지 않고, 서버에 보낸 사진은 비공개 드라이브 폴더에만 저장하며 지도에 공개하지 않는다.
- **횟수 제한**: 브라우저에서 1분 1건·하루 20건, 서버에서 기기 토큰당 1분 2건·전체 하루 500건(스크립트 속성 `DAILY_MAX`). 봇이 채우는 숨은 입력칸(honeypot)이 채워지면 조용히 버린다.
- **범위 제한**: 노원구 경계 밖 좌표는 서버가 거부한다.
- **동의 문구**: 제보 폼에 "입력 내용과 위치가 팀에 전달됨, 개인정보는 받지 않음"을 체크하게 했다.
- **키 관리**: 브라우저 코드에는 어떤 비밀 키도 없다. AI 추론 API 키는 Apps Script '스크립트 속성'에만 둔다. 네이버 지도 Client ID는 등록한 도메인에서만 동작하도록 설계된 공개 키라 코드에 넣어도 된다.
- **조회 금지**: 제보 서버는 GET으로 아무 데이터도 돌려주지 않는다. 제보 내용은 팀 시트에서만 본다.
- **외부 의존 최소화**: 웹폰트(jsdelivr) 로딩을 없앴다. 남은 외부 출처는 네이버 지도 SDK(대체 시 cdnjs의 Leaflet)와 제보 서버뿐이다.
- **브라우저 정책**: `index.html`에 최소 CSP(`object-src 'none'; base-uri 'self'; form-action 'self'`)와 referrer 정책을 넣었다. 스크립트 출처까지 제한하는 2단계 정책은 아래 1-4에 있다.

### 1-3. GitHub 계정 정보 노출에 대해

- 사이트 주소(`nimo-coder.github.io`)에 GitHub 아이디가 들어가는 것은 GitHub Pages 구조상 피할 수 없다. 숨기려면 (a) 커스텀 도메인을 연결하거나, (b) Cloudflare Pages·Netlify처럼 비공개 저장소도 무료로 배포해 주는 서비스로 옮기면 된다. 수업 범위에서는 그대로 두고 README·화면에서 개인 이름을 빼는 것으로 충분하다.
- 커밋 기록에는 작성자 이름·이메일이 남는다. GitHub Settings → Emails에서 **Keep my email addresses private**와 **Block command line pushes that expose my email**을 켜 두면 개인 이메일이 공개되지 않는다. 웹 편집기로 커밋하면 자동으로 noreply 주소가 쓰인다.
- README에는 팀원 실명·학번·연락처를 적지 않는다. 발표자료에만 쓴다.

### 1-4. 2단계 CSP (네이버 지도 키 적용 후 지도가 정상이면 교체)

`index.html`의 CSP 메타 태그를 아래로 바꾼다. 바꾼 뒤 브라우저 개발자도구(F12) 콘솔에 "Content Security Policy" 오류가 없고 지도·제보가 되면 유지하고, 지도가 안 뜨면 1단계 줄로 되돌린다. 네이버 SDK가 쓰는 호스트가 바뀔 수 있어 사전에 확정하지 못했다.

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' https://oapi.map.naver.com https://*.pstatic.net https://*.naver.com https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://*.naver.com https://*.naver.net https://*.pstatic.net https://*.ntruss.com https://script.google.com https://script.googleusercontent.com https://tile.openstreetmap.org; object-src 'none'; base-uri 'self'; form-action 'self'; frame-src 'none'">
```

### 1-5. 남은 일

- 프로젝트 종료(12월) 뒤 드라이브의 제보 사진 삭제, 시트는 좌표·개수만 남기고 메모 열 삭제 — 발표 때 "보관 기간"으로 말할 수 있다.
- Apps Script는 요청의 IP·Origin을 볼 수 없다. 악성 제보가 실제로 들어오면 Cloudflare Worker(무료)로 옮겨 Origin 검사와 Turnstile(봇 검사)을 붙인다. 지금 규모(수백 건)에서는 필요 없다.

---

## 2. AI 객체 인식 — 기법 비교와 데이터셋·모델

### 2-1. 결론: 핫스팟 분석에는 '개수'가 필요하므로 인스턴스 단위(객체 검출)로 간다

| 기법 | 출력 | 핫스팟 분석에서의 쓸모 | 라벨링 비용 |
|---|---|---|---|
| 시맨틱 세그멘테이션 | 픽셀마다 "꽁초/배경" | 면적 비율만 나오고 **개수가 안 나온다**. 꽁초가 겹치면 한 덩어리로 합쳐짐 | 픽셀 단위, 높음 |
| 인스턴스 세그멘테이션 | 꽁초 하나하나의 마스크 | 개수 + 면적·방향. 보고서용 시각화에 좋음 | 마스크 단위, 높음 |
| 객체 검출(bounding box) | 꽁초 하나하나의 상자 | **개수만 필요하면 충분**. 라벨링이 마스크의 1/3~1/5 비용 | 상자 단위, 낮음 |

핫스팟 점수는 "사진 1장당 꽁초 개수"와 "같은 지점의 제보 건수"로 만들므로 객체 검출이 가장 효율적이다. 마스크가 필요해지면(면적·분포 그림) 검출 상자를 SAM 2에 넣어 마스크를 뽑으면 되므로, 처음부터 세그멘테이션을 라벨링할 이유가 없다.

주의: 꽁초가 30개 이상 겹쳐 쌓인 사진에서는 어떤 모델이든 개수를 과소 추정한다. 그래서 서비스에서는 정확한 숫자 대신 **구간(0 / 1~5 / 6~20 / 21개 이상)**과 "AI 추정"이라는 표시로 보여 주고, 팀이 사진으로 확인한 값을 최종 데이터로 쓴다.

### 2-2. 쓸 수 있는 공개 데이터셋

| 데이터셋 | 내용 | 라이선스 | 비고 |
|---|---|---|---|
| [TACO](http://tacodataset.org) ([Dataset Ninja 요약](https://datasetninja.com/taco)) | 실외 쓰레기 1,500장, 60종, 9,823개 인스턴스 마스크. 이 중 **cigarette 1,336개(227장)** | CC BY 4.0 | 가장 중요. 거리·보도 배경이라 우리 환경과 비슷 |
| [Immersive Limit Cigarette Butt Dataset](https://www.immersivelimit.com/datasets/cigarette-butts) | 땅 위 꽁초 합성 이미지 2,200장, COCO 형식 마스크 | 비상업·교육용 라이선스(출처 표기) | 수업 프로젝트에 적합. 합성이라 실제 사진과 섞어야 함 |
| [Roboflow Universe](https://universe.roboflow.com) 검색어 "cigarette butt" | 사용자들이 올린 검출용 데이터셋 다수 | 데이터셋마다 다름(확인 필수) | 우리 라벨 형식으로 바로 내려받을 수 있음 |
| 직접 촬영 | 공릉동 핫스팟 3곳에서 100~200장, Roboflow에서 상자 라벨링 | 자체 | **정확도에 가장 큰 영향**. 한국 보도블록·빗물받이·야간 조명이 공개 데이터에 없음 |

### 2-3. 오픈 웨이트 모델

| 모델 | 종류 | 라이선스 | 평가 |
|---|---|---|---|
| Ultralytics YOLO11 n/s (detect, seg) | 검출·인스턴스 세그 | AGPL-3.0 | 학습·배포가 가장 쉬움. 공개 저장소 프로젝트라 라이선스 문제 없음. 나중에 상업화하면 별도 라이선스 필요 |
| Detectron2 Mask R-CNN | 인스턴스 세그 | Apache-2.0 | TACO 논문의 기준 모델. 느리고 무겁지만 마스크 품질 좋음 |
| OWLv2 / Grounding DINO | 제로샷 검출(글로 "cigarette butt"를 주면 상자) | Apache-2.0 | **학습 없이 당장 시연 가능**. 작은 물체에는 정밀도가 낮고 느림 |
| SAM 2 | 상자·점 → 마스크 | Apache-2.0 | 검출 결과에 마스크가 필요할 때만 |

### 2-4. 3단계 계획

1. **이번 주 — 제로샷 시연**: OWLv2(또는 Grounding DINO)를 Hugging Face Inference API로 호출해 "cigarette butt" 상자를 그린다. 학습 없이 AI가 동작하는 모습을 보여 주고, 공릉동 사진 30장에서 정밀도·재현율을 손으로 센다.
2. **11월 1~2주 — 학습 모델**: Roboflow 프로젝트에 TACO의 cigarette 라벨 + 합성 데이터 일부 + 직접 찍은 150장을 넣고 YOLO11n을 학습(Roboflow Train 또는 Colab 무료 GPU, 30분 안팎). 입력 해상도 1024로 올리면 작은 꽁초 검출이 좋아진다. Roboflow Hosted Inference로 배포하면 `server/Code.gs`가 바로 호출한다(스크립트 속성 `AI_PROVIDER=roboflow`).
3. **11월 3주 — 평가**: 학습에 쓰지 않은 공릉동 사진 30장으로 (a) 검출 정밀도·재현율(IoU 0.5), (b) 개수 오차(MAE), (c) 헷갈리는 물체(낙엽·돌·빨대) 사례를 정리해 최종발표 '한계' 슬라이드에 넣는다.

GPU가 없어도 된다: 학습은 Colab, 추론은 Roboflow 호스팅(무료 할당량은 요금 페이지에서 확인 — 미확인). 개인정보: 사진에 얼굴·번호판이 찍히지 않게 안내하고, 찍힌 사진은 학습에서 제외한다.

---

## 3. 서버 부하와 통신 구조

### 3-1. 규모 가정

6주 캠페인, 하루 최대 50건(부스 운영일), 총 500건 이하. 사진 1장 평균 250KB(기기 축소 후) → 하루 12.5MB, 전체 125MB. 어떤 무료 서비스로도 충분하다. 설계 목표는 "요청 수를 늘리지 않는 것"과 "실패해도 사용자가 다시 보낼 수 있는 것"이다.

### 3-2. 읽기와 쓰기를 분리

```
[읽기] 브라우저 ── GitHub Pages(CDN) ──▶ index.html, app.js, data/points.js, data/hotspots.js   (서버 호출 0회)
[쓰기] 브라우저 ──(제보 1건 = 요청 1번, JSON + 축소 사진)──▶ Apps Script 웹앱
            │  1) 검증·횟수 제한 (수십 ms)
            │  2) 시트에 한 줄 추가 (~0.5초)
            │  3) 사진을 비공개 드라이브에 저장 (~1초, 선택)
            │  4) Roboflow 추론 호출 (1~3초, 선택)
            ◀── {ok, ai:{count,status}}  (총 2~6초, 브라우저 제한 15초)
[집계] 팀이 주 1회  server/aggregate_hotspots.py  →  data/hotspots.js  →  저장소 커밋  (지도는 정적 파일만 읽음)
```

- 폴링·웹소켓·주기적 위치 전송이 없다. 지도 열람자는 서버에 아무 요청도 보내지 않는다.
- 사진은 서버에 올리기 전에 기기에서 줄인다(원본 3~5MB → 150~300KB). 서버 전송량이 10분의 1로 줄고, EXIF도 함께 제거된다.
- AI 추론은 제보 요청 안에서 한 번만 호출한다. 사진이 없으면 호출하지 않는다. 추론이 실패해도 제보는 저장되고(`aiStatus=error`), 나중에 팀이 사진을 보고 채운다.
- 요청이 실패하면 브라우저에 저장해 두고 핀에서 "팀에 다시 보내기"로 재전송한다.
- 핫스팟 집계는 요청마다 하지 않고 오프라인 배치로 한다. 결과는 정적 파일이라 열람 부하가 0이다.

### 3-3. 제한값 한눈에

| 위치 | 제한 | 값 |
|---|---|---|
| 브라우저 | 제보 간격 / 하루 | 60초 / 20건 |
| 브라우저 | 사진 | 긴 변 1024px, 600KB 이하, JPEG |
| 브라우저 | 요청 시간 초과 | 15초 |
| 서버 | 기기 토큰당 | 1분 2건 |
| 서버 | 전체 하루 | 500건(`DAILY_MAX`) |
| 서버 | 요청 본문 | 1.5MB |
| 서버 | 좌표 | 노원구 경계 안만 |
| Apps Script 자체 | 실행 시간 6분, 외부 호출 하루 2만 회(개인 계정) | 우리 규모의 40배 |

### 3-4. 늘어나면

하루 500건을 넘기거나 악성 제보가 보이면 Cloudflare Worker(무료 10만 요청/일)로 수신부를 옮긴다. Origin 헤더 검사, IP 단위 제한, Turnstile을 붙일 수 있고 시트·드라이브 저장은 그대로 쓴다. `app.js`는 `REPORT_ENDPOINT` 주소만 바꾸면 된다.

---

## 4. 네이버 지도 API 전환

### 4-1. 발급과 설정

1. [네이버 클라우드 플랫폼](https://www.ncloud.com) 가입 → 콘솔 → **Services > Application Services > Maps > Application** → 등록
2. 서비스 선택에서 **Dynamic Map(Web)** 체크 (체크하지 않으면 429 오류)
3. **Web 서비스 URL**에 `https://nimo-coder.github.io` 등록. 로컬 테스트용으로 `http://localhost:8080` 같은 주소도 추가
4. 인증 정보에서 **Client ID** 복사 → `app.js`의 `CONFIG.NAVER_KEY_ID`에 붙여넣기 → 커밋
5. 스크립트 주소는 `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=...`다. 블로그 예제의 `ncpClientId`는 옛 방식이라 인증 실패가 난다([공식 안내](https://navermaps.github.io/maps.js.en/docs/tutorial-1-Getting-Client-ID.html)).

### 4-2. 요금

- 2025년 7월 1일부터 옛 'AI NAVER API' 안의 지도 API는 무료 이용량이 끝나고 전액 과금으로 바뀌었다([NCP 공지](https://www.gov-ncloud.com/support/notice/all/528)). 새 **Maps** 상품으로 신청해야 무료 이용량을 받는다.
- 새 Maps 상품의 무료 이용량은 **대표 계정 1개**에만 제공된다([NCP Maps 개요](https://guide.ncloud-docs.com/docs/maps-overview)). 정확한 월 무료 건수는 콘솔 요금 페이지에서 확인할 것(미확인). 콘솔에서 **이용 한도**를 직접 설정할 수 있으니 과금이 나지 않도록 한도를 무료 범위 안으로 걸어 둔다.
- 수업 프로젝트 조회량(수천 건)은 무료 범위 안이다. 그래도 결제 수단 등록이 필요하므로 팀원 한 명의 계정으로 등록하고 종료 후 애플리케이션을 삭제한다.

### 4-3. 동작 방식

- `app.js`가 네이버 SDK를 동적으로 불러온다. 키가 비어 있거나 인증에 실패하면(`navermap_authFailure`) 자동으로 OpenStreetMap(Leaflet)으로 대체하고 화면 아래에 8초간 안내를 띄운다. 발표 당일 키 문제가 생겨도 지도는 뜬다.
- 지도 라이브러리와 무관한 어댑터(`addMarker / onClick / fitTwo / setView`)로 감싸서, 나중에 카카오맵으로 바꿔도 앱 코드는 그대로다.
- 네이버 로고·저작권 표시는 SDK가 그리며 지우면 약관 위반이다. OSM 대체 시에는 "© OpenStreetMap contributors"가 표시된다.

### 4-4. 확인 방법

배포 후 개발자도구 콘솔에 "Authentication Failed"가 보이면 Web 서비스 URL 등록이 잘못된 것이다. `https`와 `http`, 끝의 `/` 유무를 정확히 맞춘다.
