'use strict';
// Вход администратора в панель. Пароль хранится только в виде хеша (scrypt) в файле
// data/admin.json; задаёт его сам администратор командой node server/control/set-admin.js.
// Сеансы живут в памяти службы управления: после её перезапуска нужно войти заново.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_MS = 12 * 3600 * 1000;
const MIN_LENGTH = 10;

// Где лежат данные сервера: рядом с настройками службы либо в server/data
function dataDir() {
  if (process.env.URAL_DATA) return process.env.URAL_DATA;
  if (process.env.URAL_CONFIG) return path.dirname(process.env.URAL_CONFIG);
  return path.join(__dirname, '..', 'data');
}

function adminFile() {
  return path.join(dataDir(), 'admin.json');
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  return { salt: salt.toString('hex'), hash: crypto.scryptSync(String(password), salt, 32).toString('hex') };
}

function verifyPassword(password, record) {
  if (!record || !record.salt || !record.hash) return false;
  const got = crypto.scryptSync(String(password), Buffer.from(record.salt, 'hex'), 32);
  const want = Buffer.from(record.hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Запись о пароле администратора либо null, если пароль ещё не задан
function loadAdmin(file = adminFile()) {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    return record.salt && record.hash ? record : null;
  } catch (err) {
    return null;
  }
}

function saveAdmin(password, file = adminFile()) {
  if (String(password).length < MIN_LENGTH) throw new Error(`Пароль администратора — не короче ${MIN_LENGTH} знаков.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...hashPassword(password), setAt: new Date().toISOString() }), { mode: 0o600 });
  return file;
}

class Sessions {
  constructor() {
    this.map = new Map(); // токен -> срок действия
  }

  create() {
    const token = crypto.randomBytes(32).toString('hex');
    this.map.set(token, Date.now() + SESSION_MS);
    return token;
  }

  has(token) {
    const until = token && this.map.get(token);
    if (!until) return false;
    if (until < Date.now()) {
      this.map.delete(token);
      return false;
    }
    return true;
  }

  drop(token) {
    this.map.delete(token);
  }
}

// Не больше нескольких попыток входа в минуту с одного адреса
class Attempts {
  constructor(limit = 5) {
    this.limit = limit;
    this.map = new Map();
  }

  allowed(ip) {
    const now = Date.now();
    const list = (this.map.get(ip) || []).filter((t) => now - t < 60000);
    this.map.set(ip, list);
    return list.length < this.limit;
  }

  failed(ip) {
    const list = this.map.get(ip) || [];
    list.push(Date.now());
    this.map.set(ip, list);
  }
}

module.exports = { hashPassword, verifyPassword, loadAdmin, saveAdmin, adminFile, dataDir, Sessions, Attempts, SESSION_MS, MIN_LENGTH };
