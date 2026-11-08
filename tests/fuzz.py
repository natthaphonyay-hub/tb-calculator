#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""สุ่มเทียบตัวคำนวณจริง (index.html ผ่าน node) กับตัวคำนวณแยก tests/reference.py ที่ตัวลูกเขียนจากสเปกอย่างเดียว

ใช้: python3 -I tests/fuzz.py [จำนวนคู่ปรับยาแบบสุ่ม=40000] [seed=20261108]
ไล่ครบ: น้ำหนัก 20.0 ถึง 200.0 ทีละ 0.1 กก. (1,801 ค่า) + ค่าผิดรูปแบบ, วันเริ่มยาทุกวัน 2024 ถึง 2035
สุ่ม: คู่น้ำหนักเดิมกับใหม่ ทั้ง 2 ระยะ บางคู่ใส่ขนาดที่กินอยู่จริงเอง, ข้อความ note ที่เภสัชแก้จำนวนเม็ด
ล้มเมื่อ: ผลไม่ตรงแม้แต่ข้อเดียว หรือเคสที่ควรคำนวณได้กลับคำนวณไม่ได้
"""
import datetime as dt
import json
import pathlib
import random
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import reference as ref  # noqa: E402

N = int(sys.argv[1]) if len(sys.argv) > 1 else 40000
SEED = int(sys.argv[2]) if len(sys.argv) > 2 else 20261108
rnd = random.Random(SEED)


def w_str(w10):
    return f"{w10 // 10}.{w10 % 10}"


def random_w10():
    r = rnd.random()
    if r < 0.35:  # ใกล้ขอบแถวและจุดเตือน
        base = rnd.choice([200, 350, 500, 700, 803, 1003, 2000])
        return max(200, min(2000, base + rnd.randint(-15, 15)))
    return rnd.randint(200, 2000)


def random_current(phase):
    codes = ["H", "R", "Z", "E"] if phase == "intensive" else ["H", "R"]
    out = {}
    for c in codes:
        if rnd.random() < 0.6:
            out[c] = rnd.choice(sorted(ref._COMBO[c]))
    return out or None


def random_edits():
    sizes = {"H": [100], "R": [300, 450], "Z": [500], "E": [400, 500]}
    edits = {}
    for c, ss in sizes.items():
        if rnd.random() < 0.5:
            e = {str(s): rnd.randint(0, 6) for s in ss}
            if sum(e.values()) == 0:
                e[str(ss[0])] = 1
            edits[c] = e
    return edits or None


scen = []
# 1) regimen ทุกน้ำหนักที่รับได้ + อายุหลายค่า
for w10 in range(200, 2001):
    scen.append({"kind": "regimen", "age": 45, "weight": w_str(w10)})
for age in (0, 10, 15, 16, 17, 60, 61, 99):
    for w in ("52.0", "30.0", "80.5"):
        scen.append({"kind": "regimen", "age": age, "weight": w})
for bad in ("19.9", "200.1", "52.25", "52.20", "abc", "", " 52.0 ", "52", "0", "12345", "35", "70"):
    scen.append({"kind": "regimen", "age": 45, "weight": bad})
n_regimen = len(scen)
# 2) วันเริ่มยาทุกวัน
d = dt.date(2024, 1, 1)
while d < dt.date(2036, 1, 1):
    scen.append({"kind": "dates", "start": d.isoformat()})
    d += dt.timedelta(days=1)
n_dates = len(scen) - n_regimen
# 3) คู่ปรับยาสุ่ม
for _ in range(N):
    ph = rnd.choice(["intensive", "continuation"])
    p = {"kind": "adjust", "age": 45, "old": w_str(random_w10()), "new": w_str(random_w10()), "phase": ph}
    if rnd.random() < 0.3:
        p["current"] = random_current(ph)
    scen.append(p)
# 4) ข้อความ note สุ่มการแก้ของเภสัช (ตรวจในตัวจริงอย่างเดียว: ASCII + ไทย ไม่มี undefined/NaN)
n_notes = max(2000, N // 10)
for _ in range(n_notes):
    ph = rnd.choice(["intensive", "continuation"])
    scen.append({"kind": "notes", "age": 45, "weight": w_str(random_w10()), "start": rnd.choice(["2026-11-08", "2026-12-31", "2028-02-29"]),
                 "edits": random_edits(), "old": w_str(random_w10()), "phase": ph})

tmp = ROOT / "tmp"
tmp.mkdir(exist_ok=True)
path = tmp / "fuzz-scenarios.json"
path.write_text(json.dumps(scen, ensure_ascii=False), encoding="utf-8")
out = subprocess.run(["node", str(HERE / "run-engine.mjs"), str(path)], capture_output=True, text=True, check=True)
got = json.loads(out.stdout)
assert len(got) == len(scen), (len(got), len(scen))

bad, computed = [], {"regimen": 0, "dates": 0, "adjust": 0, "notes": 0}
for p, g in zip(scen, got):
    k = p["kind"]
    if k == "regimen":
        e = ref.regimen(p["age"], p["weight"])
    elif k == "dates":
        e = ref.dates(p["start"])
    elif k == "adjust":
        e = ref.adjust(p["age"], p["old"], p["new"], p["phase"], p.get("current"))
    else:
        e = None
        if not g.get("ok") or not g.get("safe") or g.get("bad"):
            bad.append((p, g, "note not ASCII+Thai or has undefined/NaN"))
        else:
            computed["notes"] += 1
        continue
    if g != e:
        bad.append((p, g, e))
    elif k != "dates" and e.get("ok"):
        computed[k] += 1
    elif k == "dates":
        computed[k] += 1

# เคสที่ออกแบบให้คำนวณได้ ต้องคำนวณได้จริง (กันตรวจข้ามเงียบ)
must = 1801 + 3 * 5  # น้ำหนักที่รับได้ทุกค่า + อายุ 16 17 60 61 99 x 3 น้ำหนัก
assert computed["regimen"] >= must + 4, computed  # + "52" " 52.0 " "35" "70"
assert computed["dates"] == n_dates, computed

print(f"seed {SEED}")
print(f"regimen {n_regimen} เคส (คำนวณได้ {computed['regimen']}) dates {n_dates} วัน adjust {N} คู่ (คำนวณได้ {computed['adjust']}) notes {n_notes} ฉบับ (ผ่าน {computed['notes']})")
print(f"รวม {len(scen)} เคส ไม่ตรง {len(bad)}")
for p, g, e in bad[:10]:
    print("ไม่ตรง:", json.dumps(p, ensure_ascii=False), "\n  ตัวจริง:", json.dumps(g, ensure_ascii=False), "\n  ตัวแยก:", json.dumps(e, ensure_ascii=False))
sys.exit(1 if bad else 0)
