'use strict';
// Модуль «Расчёт подсети»: эфемериды спутников.
// В потоках станций орбит нет, поэтому они берутся из открытого архива BKG (igs.bkg.bund.de):
// сводный файл за сутки по всем системам, обновляется каждые 15 минут. Вход без регистрации.

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const REFRESH_MS = 15 * 60 * 1000;

function dayOf(date) {
  const d = new Date(date);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return { year: d.getUTCFullYear(), doy: String(Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 864e5) + 1).padStart(3, '0') };
}

function urlOf(date) {
  const { year, doy } = dayOf(date);
  return `https://igs.bkg.bund.de/root_ftp/IGS/BRDC/${year}/${doy}/BRDC00WRD_S_${year}${doy}0000_01D_MN.rnx.gz`;
}

function download(url, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`архив эфемерид ответил ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('архив эфемерид не ответил вовремя')));
    req.on('error', reject);
  });
}

// Файлы эфемерид на все сутки от from до to. Файл текущих суток обновляется раз в 15 минут,
// прошедших — скачивается один раз. Возвращает { files, error }: при сбое сети остаются прежние файлы.
async function ensure(dir, from, to, fetch = download) {
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  let error = '';
  const today = dayOf(to);
  for (let t = Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), new Date(from).getUTCDate()); t <= to; t += 864e5) {
    const { year, doy } = dayOf(t);
    const file = path.join(dir, `brdc-${year}-${doy}.rnx`);
    const current = year === today.year && doy === today.doy;
    let age = Infinity;
    try { age = Date.now() - fs.statSync(file).mtimeMs; } catch (err) { /* файла ещё нет */ }
    if (age === Infinity || (current && age > REFRESH_MS)) {
      try {
        const text = zlib.gunzipSync(await fetch(urlOf(t)));
        if (!text.subarray(0, 200).toString('latin1').includes('NAV DATA')) throw new Error('архив эфемерид прислал не тот файл');
        fs.writeFileSync(`${file}.part`, text);
        fs.renameSync(`${file}.part`, file);
      } catch (err) {
        error = err.message;
      }
    }
    if (fs.existsSync(file)) files.push(file);
  }
  return { files, error };
}

module.exports = { ensure, urlOf, dayOf, download };
