'use strict';
// Служба расчёта подсетей: считает координаты станций подсети от опорной по живым потокам.
// Служба постоянно хранит последние часы наблюдений всех станций (прореженных, эпоха раз в 5 с),
// поэтому расчёт не ждёт записи: по кнопке «Вычислить текущие координаты» он берёт то, что уже
// накоплено. Непрерывный расчёт повторяет то же раз в двадцать минут: координаты сети берутся
// из PPP-AR, а он нужен для контроля и оценки ионосферы — чаще считать незачем.
//
// Станции связываются взаимными треугольниками; считаются все стороны сети, затем сеть
// уравнивается от опорной станции. Незамыкания треугольников и невязки уравнивания показывают,
// какому вектору верить нельзя. Сам расчёт векторов делает RTKLIB; эфемериды и точные орбиты
// берутся из открытых архивов. Ход расчёта виден в состоянии службы — панель показывает его в окне.
//
// Запуск отдельно: node server/solver/index.js

const fs = require('fs');
const path = require('path');
const { StreamParser } = require('../../core/stream');
const { BusClient } = require('../shared/bus');
const { request, readKey } = require('../shared/directory');
const { jsonServer } = require('../shared/http');
const { loadConfig } = require('../shared/config');
const rtcm = require('../rtcm/messages');
const { Thinner } = require('../../modules/rtknet/thin');
const rtklib = require('../../modules/rtknet/rtklib');
const ephemeris = require('../../modules/rtknet/ephemeris');
const orbits = require('../../modules/rtknet/orbits');
const glonass = require('../../modules/rtknet/glonass');
const network = require('../../modules/rtknet/network');
const ppp = require('../../modules/rtknet/ppp');

const HOUR = 3600000;
const RULES = {
  pollMs: 3000, // как часто спрашивать задания
  cycleMs: 20 * 60 * 1000, // пауза между пересчётами непрерывного расчёта
  keepHours: 72, // сколько последних часов наблюдений хранится
  windowHours: 6, // сколько последних часов идёт в расчёт
  history: 6, // по стольким последним пересчётам считается разброс
  parallel: 4, // сколько векторов считается одновременно
  pppLagHours: 3, // PPP-AR считает наблюдения не моложе этого: продукты спутников выходят с отставанием
  pppMinHours: 2, // и не меньше стольких часов наблюдений
  pppRetryMs: 20 * 60 * 1000, // как часто повторять, пока продуктов нет
  pppDailyLagHours: 3, // суточный PPP-AR: через сколько часов после конца суток считать их
  pppDailyRedoHours: 6, // сутки, посчитанные по продуктам реального времени, пересчитываются: ждём быстрые
  pppDailyMinHours: 6, // сутки с меньшим числом часов наблюдений не считаются
};
const WORDS = { fix: 'фиксированное', float: 'плавающее', none: 'нет решения' };

