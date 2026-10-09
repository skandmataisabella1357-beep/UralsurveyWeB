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

  // Параметры ИГД «СК-42 → общеземная система» по редакциям стандарта. Каталог основной сети
  // подогнан под редакцию 2008 года, поэтому она по умолчанию; остальные — на выбор сети раздачи,
  // если у роверов заказчика принята другая. Разница между редакциями — дециметры.
  const IGD = {
    g2001: { title: 'ГОСТ Р 51794-2001', note: 'СК-42 → ПЗ-90 → WGS-84', dx: 23.92, dy: -141.27, dz: -80.9, wx: 0, wy: -0.35, wz: -0.82, m: -0.12e-6 },
    g2008: { title: 'ГОСТ Р 51794-2008', note: 'СК-42 → ПЗ-90.02 → WGS-84; под неё подогнан каталог сети', dx: 23.57, dy: -140.95, dz: -79.8, wx: 0, wy: -0.35, wz: -0.79, m: -0.22e-6 },
    g2017: { title: 'ГОСТ 32453-2017', note: 'СК-42 → ПЗ-90.11', dx: 23.557, dy: -140.844, dz: -79.778, wx: -0.0023, wy: -0.34646, wz: -0.79421, m: -0.228e-6 },
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
      // Зоны шестиградусные (со слов заказчика, 06.10.2026): осевой первой зоны 60°03′, второй —
      // 66°03′, граница между ними 63°03′. Зона выбирается сама по долготе станции;
      // from — долгота, с которой зона начинается. Первая зона сверена с каталогом. Вторая проверена
      // грубо (10.10.2026): точка из опубликованного каталога «МСК-66, зона 2» (публичный сервитут в
      // Тугулымском районе, 445852.82 / 2400300.71) пересчитывается в 57.32° с. ш., 64.39° в. д. — в свой
      // район; при трёхградусной зоне она ушла бы на 180 км. Метровой сверки для второй и третьей зоны
      // нет (verified: false) — окно обязано об этом сказать.
      zones: [
        { zone: 1, lon0: 60.05, from: -Infinity, falseEasting: 1500000, falseNorthing: -5911057.63 },
        { zone: 2, lon0: 66.05, from: 63.05, falseEasting: 2500000, falseNorthing: -5911057.63, verified: false },
        { zone: 3, lon0: 72.05, from: 69.05, falseEasting: 3500000, falseNorthing: -5911057.63, verified: false },
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

  // Обратная проекция Гаусса — Крюгера: север и восток (без смещений зоны) -> широта и разность
  // долгот с осевым меридианом, радианы. Ряды Крюгера, как и в прямой задаче.
  function gaussKrugerInverse(north, east, ell) {
    const { a, f } = ell;
    const n = f / (2 - f);
    const n2 = n * n;
    const n3 = n2 * n;
    const n4 = n3 * n;
    const A = a / (1 + n) * (1 + n2 / 4 + n4 / 64);
    const beta = [
      n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360,
      n2 / 48 + n3 / 15 - 437 * n4 / 1440,
      17 * n3 / 480 - 37 * n4 / 840,
      4397 * n4 / 161280,
    ];
    const xi = north / A;
    const eta = east / A;
    let xi0 = xi;
    let eta0 = eta;
    for (let j = 0; j < 4; j++) {
      const k = 2 * (j + 1);
      xi0 -= beta[j] * Math.sin(k * xi) * Math.cosh(k * eta);
      eta0 -= beta[j] * Math.cos(k * xi) * Math.sinh(k * eta);
    }
    // Конформная широта -> геодезическая: уточнение по тангенсу, сходится за несколько шагов
    const e = Math.sqrt(f * (2 - f));
    const t0 = Math.sin(xi0) / Math.hypot(Math.sinh(eta0), Math.cos(xi0));
    let t = t0;
    for (let i = 0; i < 6; i++) {
      const sigma = Math.sinh(e * Math.atanh(e * t / Math.sqrt(1 + t * t)));
      const ti = t * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + t * t);
      t += (t0 - ti) / Math.sqrt(1 + ti * ti) * (1 + (1 - e * e) * t * t) / ((1 - e * e) * Math.sqrt(1 + t * t));
    }
    return { lat: Math.atan(t), dLon: Math.atan2(Math.sinh(eta0), Math.cos(xi0)) };
  }

  // Исходная система -> WGS-84: точное обращение перехода fromWgs84 (решается система 3×3)
  function toWgs84(v, d) {
    const wx = d.wx * SEC;
    const wy = d.wy * SEC;
    const wz = d.wz * SEC;
    const k = 1 / (1 + d.m);
    const m = [[k, -k * wz, k * wy], [k * wz, k, -k * wx], [-k * wy, k * wx, k]];
    const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const inv = [
      [(m[1][1] * m[2][2] - m[1][2] * m[2][1]) / det, (m[0][2] * m[2][1] - m[0][1] * m[2][2]) / det, (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / det],
      [(m[1][2] * m[2][0] - m[1][0] * m[2][2]) / det, (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / det, (m[0][2] * m[1][0] - m[0][0] * m[1][2]) / det],
      [(m[1][0] * m[2][1] - m[1][1] * m[2][0]) / det, (m[0][1] * m[2][0] - m[0][0] * m[2][1]) / det, (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / det],
    ];
    return [0, 1, 2].map((i) => inv[i][0] * v[0] + inv[i][1] * v[1] + inv[i][2] * v[2] + [d.dx, d.dy, d.dz][i]);
  }

  // Плоские координаты -> широта и долгота WGS-84 в градусах. zone — номер зоны (обязателен:
  // по одним плоским координатам зону не узнать). Высота принимается нулевой: на положение
  // в плане это влияет на доли миллиметра.
  function inverse(systemId, north, east, zone) {
    const system = SYSTEMS.find((s) => s.id === systemId);
    if (!system) return null;
    const z = system.zones ? system.zones.find((x) => x.zone === zone) : { lon0: zone * system.zoneWidth - system.zoneWidth / 2, falseEasting: zone * 1e6 + 500000, falseNorthing: 0 };
    if (!z) return null;
    const datum = DATUMS[system.datum];
    const ell = ELLIPSOIDS[datum.ellipsoid];
    const g = gaussKrugerInverse(north - z.falseNorthing, east - z.falseEasting, ell);
    const lon = z.lon0 * D2R + g.dLon;
    const e2 = ell.f * (2 - ell.f);
    const N = ell.a / Math.sqrt(1 - e2 * Math.sin(g.lat) ** 2);
    const local = [N * Math.cos(g.lat) * Math.cos(lon), N * Math.cos(g.lat) * Math.sin(lon), N * (1 - e2) * Math.sin(g.lat)];
    const w = toGeodetic(toWgs84(local, datum), { a: 6378137, f: 1 / 298.257223563 });
    return { lat: w.lat / D2R, lon: w.lon / D2R };
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
      verified: system.verified && z.verified !== false,
      zone: z.zone,
      north: p.north + z.falseNorthing,
      east: p.east + z.falseEasting,
    };
  }

  // Описание системы целиком: исходная система, эллипсоид и зоны — для сообщений пересчёта в потоке
  function describe(systemId) {
    const system = SYSTEMS.find((x) => x.id === systemId);
    if (!system) return null;
    const datum = DATUMS[system.datum];
    return { id: system.id, name: system.name, datum: { ...datum, id: system.datum }, ellipsoid: ELLIPSOIDS[datum.ellipsoid], zones: (system.zones || []).map((z) => ({ ...z, verified: system.verified && z.verified !== false })) };
  }

  return { list, register, convert, inverse, describe, gaussKruger, gaussKrugerInverse, fromWgs84, toWgs84, toGeodetic, ELLIPSOIDS, DATUMS, IGD };
});
