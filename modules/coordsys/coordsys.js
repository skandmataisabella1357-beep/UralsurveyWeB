'use strict';
// Модуль «Системы координат»: пересчёт положения станции из WGS-84 в плоские системы.
// От ядра не зависит: на входе геоцентрические координаты X, Y, Z, на выходе север, восток и зона.
// Работает и в окне (window.CoordSys), и в тестах (require).
//
// Пересчёт идёт в два шага: переход на эллипсоид Красовского по семи параметрам,
// затем проекция Гаусса — Крюгера с параметрами зоны.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CoordSys = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const D2R = Math.PI / 180;
  const SEC = D2R / 3600;

  const ELLIPSOIDS = {
    krass: { a: 6378245, f: 1 / 298.3 },
  };

  // Переход «исходная система → WGS-84» в записи ГОСТ 32453: сдвиги в метрах,
  // повороты в угловых секундах, масштаб в долях единицы. Нам нужен обратный ход.
  const DATUMS = {
    sk42: { name: 'СК-42', ellipsoid: 'krass', dx: 23.57, dy: -140.95, dz: -79.8, wx: 0, wy: -0.35, wz: -0.79, m: -0.22e-6 },
    sk95: { name: 'СК-95', ellipsoid: 'krass', dx: 24.47, dy: -130.89, dz: -81.56, wx: 0, wy: 0, wz: -0.13, m: -0.22e-6 },
  };

  // Системы координат. zones — готовый список зон либо правило, по которому зона
  // выбирается по долготе. verified: false — параметры с каталогом не сверены,
  // и окно обязано об этом сказать.
  // МСК-66, зона 1 сверена 05.10.2026 с каталогом заказчика: девять станций сошлись до 1 мм
  // (координаты баз в потоках подогнаны им под переход по ГОСТ Р 51794-2008).
  const SYSTEMS = [
    {
      id: 'msk66',
      name: 'МСК-66',
      datum: 'sk42',
      verified: true,
      // Зона выбирается сама по долготе станции. from — долгота, с которой зона начинается.
      // По каталогу заказчика первая зона доходит как минимум до 63°41′ (станция TOUR);
      // где начинается вторая, он ещё не сообщил — граница условная.
      zones: [
        { zone: 1, lon0: 60.05, from: -Infinity, falseEasting: 1500000, falseNorthing: -5911057.63 },
        { zone: 2, lon0: 63.05, from: 64.55, falseEasting: 2500000, falseNorthing: -5911057.63 },
        { zone: 3, lon0: 66.05, from: 66.05, falseEasting: 3500000, falseNorthing: -5911057.63 },
      ],
    },
  ];

  function register(system) {
    const i = SYSTEMS.findIndex((s) => s.id === system.id);
    if (i === -1) SYSTEMS.push(system);
    else SYSTEMS[i] = system;
  }

  function list() {
    return SYSTEMS.map((s) => ({ id: s.id, name: s.name, short: s.short || s.name, verified: s.verified }));
  }

  // WGS-84 → исходная система: обратный переход по семи параметрам
  function fromWgs84(ecef, d) {
    const x = ecef[0] - d.dx;
    const y = ecef[1] - d.dy;
    const z = ecef[2] - d.dz;
    const wx = d.wx * SEC;
    const wy = d.wy * SEC;
    const wz = d.wz * SEC;
    const k = 1 / (1 + d.m);
    return [
      k * (x - wz * y + wy * z),
      k * (wz * x + y - wx * z),
      k * (-wy * x + wx * y + z),
    ];
  }

  function toGeodetic(ecef, ell) {
    const { a, f } = ell;
    const e2 = f * (2 - f);
    const [x, y, z] = ecef;
    const p = Math.hypot(x, y);
    let lat = Math.atan2(z, p * (1 - e2));
    let h = 0;
    for (let i = 0; i < 8; i++) {
      const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
      h = p / Math.cos(lat) - n;
      lat = Math.atan2(z, p * (1 - e2 * n / (n + h)));
    }
    return { lat, lon: Math.atan2(y, x), h };
  }

  // Проекция Гаусса — Крюгера: ряды Крюгера по третьему сплющиванию, масштаб на осевом меридиане 1.
  // Возвращает север и восток в метрах без смещений зоны.
  function gaussKruger(lat, dLon, ell) {
    const { a, f } = ell;
    const n = f / (2 - f);
    const n2 = n * n;
    const n3 = n2 * n;
    const n4 = n3 * n;
    const A = a / (1 + n) * (1 + n2 / 4 + n4 / 64);
    const alpha = [
      n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180,
      13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440,
      61 * n3 / 240 - 103 * n4 / 140,
      49561 * n4 / 161280,
    ];
    const e = Math.sqrt(f * (2 - f));
    const s = Math.sin(lat);
    const t = Math.sinh(Math.atanh(s) - e * Math.atanh(e * s));
    const xi0 = Math.atan2(t, Math.cos(dLon));
    const eta0 = Math.atanh(Math.sin(dLon) / Math.sqrt(1 + t * t));
    let xi = xi0;
    let eta = eta0;
    for (let j = 0; j < 4; j++) {
      const k = 2 * (j + 1);
      xi += alpha[j] * Math.sin(k * xi0) * Math.cosh(k * eta0);
      eta += alpha[j] * Math.cos(k * xi0) * Math.sinh(k * eta0);
    }
    return { north: A * xi, east: A * eta };
  }

  function pickZone(system, lonDeg) {
    if (system.zones) {
      // Последняя зона, которая начинается западнее станции
      return system.zones.reduce((best, z) => (lonDeg >= z.from ? z : best));
    }
    const w = system.zoneWidth;
    const zone = Math.floor(((lonDeg % 360) + 360) % 360 / w) + 1;
    return { zone, lon0: zone * w - w / 2, falseEasting: zone * 1e6 + 500000, falseNorthing: 0 };
  }

  // Положение в выбранной системе. ecef — координаты WGS-84 в метрах.
  // zone — номер зоны, если нужна не та, что выбирается по долготе.
  function convert(systemId, ecef, zone) {
    const system = SYSTEMS.find((s) => s.id === systemId);
    if (!system) return null;
    const datum = DATUMS[system.datum];
    const ell = ELLIPSOIDS[datum.ellipsoid];
    const g = toGeodetic(fromWgs84(ecef, datum), ell);
    const lonDeg = g.lon / D2R;
    let z = pickZone(system, lonDeg);
    if (zone !== undefined && system.zones) z = system.zones.find((x) => x.zone === zone) || z;
    const p = gaussKruger(g.lat, (lonDeg - z.lon0) * D2R, ell);
    return {
      system: system.id,
      name: system.name,
      datum: datum.name,
      verified: system.verified,
      zone: z.zone,
      north: p.north + z.falseNorthing,
      east: p.east + z.falseEasting,
    };
  }

  return { list, register, convert, gaussKruger, fromWgs84, toGeodetic, ELLIPSOIDS, DATUMS };
});
