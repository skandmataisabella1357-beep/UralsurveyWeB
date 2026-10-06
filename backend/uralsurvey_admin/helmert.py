"""Семь параметров перехода между двумя наборами координат одних и тех же станций.

Формула — как в ГОСТ 32453 и в полевых контроллерах:
    X2 = (1 + m) · R · X1 + T,   R = [[1, wz, -wy], [-wz, 1, wx], [wy, -wx, 1]]
T — в метрах, углы — в секундах дуги, m — в миллионных долях. В программах, где знак
поворота обратный («position vector»), углы вводятся с противоположным знаком.
"""

from __future__ import annotations

import math

ARCSEC = math.pi / 648000
SPAN = 1e5  # масштаб неизвестных: сеть порядка ста километров


def _solve(a: list[list[float]], b: list[float]) -> list[float]:
    """Система линейных уравнений методом Гаусса с выбором главного элемента."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(m[r][col]))
        if abs(m[pivot][col]) < 1e-12:
            raise ValueError("станции лежат слишком тесно: параметры не определяются")
        m[col], m[pivot] = m[pivot], m[col]
        for r in range(n):
            if r != col:
                k = m[r][col] / m[col][col]
                if k:
                    m[r] = [v - k * w for v, w in zip(m[r], m[col])]
    return [m[i][n] / m[i][i] for i in range(n)]


def fit(pairs: list[tuple[list[float], list[float]]], shift_only: bool = False) -> dict:
    """Параметры по парам (откуда, куда). Числа округлены так, как их вводят в контроллер:
    пересчёт по ним совпадает с тем, что раздаёт сервер. shift_only — только общий сдвиг
    (повороты и масштаб нулевые): так устроена сеть, полученная прибавлением одного сдвига."""
    if shift_only:
        if len(pairs) < 3:
            raise ValueError("для общего сдвига нужно не меньше трёх станций")
        t = [sum(dst[i] - src[i] for src, dst in pairs) / len(pairs) for i in range(3)]
        return {"tx": round(t[0], 4), "ty": round(t[1], 4), "tz": round(t[2], 4), "rx": 0.0, "ry": 0.0, "rz": 0.0, "m": 0.0}
    if len(pairs) < 5:
        raise ValueError("для семи параметров нужно не меньше пяти станций")
    c = [sum(p[0][i] for p in pairs) / len(pairs) for i in range(3)]
    n = [[0.0] * 7 for _ in range(7)]
    u = [0.0] * 7
    for src, dst in pairs:
        px, py, pz = ((src[i] - c[i]) / SPAN for i in range(3))
        # dX = t0 + s·p + w×p  (w — поворот «position vector»)
        rows = ([1, 0, 0, px, 0, pz, -py], [0, 1, 0, py, -pz, 0, px], [0, 0, 1, pz, py, -px, 0])
        for row, value in zip(rows, (dst[i] - src[i] for i in range(3))):
            for i in range(7):
                u[i] += row[i] * value
                for j in range(7):
                    n[i][j] += row[i] * row[j]
    t0x, t0y, t0z, s, wx, wy, wz = _solve(n, u)
    s, wx, wy, wz = s / SPAN, wx / SPAN, wy / SPAN, wz / SPAN
    # От центра сети — к началу координат: T = t0 − s·c − w×c
    t = [t0x - s * c[0] - (wy * c[2] - wz * c[1]), t0y - s * c[1] - (wz * c[0] - wx * c[2]), t0z - s * c[2] - (wx * c[1] - wy * c[0])]
    return {"tx": round(t[0], 4), "ty": round(t[1], 4), "tz": round(t[2], 4),
            "rx": round(-wx / ARCSEC, 6), "ry": round(-wy / ARCSEC, 6), "rz": round(-wz / ARCSEC, 6), "m": round(s * 1e6, 5)}


def apply(p: dict, xyz: list[float]) -> list[float]:
    x, y, z = (float(v) for v in xyz)
    wx, wy, wz = (float(p[k]) * ARCSEC for k in ("rx", "ry", "rz"))
    k = 1 + float(p["m"]) * 1e-6
    return [k * (x + wz * y - wy * z) + float(p["tx"]), k * (-wz * x + y + wx * z) + float(p["ty"]), k * (wy * x - wx * y + z) + float(p["tz"])]


def geodetic(xyz: list[float]) -> tuple[float, float]:
    """Широта и долгота точки, радианы (эллипсоид WGS-84)."""
    x, y, z = xyz
    lon = math.atan2(y, x)
    e2 = 0.00669438002290
    p = math.hypot(x, y)
    lat = math.atan2(z, p * (1 - e2))
    for _ in range(5):
        nn = 6378137.0 / math.sqrt(1 - e2 * math.sin(lat) ** 2)
        lat = math.atan2(z + e2 * nn * math.sin(lat), p)
    return lat, lon


def area(points: list[list[float]], margin: float = 1.0) -> dict:
    """Область действия параметров в градусах: центр и полуразмеры по станциям с запасом."""
    where = [geodetic(p) for p in points]
    lats = [math.degrees(w[0]) for w in where]
    lons = [math.degrees(w[1]) for w in where]
    return {"lat": round((min(lats) + max(lats)) / 2, 3), "lon": round((min(lons) + max(lons)) / 2, 3),
            "dLat": round((max(lats) - min(lats)) / 2 + margin, 3), "dLon": round((max(lons) - min(lons)) / 2 + margin, 3)}


def enu(xyz: list[float], d: list[float]) -> list[float]:
    """Разность d в точке xyz: на восток, на север и вверх."""
    lat, lon = geodetic(xyz)
    sl, cl, sp, cp = math.sin(lon), math.cos(lon), math.sin(lat), math.cos(lat)
    return [-sl * d[0] + cl * d[1], -sp * cl * d[0] - sp * sl * d[1] + cp * d[2], cp * cl * d[0] + cp * sl * d[1] + sp * d[2]]
