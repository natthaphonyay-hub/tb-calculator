"""Reference (independent) TB dose calculator, written from spec only.
Fraction arithmetic throughout; no float; stdlib only."""
import calendar
import datetime
import itertools
import re
from fractions import Fraction

# code: (tablet sizes, lo, hi, target, max dose or None)
DRUGS = {
    "H": ([100], 4, 6, 5, 300),
    "R": ([300, 450], 8, 12, 10, 600),
    "Z": ([500], 20, 30, 25, None),
    "E": ([400, 500], 15, 20, 15, None),
}
ORDER = ["H", "R", "Z", "E"]
ROWS = {
    "row1": {"H": 300, "R": 450, "Z": 1000, "E": 800},
    "row2": {"H": 300, "R": 600, "Z": 1500, "E": 1000},
    "row3": {"H": 300, "R": 600, "Z": 2000, "E": 1200},
}
MAXTAB = 8
_WRE = re.compile(r"^[0-9]+(\.[0-9])?$")


def _tenths(dose, w):
    """round-half-up of dose/w to 1 decimal, as integer tenths."""
    x = Fraction(dose * 10) / w
    return (x.numerator * 2 + x.denominator) // (x.denominator * 2)


def _fmt(t):
    return "%d.%d" % (t // 10, t % 10)


def _combos(code):
    """dose -> (tabs dict, count): fewest tabs, tie -> larger tablets."""
    sizes, _, _, _, mx = DRUGS[code]
    desc = sorted(sizes, reverse=True)
    best = {}
    for counts in itertools.product(range(MAXTAB + 1), repeat=len(desc)):
        n = sum(counts)
        if n == 0 or n > MAXTAB:
            continue
        dose = sum(c * s for c, s in zip(counts, desc))
        if mx is not None and dose > mx:
            continue
        key = (n, tuple(-c for c in counts))
        if dose not in best or key < best[dose][0]:
            best[dose] = (key, counts)
    out = {}
    for dose, (key, counts) in best.items():
        out[dose] = ({str(s): c for s, c in zip(desc, counts) if c > 0}, key[0])
    return out


_COMBO = {c: _combos(c) for c in DRUGS}


def _tabs(code, dose):
    if dose in _COMBO[code]:
        return dict(_COMBO[code][dose][0])
    raise ValueError("no tablet combo for %s %s" % (code, dose))


def _calc(code, w):
    """weight-based pick -> (dose, nowhole, flag, alt)."""
    _, lo, hi, tgt, _ = DRUGS[code]
    target = Fraction(tgt) * w
    cands = _COMBO[code]
    inr = []
    for dose, (_, n) in cands.items():
        t = _tenths(dose, w)
        if lo * 10 <= t <= hi * 10:
            inr.append((abs(Fraction(dose) - target), n, -dose, dose))
    if inr:
        inr.sort()
        return inr[0][3], False, None, []
    ranked = sorted((abs(Fraction(d) - target), -d, d) for d in cands)
    dist, _, dose = ranked[0]
    t = _tenths(dose, w)
    flag = "yellow" if t > hi * 10 else "blue"
    alt = sorted(d for dd, _, d in ranked if dd == dist and d != dose)
    return dose, True, flag, alt


def _parse_weight(s):
    if not isinstance(s, str):
        return None
    s = s.strip()
    if not _WRE.match(s):
        return None
    return Fraction(s)


def regimen(age, weight):
    if age <= 15:
        return {"ok": False, "reason": "age"}
    w = _parse_weight(weight)
    if w is None:
        return {"ok": False, "reason": "decimal"}
    if w < 20 or w > 200:
        return {"ok": False, "reason": "weight"}
    if w < 35:
        method = "calc"
    elif w < 50:
        method = "row1"
    elif w < 70:
        method = "row2"
    else:
        method = "row3"
    drugs = {}
    for code in ORDER:
        _, lo, hi, _, mx = DRUGS[code]
        flag, nowhole, alt, suggest = None, False, [], None
        if method == "calc":
            dose, nowhole, flag, alt = _calc(code, w)
        else:
            dose = ROWS[method][code]
        t = _tenths(dose, w)
        if method == "row3" and code in ("Z", "E") and t < lo * 10:
            flag = "blue"
            suggest = _calc(code, w)[0]
        atmax = mx is not None and dose == mx and t < lo * 10
        drugs[code] = {"dose": dose, "tabs": _tabs(code, dose), "mgkg": _fmt(t),
                       "flag": flag, "nowhole": nowhole, "alt": alt,
                       "suggest": suggest, "atmax": atmax}
    return {"ok": True, "method": method, "drugs": drugs}


def adjust(age, old_weight, new_weight, phase, current=None):
    if phase == "intensive":
        codes = ["H", "R", "Z", "E"]
    elif phase == "continuation":
        codes = ["H", "R"]
    else:
        raise ValueError("phase")
    o = regimen(age, old_weight)
    if not o["ok"]:
        return {"ok": False, "reason": o["reason"]}
    n = regimen(age, new_weight)
    if not n["ok"]:
        return {"ok": False, "reason": n["reason"]}
    old, new = {}, {}
    for c in codes:
        if current is not None and c in current:
            old[c] = current[c]
        else:
            old[c] = o["drugs"][c]["dose"]
        new[c] = n["drugs"][c]["dose"]
    changed = [c for c in codes if old[c] != new[c]]
    return {"ok": True, "result": "adjust" if changed else "same",
            "changed": changed, "old": old, "new": new}


def _add_months(d, n):
    idx = d.year * 12 + (d.month - 1) + n
    y, m = divmod(idx, 12)
    m += 1
    if d.day > calendar.monthrange(y, m)[1]:
        m += 1
        if m == 13:
            y, m = y + 1, 1
        return datetime.date(y, m, 1)
    return datetime.date(y, m, d.day)


def dates(start):
    d0 = datetime.date.fromisoformat(start)
    one = datetime.timedelta(days=1)
    me = [_add_months(d0, k) - one for k in range(1, 7)]
    sc = _add_months(d0, 2)
    return {"end_intensive": me[1].isoformat(),
            "start_continuation": sc.isoformat(),
            "end_treatment": me[5].isoformat(),
            "days_intensive": (me[1] - d0).days + 1,
            "days_continuation": (me[5] - sc).days + 1,
            "month_end": [x.isoformat() for x in me]}


# ---------------------------------------------------------------- self-test
def _selftest():
    ok = 0
    bad = []

    def chk(name, got, exp):
        nonlocal ok
        if got == exp:
            ok += 1
        else:
            bad.append((name, got, exp))

    # 9.1: weight -> {code: (dose, tabs, mgkg)} + overrides
    t91 = {
        "30.0": ("calc", {"H": (200, {"100": 2}, "6.7"), "R": (300, {"300": 1}, "10.0"),
                          "Z": (1000, {"500": 2}, "33.3"), "E": (500, {"500": 1}, "16.7")},
                 {"H": dict(flag="yellow", nowhole=True, alt=[100]),
                  "Z": dict(flag="yellow", nowhole=True, alt=[500])}),
        "35.0": ("row1", {"H": (300, {"100": 3}, "8.6"), "R": (450, {"450": 1}, "12.9"),
                          "Z": (1000, {"500": 2}, "28.6"), "E": (800, {"400": 2}, "22.9")}, {}),
        "49.5": ("row1", {"H": (300, {"100": 3}, "6.1"), "R": (450, {"450": 1}, "9.1"),
                          "Z": (1000, {"500": 2}, "20.2"), "E": (800, {"400": 2}, "16.2")}, {}),
        "50.0": ("row2", {"H": (300, {"100": 3}, "6.0"), "R": (600, {"300": 2}, "12.0"),
                          "Z": (1500, {"500": 3}, "30.0"), "E": (1000, {"500": 2}, "20.0")}, {}),
        "69.9": ("row2", {"H": (300, {"100": 3}, "4.3"), "R": (600, {"300": 2}, "8.6"),
                          "Z": (1500, {"500": 3}, "21.5"), "E": (1000, {"500": 2}, "14.3")}, {}),
        "70.0": ("row3", {"H": (300, {"100": 3}, "4.3"), "R": (600, {"300": 2}, "8.6"),
                          "Z": (2000, {"500": 4}, "28.6"), "E": (1200, {"400": 3}, "17.1")}, {}),
        "80.5": ("row3", {"H": (300, {"100": 3}, "3.7"), "R": (600, {"300": 2}, "7.5"),
                          "Z": (2000, {"500": 4}, "24.8"), "E": (1200, {"400": 3}, "14.9")},
                 {"H": dict(atmax=True), "R": dict(atmax=True),
                  "E": dict(flag="blue", suggest=1300)}),
        "100.5": ("row3", {"H": (300, {"100": 3}, "3.0"), "R": (600, {"300": 2}, "6.0"),
                           "Z": (2000, {"500": 4}, "19.9"), "E": (1200, {"400": 3}, "11.9")},
                  {"H": dict(atmax=True), "R": dict(atmax=True),
                   "Z": dict(flag="blue", suggest=2500), "E": dict(flag="blue", suggest=1600)}),
    }
    for w, (meth, ex, ov) in t91.items():
        r = regimen(45, w)
        chk("9.1 %s method" % w, r.get("method"), meth)
        for c in ORDER:
            exp = {"dose": ex[c][0], "tabs": ex[c][1], "mgkg": ex[c][2], "flag": None,
                   "nowhole": False, "alt": [], "suggest": None, "atmax": False}
            exp.update(ov.get(c, {}))
            chk("9.1 %s %s" % (w, c), r["drugs"][c], exp)
    # 9.1 tabs for E 1300 via suggestion combos
    chk("tabs E1300", _tabs("E", 1300), {"500": 1, "400": 2} if False else {"500": 1, "400": 2})
    chk("tabs R600", _tabs("R", 600), {"300": 2})

    # 9.2
    t92 = [("48.0", "52.0", "intensive", ["R", "Z", "E"], {"H": 300, "R": 450, "Z": 1000, "E": 800},
            {"H": 300, "R": 600, "Z": 1500, "E": 1000}),
           ("69.0", "71.0", "intensive", ["Z", "E"], {"H": 300, "R": 600, "Z": 1500, "E": 1000},
            {"H": 300, "R": 600, "Z": 2000, "E": 1200}),
           ("69.0", "71.0", "continuation", [], {"H": 300, "R": 600}, {"H": 300, "R": 600}),
           ("52.0", "53.5", "intensive", [], {"H": 300, "R": 600, "Z": 1500, "E": 1000},
            {"H": 300, "R": 600, "Z": 1500, "E": 1000}),
           ("34.0", "36.0", "intensive", ["H", "R", "E"], {"H": 200, "R": 300, "Z": 1000, "E": 500},
            {"H": 300, "R": 450, "Z": 1000, "E": 800})]
    for a, b, ph, ch, o, n in t92:
        exp = {"ok": True, "result": "adjust" if ch else "same", "changed": ch, "old": o, "new": n}
        chk("9.2 %s->%s %s" % (a, b, ph), adjust(45, a, b, ph), exp)

    # 9.3
    t93 = [("2026-11-08", "2027-01-07", "2027-01-08", "2027-05-07", 61, 120,
            ["2026-12-07", "2027-01-07", "2027-02-07", "2027-03-07", "2027-04-07", "2027-05-07"]),
           ("2026-12-31", "2027-02-28", "2027-03-01", "2027-06-30", 60, 122,
            ["2027-01-30", "2027-02-28", "2027-03-30", "2027-04-30", "2027-05-30", "2027-06-30"]),
           ("2028-02-29", "2028-04-28", "2028-04-29", "2028-08-28", 60, 122,
            ["2028-03-28", "2028-04-28", "2028-05-28", "2028-06-28", "2028-07-28", "2028-08-28"]),
           ("2027-08-31", "2027-10-30", "2027-10-31", "2028-02-29", 61, 122,
            ["2027-09-30", "2027-10-30", "2027-11-30", "2027-12-30", "2028-01-30", "2028-02-29"])]
    for s, ei, sc, et, di, dc, me in t93:
        chk("9.3 " + s, dates(s), {"end_intensive": ei, "start_continuation": sc,
                                   "end_treatment": et, "days_intensive": di,
                                   "days_continuation": dc, "month_end": me})

    # extra edge cases
    chk("age 15", regimen(15, "52"), {"ok": False, "reason": "age"})
    chk("age 16", regimen(16, "52")["ok"], True)
    chk("age 15 bad weight", regimen(15, "abc"), {"ok": False, "reason": "age"})
    for w, rs in [("19.9", "weight"), ("200.1", "weight"), ("52.25", "decimal"),
                  ("abc", "decimal"), ("", "decimal"), ("19.95", "decimal")]:
        chk("w " + w, regimen(45, w), {"ok": False, "reason": rs})
    for w in ("20.0", "200.0", "52", "52.0"):
        chk("w ok " + w, regimen(45, w)["ok"], True)
    chk("52==52.0", regimen(45, "52"), regimen(45, "52.0"))
    for w, m in [("34.9", "calc"), ("35.0", "row1"), ("49.9", "row1"), ("50.0", "row2"),
                 ("69.9", "row2"), ("70.0", "row3")]:
        chk("method " + w, regimen(45, w)["method"], m)
    e = lambda w: regimen(45, w)["drugs"]["E"]
    z = lambda w: regimen(45, w)["drugs"]["Z"]
    chk("80.2 E no flag", (e("80.2")["mgkg"], e("80.2")["flag"]), ("15.0", None))
    chk("80.3 E blue", (e("80.3")["mgkg"], e("80.3")["flag"], e("80.3")["suggest"]), ("14.9", "blue", 1300))
    chk("100.2 Z no flag", (z("100.2")["mgkg"], z("100.2")["flag"]), ("20.0", None))
    chk("100.3 Z blue", (z("100.3")["mgkg"], z("100.3")["flag"]), ("19.9", "blue"))
    chk("adjust bad old", adjust(45, "10", "52", "intensive"), {"ok": False, "reason": "weight"})
    chk("adjust bad new", adjust(45, "52", "52.55", "intensive"), {"ok": False, "reason": "decimal"})
    chk("adjust current", adjust(45, "52", "52", "continuation", {"H": 300, "R": 450}),
        {"ok": True, "result": "adjust", "changed": ["R"], "old": {"H": 300, "R": 450},
         "new": {"H": 300, "R": 600}})

    print("ตรง %d ข้อ ไม่ตรง %d ข้อ" % (ok, len(bad)))
    for name, got, exp in bad:
        print("  ไม่ตรง:", name, "\n    ได้:", got, "\n    คาด:", exp)
    return len(bad)


if __name__ == "__main__":
    raise SystemExit(1 if _selftest() else 0)
