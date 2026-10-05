'use strict';
// Модуль «Расчёт подсети»: порядок расчёта.
// Координаты станций считаются от опорной не напрямую, а цепочкой через ближайших соседей:
// чем короче вектор, тем он точнее. Здесь строится дерево кратчайших связей от опорной станции.

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// reference — код опорной станции; positions — { КОД: [x, y, z] } (приближённые, из потоков).
// Возвращает связи в порядке расчёта: [{ code, from, length }], length в метрах.
// Станции без приближённых координат в дерево не попадают.
function plan(reference, positions) {
  if (!positions[reference]) return [];
  const left = new Set(Object.keys(positions).filter((c) => c !== reference));
  const reached = [reference];
  const out = [];
  while (left.size) {
    let best = null;
    for (const code of left) {
      for (const from of reached) {
        const length = distance(positions[code], positions[from]);
        if (!best || length < best.length) best = { code, from, length };
      }
    }
    out.push(best);
    reached.push(best.code);
    left.delete(best.code);
  }
  return out;
}

module.exports = { plan, distance };
