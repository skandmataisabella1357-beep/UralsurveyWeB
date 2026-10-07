'use strict';
// Модуль «VRS»: сторона сети — пара станций с известными координатами.
// Задача стороны: найти для каждого спутника целые числа длин волн (неоднозначности) в разности
// фаз двух станций. Когда они найдены, фаза показывает разность ионосферы и остаток тропосферы
// между станциями с точностью в миллиметры — это и есть поправки сети.
//
// Как это делается. Координаты станций известны, поэтому в разности фаз остаются только:
// часы приёмников (общие для спутников одной системы), остаток тропосферы (один на сторону),
// ионосфера (своя у спутника, но малая и плавная) и целые неоднозначности. Фильтр оценивает всё
// это вместе по фазам двух частот; код участвует только через комбинацию Мельбурна—Вюббены и
// лишь подсказывает широкую полосу. Ионосфера между станциями — это прежде всего её наклон
// над районом: он общий для всех спутников и оценивается тремя числами, а на каждый спутник
// остаётся лишь малый остаток. Поэтому днём, когда ионосфера велика, стороны не теряют целые. Целые закрепляются по одному, от самой уверенной оценки:
// сначала широкая полоса (разность неоднозначностей двух частот), затем первая частота.
// После короткого пропуска или срыва слежения целые восстанавливаются сразу — по тому, что
// поправки меняются плавно.

const { CLIGHT } = require('./obs');
const { PAIRS } = require('./model');

const DEFAULTS = {
  mask: 10, // градусов: ниже спутник в поиске неоднозначностей не участвует
  gapSec: 120, // пропуск дольше — спутник начинается заново (обрыв связи со станцией короче переживается)
  step: 5, // с: как часто работает фильтр (поправки по закреплённым спутникам считаются каждую эпоху)
  phaseSigma: 0.004, // м, шум разности фаз на одной частоте в зените (с переотражениями)
  mwSigma: 0.5, // циклов, шум комбинации Мельбурна—Вюббены за независимый отсчёт
  ionoBase: 0.01, // м: остаток ионосферы спутника сверх общего наклона — постоянная часть
  ionoPpm: 0.5, // и часть, растущая с длиной стороны, мм на км
  ionoMin: 600, // с: за сколько остаток успевает заметно измениться
  gradPpm: 5, // мм на км: каким может быть общий наклон ионосферы над районом
  gradMin: 1800, // с: за сколько он успевает заметно измениться
  ztdSigma: 0.03, // м: насколько разность зенитной тропосферы двух станций отличается от модели
  ztdHours: 3, // за сколько часов она успевает заметно измениться
  coordSigma: 0.02, // м: насколько вектор между станциями может отличаться от заданных координат (0 — верить полностью)
  geoSmooth: 180, // с: сглаживание геометрической поправки спутника (гасит переотражения)
  ionoSmooth: 60, // с: сглаживание ионосферной поправки спутника
  wlMinSec: 30, // сколько секунд спутник в фильтре до закрепления широкой полосы
  wlSigma: 0.15, // допустимая ошибка оценки широкой полосы, циклов
  wlFrac: 0.25, // и отклонение от целого
  nlMinSec: 60, // сколько секунд до закрепления первой частоты
  nlSigma: 0.15, // допустимая ошибка оценки, циклов
  nlFrac: 0.2, // допустимое отклонение от целого
  holdSec: 20, // столько секунд оценка должна указывать на одно и то же целое
  refitSec: 120, // оценка уверенная, но не целая дольше этого — спутник начинается заново
  slipGf: 0.02, // м, скачок разности L1−L2 между эпохами — срыв слежения
  slipGfRate: 0.003, // м/с, прибавка к порогу на длину пропуска
  outlier: 0.06, // м, невязка закреплённого спутника, после которой он проверяется заново
  outlierEpochs: 4,
  ionoOut: 3, // во сколько раз ионосфера закреплённого спутника может превышать ожидаемую
  bridgeSec: 90, // после пропуска короче целые восстанавливаются без нового поиска
  bridgeFrac: 0.15,
  bridgeTries: 3, // столько срывов подряд — и спутник ищется заново, без восстановления
  histSec: 60, // с: сколько хранятся недавние значения поправок
  healthy: 3.5, // во сколько раз тропосфера или вектор могут уйти от ожидаемого; больше — сторона начинает заново
};

