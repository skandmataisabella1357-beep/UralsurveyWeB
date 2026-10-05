'use strict';
// Модуль «Расчёт подсети»: обращение к программам RTKLIB (convbin и rnx2rtkp).
// Сам расчёт векторов делает RTKLIB; здесь — настройки, запуск и разбор ответа.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// До этой длины вектор считается с фиксацией неоднозначностей; дальше ионосфера на двух концах
// разная, и надёжнее плавающее решение на комбинации двух частот.
const SHORT_METERS = 30000;

// Способы расчёта вектора:
//   fix      — короткий вектор: ионосфера по модели, неоднозначности фиксируются;
//   ionofree — длинный вектор: комбинация двух частот без ионосферы, решение плавающее;
//   ionoest  — длинный вектор: ионосфера оценивается как неизвестная, неоднозначности фиксируются
//              (нужны часы наблюдений; если фиксация не удержалась, берётся ionofree).
// precise — считать по точным орбитам: тогда нужен и файл антенн спутников (antex).
// glonass — в наблюдениях есть фаза ГЛОНАСС (номера частот подложены, см. glonass.js); её
// неоднозначности не фиксируются (у спутников разные частоты), но геометрию она улучшает.
// antennas — в шапках наблюдений указаны типы антенн станций: учитываются их фазовые центры.
function config({ base, long, method, precise = false, antex = '', glonass = false, l5 = false, antennas = false }) {
  const how = method || (long ? 'ionofree' : 'fix');
  const lines = {
    'pos1-posmode': 'static',
    'pos1-frequency': l5 && how !== 'ionofree' ? 'l1+l2+l5' : 'l1+l2',
    'pos1-soltype': 'forward',
    'pos1-elmask': '15',
    'pos1-dynamics': 'off',
    'pos1-tidecorr': 'off',
    'pos1-ionoopt': { fix: 'brdc', ionofree: 'dual-freq', ionoest: 'est-stec' }[how],
    'pos1-tropopt': how === 'fix' ? 'saas' : 'est-ztd',
    'pos1-sateph': precise ? 'precise' : 'brdc',
    'pos1-navsys': glonass ? '45' : '41', // GPS + Galileo + BeiDou, с ГЛОНАСС — 45
    'pos2-armode': how === 'ionofree' ? 'off' : 'continuous',
    'pos2-gloarmode': 'off',
    'pos2-bdsarmode': 'on',
    'pos2-arthres': '3',
    'out-solformat': 'xyz',
    'out-outhead': 'off',
    'out-outopt': 'off',
    'out-timesys': 'gpst',
    'out-timeform': 'hms',
    'out-timendec': '1',
    'out-solstatic': 'all',
    // При оценке ионосферы RTKLIB пишет её значения по спутникам в файл состояния
    'out-outstat': how === 'ionoest' ? 'state' : 'off',
    'ant2-postype': 'xyz',
    'ant2-pos1': base[0].toFixed(4),
    'ant2-pos2': base[1].toFixed(4),
    'ant2-pos3': base[2].toFixed(4),
  };
  if (precise || antennas) Object.assign(lines, { 'file-satantfile': antex, 'file-rcvantfile': antex });
  // Звёздочка — взять тип антенны из шапки файла наблюдений
  if (antennas) Object.assign(lines, { 'ant1-anttype': '*', 'ant2-anttype': '*' });
  return Object.entries(lines).map(([k, v]) => `${k.padEnd(18)} =${v}`).join('\n') + '\n';
}

// Разбор файла решения. Строка: дата время X Y Z Q спутников sdx sdy sdz sdxy sdyz sdzx возраст ratio.
// В статике каждая строка — оценка по всем данным до этой минуты, поэтому ответ — последняя строка.
function parsePos(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line || line[0] === '%') continue;
    const f = line.trim().split(/\s+/);
    if (f.length < 15) continue;
    const v = f.slice(2).map(Number);
    if (!v.slice(0, 5).every(Number.isFinite)) continue;
    rows.push({ at: Date.parse(`${f[0].replace(/\//g, '-')}T${f[1]}Z`), ecef: [v[0], v[1], v[2]], q: v[3], sats: v[4], sd: [v[5], v[6], v[7]], ratio: v[12] });
  }
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const tail = rows.slice(Math.floor(rows.length * 2 / 3));
  return {
    ecef: last.ecef,
    sd: last.sd,
    sats: last.sats,
    ratio: last.ratio,
    epochs: rows.length,
    spanMs: last.at - rows[0].at,
    lastFixed: last.q === 1,
    // Доля фиксированных решений в последней трети: фиксация должна держаться, а не мелькать
    fixShare: tail.filter((r) => r.q === 1).length / tail.length,
  };
}

