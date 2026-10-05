'use strict';
// Протокол NTRIP версий 1 и 2 со стороны кастера: разбор запроса ровера, ответы,
// таблица источников, строка GGA. Здесь нет сети — только текст и байты, чтобы каждую
// строку таблицы ответов из ТЗ можно было проверить тестом.

const SERVER = 'Uralsurvey NTRIP';
const MAX_REQUEST = 4096;

// Разбор запроса. Возвращает { pending } — запрос ещё не дочитан, { invalid } — мусор,
// либо { path, version, user, password, hasAuth, agent, gga, rest }.
function parseRequest(buf) {
  const end = buf.indexOf('\r\n\r\n');
  if (end === -1) {
    // Некоторые старые клиенты заканчивают запрос одним переводом строки
    const alt = buf.indexOf('\n\n');
    if (alt === -1) return buf.length > MAX_REQUEST ? { invalid: 'запрос слишком длинный' } : { pending: true };
    return parseHead(buf.toString('latin1', 0, alt), buf.subarray(alt + 2));
  }
  return parseHead(buf.toString('latin1', 0, end), buf.subarray(end + 4));
}

function parseHead(text, rest) {
  const lines = text.split(/\r?\n/);
  const first = /^(GET)\s+(\S+)(?:\s+HTTP\/(1\.[01]))?\s*$/i.exec(lines[0] || '');
  if (!first) return { invalid: 'непонятная первая строка запроса' };
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  let path = first[2];
  // Клиент может прислать полный адрес: http://host:port/POINT
  const abs = /^https?:\/\/[^/]+(\/.*)?$/i.exec(path);
  if (abs) path = abs[1] || '/';
  path = path.split('?')[0].replace(/^\/+/, '');
  try {
    path = decodeURIComponent(path);
  } catch (err) {
    return { invalid: 'непонятное имя точки подключения' };
  }
  const out = {
    path,
    version: /ntrip\/2/i.test(headers['ntrip-version'] || '') ? 2 : 1,
    agent: (headers['user-agent'] || '').slice(0, 120),
    user: '',
    password: '',
    hasAuth: false,
    gga: headers['ntrip-gga'] || null,
    rest,
  };
  const auth = /^Basic\s+(\S+)/i.exec(headers.authorization || '');
  if (auth) {
    const pair = Buffer.from(auth[1], 'base64').toString('utf8');
    const i = pair.indexOf(':');
    out.user = i === -1 ? pair : pair.slice(0, i);
    out.password = i === -1 ? '' : pair.slice(i + 1);
    out.hasAuth = true;
  }
  return out;
}

// ---------- Ответы ----------

const REASONS = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 503: 'Service Unavailable' };

// Начало потока: после этих строк идут байты RTCM
function streamHead(version) {
  if (version === 2) {
    return Buffer.from(`HTTP/1.1 200 OK\r\nNtrip-Version: Ntrip/2.0\r\nServer: ${SERVER}\r\nCache-Control: no-store, no-cache, max-age=0\r\nPragma: no-cache\r\nConnection: close\r\nContent-Type: gnss/data\r\nTransfer-Encoding: chunked\r\n\r\n`, 'latin1');
  }
  return Buffer.from('ICY 200 OK\r\n\r\n', 'latin1');
}

// Отказ с кодом из таблицы ответов
function refusal(version, code) {
  const reason = REASONS[code];
  if (!reason) throw new Error(`нет ответа с кодом ${code}`);
  const lines = [`HTTP/1.${version === 2 ? 1 : 0} ${code} ${reason}`, `Server: ${SERVER}`];
  if (version === 2) lines.push('Ntrip-Version: Ntrip/2.0');
  if (code === 401) lines.push('WWW-Authenticate: Basic realm="Uralsurvey"');
  lines.push('Content-Length: 0', 'Connection: close');
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
}

