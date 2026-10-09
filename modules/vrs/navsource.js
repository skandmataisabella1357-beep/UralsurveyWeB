'use strict';
// Модуль «VRS»: запасной источник эфемерид — архив CDDIS (NASA).
// Основной источник — сводный файл BKG; когда он недоступен, орбиты стареют, и через три часа
// сетевой расчёт остаётся без спутников. В архиве CDDIS лежат почасовые файлы эфемерид отдельных
// станций мировой сети: берутся несколько станций, которые видят то же небо, что и Урал, и их
// файлы за последние часы. Вход — открытый (anonymous по FTP с шифрованием), как у точных орбит.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');

const BASE = 'ftp://gdc.cddis.eosdis.nasa.gov/gnss/data/hourly';
// Станции по порядку предпочтения. Чередуются восток и запад: спутник, который у нас только
// восходит, раньше всех видят станции восточнее и южнее Урала, а заходящий — западнее. Ближние
// к Уралу (ARTU, MDVJ, KIT3, POL2) идут первыми, но в архиве бывают не всегда.
const STATIONS = ['ARTU', 'MDVJ', 'KIT3', 'POL2', 'URUM', 'NRIL', 'IITK', 'KIRU', 'LCK4', 'ISTA', 'DRDN', 'WTZR', 'JDPR', 'GANP', 'IISC', 'BUCU', 'SHLG', 'ZIMM', 'BADG', 'CHUM', 'ZECK', 'POTS', 'BRUX', 'NICO', 'USUD', 'YEL3'];
const HOUR = 3600000;

function curl(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-s', '--fail', '--ssl-reqd', '-u', 'anonymous:anonymous', ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(new Error('CDDIS не ответил')) : resolve(stdout)));
  });
}

const dayOf = (ms) => { const d = new Date(ms); return { year: d.getUTCFullYear(), doy: String(Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1).padStart(3, '0'), hour: String(d.getUTCHours()).padStart(2, '0') }; };

// Из списка файлов часа — файлы эфемерид всех систем у предпочтительных станций, не больше count
function choose(names, count = 6) {
  const mixed = names.filter((n) => /^[A-Z0-9]{9}_R_\d{11}_01H_MN\.rnx\.gz$/.test(n));
  const out = [];
  for (const st of STATIONS) {
    const hit = mixed.find((n) => n.startsWith(st));
    if (hit) out.push(hit);
    if (out.length >= count) break;
  }
  return out;
}

// Почасовые файлы за последние hours часов в папке dir. Возвращает { files, error }: при сбое
// сети остаются скачанные раньше. Уже скачанное заново не берётся.
async function ensure(dir, now, { hours = 4, count = 6, run = curl } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  let error = '';
  // Час появляется в архиве после своего конца: начинаем с прошлого
  for (let k = 1; k <= hours; k++) {
    const t = now - k * HOUR;
    const { year, doy, hour } = dayOf(t);
    const mark = path.join(dir, `hour-${year}-${doy}-${hour}.done`);
    if (fs.existsSync(mark)) continue;
    try {
      const names = (await run(['-m', '40', '-l', `${BASE}/${year}/${doy}/${hour}/`])).split(/\r?\n/).map((n) => n.trim());
      const picked = choose(names, count);
      // Архив наполняется постепенно: пока станций мало, час не считается взятым
      let got = 0;
      for (const name of picked) {
        const file = path.join(dir, name.replace(/\.gz$/, ''));
        if (!fs.existsSync(file)) {
          await run(['-m', '60', '-o', `${file}.gz`, `${BASE}/${year}/${doy}/${hour}/${name}`]);
          const text = zlib.gunzipSync(fs.readFileSync(`${file}.gz`));
          fs.unlinkSync(`${file}.gz`);
          if (!text.subarray(0, 200).toString('latin1').includes('NAV')) continue;
          fs.writeFileSync(file, text);
        }
        got++;
      }
      if (got >= Math.min(3, count)) fs.writeFileSync(mark, '');
    } catch (err) {
      error = err.message;
    }
  }
  // Старое не копится
  const files = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (now - fs.statSync(full).mtimeMs > (hours + 8) * HOUR) { fs.unlinkSync(full); continue; }
    if (name.endsWith('.rnx')) files.push(full);
  }
  return { files, error };
}

// Сводный файл из почасовых: шапка первого файла и записи всех подряд. Нужен программам, которым
// подаётся один файл эфемерид (RTKLIB, PPP). Берутся файлы третьей версии формата: записи четвёртой
// устроены иначе, под одной шапкой их смешивать нельзя. Возвращает путь или null, если собрать не из чего.
function merge(files, out) {
  let head = '';
  const bodies = [];
  for (const file of files.slice().sort()) {
    const text = fs.readFileSync(file, 'latin1');
    const at = text.indexOf('END OF HEADER');
    if (at < 0 || !/^\s+3\.\d\d/.test(text)) continue;
    const eol = text.indexOf('\n', at);
    if (!head) head = text.slice(0, eol + 1);
    const body = text.slice(eol + 1);
    if (body.trim()) bodies.push(body.endsWith('\n') ? body : `${body}\n`);
  }
  if (!head || !bodies.length) return null;
  fs.writeFileSync(`${out}.part`, head + bodies.join(''), 'latin1');
  fs.renameSync(`${out}.part`, out);
  return out;
}

module.exports = { ensure, choose, merge, STATIONS };