// Небольшой фильтр Калмана с именованными неизвестными
class Filter {
  constructor() {
    this.names = [];
    this.index = new Map();
    this.x = [];
    this.p = [];
  }

  has(name) { return this.index.has(name); }

  add(name, value, variance) {
    const n = this.names.length;
    this.names.push(name);
    this.index.set(name, n);
    this.x.push(value);
    for (const row of this.p) row.push(0);
    const row = new Array(n + 1).fill(0);
    row[n] = variance;
    this.p.push(row);
  }

  remove(name) {
    const k = this.index.get(name);
    if (k === undefined) return;
    this.names.splice(k, 1);
    this.x.splice(k, 1);
    this.p.splice(k, 1);
    for (const row of this.p) row.splice(k, 1);
    this.index.clear();
    this.names.forEach((nm, i) => this.index.set(nm, i));
  }

  // Забыть значение: неизвестная оценивается заново
  reset(name, value, variance) {
    const k = this.index.get(name);
    for (let i = 0; i < this.names.length; i++) { this.p[k][i] = 0; this.p[i][k] = 0; }
    this.p[k][k] = variance;
    this.x[k] = value;
  }

  get(name) { return this.x[this.index.get(name)]; }

  sigma(name) { const k = this.index.get(name); return Math.sqrt(Math.max(0, this.p[k][k])); }

  // Величина, которая сама возвращается к нулю (процесс Гаусса—Маркова): за шаг остаётся доля phi,
  // разброс в установившемся режиме — variance
  relax(name, phi, variance) {
    const k = this.index.get(name);
    this.x[k] *= phi;
    for (let i = 0; i < this.names.length; i++) { this.p[k][i] *= phi; this.p[i][k] *= phi; }
    this.p[k][k] += variance * (1 - phi * phi);
  }

  // Одно измерение: y = сумма coef·x + шум с дисперсией r. terms: [[имя, coef], ...]
  update(terms, y, r) {
    const n = this.names.length;
    const h = terms.map(([name, c]) => [this.index.get(name), c]);
    const ph = new Array(n).fill(0);
    let pred = 0;
    for (const [k, c] of h) {
      pred += c * this.x[k];
      const row = this.p[k];
      for (let i = 0; i < n; i++) ph[i] += row[i] * c;
    }
    let s = r;
    for (const [k, c] of h) s += c * ph[k];
    const v = y - pred;
    for (let i = 0; i < n; i++) {
      const g = ph[i] / s;
      if (g === 0) continue;
      this.x[i] += g * v;
      const row = this.p[i];
      for (let j = 0; j < n; j++) row[j] -= g * ph[j];
    }
    return v;
  }
}