function sourcetableResponse(version, table) {
  const body = Buffer.from(table, 'latin1');
  const head = version === 2
    ? `HTTP/1.1 200 OK\r\nNtrip-Version: Ntrip/2.0\r\nServer: ${SERVER}\r\nContent-Type: gnss/sourcetable\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`
    : `SOURCETABLE 200 OK\r\nServer: ${SERVER}\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, 'latin1'), body]);
}

// Порция данных для версии 2 (Transfer-Encoding: chunked)
function chunk(data) {
  return Buffer.concat([Buffer.from(`${data.length.toString(16)}\r\n`, 'latin1'), data, Buffer.from('\r\n', 'latin1')]);
}

// ---------- Таблица источников ----------

const SYSTEM_BY_MSM = { 107: 'GPS', 108: 'GLO', 109: 'GAL', 110: 'SBS', 111: 'QZS', 112: 'BDS', 113: 'IRN' };

// points: [{ name, city, messages: [{ type, period }], lat, lon, needsGga, receiver, bitrate }]
function sourcetable({ host, port, points }) {
  const lines = [
    `CAS;${host};${port};Uralsurvey;UCI;0;RUS;56.84;60.61;0.0.0.0;0;`,
    'NET;URALSURVEY;UCI;B;N;;;;none',
  ];
  for (const p of points) {
    const systems = [...new Set(p.messages.map((m) => SYSTEM_BY_MSM[Math.floor(m.type / 10)]).filter(Boolean))].join('+');
    const types = p.messages.map((m) => `${m.type}(${m.period})`).join(',');
    const clean = (s) => String(s || '').replace(/[;\r\n]/g, ' ').replace(/[^\x20-\x7e]/g, '?');
    lines.push([
      // Таблица передаётся латиницей: название кириллицей заменяем именем точки
      'STR', clean(p.name), /^[ -~]+$/.test(p.city || '') ? clean(p.city) : clean(p.name), 'RTCM 3.2', types, 2, systems || 'GNSS', 'URALSURVEY', 'RUS',
      p.lat === null ? '0.00' : p.lat.toFixed(2), p.lon === null ? '0.00' : p.lon.toFixed(2),
      p.needsGga ? 1 : 0, 0, clean(p.receiver) || 'unknown', 'none', 'B', 'Y', p.bitrate || 0, '',
    ].join(';'));
  }
  lines.push('ENDSOURCETABLE');
  return `${lines.join('\r\n')}\r\n`;
}

// ---------- Координаты ровера ----------

// Строка NMEA GGA. Принимается, если верна контрольная сумма, решение не нулевое
// и координаты правдоподобны. Возвращает null, если строка не годится.
function parseGga(line) {
  const m = /^\$(G[A-Z]GGA,[^*]*)\*([0-9A-Fa-f]{2})\s*$/.exec(line.trim());
  if (!m) return null;
  let sum = 0;
  for (let i = 0; i < m[1].length; i++) sum ^= m[1].charCodeAt(i);
  if (sum !== parseInt(m[2], 16)) return null;
  const f = m[1].split(',');
  const quality = Number(f[6]);
  if (!f[2] || !f[4] || !(quality > 0)) return null;
  const angle = (text, degLen) => Number(text.slice(0, degLen)) + Number(text.slice(degLen)) / 60;
  let lat = angle(f[2], 2);
  let lon = angle(f[4], 3);
  if (f[3] === 'S') lat = -lat;
  if (f[5] === 'W') lon = -lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  // Тип решения: 4 — фиксированное, 5 — плавающее, остальное — автономное или дифференциальное
  const kind = quality === 4 ? 'fixed' : (quality === 5 ? 'float' : (quality === 2 ? 'dgps' : 'single'));
  return {
    lat, lon, quality, kind,
    sats: f[7] === '' ? null : Number(f[7]),
    h: f[9] === '' ? null : Number(f[9]) + (f[11] === '' ? 0 : Number(f[11])),
    age: f[13] === '' || f[13] === undefined ? null : Number(f[13]),
  };
}

module.exports = { parseRequest, streamHead, refusal, sourcetableResponse, chunk, sourcetable, parseGga, SERVER };
