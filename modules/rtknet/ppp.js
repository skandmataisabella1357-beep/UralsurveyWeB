'use strict';
// Модуль «Расчёт подсети»: абсолютные координаты станции методом PPP-AR.
// Станция считается сама по себе, без опорной: по точным орбитам, часам и фазовым поправкам
// спутников, с фиксацией неоднозначностей. Расчёт делает открытая программа PRIDE PPP-AR
// (Уханьский университет); здесь — запуск, разбор ответа и перевод в ITRF2014.
//
// Продукты для спутников выходят с отставанием: «реального времени» — через несколько часов,
// быстрые — на следующий день. Поэтому PPP-AR считает наблюдения, которым уже несколько часов.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function available(dir) {
  return fs.existsSync(path.join(dir, 'bin', 'pdp3')) && fs.existsSync(path.join(dir, 'config_template'));
}

// Ответ программы — файл pos_ГГГГДДД_имя: шапка и строка
// «имя MJD X Y Z Sx Sy Sz Rxy Rxz Ryz Sig0 Nobs»; точность координаты = Sig0·√S.
function parsePos(text) {
  const lines = text.split('\n');
  const head = (label) => { const l = lines.find((x) => x.slice(60).trim() === label); return l ? l.slice(0, 60).trim() : ''; };
  const at = lines.findIndex((l) => l.startsWith('*Name'));
  const f = at >= 0 && lines[at + 1] ? lines[at + 1].trim().split(/\s+/) : [];
  if (f.length < 13) return null;
  const v = f.slice(1).map(Number);
  const [, x, y, z, sx, sy, sz] = v;
  const sig0 = v[10];
  const nobs = v[11];
  if (![x, y, z, sx, sy, sz, sig0].every(Number.isFinite) || !nobs || Math.hypot(x, y, z) < 6.3e6) return null;
  const when = (s) => { const p = s.split(/\s+/).map(Number); return p.length >= 6 ? Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4], p[5]) : null; };
  return {
    ecef: [x, y, z],
    sd: [sx, sy, sz].map((s) => sig0 * Math.sqrt(Math.max(s, 0))),
    nobs,
    fixed: /^YES\b/.test(head('AMB FIXING')),
    first: when(head('OBS FIRST EPOCH')),
    last: when(head('OBS LAST EPOCH')),
    products: head('SAT ORBIT').split('_')[0] || '',
    antenna: head('SITE ANTENNA TYPE'),
  };
}

// ITRF2020 -> ITRF2014 на эпоху измерений (параметры IERS: сдвиги −1,4; −0,9; 1,4 мм и масштаб
// −0,42·10⁻⁹ на эпоху 2015,0; скорости 0; −0,1; 0,2 мм в год; поворотов нет). Это миллиметры.
function itrf2020to2014(ecef, year) {
  const dt = year - 2015;
  const t = [-0.0014, -0.0009 - 0.0001 * dt, 0.0014 + 0.0002 * dt];
  const d = -0.42e-9;
  return ecef.map((v, i) => v + t[i] + d * v);
}

const decimalYear = (ms) => { const y = new Date(ms).getUTCFullYear(); return y + (ms - Date.UTC(y, 0, 1)) / (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)); };

// Расчёт одной станции. dir — рабочая папка (своя на станцию); obsFile — наблюдения RINEX;
// navFile — эфемериды суток (свои: тот файл, что программа качает сама, бывает неполным);
// from, to — границы расчёта. Возвращает { sol } или { error }.
function run({ pride, dir, code, obsFile, navFile, from, to, timeoutMs = 20 * 60 * 1000 }) {
  const site = code.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4).padEnd(4, 'x');
  const d = new Date(from);
  const doy = String(Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1).padStart(3, '0');
  const yy = String(d.getUTCFullYear()).slice(2);
  fs.mkdirSync(dir, { recursive: true });
  const obs = path.join(dir, `${site}.obs`);
  fs.copyFileSync(obsFile, obs);
  fs.copyFileSync(navFile, path.join(dir, `brdm${doy}0.${yy}p`));
  const stamp = (ms) => { const t = new Date(ms).toISOString(); return [t.slice(0, 10).replace(/-/g, '/'), t.slice(11, 19)]; };
  const args = ['-cfg', path.join(pride, 'config_template'), '-m', 'S', '-i', '30', '-n', site, '-s', ...stamp(from), '-e', ...stamp(to), obs];
  return new Promise((resolve) => {
    execFile(path.join(pride, 'bin', 'pdp3'), args, { cwd: dir, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PATH: `${path.join(pride, 'bin')}:${process.env.PATH}`, LC_ALL: 'C' } }, (err, stdout, stderr) => {
      let text = '';
      try { text = fs.readFileSync(path.join(dir, String(d.getUTCFullYear()), doy, `pos_${d.getUTCFullYear()}${doy}_${site}`), 'latin1'); } catch (e) { /* ответа нет */ }
      const sol = parsePos(text);
      if (sol) { resolve({ sol }); return; }
      const out = `${stdout}${stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
      const why = /failed to download|no satellite clock|PrepareProducts.*fail/i.test(out) ? 'продукты для спутников на это время ещё не вышли'
        : (err && err.killed ? 'расчёт не уложился во время' : 'решения нет: наблюдений с готовыми продуктами мало');
      resolve({ error: why });
    });
  });
}

// Суточный расчёт: какие сутки пора считать. Вчерашние — когда после их конца прошло отставание
// продуктов. Посчитанные по продуктам реального времени (RTS) пересчитываются позже: к тому
// времени выходят быстрые. task: { have: { 'ГГГГ-ММ-ДД': { products, at } }, tried: Map }.
const DAY = 86400000;
function dueDay(task, now, rules) {
  const day = Math.floor(now / DAY) * DAY - DAY;
  if (now < day + DAY + rules.pppDailyLagHours * 3600000) return null;
  const had = task.have[new Date(day).toISOString().slice(0, 10)];
  const tried = task.tried.get(day) || 0;
  if (!had) return now - tried >= rules.pppRetryMs ? day : null;
  const last = Math.max(tried, Date.parse(had.at) || 0);
  return /RTS$/.test(had.products || '') && now - last >= rules.pppDailyRedoHours * 3600000 ? day : null;
}

module.exports = { available, parsePos, itrf2020to2014, decimalYear, dueDay, run };
