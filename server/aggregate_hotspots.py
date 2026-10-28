#!/usr/bin/env python3
"""
노꽁 핫스팟 집계 — 제보 시트(CSV) → data/hotspots.js + 구청 제안용 CSV

왜 따로 돌리나: 지도는 정적 파일만 읽습니다(서버 부하 0). 제보는 시트에 쌓이고,
팀이 일주일에 한 번 이 스크립트로 묶어서 검증한 뒤 hotspots.js 를 저장소에 올립니다.

사용법
  1) 구글 시트에서 파일 > 다운로드 > CSV 로 저장 (예: reports.csv)
  2) 팀 검증: 시트의 status 열을 verified / rejected 로 표시 (기본은 new)
  3) python3 server/aggregate_hotspots.py reports.csv --out data/hotspots.js --report hotspots.csv
     옵션: --radius 40 (묶는 반경 m, 기본 40)  --min 2 (최소 제보 건수, 기본 2)  --include-new (status=new 도 포함)
  4) index.html 의 data/hotspots.js?v= 숫자를 올리고 커밋
"""
import argparse, csv, json, math, sys
from collections import Counter
from datetime import date

def haversine(a, b):
    R = 6371000.0
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    s = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(s))

def load_rows(path, include_new):
    rows = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            if (r.get("type") or "") not in ("hotspot", "need"):
                continue
            status = (r.get("status") or "new").strip().lower()
            if status == "rejected" or (status == "new" and not include_new):
                continue
            try:
                lat, lng = float(r["lat"]), float(r["lng"])
            except (KeyError, ValueError):
                continue
            ai = r.get("aiCount")
            rows.append({
                "lat": lat, "lng": lng, "name": (r.get("name") or "").strip(),
                "type": r["type"], "ai": float(ai) if ai not in (None, "", "null") else None,
                "ts": r.get("timestamp") or "",
            })
    return rows

def cluster(rows, radius_m):
    clusters = []
    for r in sorted(rows, key=lambda x: x["ts"]):
        for c in clusters:
            if haversine((r["lat"], r["lng"]), (c["lat"], c["lng"])) <= radius_m:
                c["rows"].append(r)
                n = len(c["rows"])
                c["lat"] = sum(x["lat"] for x in c["rows"]) / n   # 중심을 평균으로 갱신
                c["lng"] = sum(x["lng"] for x in c["rows"]) / n
                break
        else:
            clusters.append({"lat": r["lat"], "lng": r["lng"], "rows": [r]})
    return clusters

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--out", default="data/hotspots.js")
    ap.add_argument("--report", default="hotspots.csv")
    ap.add_argument("--radius", type=float, default=40)
    ap.add_argument("--min", type=int, default=2)
    ap.add_argument("--include-new", action="store_true")
    a = ap.parse_args()

    rows = load_rows(a.csv, a.include_new)
    clusters = [c for c in cluster(rows, a.radius) if len(c["rows"]) >= a.min]
    clusters.sort(key=lambda c: -len(c["rows"]))
    today = date.today().isoformat()
    out = []
    for i, c in enumerate(clusters, 1):
        names = Counter(x["name"] for x in c["rows"] if x["name"])
        ais = [x["ai"] for x in c["rows"] if x["ai"] is not None]
        out.append({
            "id": f"h-{i:03d}",
            "name": names.most_common(1)[0][0] if names else f"핫스팟 {i}",
            "lat": round(c["lat"], 5), "lng": round(c["lng"], 5),
            "count": len(c["rows"]),
            "needCount": sum(1 for x in c["rows"] if x["type"] == "need"),
            "aiAvg": round(sum(ais) / len(ais), 1) if ais else None,
            "updated": today,
        })

    with open(a.out, "w", encoding="utf-8") as f:
        f.write("// 노꽁 핫스팟 데이터 — server/aggregate_hotspots.py 가 생성 (" + today + ")\n")
        f.write("// 필드: id, name, lat, lng, count(제보 건수), needCount(꽁초함 필요 제보), aiAvg(AI 추정 꽁초 평균), updated\n")
        f.write("const HOTSPOTS = " + json.dumps(out, ensure_ascii=False, indent=2) + ";\n")
    with open(a.report, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["id", "이름", "위도", "경도", "제보 건수", "꽁초함 필요 제보", "AI 추정 꽁초 평균", "기준일"])
        for o in out:
            w.writerow([o["id"], o["name"], o["lat"], o["lng"], o["count"], o["needCount"], o["aiAvg"] if o["aiAvg"] is not None else "", o["updated"]])
    print(f"제보 {len(rows)}건 → 핫스팟 {len(out)}곳 (반경 {a.radius:.0f}m, 최소 {a.min}건) → {a.out}, {a.report}")

if __name__ == "__main__":
    sys.exit(main())