const frac = (v) => v - Math.round(v);
const middle = (list) => { const s = [...list].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const usable = (g) => g && g.P !== null && g.L !== null && !g.half;

// Опорные сигналы спутника на стороне: по возможности одни и те же у обеих станций
function choose(sys, sa, sb, keep) {
  const pick = (ids, was) => {
    if (was && usable(sa.get(was[0])) && usable(sb.get(was[1]))) return was;
    for (const id of ids) if (usable(sa.get(id)) && usable(sb.get(id))) return [id, id];
    const x = ids.find((id) => usable(sa.get(id)));
    const y = ids.find((id) => usable(sb.get(id)));
    return x && y ? [x, y] : null;
  };
  const one = pick(PAIRS[sys].a, keep && keep[0]);
  const two = pick(PAIRS[sys].b, keep && keep[1]);
  return one && two ? [one, two] : null;
}

class Baseline {
  // a, b — станции { code, ecef }; поправки считаются как «b минус a»
  constructor(a, b, options = {}) {
    this.a = a;
    this.b = b;
    this.km = Math.hypot(a.ecef[0] - b.ecef[0], a.ecef[1] - b.ecef[1], a.ecef[2] - b.ecef[2]) / 1000;
    this.o = { ...DEFAULTS, ...options };
    this.ionoSigma = this.o.ionoBase + this.o.ionoPpm * 1e-3 * this.km;
    this.sats = new Map(); // 'G05' -> состояние спутника на этой стороне
    this.memory = new Map(); // 'G05' -> последние закреплённые поправки, для восстановления после пропуска
    this.cum = {}; // накопленный общий ход поправок по системам
    this.kf = new Filter();
    this.kf.add('ztd', 0, this.o.ztdSigma ** 2);
    // Поправка вектора между станциями (восток, север, верх): координаты известны с точностью
    // около сантиметра, а на низких спутниках и это заметно. Сторона уточняет вектор сама.
    for (const k of ['dE', 'dN', 'dU']) this.kf.add(k, 0, Math.max(this.o.coordSigma, 1e-5) ** 2);
    // Наклон ионосферы над районом: среднее значение и изменение к северу и к востоку
    this.gradSigma = this.o.gradPpm * 1e-3 * this.km;
    for (const k of ['ia', 'in', 'ie']) this.kf.add(k, 0, this.gradSigma ** 2);
    this.tri = 0; // в скольких треугольниках сети участвует сторона
    this.t = 0;
    this.tf = 0; // время последней работы фильтра
    this.started = 0;
    this.count = { slip: 0, outlier: 0, iono: 0, refit: 0, closure: 0, bridge: 0, rejoin: 0, fix: 0, restart: 0 };
  }

  drop(sat, why) {
    if (why && this.sats.has(sat)) this.count[why] += 1;
    if (why && why !== 'slip') this.memory.delete(sat);
    this.sats.delete(sat);
    for (const k of ['I:', 'N:', 'W:']) this.kf.remove(k + sat);
  }

  // Начать сторону заново: так бывает после ошибки в целых, которая увела тропосферу или вектор
  restart() {
    for (const sat of [...this.sats.keys()]) this.drop(sat);
    this.memory.clear();
    const o = this.o;
    this.kf.reset('ztd', 0, o.ztdSigma ** 2);
    for (const k of ['dE', 'dN', 'dU']) this.kf.reset(k, 0, Math.max(o.coordSigma, 1e-5) ** 2);
    for (const k of ['ia', 'in', 'ie']) this.kf.reset(k, 0, this.gradSigma ** 2);
    this.count.restart += 1;
  }

  // ea, eb — приведённые наблюдения станций за одну эпоху (model.reduce);
  // slips — спутники, у которых приёмник станции сообщил о срыве слежения
  update(t, ea, eb, slips = { a: new Set(), b: new Set() }) {
    const o = this.o;
    if (!this.started) this.started = t;
    this.t = t;
    const mask = o.mask * Math.PI / 180;
    for (const [sat, s] of this.sats) if (t - s.t > o.gapSec) this.drop(sat);
    for (const [sat, m] of this.memory) if (t - m.t > o.bridgeSec) this.memory.delete(sat);

    const now = [];
    for (const [sat, sa] of ea.sats) {
      const sb = eb.sats.get(sat);
      if (!sb) continue;
      const el = (sa.el + sb.el) / 2;
      if (el < mask) continue;
      let s = this.sats.get(sat);
      const sig = choose(sa.sys, sa.sig, sb.sig, s && s.sig);
      if (!sig) continue;
      const a1 = sa.sig.get(sig[0][0]); const b1 = sb.sig.get(sig[0][1]);
      const a2 = sa.sig.get(sig[1][0]); const b2 = sb.sig.get(sig[1][1]);
      const f1 = a1.f; const f2 = a2.f;
      if (b1.f !== f1 || b2.f !== f2) continue;
      const d = { P1: b1.P - a1.P, P2: b2.P - a2.P, L1: b1.L - a1.L, L2: b2.L - a2.L };
      const key = sig.flat().join('.');
      const gf = d.L1 - d.L2;
      // Срыв слежения: приёмник сообщил о нём, сменился сигнал или разность L1−L2 скакнула
      if (s && (slips.a.has(sat) || slips.b.has(sat) || s.key !== key || Math.abs(gf - s.gf) > o.slipGf + o.slipGfRate * (t - s.t))) {
        this.drop(sat, 'slip');
        s = null;
      }
      if (!s) {
        s = { sys: sat[0], key, sig, f1, f2, since: t, n: 0, nw: null, n1: null, cand: {}, bad: 0, fixAt: 0 };
        s.lw = CLIGHT / (f1 - f2); s.ln = CLIGHT / (f1 + f2); s.l1 = CLIGHT / f1; s.l2 = CLIGHT / f2; s.g = (f1 / f2) ** 2;
        s.k = f2 / (f1 - f2);
        s.fi = (1575.42e6 / f1) ** 2; // ионосфера на первой частоте системы относительно L1
        this.sats.set(sat, s);
      }
      s.t = t; s.gf = gf; s.el = el; s.az = sa.az; s.m = (sa.mw + sb.mw) / 2; s.d = d; s.n += 1;
      // Направление на спутник: на столько меняется дальность при сдвиге станции b на метр
      s.e = [-Math.cos(el) * Math.sin(sa.az), -Math.cos(el) * Math.cos(sa.az), -Math.sin(el)];
      // Ионосфера: наклонный путь длиннее вертикального в mf раз; точка, где луч пересекает
      // ионосферу, смещена от станции в сторону спутника — тем дальше, чем он ниже
      const far = Math.min(1 / Math.tan(el), 3);
      const mf = s.fi / Math.sqrt(1 - (6371e3 * Math.cos(el) / (6371e3 + 350e3)) ** 2);
      s.ig = [mf, mf * far * Math.cos(sa.az), mf * far * Math.sin(sa.az)];
      s.mixed = sig[0][0] !== sig[0][1] || sig[1][0] !== sig[1][1];
      s.mw = ((f1 * d.L1 - f2 * d.L2) / (f1 - f2) - (f1 * d.P1 + f2 * d.P2) / (f1 + f2)) / s.lw;
      now.push(sat);
    }
    this.bridge(t, now);
    if (!this.tf || t - this.tf >= o.step - 1e-3) {
      this.filter(t, now, this.tf ? t - this.tf : 0);
      this.tf = t;
    }
    this.output(t, now);
    return now.length;
  }

  // Восстановление после пропуска: поправки спутника меняются плавно, а общий ход всех спутников
  // системы известен — значит, новые целые находятся сразу
  bridge(t, now) {
    this.rejoin(t, now);
    for (const sat of now) {
      const s = this.sats.get(sat);
      const m = this.memory.get(sat);
      if (s.n !== 1 || s.n1 !== null || !m || m.key !== s.key) continue;
      const cum = this.cum[s.sys];
      if (!cum || cum.era !== m.era) continue;
      const n1 = (s.d.L1 - (m.a1 + cum.c1 - m.c1)) / s.l1;
      const n2 = (s.d.L2 - (m.a2 + cum.c2 - m.c2)) / s.l2;
      m.tries = (m.tries || 0) + 1;
      if (m.tries > this.o.bridgeTries) { this.memory.delete(sat); continue; }
      if (Math.abs(frac(n1)) > this.o.bridgeFrac || Math.abs(frac(n2)) > this.o.bridgeFrac) continue;
      s.n1 = Math.round(n1);
      s.nw = s.n1 - Math.round(n2);
      s.fixAt = t; s.bridged = true;
      s.pinned = false; // фильтр получит эти целые при первой же своей работе
      this.count.bridge += 1;
    }
  }

  // Возвращение станции после обрыва связи: пропали сразу все спутники, и общий ход неизвестен.
  // Но он у всех спутников системы один: если после вычитания прежних поправок дробные части
  // фаз у спутников совпали, значит поправки за время обрыва почти не изменились, и целые
  // находятся сразу — без нового поиска на две минуты.
  rejoin(t, now) {
    const o = this.o;
    const groups = {};
    for (const sat of now) {
      const s = this.sats.get(sat);
      const m = this.memory.get(sat);
      if (s.n !== 1 || !m || m.key !== s.key) continue;
      const cum = this.cum[s.sys];
      if (cum && cum.era === m.era) continue; // общий ход известен — хватит обычного восстановления
      (groups[`${s.sys}.${m.era}`] || (groups[`${s.sys}.${m.era}`] = [])).push({ sat, s, m, x1: (s.d.L1 - m.a1) / s.l1, x2: (s.d.L2 - m.a2) / s.l2 });
    }
    for (const list of Object.values(groups)) {
      if (list.length < 4) continue;
      // Общая дробная часть — среднее по кругу
      const common = (key) => {
        let sx = 0; let sy = 0;
        for (const r of list) { const a = 2 * Math.PI * r[key]; sx += Math.cos(a); sy += Math.sin(a); }
        return Math.atan2(sy, sx) / (2 * Math.PI);
      };
      const d1 = common('x1'); const d2 = common('x2');
      const good = list.filter((r) => Math.abs(frac(r.x1 - d1)) < o.bridgeFrac && Math.abs(frac(r.x2 - d2)) < o.bridgeFrac);
      if (good.length < 4 || good.length < 0.7 * list.length) continue;
      for (const r of good) {
        r.s.n1 = Math.round(r.x1 - d1);
        r.s.nw = r.s.n1 - Math.round(r.x2 - d2);
        r.s.fixAt = t; r.s.bridged = true; r.s.pinned = false;
        this.count.bridge += 1;
      }
      this.count.rejoin += 1;
    }
  }

  // Фильтр: одна работа на все спутники стороны. dt — сколько секунд прошло с прошлой.
  filter(t, now, dt) {
    const o = this.o;
    const kf = this.kf;
    // Соседние отсчёты связаны переотражениями: чаще чем раз в 5 с они нового почти не несут
    const often = Math.max(1, 5 / Math.max(dt || o.step, 0.1));
    if (dt > 0) {
      // Разность тропосферы и ионосфера держатся около нуля и меняются плавно
      kf.relax('ztd', Math.exp(-dt / (o.ztdHours * 3600)), o.ztdSigma ** 2);
      const phi = Math.exp(-dt / o.ionoMin);
      for (const name of kf.names) if (name.startsWith('I:')) kf.relax(name, phi, this.ionoSigma ** 2);
      for (const k of ['ia', 'in', 'ie']) kf.relax(k, Math.exp(-dt / o.gradMin), this.gradSigma ** 2);
    }
    const list = now.map((sat) => [sat, this.sats.get(sat)]);
    const systems = [...new Set(list.map(([, s]) => s.sys))];
    for (const sys of systems) {
      // Часы приёмников на каждой частоте — заново каждую эпоху
      for (const name of [`c1${sys}`, `c2${sys}`]) { if (!kf.has(name)) kf.add(name, 0, 1e4); else kf.reset(name, 0, 1e4); }
      if (!kf.has(`bw${sys}`)) kf.add(`bw${sys}`, 0, 0.25);
    }
    const ztd = kf.get('ztd');
    // Закреплённые спутники сначала проверяются: комбинация без ионосферы должна сходиться,
    // а ионосфера — не уходить от остальных. Общий сдвиг эпохи — медиана по спутникам.
    const gone = new Set();
    for (const sys of systems) {
      const fixed = list.filter(([, s]) => s.sys === sys && s.n1 !== null);
      if (fixed.length < 4) continue;
      const res = fixed.map(([, s]) => this.free(s) - s.m * ztd - this.shift(s) - s.ln * (s.n1 + s.k * s.nw));
      const mid = middle(res);
      const ions = fixed.map(([, s]) => this.iono(s) - this.slope(s));
      const ionoMid = middle(ions);
      fixed.forEach(([sat, s], i) => {
        s.res = res[i] - mid;
        s.bad = Math.abs(s.res) > o.outlier ? s.bad + 1 : 0;
        if (s.bad >= o.outlierEpochs) { this.drop(sat, 'outlier'); gone.add(sat); return; }
        s.badIono = Math.abs(ions[i] - ionoMid) > o.ionoOut * this.ionoSigma + 0.05 ? (s.badIono || 0) + 1 : 0;
        if (s.badIono >= o.outlierEpochs) { this.drop(sat, 'iono'); gone.add(sat); }
      });
    }
    for (const [sat, s] of list) {
      if (gone.has(sat)) continue;
      const I = `I:${sat}`; const N = `N:${sat}`; const W = `W:${sat}`;
      if (!kf.has(N)) {
        kf.add(I, 0, this.ionoSigma ** 2);
        kf.add(N, s.d.L1 / s.l1, 1e6);
        kf.add(W, s.d.L1 / s.l1 - s.d.L2 / s.l2, 1e4);
        s.inAt = t;
      }
      if (s.n1 !== null && !s.pinned) {
        kf.update([[W, 1]], s.nw, 1e-10);
        kf.update([[N, 1]], s.n1, 1e-10);
        s.pinned = true;
      }
      const sg = (o.phaseSigma / Math.sin(s.el)) ** 2 * often;
      const geo = [['ztd', s.m], ['dE', s.e[0]], ['dN', s.e[1]], ['dU', s.e[2]]];
      const ion = (c) => [['ia', c * s.ig[0]], ['in', c * s.ig[1]], ['ie', c * s.ig[2]], [I, c]];
      kf.update([[`c1${s.sys}`, 1], ...geo, ...ion(-1), [N, s.l1]], s.d.L1, sg);
      kf.update([[`c2${s.sys}`, 1], ...geo, ...ion(-s.g), [N, s.l2], [W, -s.l2]], s.d.L2, sg);
      // Код: только подсказка для широкой полосы; у пары разных сигналов он может быть смещён
      const mw = o.mwSigma / Math.sin(s.el) * (s.mixed ? 3 : 1);
      if (s.nw === null) kf.update([[W, 1], [`bw${s.sys}`, 1]], s.mw, mw * mw * often * 2);
    }
    for (const sys of systems) this.resolve(t, list.filter(([sat, s]) => s.sys === sys && !gone.has(sat)));
    // Здоровье стороны: тропосфера и вектор не могут уйти далеко. Если ушли — виновата ошибка
    // в целых, и надёжнее начать заново, чем чинить по одному спутнику.
    const far = (name, sigma) => Math.abs(kf.get(name)) > o.healthy * sigma;
    if (far('ztd', o.ztdSigma) || (o.coordSigma > 0 && ['dE', 'dN', 'dU'].some((k) => far(k, o.coordSigma)))) this.restart();
  }

  // Общий наклон ионосферы в направлении спутника, метры на первой частоте
  slope(s) {
    const kf = this.kf;
    return s.ig[0] * kf.get('ia') + s.ig[1] * kf.get('in') + s.ig[2] * kf.get('ie');
  }

  // Закрепление целых одной системы
  resolve(t, mine) {
    const o = this.o;
    const kf = this.kf;
    // Первый спутник системы закрепляется без проверки: общий сдвиг всех неоднозначностей системы
    // неотличим от часов приёмника (на каждой частоте своих) и на поправки не влияет
    if (!mine.some(([, s]) => s.n1 !== null)) {
      const ready = mine.filter(([, s]) => t - s.inAt >= o.wlMinSec).sort((x, y) => (x[1].mixed - y[1].mixed) || (y[1].el - x[1].el));
      if (!ready.length) return;
      const [sat, s] = ready[0];
      s.nw = Math.round(kf.get(`W:${sat}`));
      kf.update([[`W:${sat}`, 1]], s.nw, 1e-10);
      s.n1 = Math.round(kf.get(`N:${sat}`));
      kf.update([[`N:${sat}`, 1]], s.n1, 1e-10);
      s.pinned = true; s.fixAt = t; s.pivot = true;
      this.count.fix += 1;
    }
    const seen = new Set();
    for (;;) {
      // Кандидаты — от самой точной оценки; каждое закрепление уточняет остальные
      let best = null;
      for (const [sat, s] of mine) {
        if (s.n1 !== null || !this.sats.has(sat)) continue;
        const kind = s.nw === null ? 'W' : 'N';
        const name = `${kind}:${sat}`;
        if (seen.has(name) || t - s.inAt < (kind === 'W' ? o.wlMinSec : o.nlMinSec)) continue;
        const sg = kf.sigma(name);
        if (sg < (kind === 'W' ? o.wlSigma : o.nlSigma) && (!best || sg < best.sg)) best = { sat, s, kind, name, sg };
      }
      if (!best) break;
      const { sat, s, kind, name } = best;
      seen.add(name);
      const value = kf.get(name);
      const whole = Math.round(value);
      const c = s.cand[kind] || (s.cand[kind] = { whole: null, at: 0, offAt: 0 });
      if (Math.abs(value - whole) >= (kind === 'W' ? o.wlFrac : o.nlFrac)) {
        // Уверенная, но не целая оценка: если так долго — в спутнике что-то не так
        if (!c.offAt) c.offAt = t;
        c.whole = null;
        if (t - c.offAt > o.refitSec) this.drop(sat, 'refit');
        continue;
      }
      c.offAt = 0;
      if (c.whole !== whole) { c.whole = whole; c.at = t; }
      if (t - c.at < o.holdSec) continue;
      kf.update([[name, 1]], whole, 1e-10);
      if (kind === 'W') s.nw = whole; else { s.n1 = whole; s.pinned = true; s.fixAt = t; this.count.fix += 1; }
    }
  }

  // Значения поправок спутника на эпоху t: [t, ионосфера, геометрия] или null
  past(s, t) {
    const hist = s.hist;
    if (!hist) return null;
    for (let i = hist.length - 1; i >= 0 && hist[i][0] >= t - 1e-3; i--) if (Math.abs(hist[i][0] - t) < 1e-3) return hist[i];
    return null;
  }

  // Влияние поправки вектора между станциями на дальность до спутника, метры
  shift(s) {
    const kf = this.kf;
    return s.e[0] * kf.get('dE') + s.e[1] * kf.get('dN') + s.e[2] * kf.get('dU');
  }

  // Комбинация двух частот без ионосферы, метры
  free(s) {
    const { f1, f2 } = s;
    return (f1 * f1 * s.d.L1 - f2 * f2 * s.d.L2) / (f1 * f1 - f2 * f2);
  }

  // Разность ионосферы на первой частоте по закреплённым целым, метры (с общим сдвигом системы)
  iono(s) {
    return ((s.d.L1 - s.l1 * s.n1) - (s.d.L2 - s.l2 * (s.n1 - s.nw))) / (s.g - 1);
  }

  // Поправки по закреплённым спутникам: ионосфера на первой частоте и общая (геометрическая) часть
  output(t, now) {
    const steps = {};
    for (const sat of now) {
      const s = this.sats.get(sat);
      if (!s) continue;
      if (s.n1 === null) { s.iono = null; s.geo = null; s.calm = null; s.still = null; s.a1 = undefined; s.eps = undefined; s.ion = undefined; s.hist = null; continue; }
      const a1 = s.d.L1 - s.l1 * s.n1;
      const a2 = s.d.L2 - s.l2 * (s.n1 - s.nw);
      if (s.a1 !== undefined && s.at === this.prev) {
        const st = steps[s.sys] || (steps[s.sys] = [[], []]);
        st[0].push(a1 - s.a1); st[1].push(a2 - s.a2);
      }
      s.a1 = a1; s.a2 = a2; s.at = t;
      s.iono = (a1 - a2) / (s.g - 1);
      s.geo = (s.g * a1 - a2) / (s.g - 1);
      // Недавние значения — для сверки по треугольникам: соседние стороны считаются в другое время
      const hist = s.hist || (s.hist = []);
      hist.push([t, s.iono, s.geo]);
      while (hist.length && t - hist[0][0] > this.o.histSec) hist.shift();
    }
    // Геометрическая поправка в спокойном виде: тропосфера и вектор — из фильтра, остаток спутника
    // сглажен по времени. Сырое значение шумит переотражениями на сантиметр-два, а меняется
    // настоящая поправка медленно. Общие часы системы убраны — в разностях спутников их нет.
    const ztd = this.kf.get('ztd');
    const gain = this.prev ? 1 - Math.exp(-(t - this.prev) / this.o.geoSmooth) : 1;
    const gainIono = this.prev ? 1 - Math.exp(-(t - this.prev) / Math.max(this.o.ionoSmooth, 0.1)) : 1;
    for (const sys of Object.keys(PAIRS)) {
      const fixed = now.map((sat) => this.sats.get(sat)).filter((s) => s && s.sys === sys && s.n1 !== null);
      if (!fixed.length) continue;
      const model = fixed.map((s) => s.m * ztd + this.shift(s));
      const clock = middle(fixed.map((s, i) => s.geo - model[i]));
      fixed.forEach((s, i) => {
        const eps = s.geo - model[i] - clock;
        s.eps = s.eps === undefined ? eps : s.eps + gain * (eps - s.eps);
        s.calm = model[i] + s.eps;
      });
      // Ионосфера — так же: общий сдвиг системы убран медианой, остальное сглажено
      const mid = middle(fixed.map((s) => s.iono));
      for (const s of fixed) {
        const v = s.iono - mid;
        s.ion = s.ion === undefined ? v : s.ion + gainIono * (v - s.ion);
        s.still = s.ion;
      }
    }
    // Общий ход поправок системы от эпохи к эпохе (часы приёмников) — медиана по спутникам
    for (const sys of Object.keys(PAIRS)) {
      const cum = this.cum[sys] || (this.cum[sys] = { c1: 0, c2: 0, era: 0 });
      const st = steps[sys];
      if (st && st[0].length >= 3) { cum.c1 += middle(st[0]); cum.c2 += middle(st[1]); } else cum.era += 1;
    }
    for (const sat of now) {
      const s = this.sats.get(sat);
      if (!s || s.n1 === null) continue;
      const cum = this.cum[s.sys];
      this.memory.set(sat, { key: s.key, a1: s.a1, a2: s.a2, c1: cum.c1, c2: cum.c2, era: cum.era, t });
    }
    this.prev = t;
  }

  // Сводка для панели: сколько спутников видно, сколько закреплено
  summary() {
    const by = {};
    let seen = 0; let fixed = 0;
    for (const s of this.sats.values()) {
      if (this.t - s.t > 1e-3) continue;
      const row = by[s.sys] || (by[s.sys] = { seen: 0, fixed: 0 });
      row.seen++; seen++;
      if (s.n1 !== null) { row.fixed++; fixed++; }
    }
    const kf = this.kf;
    return {
      a: this.a.code, b: this.b.code, km: this.km, t: this.t, seen, fixed, by, ztd: kf.get('ztd'), ztdSigma: kf.sigma('ztd'),
      shift: [kf.get('dE'), kf.get('dN'), kf.get('dU')], grad: [kf.get('ia'), kf.get('in'), kf.get('ie')], count: { ...this.count },
    };
  }
}

module.exports = { Baseline, Filter, DEFAULTS, choose };
