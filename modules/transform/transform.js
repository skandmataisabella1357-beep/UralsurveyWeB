'use strict';
// Модуль «Пересчёт в потоке»: параметры сообщений RTCM 1021 (семь параметров) и 1025 (проекция),
// с которыми ровер сам получает местную систему координат из координат базы в ITRF.
// Работает и в окне (window.Transform), и на сервере (require): панель показывает ровно те
// числа, которые раздача отправляет роверам.
//
// Цели пересчёта:
//   msk66, sk42 — ITRF → [привязка подсети] → система основной сети → [параметры ГОСТ, обратный
//     ход] → эллипсоид Красовского → проекция Гаусса — Крюгера (зоны МСК-66 либо шестиградусные
//     зоны СК-42). Привязка и параметры ГОСТ складываются в одни семь параметров.
//   gsk2011 — ITRF на сегодняшнюю эпоху → ГСК-2011 (это ITRF2008, закреплённая на эпоху 2011,0):
//     перенос эпохи по движению Евразийской плиты записывается поворотом, переход ITRF2014 →
//     ITRF2008 — сдвигом и масштабом; затем проекция Гаусса — Крюгера на эллипсоиде ГСК-2011.
//     Привязка подсети здесь не нужна. Точность — как у модели плиты: 2–3 см.

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
  const WGS = { a: 6378137, b: 6356752.314 };
  const GSK = { a: 6378136.5, f: 1 / 298.2564151 };
  // Движение Евразийской плиты (модель ITRF2014), миллисекунды дуги в год
  const PLATE = [-0.085, -0.531, 0.770];
  const ZERO = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, m: 0 };
  const TARGETS = { msk66: 'МСК-66', sk42: 'СК-42', gsk2011: 'ГСК-2011' };

  // Запись ГОСТ 32453 (поворот системы координат): X2 = (1 + m)·R·X1 + T
  function apply(p, xyz) {
    const [x, y, z] = xyz;
    const wx = p.rx * SEC;
    const wy = p.ry * SEC;
    const wz = p.rz * SEC;
    const k = 1 + p.scale * 1e-6;
    return [k * (x + wz * y - wy * z) + p.dx, k * (-wz * x + y + wx * z) + p.dy, k * (wy * x - wx * y + z) + p.dz];
  }
  const round = (p) => ({
    dx: snap(p.dx, STEP.shift, 3), dy: snap(p.dy, STEP.shift, 3), dz: snap(p.dz, STEP.shift, 3),
    rx: snap(p.rx, STEP.rotation, 5), ry: snap(p.ry, STEP.rotation, 5), rz: snap(p.rz, STEP.rotation, 5), scale: snap(p.scale, STEP.scale, 5),
  });

  // Привязка подсети (ITRF → система основной сети) и обратный ход параметров исходной системы
  // (как у CoordSys.fromWgs84) — одним набором семи параметров. Углы малы, поэтому они
  // складываются, а сдвиг пересчитывается точно.
  function compose(link, datum) {
    const k = 1 / (1 + datum.m);
    const t = [link.tx - datum.dx, link.ty - datum.dy, link.tz - datum.dz];
    const wx = datum.wx * SEC;
    const wy = datum.wy * SEC;
    const wz = datum.wz * SEC;
    return round({
      dx: k * (t[0] - wz * t[1] + wy * t[2]), dy: k * (wz * t[0] + t[1] - wx * t[2]), dz: k * (-wy * t[0] + wx * t[1] + t[2]),
      rx: link.rx - datum.wx, ry: link.ry - datum.wy, rz: link.rz - datum.wz, scale: ((1 + link.m * 1e-6) * k - 1) * 1e6,
    });
  }

  // ITRF2014 на эпоху year → ГСК-2011. pre — малая поправка до ITRF2014 (для координат в ITRF2020).
  // Перенос на 2011,0: X − (ω × X)·dt, в записи ГОСТ это поворот на ω·dt; переход ITRF2014 →
  // ITRF2008 (IERS): сдвиги 1,6; 1,9; 2,4 мм и масштаб −0,02·10⁻⁹ на 2010,0, скорости 0; 0; −0,1 мм
  // и 0,03·10⁻⁹ в год.
  function toGsk(year, pre = ZERO) {
    const dt = year - 2011;
    return round({
      dx: pre.tx + 0.0016, dy: pre.ty + 0.0019, dz: pre.tz + 0.0023,
      rx: pre.rx + PLATE[0] * dt / 1000, ry: pre.ry + PLATE[1] * dt / 1000, rz: pre.rz + PLATE[2] * dt / 1000,
      scale: pre.m + 0.00001,
    });
  }

  // Шестиградусные зоны Гаусса — Крюгера, которые накрывают область (или одна зона центра)
  function gkZones(area) {
    const from = Math.floor(((area ? area.lon - area.dLon : 60)) / 6) + 1;
    const to = Math.floor(((area ? area.lon + area.dLon : 60)) / 6) + 1;
    const out = [];
    for (let n = from; n <= to; n++) out.push({ zone: n, from: n === from ? -Infinity : (n - 1) * 6, lon0: n * 6 - 3, falseEasting: n * 1e6 + 500000, falseNorthing: 0, verified: true });
    return out;
  }

  // Всё, что уходит роверу: одно сообщение 1021 и по сообщению 1025 на зону.
  // spec — { target: 'msk66' | 'sk42' | 'gsk2011', link, area, epoch, source: 'ITRF2014' | 'ITRF2020', igd }:
  //   igd — редакция параметров ИГД для msk66 и sk42: 'g2001', 'g2008' (по умолчанию) или 'g2017';
  //   link — для msk66 и sk42 привязка «координаты базы → система основной сети»; для gsk2011 —
  //     малая поправка «координаты базы → ITRF2014» (нужна только при координатах в ITRF2020);
  //   area — область действия в градусах { lat, lon, dLat, dLon }; epoch — эпоха координат, год.
  // Возвращает null, если собрать не из чего.
  function plan(spec) {
    if (!spec || !TARGETS[spec.target]) return null;
    let datum;
    let ell;
    let seven;
    let zones;
    if (spec.target === 'gsk2011') {
      if (!Number.isFinite(spec.epoch)) return null;
      seven = toGsk(spec.epoch, spec.link || ZERO);
      ell = GSK;
      datum = { id: 'GSK-2011', name: 'ГСК-2011' };
      zones = gkZones(spec.area);
    } else {
      if (!spec.link) return null;
      const system = CoordSys.describe('msk66');
      const igd = CoordSys.IGD[spec.igd] || CoordSys.IGD.g2008;
      datum = { ...system.datum, ...igd, name: `${system.datum.name}, ${igd.title}` };
      ell = system.ellipsoid;
      seven = compose(spec.link, datum);
      zones = spec.target === 'msk66' ? system.zones : gkZones(spec.area);
    }
    const helmert = {
      sourceName: spec.source || 'ITRF2014', targetName: String(datum.id).toUpperCase(), ...seven,
      sourceA: WGS.a, sourceB: WGS.b, targetA: ell.a, targetB: Number((ell.a * (1 - ell.f)).toFixed(3)),
      area: spec.area || { lat: 0, lon: 0, dLat: 0, dLon: 0 }, computation: 0, heightIndicator: 0, plate: 0, utilized: UTILIZED_1025,
    };
    const projections = zones.map((z) => ({
      zone: z.zone, from: z.from, systemId: z.zone, verified: z.verified !== false, projection: 1, lat0: 0, lon0: z.lon0, scale: 1,
      falseEasting: z.falseEasting, falseNorthing: z.falseNorthing,
    }));
    return { target: spec.target, system: TARGETS[spec.target], datum: datum.name, igd: spec.target === 'gsk2011' ? null : (CoordSys.IGD[spec.igd] ? spec.igd : 'g2008'), helmert, projections };
  }

  // Зона по долготе: последняя, чья граница не восточнее точки
  function zoneFor(p, lon) {
    let best = p.projections[0];
    for (const z of p.projections) if (Number.isFinite(z.from) && lon >= z.from) best = z;
    return best;
  }

  return { apply, compose, toGsk, plan, zoneFor, STEP, UTILIZED_1025, TARGETS, GSK };
});
