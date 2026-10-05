'use strict';
// Модуль «Расчёт подсети»: точные орбиты спутников с CDDIS (NASA).
// Берутся сверхбыстрые орбиты (выходят 4 раза в сутки, половина файла — прогноз вперёд),
// поэтому годятся для расчёта по живым потокам. Вход — открытый (anonymous по FTP с шифрованием),
// учётная запись не нужна. Вместе с орбитами нужен файл антенн спутников igs20.atx: в орбитах
// даны центры масс спутников, а сигнал идёт от антенны.
//
// Если CDDIS недоступен или подходящего файла нет, расчёт идёт по бортовым эфемеридам.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');

const BASE = 'ftp://gdc.cddis.eosdis.nasa.gov/gnss/products';
const ANTEX_URL = 'https://files.igs.org/pub/station/general/igs20.atx';
// Чьи орбиты брать, по порядку: CODE и GFZ дают GPS и Galileo, сводные IGS — только GPS
const CENTERS = ['COD0OPSULT', 'GFZ0OPSULT', 'IGS0OPSULT'];
const LIST_MS = 30 * 60 * 1000;
const WEEK_MS = 7 * 864e5;
const GPS_EPOCH = Date.UTC(1980, 0, 6);

function gpsWeek(ms) {
  return Math.floor((ms - GPS_EPOCH) / WEEK_MS);
}

// COD0OPSULT_20262780000_02D_05M_ORB.SP3.gz -> центр, начало и конец охвата
function parseName(name) {
  const m = /^([A-Z0-9]{10})_(\d{4})(\d{3})(\d{2})(\d{2})_(\d{2})D_\d{2}M_ORB\.SP3\.gz$/.exec(name);
  if (!m) return null;
  const start = Date.UTC(Number(m[2]), 0, Number(m[3]), Number(m[4]), Number(m[5]));
  return { name, center: m[1], start, end: start + Number(m[6]) * 864e5 };
}

// Какие файлы нужны, чтобы покрыть время от from до to. Берётся самый свежий файл, достающий
// до to; если он начинается позже from — к нему добавляется файл, покрывающий начало.
function choose(names, from, to) {
  const all = names.map(parseName).filter(Boolean);
  for (const center of CENTERS) {
    const files = all.filter((f) => f.center === center && f.start <= to && f.end >= to).sort((a, b) => b.start - a.start);
    if (!files.length) continue;
    const picked = [files[0]];
    if (files[0].start > from) {
      const early = all.filter((f) => f.center === center && f.start <= from && f.end >= files[0].start).sort((a, b) => b.start - a.start)[0];
      // Начало расчёта не покрыто — орбиты этого центра не годятся
      if (!early) continue;
      picked.unshift(early);
    }
    return { center, files: picked };
  }
  return null;
}

function curl(args, timeoutMs = 150000) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-s', '--fail', '--ssl-reqd', '-u', 'anonymous:anonymous', ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(new Error('CDDIS не ответил')) : resolve(stdout)));
  });
}

const listing = { at: 0, weeks: '', names: [] };

// Файлы точных орбит на время от from до to. Возвращает { files, center, error }.
async function ensure(dir, from, to, run = curl) {
  fs.mkdirSync(dir, { recursive: true });
  const weeks = [...new Set([gpsWeek(from), gpsWeek(to)])];
  try {
    if (Date.now() - listing.at > LIST_MS || listing.weeks !== weeks.join()) {
      const names = [];
      for (const week of weeks) names.push(...(await run(['-m', '60', '-l', `${BASE}/${week}/`])).split(/\r?\n/).map((n) => ({ week, name: n.trim() })));
      listing.names = names;
      listing.weeks = weeks.join();
      listing.at = Date.now();
    }
    const got = choose(listing.names.map((n) => n.name), from, to);
    if (!got) return { files: [], center: '', error: 'на CDDIS нет орбит на это время' };
    const files = [];
    for (const f of got.files) {
      const file = path.join(dir, f.name.replace(/\.gz$/, ''));
      if (!fs.existsSync(file)) {
        const week = listing.names.find((n) => n.name === f.name).week;
        await run(['-m', '120', '-o', `${file}.gz`, `${BASE}/${week}/${f.name}`]);
        const text = zlib.gunzipSync(fs.readFileSync(`${file}.gz`));
        fs.unlinkSync(`${file}.gz`);
        if (text[0] !== 0x23) throw new Error('CDDIS прислал не файл орбит');
        fs.writeFileSync(file, text);
      }
      files.push(file);
    }
    // Старые файлы не копим
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (/\.SP3(\.gz)?$/.test(name) && !files.includes(full) && Date.now() - fs.statSync(full).mtimeMs > 3 * 864e5) fs.unlinkSync(full);
    }
    return { files, center: got.center.slice(0, 3), error: '' };
  } catch (err) {
    return { files: [], center: '', error: err.message };
  }
}

// Файл антенн спутников; обновляется раз в неделю. download — функция загрузки по HTTPS.
async function ensureAntex(dir, download) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'igs20.atx');
  let age = Infinity;
  try { age = Date.now() - fs.statSync(file).mtimeMs; } catch (err) { /* файла ещё нет */ }
  if (age > WEEK_MS) {
    try {
      const text = await download(ANTEX_URL, 120000);
      if (!text.subarray(0, 200).toString('latin1').includes('ANTEX')) throw new Error('пришёл не файл антенн');
      fs.writeFileSync(`${file}.part`, text);
      fs.renameSync(`${file}.part`, file);
    } catch (err) { /* останется прежний файл, если он есть */ }
  }
  return fs.existsSync(file) ? file : null;
}

module.exports = { ensure, ensureAntex, choose, parseName, gpsWeek, CENTERS };
