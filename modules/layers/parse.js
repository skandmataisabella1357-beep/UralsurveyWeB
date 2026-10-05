'use strict';
// Модуль «Слои»: чтение файлов KML и DXF в набор контуров и линий на карте.
// Работает и в браузере (window.LayerParse), и в тестах (require). От ядра не зависит.
//
// Результат — список объектов: { kind: 'polygon' | 'line', name, points: [[широта, долгота], ...] }.
// KML всегда в широте и долготе. В DXF координаты могут быть какими угодно, поэтому пересчёт
// в широту и долготу задаёт вызывающий: функция toLatLon(x, y) -> [широта, долгота] или null.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LayerParse = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const MAX_POINTS = 12000; // на весь слой: больше ни карте, ни серверу не нужно

  const closed = (pts) => pts.length >= 4 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
  const valid = (p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;

  // Приводит объекты к общему виду: отбрасывает негодные точки и пустые объекты, округляет,
  // прореживает слишком подробные контуры (каждую k-ю точку), считает итог.
  function finish(features) {
    let list = features.map((f) => {
      let pts = f.points.filter(valid).map((p) => [Number(p[0].toFixed(6)), Number(p[1].toFixed(6))]);
      const polygon = f.kind === 'polygon' || closed(pts);
      if (polygon && closed(pts)) pts = pts.slice(0, -1);
      return { kind: polygon ? 'polygon' : 'line', name: String(f.name || '').slice(0, 80), points: pts };
    }).filter((f) => f.points.length >= (f.kind === 'polygon' ? 3 : 2));
    const total = list.reduce((sum, f) => sum + f.points.length, 0);
    if (total > MAX_POINTS) {
      const k = Math.ceil(total / MAX_POINTS);
      list = list.map((f) => ({ ...f, points: f.points.filter((p, i) => i % k === 0 || i === f.points.length - 1) })).filter((f) => f.points.length >= (f.kind === 'polygon' ? 3 : 2));
    }
    return { features: list, polygons: list.filter((f) => f.kind === 'polygon').length, lines: list.filter((f) => f.kind === 'line').length, points: list.reduce((sum, f) => sum + f.points.length, 0) };
  }

  // ---------- KML ----------
  // Берутся контуры (Polygon, внешняя граница) и линии (LineString) из меток Placemark.
  function parseKml(text) {
    const features = [];
    const coords = (block) => block.trim().split(/\s+/).map((t) => { const v = t.split(',').map(Number); return [v[1], v[0]]; });
    const marks = text.match(/<Placemark[\s\S]*?<\/Placemark>/g) || [];
    for (const mark of marks) {
      const title = /<name>([\s\S]*?)<\/name>/.exec(mark);
      const name = title ? title[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
      for (const poly of mark.match(/<Polygon[\s\S]*?<\/Polygon>/g) || []) {
        const outer = /<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/.exec(poly);
        if (outer) features.push({ kind: 'polygon', name, points: coords(outer[1]) });
      }
      const rest = mark.replace(/<Polygon[\s\S]*?<\/Polygon>/g, '');
      for (const line of rest.match(/<LineString[\s\S]*?<\/LineString>/g) || []) {
        const c = /<coordinates>([\s\S]*?)<\/coordinates>/.exec(line);
        if (c) features.push({ kind: 'line', name, points: coords(c[1]) });
      }
    }
    return finish(features);
  }

  // ---------- DXF ----------
  // Файл — пары строк «код группы / значение». Берутся полилинии (LWPOLYLINE, POLYLINE с вершинами
  // VERTEX) и отрезки (LINE) из раздела ENTITIES; имя объекта — имя его слоя в чертеже.
  function parseDxf(text, toLatLon) {
    const rows = text.split(/\r?\n/);
    const pairs = [];
    for (let i = 0; i + 1 < rows.length; i += 2) pairs.push([Number(rows[i].trim()), rows[i + 1].trim()]);
    const features = [];
    let inEntities = false;
    let cur = null; // текущий объект: { type, name, flag, xs, ys }
    let poly = null; // полилиния старого вида, которая собирает вершины
    const flush = () => {
      if (!cur) return;
      const pts = cur.xs.map((x, i) => toLatLon(x, cur.ys[i]));
      if (cur.type === 'VERTEX') { if (poly && pts[0]) poly.points.push(pts[0]); }
      else if (cur.type === 'POLYLINE') poly = { kind: cur.flag & 1 ? 'polygon' : 'line', name: cur.name, points: [] };
      else if (cur.type === 'SEQEND') { if (poly) features.push(poly); poly = null; }
      else if (cur.type === 'LWPOLYLINE') features.push({ kind: cur.flag & 1 ? 'polygon' : 'line', name: cur.name, points: pts.filter(Boolean) });
      else if (cur.type === 'LINE') features.push({ kind: 'line', name: cur.name, points: pts.filter(Boolean) });
      cur = null;
    };
    for (let i = 0; i < pairs.length; i++) {
      const [code, value] = pairs[i];
      if (code === 0) {
        flush();
        if (value === 'SECTION') { inEntities = pairs[i + 1] && pairs[i + 1][0] === 2 && pairs[i + 1][1] === 'ENTITIES'; continue; }
        if (value === 'ENDSEC') { inEntities = false; continue; }
        if (inEntities) cur = { type: value, name: '', flag: 0, xs: [], ys: [] };
        continue;
      }
      if (!cur) continue;
      if (code === 8) cur.name = value;
      else if (code === 70) cur.flag = Number(value) || 0;
      else if (code === 10 || code === 11) cur.xs.push(Number(value));
      else if (code === 20 || code === 21) cur.ys.push(Number(value));
    }
    flush();
    if (poly) features.push(poly);
    return finish(features);
  }

  // Лежит ли точка в одном из контуров: [[широта, долгота], ...] — как в геометрии подсетей
  function inside(lat, lon, polygons) {
    return polygons.some((poly) => {
      let hit = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [la, lo] = poly[i];
        const [lb, lob] = poly[j];
        if ((la > lat) !== (lb > lat) && lon < (lob - lo) * (lat - la) / (lb - la) + lo) hit = !hit;
      }
      return hit;
    });
  }

  return { parseKml, parseDxf, inside, MAX_POINTS };
});
