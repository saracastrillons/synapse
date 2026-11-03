"""Server-side statistics for A/B experiments.

The browser runs the simulations, but the API does not trust its conclusions:
it recomputes means, standard deviations, relative deltas and a Welch t-test
from the raw per-replicate KPIs before storing a run.
"""
from __future__ import annotations

import math
from statistics import mean, stdev
from typing import Any

# KPI → is a higher value better?
KPIS: dict[str, bool] = {
    "speed": True, "congestion": False, "trip": False, "throughput": True,
    "co2": False, "power": True, "response": False, "removed": False,
}
WEIGHTS = {"congestion": 3, "trip": 2, "speed": 2, "throughput": 1.5, "response": 2.5, "power": 2, "removed": 1.5, "co2": 1}


def _betacf(a: float, b: float, x: float) -> float:
    """Continued fraction for the regularised incomplete beta (Numerical Recipes §6.4)."""
    tiny = 1e-30
    qab, qap, qam = a + b, a + 1, a - 1
    c, d = 1.0, 1 - qab * x / qap
    d = 1 / (d if abs(d) > tiny else tiny)
    h = d
    for m in range(1, 200):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1 + aa * d
        d = 1 / (d if abs(d) > tiny else tiny)
        c = 1 + aa / c
        c = c if abs(c) > tiny else tiny
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1 + aa * d
        d = 1 / (d if abs(d) > tiny else tiny)
        c = 1 + aa / c
        c = c if abs(c) > tiny else tiny
        delta = d * c
        h *= delta
        if abs(delta - 1) < 3e-12:
            break
    return h


def _betai(a: float, b: float, x: float) -> float:
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    lbt = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1 - x)
    bt = math.exp(lbt)
    if x < (a + 1) / (a + b + 2):
        return bt * _betacf(a, b, x) / a
    return 1 - bt * _betacf(b, a, 1 - x) / b


def t_two_sided_p(t: float, df: float) -> float:
    """Two-sided p-value of Student's t distribution."""
    if not math.isfinite(t):
        return 0.0
    return _betai(df / 2, 0.5, df / (df + t * t))


def welch(a: list[float], b: list[float]) -> tuple[float | None, float | None]:
    """Welch's unequal-variance t-test. Returns (t, p) or (None, None) when undefined."""
    if len(a) < 2 or len(b) < 2:
        return None, None
    va, vb = stdev(a) ** 2 / len(a), stdev(b) ** 2 / len(b)
    se = math.sqrt(va + vb)
    if se == 0:
        return (None, None) if mean(a) == mean(b) else (math.inf, 0.0)
    t = (mean(b) - mean(a)) / se
    df = (va + vb) ** 2 / ((va ** 2 / (len(a) - 1) if va else 0) + (vb ** 2 / (len(b) - 1) if vb else 0) or 1e-12)
    return t, t_two_sided_p(t, df)


def compare(rep_a: list[dict[str, Any]], rep_b: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str]:
    rows: list[dict[str, Any]] = []
    score = 0.0
    for key, higher in KPIS.items():
        xa = [float(r["summary"].get(key, 0)) for r in rep_a]
        xb = [float(r["summary"].get(key, 0)) for r in rep_b]
        ma, mb = mean(xa), mean(xb)
        delta = (mb - ma) / abs(ma) if ma else (0.0 if mb == 0 else 1.0)
        undefined = key == "response" and (ma == 0 or mb == 0)
        better = None if undefined or abs(mb - ma) < 1e-9 or abs(delta) < 0.005 else (mb > ma) == higher
        consistent = all((y >= x) == higher or y == x for x, y in zip(xa, xb)) or all((y <= x) == higher or y == x for x, y in zip(xa, xb))
        t, p = welch(xa, xb)
        rows.append({
            "kpi": key, "mean_a": ma, "mean_b": mb,
            "sd_a": stdev(xa) if len(xa) > 1 else 0.0, "sd_b": stdev(xb) if len(xb) > 1 else 0.0,
            "delta": delta, "better": better, "consistent": consistent,
            "t": t if t is None or math.isfinite(t) else None, "p_value": p,
        })
        if better is not None:
            score += (1 if better else -1) * WEIGHTS[key] * min(1.0, abs(delta) * 5)
    verdict = "tie" if abs(score) < 0.4 else ("B" if score > 0 else "A")
    return rows, verdict
