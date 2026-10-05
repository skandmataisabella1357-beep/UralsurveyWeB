'use strict';
// Геометрия подсетей: попадание станции в контур, разбиение на треугольники, длины линий.
// Работает и в окне (window.SubnetGeometry), и в тестах (require).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SubnetGeometry = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  // Лежит ли точка внутри контура. polygon — вершины [широта, долгота] по обходу.
  function pointInPolygon(lat, lon, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [yi, xi] = polygon[i];
      const [yj, xj] = polygon[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // Триангуляция Делоне (алгоритм Боуэра — Уотсона). points — [{ x, y }].
  // Возвращает стороны треугольников парами номеров точек, без повторов.
  function triangulate(points) {
    const n = points.length;
    if (n < 2) return [];
    if (n === 2) return [[0, 1]];

    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const d = Math.max(maxX - minX, maxY - minY, 1e-9) * 20;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const pts = points.concat([{ x: cx - d, y: cy - d }, { x: cx + d, y: cy - d }, { x: cx, y: cy + d }]);

    const inCircle = (t, p) => {
      const a = pts[t[0]]; const b = pts[t[1]]; const c = pts[t[2]];
      const ax = a.x - p.x; const ay = a.y - p.y;
      const bx = b.x - p.x; const by = b.y - p.y;
      const qx = c.x - p.x; const qy = c.y - p.y;
      const det = (ax * ax + ay * ay) * (bx * qy - qx * by)
        - (bx * bx + by * by) * (ax * qy - qx * ay)
        + (qx * qx + qy * qy) * (ax * by - bx * ay);
      const orient = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      return orient > 0 ? det > 0 : det < 0;
    };

    let triangles = [[n, n + 1, n + 2]];
    for (let i = 0; i < n; i++) {
      const bad = triangles.filter((t) => inCircle(t, pts[i]));
      const count = new Map();
      for (const t of bad) {
        for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
          const key = a < b ? `${a}-${b}` : `${b}-${a}`;
          count.set(key, (count.get(key) || 0) + 1);
        }
      }
      triangles = triangles.filter((t) => !bad.includes(t));
      for (const [key, c] of count) {
        if (c !== 1) continue; // общая сторона двух удаляемых треугольников — внутри полости
        const [a, b] = key.split('-').map(Number);
        triangles.push([a, b, i]);
      }
    }

    const edges = new Map();
    for (const t of triangles) {
      if (t.some((v) => v >= n)) continue;
      for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        edges.set(`${lo}-${hi}`, [lo, hi]);
      }
    }
    if (!edges.size) {
      // Точки на одной прямой: соединяем соседние по порядку вдоль линии
      const order = points.map((p, i) => i).sort((a, b) => (points[a].x - points[b].x) || (points[a].y - points[b].y));
      return order.slice(1).map((v, i) => [Math.min(order[i], v), Math.max(order[i], v)]);
    }
    return [...edges.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }

  // Стороны подсети по станциям с координатами: [{ a, b, length }], длина — в метрах по прямой
  function baselines(stations) {
    if (stations.length < 2) return [];
    const lat0 = stations.reduce((s, st) => s + st.lat, 0) / stations.length;
    const k = Math.cos(lat0 * Math.PI / 180);
    const edges = triangulate(stations.map((st) => ({ x: st.lon * k, y: st.lat })));
    return edges.map(([i, j]) => {
      const p = stations[i].ecef;
      const q = stations[j].ecef;
      return { a: i, b: j, length: Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) };
    });
  }

  return { pointInPolygon, triangulate, baselines };
});