// fixed — расчёт шёл с фиксацией неоднозначностей (способы fix и ionoest)
// Разница ионосферной задержки между концами вектора, по файлу состояния RTKLIB.
// Строка: $ION,неделя,секунды,статус,спутник,азимут,высота,задержка L1 (м),…
// Общая для всех спутников часть уходит в часы приёмника, поэтому мерой служит разброс между
// спутниками. Берётся последняя четверть расчёта (оценки к этому времени устоялись) и спутники
// выше 20°; ответ — медиана по эпохам, в метрах. null — данных мало.
function parseIono(text) {
  const epochs = new Map();
  for (const line of text.split('\n')) {
    if (!line.startsWith('$ION,')) continue;
    const f = line.split(',');
    const value = Number(f[7]);
    if (Number(f[6]) < 20 || !Number.isFinite(value)) continue;
    if (!epochs.has(f[2])) epochs.set(f[2], []);
    epochs.get(f[2]).push(value);
  }
  const list = [...epochs.values()];
  const spreads = list.slice(Math.floor(list.length * 0.75)).filter((v) => v.length >= 5).map((v) => {
    const mean = v.reduce((sum, x) => sum + x, 0) / v.length;
    return Math.sqrt(v.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (v.length - 1));
  }).sort((a, b) => a - b);
  return spreads.length >= 3 ? spreads[Math.floor(spreads.length / 2)] : null;
}

function quality(sol, long, fixed = !long) {
  if (!sol) return 'none';
  return fixed && sol.lastFixed && sol.fixShare >= 0.8 ? 'fix' : 'float';
}

function run(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, error: err ? (err.killed ? 'расчёт не уложился во время' : err.message.split('\n')[0]) : '', text: `${stdout}${stderr}` });
    });
  });
}

// Поток RTCM -> файл наблюдений RINEX. start — примерное время начала записи: в RTCM нет даты.
// antenna — тип антенны станции из каталога: попадает в шапку наблюдений
// interval — оставить эпохи с таким шагом в секундах
async function toRinex({ bin, rtcmFile, obsFile, start, antenna = '', interval = 0 }) {
  const d = new Date(start);
  const p2 = (n) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}/${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}`;
  const time = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
  const res = await run(path.join(bin, 'convbin'), ['-r', 'rtcm3', '-tr', date, time, '-v', '3.04', ...(antenna ? ['-ha', `0/${antenna}`] : []), ...(interval > 5 ? ['-ti', String(interval)] : []), '-o', obsFile, '-n', `${obsFile}.nav`, rtcmFile], 120000);
  return res.ok && fs.existsSync(obsFile) ? { ok: true } : { ok: false, error: res.error || 'наблюдения не прочитаны' };
}

// Приближённые координаты станции из шапки файла наблюдений (в поток их кладёт сама станция)
function approxPosition(obsFile) {
  let head = '';
  try {
    const fd = fs.openSync(obsFile, 'r');
    const buf = Buffer.alloc(8192);
    head = buf.toString('latin1', 0, fs.readSync(fd, buf, 0, buf.length, 0));
    fs.closeSync(fd);
  } catch (err) {
    return null;
  }
  const line = head.split('\n').find((l) => l.includes('APPROX POSITION XYZ'));
  if (!line) return null;
  const xyz = line.slice(0, 42).trim().split(/\s+/).map(Number);
  return xyz.length === 3 && xyz.every(Number.isFinite) && Math.hypot(...xyz) > 6.3e6 ? xyz : null;
}

// Вектор от базы до станции. base — координаты базы; возвращает разобранное решение или null.
async function baseline({ bin, dir, rover, baseCode, base, long, method, navFiles, orbitFiles = [], antex = '', glonass = false, l5 = false, antennas = false }) {
  const precise = orbitFiles.length > 0 && Boolean(antex);
  const how = method || (long ? 'ionofree' : 'fix');
  const conf = path.join(dir, `${rover}-${baseCode}-${how}.conf`);
  const out = path.join(dir, `${rover}-${baseCode}-${how}.pos`);
  fs.writeFileSync(conf, config({ base, method: how, precise, antex, glonass, l5, antennas: antennas && Boolean(antex) }));
  try { fs.unlinkSync(out); } catch (err) { /* прежнего решения нет */ }
  const res = await run(path.join(bin, 'rnx2rtkp'), ['-k', conf, '-o', out, path.join(dir, `${rover}.obs`), path.join(dir, `${baseCode}.obs`), ...navFiles, ...(precise ? orbitFiles : [])], 600000);
  let text = '';
  try { text = fs.readFileSync(out, 'utf8'); } catch (err) { /* решения нет */ }
  const sol = parsePos(text);
  let iono = null;
  if (how === 'ionoest') {
    try { iono = parseIono(fs.readFileSync(`${out}.stat`, 'latin1')); } catch (err) { /* файла состояния нет */ }
    fs.rm(`${out}.stat`, { force: true }, () => {});
  }
  return { sol, precise, method: how, iono, error: sol ? '' : (res.error || 'решения нет: мало общих спутников или данных') };
}

function available(bin) {
  return ['convbin', 'rnx2rtkp'].every((name) => fs.existsSync(path.join(bin, name)));
}

module.exports = { SHORT_METERS, config, parsePos, parseIono, quality, toRinex, approxPosition, baseline, available };
