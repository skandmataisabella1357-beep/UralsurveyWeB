'use strict';
// Модуль «Пересчёт в потоке»: параметры сообщений RTCM 1021 (семь параметров) и 1025 (проекция),
// с которыми ровер сам получает местную систему координат из координат базы в ITRF2014.
// Работает и в окне (window.Transform), и на сервере (require): панель показывает ровно те
// числа, которые раздача отправляет роверам.
//
// Цепочка: ITRF2014 → [привязка подсети] → система основной сети → [параметры ГОСТ исходной
// системы, обратный ход] → эллипсоид Красовского → [проекция Гаусса — Крюгера зоны] → МСК.
// Первые два перехода складываются в одни семь параметров — они и уходят в сообщении 1021.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../coordsys/coordsys'));
  else root.Transform = factory(root.CoordSys);
})(typeof self !== 'undefined' ? self : this, (CoordSys) => {
  const SEC = Math.PI / 648000;
  // Шаг значений в сообщении 1021: в поток уходят числа, округлённые до него
  const STEP = { shift: 0.001, rotation: 0.00002, scale: 0.00001 };
  const snap = (v, step, digits) => Number((Math.round(v / step) * step).toFixed(digits));
  // Какие ещё сообщения пересчёта идут вместе с 1021 (поле DF148): у нас — только 1025.
  // Порядок бит стандарт описывает словами; значение проверяется на ровере перед работой.
  const UTILIZED_1025 = 4;

  // Запись ГОСТ 32453 (поворот системы координат): X2 = (1 + m)·R·X1 + T
  function apply(p, xyz) {
    const [x, y, z] = xyz;
    const wx = p.rx * SEC;
    const wy = p.ry * SEC;
    const wz = p.rz * SEC;
    const k = 1 + p.scale * 1e-6;
    return [k * (x + wz * y - wy * z) + p.dx, k * (-wz * x + y + wx * z) + p.dy, k * (wy * x - wx * y + z) + p.dz];
  }

  // Привязка подсети (ITRF2014 → система основной сети) и обратный ход параметров исходной
  // системы (как у CoordSys.fromWgs84) — одним набором семи параметров. Углы малы, поэтому
  // они складываются, а сдвиг пересчитывается точно.
  function compose(link, datum) {
    const k = 1 / (1 + datum.m);
    const t = [link.tx - datum.dx, link.ty - datum.dy, link.tz - datum.dz];
    const wx = datum.wx * SEC;
    const wy = datum.wy * SEC;
    const wz = datum.wz * SEC;
    return {
      dx: snap(k * (t[0] - wz * t[1] + wy * t[2]), STEP.shift, 3),
      dy: snap(k * (wz * t[0] + t[1] - wx * t[2]), STEP.shift, 3),
      dz: snap(k * (-wy * t[0] + wx * t[1] + t[2]), STEP.shift, 3),
      rx: snap(link.rx - datum.wx, STEP.rotation, 5),
      ry: snap(link.ry - datum.wy, STEP.rotation, 5),
      rz: snap(link.rz - datum.wz, STEP.rotation, 5),
      scale: snap(((1 + link.m * 1e-6) * k - 1) * 1e6, STEP.scale, 5),
    };
  }

  // Всё, что уходит роверу для системы systemId: одно сообщение 1021 и по сообщению 1025 на зону.
  // link — привязка подсети { tx, ty, tz, rx, ry, rz, m }; area — область действия в градусах
  // { lat, lon, dLat, dLon } (центр и полуразмеры). Возвращает null, если системы нет.
  function plan(link, systemId, area) {
    const system = CoordSys.describe(systemId);
    if (!system || !link) return null;
    const ell = system.ellipsoid;
    const helmert = {
      sourceName: 'ITRF2014', targetName: system.datum.id.toUpperCase(), ...compose(link, system.datum),
      sourceA: 6378137, sourceB: 6356752.314, targetA: ell.a, targetB: Number((ell.a * (1 - ell.f)).toFixed(3)),
      area: area || { lat: 0, lon: 0, dLat: 0, dLon: 0 }, computation: 0, heightIndicator: 0, plate: 0, utilized: UTILIZED_1025,
    };
    const projections = system.zones.map((z) => ({
      zone: z.zone, from: z.from, systemId: z.zone, verified: z.verified, projection: 1, lat0: 0, lon0: z.lon0, scale: 1,
      falseEasting: z.falseEasting, falseNorthing: z.falseNorthing,
    }));
    return { system: system.name, datum: system.datum.name, helmert, projections };
  }

  // Зона по долготе: последняя, чья граница не восточнее точки
  function zoneFor(p, lon) {
    let best = p.projections[0];
    for (const z of p.projections) if (Number.isFinite(z.from) && lon >= z.from) best = z;
    return best;
  }

  return { apply, compose, plan, zoneFor, STEP, UTILIZED_1025 };
});
