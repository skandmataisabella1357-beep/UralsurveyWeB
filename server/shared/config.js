'use strict';
// Настройки сервера. Всё, что не секрет, лежит в одном файле config.json;
// пароли и ключи — отдельно в secrets.json. Оба файла в git не попадают:
// в репозитории есть только образцы config.example.json и secrets.example.json.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..');

const DEFAULTS = {
  // Службы слушают только эту машину, пока сервер не принят в работу
  bind: '127.0.0.1',
  ingest: { busPort: 7101, statePort: 7102 },
  caster: { statePort: 7103, port: 2101, enabled: false },
  vrs: { port: 7106 }, // внутреннее соединение раздачи со службой виртуальных баз
  control: { port: 8080 },
  stations: [],
};

function readJson(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Файл ${path.basename(file)} не читается как JSON: ${err.message}`);
  }
}

function merge(base, over) {
  const out = { ...base };
  for (const [key, value] of Object.entries(over || {})) {
    const plain = value && typeof value === 'object' && !Array.isArray(value);
    out[key] = plain && base[key] && typeof base[key] === 'object' ? merge(base[key], value) : value;
  }
  return out;
}

function checkPort(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`Настройка ${name}: порт — целое число от 0 до 65535.`);
}

// Проверка настроек: ошибка должна объяснять, что поправить
function validate(config) {
  checkPort(config.ingest.busPort, 'ingest.busPort');
  checkPort(config.ingest.statePort, 'ingest.statePort');
  checkPort(config.caster.statePort, 'caster.statePort');
  checkPort(config.caster.port, 'caster.port');
  checkPort(config.control.port, 'control.port');
  checkPort(config.vrs.port, 'vrs.port');
  if (!Array.isArray(config.stations)) throw new Error('Настройка stations — список станций.');
  const seen = new Set();
  config.stations.forEach((st, i) => {
    const where = `stations[${i}]`;
    if (!st || typeof st.code !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(st.code)) {
      throw new Error(`${where}: код станции — латинские буквы, цифры, «_» и «-», до 32 знаков.`);
    }
    if (seen.has(st.code)) throw new Error(`${where}: код станции ${st.code} повторяется.`);
    seen.add(st.code);
    const src = st.source;
    if (!src || !['sim', 'tcp', 'ntrip', 'listen'].includes(src.mode)) {
      throw new Error(`${where}: источник source.mode — одно из sim, tcp, ntrip, listen.`);
    }
    if (src.mode === 'tcp' || src.mode === 'ntrip') {
      if (!src.host) throw new Error(`${where}: у источника не указан адрес (source.host).`);
      checkPort(src.port, `${where}.source.port`);
    }
    if (src.mode === 'ntrip' && !src.mountpoint) throw new Error(`${where}: у источника NTRIP не указана точка подключения (source.mountpoint).`);
    if (src.mode === 'listen') checkPort(src.port, `${where}.source.port`);
    if (src.allow !== undefined && (!Array.isArray(src.allow) || src.allow.some((a) => typeof a !== 'string'))) {
      throw new Error(`${where}: список разрешённых адресов (source.allow) — список строк вида «1.2.3.4» или «10.0.0.0/8».`);
    }
    if (src.mode === 'sim' && !(Number.isFinite(src.lat) && Number.isFinite(src.lon))) {
      throw new Error(`${where}: имитатору нужны широта и долгота (source.lat, source.lon).`);
    }
  });
  return config;
}

// Читает настройки. Без config.json берётся образец: сервер запускается на имитаторах.
function loadConfig(options = {}) {
  const file = options.file || process.env.URALSURVEY_CONFIG || path.join(DIR, 'config.json');
  const example = path.join(DIR, 'config.example.json');
  const usingExample = !fs.existsSync(file);
  const config = validate(merge(DEFAULTS, readJson(usingExample ? example : file)));
  const secretsFile = options.secrets || process.env.URALSURVEY_SECRETS || path.join(DIR, 'secrets.json');
  const secrets = fs.existsSync(secretsFile) ? readJson(secretsFile) : {};
  return { config, secrets, usingExample, file: usingExample ? example : file };
}

// Логин и пароль источника берутся из секретов по имени, в настройках их нет
function credentials(secrets, name) {
  if (!name) return { username: '', password: '' };
  const found = secrets.credentials && secrets.credentials[name];
  if (!found) throw new Error(`В secrets.json нет записи credentials.${name}, на которую ссылается источник станции.`);
  return { username: String(found.username || ''), password: String(found.password || '') };
}

module.exports = { loadConfig, validate, merge, credentials, DEFAULTS };