async function start({ config, log = console.log, rules = {}, directoryUrl = process.env.URAL_DIRECTORY || '', directoryKey,
  dataDir = process.env.URAL_DATA || path.join(__dirname, '..', '..', 'backend', 'data'), statePort = Number(process.env.URAL_SOLVER_PORT || 7104) }) {
  const R = { ...RULES, ...rules };
  const startedAt = Date.now();
  const bin = process.env.URAL_RTKLIB || path.join(dataDir, 'rtklib');
  const workDir = path.join(dataDir, 'solver');
  const ringDir = path.join(workDir, 'ring');
  const tasks = new Map(); // номер подсети -> задание
  const progress = new Map(); // номер подсети -> ход последнего расчёта (остаётся и после его конца)
  let key = directoryKey;
  let stopped = false;

  // ---------- Запас наблюдений: по файлу на станцию и час ----------

  const ring = new Map(); // код станции -> запись
  function prune(dir) {
    const oldest = Math.floor(Date.now() / HOUR) - R.keepHours;
    for (const name of fs.readdirSync(dir)) if (Number(name.split('.')[0]) < oldest) fs.unlinkSync(path.join(dir, name));
  }

  function onData(code, body) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(code)) return;
    let rec = ring.get(code);
    if (!rec) {
      rec = { parser: new StreamParser(), thin: new Thinner(), dir: path.join(ringDir, code), hour: 0, out: null, bytes: 0 };
      fs.mkdirSync(rec.dir, { recursive: true });
      ring.set(code, rec);
    }
    const frames = [];
    for (const fr of rec.parser.push(body)) if (fr.kind === 'rtcm' && rec.thin.take(fr.type, fr.payload)) frames.push(rtcm.frame(fr.payload));
    if (!frames.length) return;
    const hour = Math.floor(Date.now() / HOUR);
    if (hour !== rec.hour) {
      if (rec.out) rec.out.end();
      rec.hour = hour;
      rec.out = fs.createWriteStream(path.join(rec.dir, `${hour}.rtcm3`), { flags: 'a' });
      prune(rec.dir);
    }
    const data = Buffer.concat(frames);
    rec.bytes += data.length;
    rec.out.write(data);
  }

  // Наблюдения станции за последние часы — одним файлом в папке задания. Впереди подкладываются
  // номера частот ГЛОНАСС (fcn), иначе фаза ГЛОНАСС из MSM4 не читается. Возвращает начало записи.
  // range — часы [от, до] включительно; без него берутся последние часы расчётного окна
  function gather(code, target, fcn, range) {
    const dir = path.join(ringDir, code);
    const [low, high] = range || [Math.floor(Date.now() / HOUR) - R.windowHours, Infinity];
    let hours = [];
    try { hours = fs.readdirSync(dir).map((n) => Number(n.split('.')[0])).filter((h) => h >= low && h <= high).sort((a, b) => a - b); } catch (err) { /* станция ещё не писалась */ }
    const parts = hours.map((h) => fs.readFileSync(path.join(dir, `${h}.rtcm3`))).filter((b) => b.length);
    if (!parts.length) return null;
    let from = hours[0] * HOUR;
    // Первый файл мог начаться посреди часа; время создания вне этого часа (файл скопирован) не годится
    try { const born = fs.statSync(path.join(dir, `${hours[0]}.rtcm3`)).birthtimeMs || 0; if (born > from && born < from + HOUR) from = born; } catch (err) { /* начало часа */ }
    const head = parts[0][0] === 0xd3 && Object.keys(fcn).length ? glonass.hint(rtcm.frameStationId(parts[0]), fcn, from) : Buffer.alloc(0);
    fs.writeFileSync(target, Buffer.concat([head, ...parts]));
    return from;
  }

  const bus = new BusClient({ host: config.bind, port: config.ingest.busPort });
  bus.on('message', (header, body) => { if (header.t === 'data') onData(header.station, body); });
  bus.start();

  // ---------- Задания ----------

  function closeTask(task) {
    clearTimeout(task.timer);
    task.closed = true;
    fs.rm(task.dir, { recursive: true, force: true }, () => {});
  }

  function openTask(t) {
    const dir = path.join(workDir, String(t.id));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const task = {
      id: t.id, name: t.name, startedAt: t.startedAt, once: Boolean(t.once), reference: t.reference, ecef: t.ecef, stations: t.stations,
      antennas: t.antennas || {}, dir, history: new Map(), closed: false, busy: false, done: false, timer: null, cycles: 0, lastCycleAt: 0, lastCycleMs: 0, note: '',
    };
    task.timer = setTimeout(() => cycle(task), 300);
    log(`расчёт: подсеть ${t.name} — ${task.once ? 'вычисляем текущие координаты' : 'считаем непрерывно'}, станций ${t.stations.length}, опорная ${t.reference}`);
    return task;
  }

  function applyTasks(list) {
    const seen = new Set();
    for (const t of list) {
      seen.add(t.id);
      const old = tasks.get(t.id);
      if (old && old.startedAt === t.startedAt) continue;
      if (old) closeTask(old);
      tasks.set(t.id, openTask(t));
    }
    for (const [id, task] of tasks) {
      if (seen.has(id)) continue;
      // Расчёт закончен, остановлен или подсеть удалена: итог уже в базе
      closeTask(task);
      tasks.delete(id);
    }
  }

  // ---------- Расчёт ----------

  // Один вектор: способ по длине, точные орбиты с запасным вариантом на бортовых
  async function vector(task, link, base, files) {
    const long = link.length > rtklib.SHORT_METERS;
    const antennas = Boolean(task.antennas[link.from] && task.antennas[link.to]);
    const common = { bin, dir: task.dir, rover: link.to, baseCode: link.from, base, navFiles: files.nav, glonass: files.glonass, l5: true, antex: files.antex, antennas };
    // Длинный вектор: сначала с оценкой ионосферы и фиксацией, не вышло — комбинация без ионосферы
    const methods = long ? ['ionoest', 'ionofree'] : ['fix', 'ionoest'];
    for (const method of methods) {
      for (const orbitFiles of files.orbits.length ? [files.orbits, []] : [[]]) {
        const res = await rtklib.baseline({ ...common, method, orbitFiles });
        if (res.sol) return { ...link, sol: res.sol, method, precise: res.precise, iono: res.iono, base, quality: rtklib.quality(res.sol, long, method !== 'ionofree') };
      }
    }
    return { ...link, sol: null, quality: 'none', base };
  }

  async function solve(task) {
    const began = Date.now();
    const P = { subnet: task.name, startedAt: began, stage: '', done: 0, total: 0, lines: [], finished: false, tookMs: null };
    progress.set(task.id, P);
    const say = (text) => { P.lines.push({ at: Date.now(), text }); if (P.lines.length > 80) P.lines.shift(); };
    const stage = (text) => { P.stage = text; say(text); };
    const out = { stations: {}, vectors: [], reference: task.reference, startedAt: task.startedAt, cycles: task.cycles + 1, note: '' };
    const fail = (text) => { out.note = text; say(text); P.finished = true; P.tookMs = Date.now() - began; return out; };
    if (!rtklib.available(bin)) return fail('На сервере не найден RTKLIB: расчёт невозможен.');

    stage('Эфемериды спутников');
    const nav = await ephemeris.ensure(path.join(workDir, 'brdc'), began - R.windowHours * HOUR, began);
    if (!nav.files.length) return fail(`Нет эфемерид: ${nav.error || 'архив недоступен'}.`);
    if (nav.error) out.note = `Эфемериды не обновились (${nav.error}), считаем по прежним.`;
    let fcn = {};
    try { fcn = glonass.channels(fs.readFileSync(nav.files[nav.files.length - 1], 'latin1')); } catch (err) { /* без ГЛОНАСС */ }

    stage('Наблюдения станций');
    const starts = {};
    for (const code of task.stations) starts[code] = gather(code, path.join(task.dir, `${code}.rtcm3`), fcn);
    const since = Math.min(began, ...Object.values(starts).filter(Boolean));
    const minutes = Math.round((began - since) / 60000);
    // Для статики на часах наблюдений хватает редких эпох: расчёт быстрее, точность та же
    const interval = minutes < 60 ? 5 : (minutes < 180 ? 15 : 30);
    const approx = {};
    await Promise.all(task.stations.map(async (code) => {
      const res = starts[code] ? await rtklib.toRinex({ bin, rtcmFile: path.join(task.dir, `${code}.rtcm3`), obsFile: path.join(task.dir, `${code}.obs`),
        start: starts[code], antenna: task.antennas[code] || '', interval }) : { ok: false };
      const pos = res.ok ? rtklib.approxPosition(path.join(task.dir, `${code}.obs`)) : null;
      if (pos) approx[code] = pos;
      else out.stations[code] = { quality: 'none', note: res.ok ? 'в потоке станции нет её координат' : 'наблюдений пока нет' };
    }));
    say(`Станций с наблюдениями: ${Object.keys(approx).length} из ${task.stations.length}, в расчёте последние ${minutes} мин, эпоха ${interval} с`);
    out.window_minutes = minutes;

    stage('Точные орбиты');
    const antex = await orbits.ensureAntex(path.join(workDir, 'orbits'), ephemeris.download);
    const orb = antex ? await orbits.ensure(path.join(workDir, 'orbits'), since, began) : { files: [], center: '', error: 'нет файла антенн спутников' };
    out.orbits = orb.files.length ? `точные, CDDIS (${orb.center})` : `бортовые (точных нет: ${orb.error})`;
    say(`Орбиты: ${out.orbits}; ГЛОНАСС: ${Object.keys(fcn).length ? 'в расчёте' : 'нет номеров частот'}`);
    const files = { nav: nav.files, orbits: orb.files, antex: antex || '', glonass: Object.keys(fcn).length > 0 };

    out.stations[task.reference] = { quality: 'reference', x: task.ecef[0], y: task.ecef[1], z: task.ecef[2], from: null,
      shift: approx[task.reference] ? Number(Math.hypot(...task.ecef.map((v, i) => v - approx[task.reference][i])).toFixed(4)) : null };
    if (!approx[task.reference]) return fail(`Опорная станция ${task.reference} не даёт наблюдений: считать не от чего.`);

    // Сеть: взаимные треугольники. Сначала дерево от опорной, затем остальные стороны.
    const plan = network.order(task.reference, network.edges(approx));
    P.total = plan.tree.length + plan.extra.length;
    stage(`Векторы сети: ${P.total}`);
    const known = { [task.reference]: task.ecef }; // координаты по цепочке — нужны как начало следующих векторов
    const parent = {};
    const done = [];
    const report = (v) => {
      P.done++;
      say(`${v.from} → ${v.to}, ${(v.length / 1000).toFixed(1)} км: ${WORDS[v.quality]}${v.sol ? `, ±${(Math.hypot(...v.sol.sd) * 1000).toFixed(0)} мм` : ''}`);
      done.push(v);
    };
    for (const link of plan.tree) {
      if (task.closed) return null;
      parent[link.to] = link;
      if (!known[link.from]) { report({ ...link, sol: null, quality: 'none' }); continue; }
      const v = await vector(task, link, known[link.from], files);
      if (v.sol) known[link.to] = v.sol.ecef;
      report(v);
    }
    for (let i = 0; i < plan.extra.length; i += R.parallel) {
      if (task.closed) return null;
      const batch = plan.extra.slice(i, i + R.parallel).filter((link) => known[link.from] && known[link.to]);
      (await Promise.all(batch.map((link) => vector(task, link, known[link.from], files)))).forEach(report);
    }

    stage('Уравнивание сети');
    const good = done.filter((v) => v.sol).map((v) => ({
      from: v.from, to: v.to, d: v.sol.ecef.map((x, i) => x - v.base[i]),
      // Оценка RTKLIB бывает слишком смелой: не верим точности лучше 3 мм + 0,1 мм на километр
      sigma: Math.max(Math.hypot(...v.sol.sd), 0.003 + v.length * 1e-7), source: v,
    }));
    const adj = good.length ? network.adjust(task.reference, task.ecef, good) : null;
    const closure = network.closures(good);
    const coords = adj ? adj.coords : known;
    good.forEach((g, i) => { g.source.resid = adj ? adj.residuals[i] : null; g.source.closure = closure.worst[network.key(g.from, g.to)] ?? null; });
    const worst = closure.triangles.reduce((m, t) => Math.max(m, t.closure), 0);
    out.network = { vectors: good.length, failed: done.length - good.length, triangles: closure.triangles.length,
      max_closure: closure.triangles.length ? Number(worst.toFixed(4)) : null, sigma0: adj && adj.sigma0 !== null ? Number(adj.sigma0.toFixed(2)) : null };
    say(`Векторов: ${good.length}, без решения: ${done.length - good.length}, треугольников: ${closure.triangles.length}${closure.triangles.length ? `, наибольшее незамыкание ${(worst * 1000).toFixed(0)} мм` : ''}`);

    // Ионосфера сейчас: на сколько миллиметров расходится её задержка на километр расстояния.
    // От неё зависит, как далеко от станции ровер получит фиксированное решение.
    const ppmOf = (v) => (v.sol && v.iono != null ? v.iono * 1000 / (v.length / 1000) : null);
    const median = (list) => { const s = list.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
    // Шум оценки только завышает разброс, и на коротких векторах сильнее всего (он делится на
    // малую длину). Поэтому берутся только векторы от 60 км, по ним — середина значений.
    const longOnes = done.filter((v) => v.length >= 60000).map(ppmOf).filter((x) => x != null);
    const pool = (longOnes.length >= 3 ? longOnes : done.map(ppmOf).filter((x) => x != null)).sort((a, b) => a - b);
    const netPpm = pool.length ? pool[Math.floor(pool.length / 2)] : null;
    const radii = (ppm) => {
      if (ppm == null) return {};
      // Двухчастотный ровер сам учитывает ионосферу и держит фиксацию примерно до 7,5 см её
      // расхождения с базой (в спокойной ионосфере это 40–50 км, как и бывает на практике);
      // до ~30 см решение остаётся плавающим, дальше база роверу почти не помогает
      const fix = Math.max(10, Math.min(100, 75 / ppm));
      return { iono_ppm: Number(ppm.toFixed(2)), fix_km: Number(fix.toFixed(1)), float_km: Number(Math.max(fix, Math.min(300, 300 / ppm)).toFixed(1)) };
    };
    if (netPpm != null) out.network.iono_ppm = Number(netPpm.toFixed(2));
    say(netPpm == null ? 'Ионосфера: оценки пока нет' : `Ионосфера: ${netPpm.toFixed(1)} мм на км — фиксированное решение до ${radii(netPpm).fix_km} км от станции`);
    // Радиус один на всю сеть: ионосфера над областью общая, а разница между станциями —
    // в основном шум оценки, и разнобой кругов на карте только мешает
    Object.assign(out.stations[task.reference], radii(netPpm));

    out.vectors = done.map((v) => ({
      a: v.from, b: v.to, length_km: Number((v.length / 1000).toFixed(2)), quality: v.quality, method: v.method || null, orbits: v.sol ? (v.precise ? 'precise' : 'broadcast') : null,
      sd: v.sol ? Number(Math.hypot(...v.sol.sd).toFixed(4)) : null, resid: v.resid == null ? null : Number(v.resid.toFixed(4)), closure: v.closure == null ? null : Number(v.closure.toFixed(4)),
      minutes: v.sol ? Math.round(v.sol.spanMs / 60000) : null, sats: v.sol ? v.sol.sats : null, fix_share: v.sol ? Number(v.sol.fixShare.toFixed(2)) : null,
      iono: v.sol && v.iono != null ? Number(v.iono.toFixed(4)) : null,
    }));
    for (const code of Object.keys(approx)) {
      if (code === task.reference) continue;
      const mine = done.filter((v) => v.from === code || v.to === code);
      const ok = mine.filter((v) => v.sol);
      const link = parent[code];
      const entry = { from: link ? link.from : null, length_km: link ? Number((link.length / 1000).toFixed(2)) : null, vectors: ok.length, ...radii(netPpm) };
      out.stations[code] = entry;
      if (!coords[code] || !ok.length) {
        Object.assign(entry, { quality: 'none', note: mine.length ? 'нет решения ни по одному вектору' : 'станция не связана с сетью' });
        continue;
      }
      const xyz = coords[code];
      const past = task.history.get(code) || [];
      past.push(xyz);
      if (past.length > R.history) past.shift();
      task.history.set(code, past);
      // Разброс: насколько ответ гулял за последние пересчёты; мало пересчётов — оценки нет
      let spread = null;
      if (past.length >= 3) {
        const mean = [0, 1, 2].map((i) => past.reduce((sum, p) => sum + p[i], 0) / past.length);
        spread = Math.max(...past.map((p) => Math.hypot(p[0] - mean[0], p[1] - mean[1], p[2] - mean[2])));
      }
      const sd = adj && adj.sd[code] ? adj.sd[code] : ok[0].sol.sd;
      Object.assign(entry, {
        quality: ok.every((v) => v.quality === 'fix') ? 'fix' : 'float',
        x: Number(xyz[0].toFixed(4)), y: Number(xyz[1].toFixed(4)), z: Number(xyz[2].toFixed(4)), sd: sd.map((v) => Number(v.toFixed(4))),
        resid: ok.some((v) => v.resid != null) ? Number(Math.max(...ok.map((v) => v.resid || 0)).toFixed(4)) : null,
        minutes: Math.max(...ok.map((v) => Math.round(v.sol.spanMs / 60000))), sats: Math.max(...ok.map((v) => v.sol.sats)),
        spread: spread === null ? null : Number(spread.toFixed(4)),
        // Насколько расчёт разошёлся с координатами, которые станция сама передаёт в потоке
        shift: Number(Math.hypot(...xyz.map((v, i) => v - approx[code][i])).toFixed(4)),
      });
    }
    out.tookMs = Date.now() - began;
    P.finished = true;
    P.tookMs = out.tookMs;
    stage(`Готово за ${Math.round(out.tookMs / 1000)} с`);
    return out;
  }

  async function cycle(task) {
    if (task.closed || task.busy || task.done || stopped) return;
    task.busy = true;
    const began = Date.now();
    try {
      const results = await solve(task);
      if (results && !task.closed) {
        task.cycles++;
        task.note = results.note || '';
        let stored = !directoryUrl;
        if (directoryUrl) {
          if (!key) key = readKey();
          // final — разовый расчёт закончен: служба управления сама переведёт подсеть в «выполнен»
          const res = await request('POST', `${directoryUrl}/internal/solver`, key, { id: task.id, startedAt: task.startedAt, results, final: task.once }, 10000);
          stored = res.ok;
        }
        task.last = results;
        if (task.once && stored) task.done = true;
      }
    } catch (err) {
      task.note = `сбой расчёта: ${err.message}`;
      const P = progress.get(task.id);
      if (P) { P.lines.push({ at: Date.now(), text: `Сбой расчёта: ${err.message}` }); P.finished = true; }
      log(`расчёт: подсеть ${task.name} — ${task.note}`);
    } finally {
      task.busy = false;
      task.lastCycleAt = Date.now();
      task.lastCycleMs = Date.now() - began;
      // Разовый расчёт, чей ответ не дошёл до управления, повторяется вскоре; непрерывный — по расписанию
      if (!task.closed && !task.done && !stopped) task.timer = setTimeout(() => cycle(task), task.once ? 10000 : R.cycleMs);
    }
  }

  // ---------- PPP-AR: абсолютные координаты каждой станции ----------

  const pride = process.env.URAL_PRIDE || path.join(dataDir, 'pride');
  const pppTasks = new Map(); // номер подсети -> задание

  // Расчёт станций задания за отрезок одних суток [day, to]. Заполняет out.stations и out.epoch.
  // Возвращает число решённых станций; −1 — считать нечего (нет наблюдений или эфемерид).
  let pppBusy = 0;
  async function pppSolve(task, day, to, minHours, out, P, say) {
    pppBusy++;
    try {
      P.stage = 'Наблюдения станций';
      say(P.stage);
      const nav = await ephemeris.ensure(path.join(workDir, 'brdc'), day, day);
      let fcn = {};
      try { fcn = glonass.channels(fs.readFileSync(nav.files[0], 'latin1')); } catch (err) { /* без ГЛОНАСС */ }
      const ready = [];
      for (const code of task.stations) {
        const file = path.join(task.dir, `${code}.rtcm3`);
        const from = gather(code, file, fcn, [Math.floor(day / HOUR), Math.floor((to - 1) / HOUR)]);
        const start = from ? Math.max(from, day) : null;
        if (!start || to - start < minHours * HOUR) { out.stations[code] = { note: 'мало наблюдений, для которых уже есть продукты' }; continue; }
        const obs = path.join(task.dir, `${code}.obs`);
        const res = await rtklib.toRinex({ bin, rtcmFile: file, obsFile: obs, start, antenna: task.antennas[code] || '', interval: 30 });
        if (res.ok) ready.push({ code, obs, start, approx: rtklib.approxPosition(obs) });
        else out.stations[code] = { note: 'наблюдения не прочитаны' };
      }
      if (!ready.length || !nav.files.length) return -1;
      P.stage = `PPP-AR: станций ${ready.length}`;
      say(`${P.stage}, наблюдения до ${new Date(to).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
      const year = ppp.decimalYear((ready[0].start + to) / 2);
      out.epoch = Number(year.toFixed(3));
      let solved = 0;
      for (let i = 0; i < ready.length && !task.closed; i += 3) {
        await Promise.all(ready.slice(i, i + 3).map(async (st) => {
          const res = await ppp.run({ pride, dir: path.join(task.dir, st.code), code: st.code, obsFile: st.obs, navFile: nav.files[0], from: st.start, to });
          P.done++;
          if (!res.sol) { out.stations[st.code] = { note: res.error }; say(`${st.code}: ${res.error}`); return; }
          solved++;
          const s = res.sol;
          const old = ppp.itrf2020to2014(s.ecef, year);
          out.stations[st.code] = {
            x: Number(s.ecef[0].toFixed(4)), y: Number(s.ecef[1].toFixed(4)), z: Number(s.ecef[2].toFixed(4)),
            x14: Number(old[0].toFixed(4)), y14: Number(old[1].toFixed(4)), z14: Number(old[2].toFixed(4)),
            sd: s.sd.map((v) => Number(v.toFixed(4))), fixed: s.fixed, nobs: s.nobs, products: s.products,
            hours: Number(((s.last - s.first) / HOUR).toFixed(1)),
            shift: st.approx ? Number(Math.hypot(...old.map((v, k) => v - st.approx[k])).toFixed(4)) : null,
          };
          say(`${st.code}: ${s.fixed ? 'неоднозначности зафиксированы' : 'плавающее решение'}, ±${(Math.hypot(...s.sd) * 1000).toFixed(0)} мм, ${out.stations[st.code].hours} ч, продукты ${s.products}`);
        }));
      }
      return solved;
    } finally {
      pppBusy--;
    }
  }

  // ---------- Суточный PPP-AR: вчерашние сутки целиком, ответы копятся в управлении ----------

  const DAY = 24 * HOUR;
  const dailyTasks = new Map(); // номер подсети -> задание
  const dayName = (ms) => new Date(ms).toISOString().slice(0, 10);

  async function dailyCycle(task) {
    const now = Date.now();
    const day = ppp.dueDay(task, now, R);
    if (day === null || task.busy || task.closed || pppBusy || stopped || !ppp.available(pride)) return;
    task.busy = true;
    task.tried.set(day, now);
    const P = { subnet: `${task.name} · сутки ${dayName(day)}`, startedAt: now, stage: '', done: 0, total: task.stations.length, lines: [], finished: false, tookMs: null };
    progress.set(`ppp-${task.id}`, P);
    const say = (text) => { P.lines.push({ at: Date.now(), text }); if (P.lines.length > 80) P.lines.shift(); };
    try {
      fs.rmSync(task.dir, { recursive: true, force: true });
      fs.mkdirSync(task.dir, { recursive: true });
      const out = { stations: {} };
      const solved = await pppSolve(task, day, day + DAY, R.pppDailyMinHours, out, P, say);
      P.finished = true;
      P.tookMs = Date.now() - now;
      if (solved > 0) {
        if (!key) key = readKey();
        const res = directoryUrl ? await request('POST', `${directoryUrl}/internal/solver`, key, { kind: 'ppp-day', id: task.id, day: dayName(day), results: out }, 10000) : { ok: true };
        P.stage = `Сутки ${dayName(day)}: станций ${solved}, за ${Math.round(P.tookMs / 1000)} с${res.ok ? '' : ' — управление ответ не приняло'}`;
        log(`расчёт: суточный PPP-AR ${task.name} за ${dayName(day)} — станций ${solved}`);
      } else P.stage = solved < 0 ? `Сутки ${dayName(day)}: наблюдений нет` : `Сутки ${dayName(day)}: продукты спутников ещё не вышли, повторим`;
      say(P.stage);
    } catch (err) {
      say(`Сбой расчёта: ${err.message}`);
      log(`расчёт: суточный PPP-AR ${task.name} — сбой: ${err.message}`);
    } finally {
      task.busy = false;
      fs.rm(task.dir, { recursive: true, force: true }, () => {});
    }
  }

  function applyDaily(list) {
    const seen = new Set();
    for (const t of list) {
      seen.add(t.id);
      const task = dailyTasks.get(t.id) || { id: t.id, dir: path.join(workDir, `pppday-${t.id}`), tried: new Map(), busy: false, closed: false };
      Object.assign(task, { name: t.name, stations: t.stations, antennas: t.antennas || {}, have: t.have || {} });
      dailyTasks.set(t.id, task);
    }
    for (const [id, task] of dailyTasks) if (!seen.has(id)) { task.closed = true; dailyTasks.delete(id); }
  }
  // Подсети считаются по очереди: расчёт суток занимает процессор целиком
  const dailyTimer = setInterval(async () => { for (const task of [...dailyTasks.values()]) await dailyCycle(task); }, 60000);
  if (dailyTimer.unref) dailyTimer.unref();

  async function pppCycle(task) {
    if (task.closed || task.busy || stopped) return;
    task.busy = true;
    const began = Date.now();
    const P = { subnet: task.name, startedAt: began, stage: '', done: 0, total: task.stations.length, lines: [], finished: false, tookMs: null };
    progress.set(`ppp-${task.id}`, P);
    const say = (text) => { P.lines.push({ at: Date.now(), text }); if (P.lines.length > 80) P.lines.shift(); };
    const post = async (results, final) => {
      if (!directoryUrl) return true;
      if (!key) key = readKey();
      return (await request('POST', `${directoryUrl}/internal/solver`, key, { kind: 'ppp', id: task.id, startedAt: task.startedAt, results, final }, 10000)).ok;
    };
    let final = false;
    try {
      const out = { stations: {}, note: '', frame: 'ITRF2020 на эпоху измерений; рядом — пересчёт в ITRF2014' };
      // Считаются одни сутки по всемирному времени: от их начала до «сейчас минус отставание продуктов»
      const to = Math.floor((began - R.pppLagHours * HOUR) / 60000) * 60000;
      const day = Math.floor(to / (24 * HOUR)) * 24 * HOUR;
      if (!ppp.available(pride)) {
        out.note = 'На сервере не найдена программа PRIDE PPP-AR.';
        final = true;
      } else {
        const solved = await pppSolve(task, day, to, R.pppMinHours, out, P, say);
        if (solved > 0) final = true;
        else if (solved < 0) {
          out.note = `Ждём: PPP-AR считает наблюдения старше ${R.pppLagHours} ч (продукты спутников выходят с отставанием) и не короче ${R.pppMinHours} ч. Расчёт начнётся сам.`;
          say(out.note);
        } else { out.note = 'Продукты спутников на время наблюдений ещё не вышли. Расчёт повторится сам.'; say(out.note); }
      }
      out.tookMs = Date.now() - began;
      if (final) { P.finished = true; P.tookMs = out.tookMs; P.stage = `Готово за ${Math.round(out.tookMs / 1000)} с`; say(P.stage); } else P.stage = 'Ждём продукты спутников';
      if (!task.closed && await post(out, final) && final) task.done = true;
    } catch (err) {
      say(`Сбой расчёта: ${err.message}`);
      log(`расчёт: PPP-AR ${task.name} — сбой: ${err.message}`);
    } finally {
      task.busy = false;
      if (!task.closed && !task.done && !stopped) task.timer = setTimeout(() => pppCycle(task), R.pppRetryMs);
    }
  }

  function applyPpp(list) {
    const seen = new Set();
    for (const t of list) {
      seen.add(t.id);
      const old = pppTasks.get(t.id);
      if (old && old.startedAt === t.startedAt) continue;
      if (old) { clearTimeout(old.timer); old.closed = true; }
      const dir = path.join(workDir, `ppp-${t.id}`);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const task = { id: t.id, name: t.name, startedAt: t.startedAt, stations: t.stations, antennas: t.antennas || {}, dir, closed: false, busy: false, done: false, timer: null };
      task.timer = setTimeout(() => pppCycle(task), 300);
      pppTasks.set(t.id, task);
      log(`расчёт: PPP-AR подсети ${t.name}, станций ${t.stations.length}`);
    }
    for (const [id, task] of pppTasks) {
      if (seen.has(id)) continue;
      clearTimeout(task.timer);
      task.closed = true;
      fs.rm(task.dir, { recursive: true, force: true }, () => {});
      pppTasks.delete(id);
    }
  }

  let polling = false;
  async function poll() {
    if (polling || !directoryUrl) return;
    polling = true;
    try {
      if (!key) key = readKey();
      const res = await request('GET', `${directoryUrl}/internal/solver`, key);
      // Управление недоступно — работаем по прежним заданиям: расчёт от этого не останавливается
      if (res.ok && Array.isArray(res.body.subnets)) applyTasks(res.body.subnets);
      if (res.ok && Array.isArray(res.body.ppp)) applyPpp(res.body.ppp);
      if (res.ok && Array.isArray(res.body.pppDaily)) applyDaily(res.body.pppDaily);
    } finally {
      polling = false;
    }
  }
  const pollTimer = setInterval(poll, R.pollMs);
  if (pollTimer.unref) pollTimer.unref();
  poll();

  const state = jsonServer({
    '/state': () => ({
      service: 'solver',
      startedAt,
      ingestLink: bus.connected,
      rtklib: rtklib.available(bin),
      pride: ppp.available(pride),
      keepHours: R.keepHours,
      windowHours: R.windowHours,
      stations: ring.size,
      bytes: [...ring.values()].reduce((sum, r) => sum + r.bytes, 0),
      tasks: [...tasks.values()].map((t) => ({
        id: t.id, name: t.name, startedAt: t.startedAt, once: t.once, stations: t.stations.length, cycles: t.cycles, busy: t.busy,
        lastCycleAt: t.lastCycleAt, lastCycleMs: t.lastCycleMs, note: t.note,
      })),
      // Ход последнего расчёта каждой подсети: этап, сколько векторов готово, последние строки
      progress: Object.fromEntries([...progress].map(([id, p]) => [id, { ...p, lines: p.lines.slice(-40) }])),
    }),
  }, { host: config.bind, port: statePort });

  const ports = { state: await state.ready };
  log(`расчёт: служба запущена, RTKLIB ${rtklib.available(bin) ? 'на месте' : `не найден в ${bin}`}, храним ${R.keepHours} ч наблюдений, в расчёт идут последние ${R.windowHours} ч`);

  return {
    ports,
    tasks,
    ring,
    progress,
    applyTasks,
    cycle,
    async stop() {
      stopped = true;
      clearInterval(pollTimer);
      clearInterval(dailyTimer);
      bus.stop();
      for (const task of tasks.values()) closeTask(task);
      for (const rec of ring.values()) if (rec.out) rec.out.end();
      await state.close();
    },
  };
}

if (require.main === module) {
  // Запускающий процесс исчез — служба не остаётся сиротой
  process.on('disconnect', () => process.exit(0));
  const { config } = loadConfig();
  start({ config }).catch((err) => {
    console.error(`расчёт не запустился: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { start, RULES };
