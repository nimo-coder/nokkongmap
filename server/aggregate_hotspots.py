#!/usr/bin/env python3
"""
노꽁 핫스팟 집계 v3 — 제보 시트(reports_v3 CSV) → data/hotspots.js + 구청 제안용 CSV

왜 따로 돌리나: 지도는 정적 파일만 읽습니다(서버 부하 0). 제보는 시트에 쌓이고, 팀이 주 1회 검증(status=verified)한 뒤
이 스크립트로 묶어서 hotspots.js 를 저장소에 올립니다. '꽁초함 필요'는 제보 종류가 아니라 여기서 자동 판정합니다:
핫스팟 중심에서 --need-radius(기본 100m) 안에 꽁초함(points.js 의 type=bin)이 없으면 needBin=true.

사용법
  1) 구글 시트 reports_v3 탭 → 파일 > 다운로드 > CSV (예: reports.csv)
  2) 시트의 status 열을 verified / rejected 로 표시 (기본 new 는 제외, --include-new 로 포함 가능)
  3) python3 server/aggregate_hotspots.py reports.csv --bins data/points.js --out data/hotspots.js --report hotspots.csv
     옵션: --radius 40 (묶는 반경 m)  --min 2 (최소 제보 건수)  --need-radius 100 (꽁초함 부재 판정 반경 m)  --include-new
  4) index.html 의 data/hotspots.js?v= 숫자를 올리고 커밋
"""
import argparse, csv, json, math, re, sys
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
            if (r.get("type") or "") != "hotspot":      # 'need'(사각지대) 종류는 2026-11-18 삭제. 꽁초함 필요는 needBin 으로 자동 판정
                continue
            status = (r.get("status") or "new").strip().lower()
            if status == "rejected" or (status == "new" and not include_new):
                continue
            try:
                lat, lng = float(r["lat"]), float(r["lng"])
            except (KeyError, ValueError, TypeError):
                continue
            ai = (r.get("aiCount") or "").strip()
            rows.append({
                "lat": lat, "lng": lng, "name": (r.get("name") or "").strip(),
                "ai": float(ai) if ai not in ("", "null") else None,
                "density": (r.get("aiDensity") or "").strip(),
                "ts": (r.get("takenAt") or r.get("timestamp") or "")[:10],
            })
    return rows

def load_bins(path):
    """data/points.js 에서 const DATA = [...] 를 읽어 꽁초함(bin) 좌표만 돌려줍니다."""
    if not path:
        return []
    txt = open(path, encoding="utf-8").read()
    m = re.search(r"const\s+DATA\s*=\s*(\[.*?\]);", txt, re.S)
    if not m:
        return []
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError:
        sys.stderr.write("points.js 를 JSON 으로 읽지 못했습니다(후행 쉼표·주석 확인)\n")
        return []
    return [(d["lat"], d["lng"]) for d in data if d.get("type") == "bin" and d.get("inScope", True)]

def cluster(rows, radius_m):
    clusters = []
    for r in sorted(rows, key=lambda x: x["ts"]):
        for c in clusters:
            if haversine((r["lat"], r["lng"]), (c["lat"], c["lng"])) <= radius_m:
                c["rows"].append(r)
                n = len(c["rows"])
                c["lat"] = sum(x["lat"] for x in c["rows"]) / n
                c["lng"] = sum(x["lng"] for x in c["rows"]) / n
                break
        else:
            clusters.append({"lat": r["lat"], "lng": r["lng"], "rows": [r]})
    return clusters

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--bins", default="data/points.js")
    ap.add_argument("--out", default="data/hotspots.js")
    ap.add_argument("--report", default="hotspots.csv")
    ap.add_argument("--radius", type=float, default=40)
    ap.add_argument("--min", type=int, default=2)
    ap.add_argument("--need-radius", type=float, default=100)
    ap.add_argument("--include-new", action="store_true")
    a = ap.parse_args()

    rows = load_rows(a.csv, a.include_new)
    bins = load_bins(a.bins)
    clusters = [c for c in cluster(rows, a.radius) if len(c["rows"]) >= a.min]
    clusters.sort(key=lambda c: -len(c["rows"]))
    today = date.today().isoformat()
    out = []
    for i, c in enumerate(clusters, 1):
        names = Counter(x["name"] for x in c["rows"] if x["name"] and x["name"] != "무단투기 현장")
        ais = [x["ai"] for x in c["rows"] if x["ai"] is not None]
        nearest = min((haversine((c["lat"], c["lng"]), b) for b in bins), default=None)
        out.append({
            "id": f"h-{i:03d}",
            "name": names.most_common(1)[0][0] if names else f"핫스팟 {i}",
            "lat": round(c["lat"], 5), "lng": round(c["lng"], 5),
            "count": len(c["rows"]),
            "aiAvg": round(sum(ais) / len(ais), 1) if ais else None,
            "highCount": sum(1 for x in c["rows"] if x["density"] == "high"),
            "nearestBinM": round(nearest) if nearest is not None else None,
            "needBin": nearest is None or nearest > a.need_radius,
            "lastSeen": max((x["ts"] for x in c["rows"] if x["ts"]), default=""),
            "updated": today,
        })

    with open(a.out, "w", encoding="utf-8") as f:
        f.write("// 노꽁 핫스팟 데이터 — server/aggregate_hotspots.py 가 생성 (" + today + ")\n")
        f.write("// 필드: id, name, lat, lng, count(제보 건수), aiAvg(AI 추정 꽁초 평균), highCount(밀집도 높음 건수),\n")
        f.write("//       nearestBinM(가장 가까운 꽁초함 거리 m), needBin(반경 안에 꽁초함 없음 → 설치 후보), lastSeen, updated\n")
        f.write("const HOTSPOTS = " + json.dumps(out, ensure_ascii=False, indent=2) + ";\n")
    with open(a.report, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["id", "이름", "위도", "경도", "제보 건수", "AI 추정 꽁초 평균", "밀집도 높음 건수", "가장 가까운 꽁초함(m)", "꽁초함 설치 후보", "마지막 제보일", "기준일"])
        for o in out:
            w.writerow([o["id"], o["name"], o["lat"], o["lng"], o["count"], o["aiAvg"] if o["aiAvg"] is not None else "", o["highCount"],
                        o["nearestBinM"] if o["nearestBinM"] is not None else "없음", "예" if o["needBin"] else "", o["lastSeen"], o["updated"]])
    print(f"제보 {len(rows)}건, 꽁초함 {len(bins)}곳 기준 → 핫스팟 {len(out)}곳 (반경 {a.radius:.0f}m, 최소 {a.min}건, 설치 후보 {sum(1 for o in out if o['needBin'])}곳) → {a.out}, {a.report}")

if __name__ == "__main__":
    sys.exit(main())
