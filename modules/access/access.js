'use strict';
// Модуль «Доступы»: все логины одним списком — кто, до какого дня, сколько подключений, на связи ли.
// Цвет строки говорит о состоянии; правка — в одном всплывающем окне. Своих данных модуль не хранит:
// всё читается и пишется через /api/admin/access, а панель даёт ему только запросы и список роверов.
(function () {
  const NBSP = ' ';
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const day = (v) => (v ? String(v).slice(0, 10).split('-').reverse().join('.') : '—');

  // Состояние логина: подпись и тон (цвет)
  const STATE = {
    active: ['действует', 'ok'], trial: ['пробный', 'ok'], expiring: ['истекает', 'warn'], expired: ['истёк', 'fail'], none: ['срок не задан', 'fail'],
    suspended: ['приостановлен', 'hold'], request: ['не оплачен', 'hold'], pending: ['ещё не начался', 'hold'], off: ['выключен', 'off'], staff: ['служебный', 'staff'],
  };
  const tone = (r) => (STATE[r.state] || STATE.off)[1];
  const FILTERS = [['all', 'все', ''], ['online', 'на связи', 'on'], ['ok', 'действуют', 'ok'], ['warn', 'истекают', 'warn'], ['fail', 'истекли', 'fail'],
    ['hold', 'приостановлены', 'hold'], ['off', 'выключены', 'off'], ['staff', 'служебные', 'staff'], ['weak', 'слабый пароль', 'weak']];
  const COLS = [['login', 'Логин'], ['client', 'Чей'], ['state', 'Состояние'], ['ends', 'Работает до'], ['left', 'Осталось'], ['sessions', 'Подключений'], ['seen', 'Был на связи']];
  const WEAK = { same: 'Пароль совпадает с логином', short: 'Пароль короче 6 знаков' };

  const s = { ctx: null, data: null, at: 0, busy: false, filter: 'all', search: '', sort: 'login', dir: 1, chips: '', body: '', open: null };

  const online = () => {
    const m = new Map();
    for (const c of s.ctx.rovers || []) m.set(c.login, (m.get(c.login) || 0) + 1);
    return m;
  };
  const left = (r) => (r.days_left === null ? '—' : (r.days_left >= 0 ? `${r.days_left}${NBSP}дн.` : `${-r.days_left}${NBSP}дн. назад`));
  function seen(v) {
    if (!v) return 'не подключался';
    const days = Math.floor((Date.now() - Date.parse(v)) / 86400000);
    return days <= 0 ? 'сегодня' : (days === 1 ? 'вчера' : (days < 60 ? `${days}${NBSP}дн. назад` : day(v)));
  }

  async function load(force) {
    if (s.busy || (!force && Date.now() - s.at < 30000)) return;
    s.busy = true;
    const res = await s.ctx.api('/api/admin/access');
    s.busy = false;
    if (!res.ok) return;
    s.data = res.data;
    s.at = Date.now();
    draw();
  }

  function frame() {
    const box = s.ctx.box;
    if (box.dataset.ready) return;
    box.dataset.ready = '1';
    box.innerHTML = `<h2 class="ins-title adm-list-head"><span>Доступы</span><span class="adm-list-tools"><input class="adm-search" id="acc-search" type="search" placeholder="Логин, клиент, телефон"><span class="fig" id="acc-count"></span><button class="btn btn-quiet btn-small" type="button" id="acc-export" title="Список как на экране — с учётом фильтра и поиска">Выгрузить CSV</button></span></h2>
      <div class="acc-chips" id="acc-chips"></div>
      <div class="adm-scroll"><table class="messages srv-table adm-rows acc-table"><thead><tr id="acc-head"></tr></thead><tbody id="acc-body"></tbody></table></div>`;
    box.addEventListener('input', (event) => { if (event.target.id === 'acc-search') { s.search = event.target.value.trim().toLowerCase(); draw(); } });
    box.addEventListener('click', (event) => {
      if (event.target.id === 'acc-export') { exportList(); return; }
      const chip = event.target.closest('[data-acc-filter]');
      if (chip) { s.filter = chip.dataset.accFilter; draw(); return; }
      const th = event.target.closest('[data-acc-sort]');
      if (th) { s.dir = s.sort === th.dataset.accSort ? -s.dir : 1; s.sort = th.dataset.accSort; draw(); return; }
      const row = event.target.closest('[data-acc-id]');
      if (row) openCard(Number(row.dataset.accId));
    });
    s.ctx.dialog.addEventListener('click', onCard);
    s.ctx.dialog.addEventListener('submit', save);
  }

  function draw() {
    frame();
    const box = s.ctx.box;
    if (!s.data) { box.querySelector('#acc-body').innerHTML = '<tr><td colspan="7">Загружаем список…</td></tr>'; return; }
    const on = online();
    const all = s.data.items;
    const match = (r, f) => f === 'all' || (f === 'online' ? on.has(r.login) : (f === 'weak' ? Boolean(r.weak) : tone(r) === f));
    const chips = FILTERS.map(([id, name, cls]) => {
      const n = all.filter((r) => match(r, id)).length;
      return n || id === 'all' ? `<button class="adm-chip acc-chip ${cls ? `is-${cls}` : ''}" type="button" data-acc-filter="${id}" aria-current="${s.filter === id}">${cls ? '<i></i>' : ''}${name}<b>${n}</b></button>` : '';
    }).join('');
    if (chips !== s.chips) { s.chips = chips; box.querySelector('#acc-chips').innerHTML = chips; }

    const q = s.search;
    const key = {
      login: (r) => r.login.toLowerCase(), client: (r) => (r.client || '').toLowerCase(), state: (r) => Object.keys(STATE).indexOf(r.state),
      ends: (r) => r.ends_on || '', left: (r) => (r.days_left === null ? 1e9 : r.days_left), sessions: (r) => (on.get(r.login) || 0) * 1000 + r.max_sessions, seen: (r) => r.last_seen_at || '',
    }[s.sort];
    const list = all.filter((r) => match(r, s.filter) && (!q || `${r.login} ${r.client} ${r.phone} ${r.device} ${r.note}`.toLowerCase().includes(q)))
      .sort((a, b) => { const x = key(a); const y = key(b); return (x < y ? -1 : x > y ? 1 : a.login.localeCompare(b.login)) * s.dir; });
    s.list = list;
    box.querySelector('#acc-count').textContent = list.length === all.length ? String(all.length) : `${list.length} из ${all.length}`;
    box.querySelector('#acc-head').innerHTML = COLS.map(([id, name]) => `<th data-acc-sort="${id}" aria-sort="${s.sort === id ? (s.dir > 0 ? 'ascending' : 'descending') : 'none'}">${name}</th>`).join('');
    const body = list.map((r) => {
      const t = tone(r);
      const now = on.get(r.login) || 0;
      const whose = r.staff ? 'оператор сети' : [r.client && r.client !== r.login ? r.client : '', r.phone].filter(Boolean).join(' · ');
      return `<tr class="acc-row is-${t}" data-acc-id="${r.id}">
        <td><span class="acc-login"><i class="acc-dot ${now ? 'is-on' : ''}" title="${now ? 'на связи' : 'не на связи'}"></i><b>${esc(r.login)}</b>${r.weak ? `<em class="acc-weak" title="${WEAK[r.weak]}">!</em>` : ''}</span></td>
        <td>${esc(whose || '—')}</td>
        <td><span class="acc-pill">${STATE[r.state] ? STATE[r.state][0] : esc(r.state)}</span></td>
        <td class="fig">${r.staff ? '—' : day(r.ends_on)}</td>
        <td class="fig acc-left">${r.staff ? '—' : left(r)}</td>
        <td class="fig">${now ? `<b class="acc-now">${now}</b>${NBSP}из${NBSP}` : ''}${r.max_sessions}</td>
        <td>${now ? '<span class="acc-now">сейчас</span>' : seen(r.last_seen_at)}</td></tr>`;
    }).join('') || '<tr><td colspan="7">Никого не нашлось.</td></tr>';
    if (body !== s.body) { s.body = body; box.querySelector('#acc-body').innerHTML = body; }
  }

  // Выгрузка: то, что сейчас в списке, — с учётом фильтра, поиска и порядка. Паролей в файле нет.
  function exportList() {
    const on = online();
    const head = ['Логин', 'Чей', 'Телефон', 'Состояние', 'Работает до', 'Осталось дней', 'Подключений сейчас', 'Подключений разрешено', 'Был на связи', 'Ровер', 'Заметка', 'Надёжность пароля'];
    const rows = (s.list || []).map((r) => [r.login, r.staff ? 'оператор сети' : r.client, r.phone, STATE[r.state] ? STATE[r.state][0] : r.state, r.staff ? '' : day(r.ends_on).replace('—', ''),
      r.days_left === null ? '' : r.days_left, on.get(r.login) || 0, r.max_sessions, r.last_seen_at ? day(r.last_seen_at) : '', r.device, r.note, r.weak ? WEAK[r.weak].toLowerCase() : 'в порядке']);
    const tag = s.filter === 'all' ? '' : `-${(FILTERS.find((f) => f[0] === s.filter) || ['', s.filter])[1].replace(/\s+/g, '-')}`;
    s.ctx.csv(`uralsurvey-dostupy${tag}-${s.data.today}.csv`, [head, ...rows]);
    s.ctx.toast(`Выгружено логинов: ${rows.length}`);
  }

  // ---------- Карточка логина ----------

  const field = (label, html, cls) => `<label class="field ${cls || ''}"><span>${label}</span>${html}</label>`;

  function openCard(id) {
    const r = s.data.items.find((x) => x.id === id);
    if (!r) return;
    s.open = id;
    const admin = s.ctx.admin;
    const dis = admin ? '' : 'disabled';
    const facts = [r.tariff ? `тариф «${esc(r.tariff)}»` : '', `был на связи: ${seen(r.last_seen_at)}`, r.device ? `ровер ${esc(r.device)}` : '', r.last_refusal ? `последний отказ: ${esc(r.last_refusal)}` : '',
      r.suspend_reason ? `приостановлен: ${esc(r.suspend_reason)}` : ''].filter(Boolean).join(' · ');
    const term = r.staff ? '' : `${field('Работает до', `<input name="ends_on" type="date" value="${r.ends_on || ''}" ${dis}>`)}
      ${admin ? `<div class="acc-plus">${[[30, '+1 мес'], [90, '+3 мес'], [182, '+6 мес'], [365, '+1 год']].map(([d, name]) => `<button class="adm-chip" type="button" data-acc-plus="${d}">${name}</button>`).join('')}</div>` : ''}`;
    s.ctx.dialog.innerHTML = `<button class="icon-btn adm-close" type="button" data-acc="close" title="Закрыть (Esc)">×</button>
      <form id="acc-form" novalidate>
      <h2 class="acc-title is-${tone(r)}"><b>${esc(r.login)}</b><span class="acc-pill">${STATE[r.state] ? STATE[r.state][0] : ''}</span></h2>
      <p class="hint">${facts}</p>
      ${r.weak ? `<p class="hint acc-warn">${WEAK[r.weak]}: подобрать его легко. Смените, когда договоритесь с клиентом.</p>` : ''}
      <div class="acc-grid">${term}
      ${field('Одновременных подключений', `<input name="max_sessions" type="number" min="1" max="100" value="${r.max_sessions}" ${dis}>`)}
      ${field('Если подключений больше', `<select name="on_limit" ${dis}><option value="evict" ${r.on_limit === 'evict' ? 'selected' : ''}>вытеснить старое</option><option value="refuse" ${r.on_limit === 'refuse' ? 'selected' : ''}>не пускать новое</option></select>`)}
      ${r.staff ? '' : `${field('Чей логин', `<input name="client" type="text" maxlength="120" value="${esc(r.client)}" ${dis}>`)}${field('Телефон', `<input name="phone" type="text" maxlength="40" value="${esc(r.phone)}" ${dis}>`)}
      ${field('Заметка', `<input name="note" type="text" maxlength="300" value="${esc(r.note)}" ${dis}>`, 'is-wide')}`}
      <label class="adm-check"><input name="active" type="checkbox" ${r.active ? 'checked' : ''} ${dis}><span>Логин включён</span></label></div>
      <p class="hint acc-secret" id="acc-secret" hidden></p><p class="form-error" id="acc-error" hidden></p>
      <div class="dialog-actions">${admin ? `<button class="btn btn-quiet btn-small" type="button" data-acc="reveal">Показать пароль</button><button class="btn btn-quiet btn-small" type="button" data-acc="regen">Новый пароль</button>
        ${r.subscription_id ? `<button class="btn btn-quiet btn-small" type="button" data-acc="${r.state === 'suspended' ? 'resume' : 'suspend'}">${r.state === 'suspended' ? 'Возобновить' : 'Приостановить'}</button>` : ''}` : ''}
        <span class="adm-grow"></span><button class="btn" type="button" data-acc="close">${admin ? 'Отмена' : 'Закрыть'}</button>${admin ? '<button class="btn btn-primary" type="submit">Сохранить</button>' : ''}</div></form>`;
    if (!s.ctx.dialog.open) s.ctx.dialog.showModal();
  }

  const fail = (text) => { const e = s.ctx.dialog.querySelector('#acc-error'); e.textContent = text || 'Не получилось.'; e.hidden = false; };
  async function done(res, text) {
    if (!res.ok) return fail(res.error);
    s.ctx.dialog.close();
    s.ctx.toast(text);
    await load(true);
    return null;
  }

  async function onCard(event) {
    const plus = event.target.closest('[data-acc-plus]');
    const r = s.data && s.data.items.find((x) => x.id === s.open);
    if (plus && r) {
      // Продление считается от нынешнего конца срока, а у истёкшего — от сегодняшнего дня
      const input = s.ctx.dialog.querySelector('[name="ends_on"]');
      const from = new Date(Math.max(Date.parse(input.value || s.data.today), Date.parse(s.data.today)));
      from.setUTCDate(from.getUTCDate() + Number(plus.dataset.accPlus));
      input.value = from.toISOString().slice(0, 10);
      return;
    }
    const btn = event.target.closest('[data-acc]');
    if (!btn || !r) return;
    const act = btn.dataset.acc;
    if (act === 'close') { s.ctx.dialog.close(); return; }
    const secret = s.ctx.dialog.querySelector('#acc-secret');
    if (act === 'reveal' || act === 'regen') {
      if (act === 'regen' && !window.confirm(`Создать новый пароль для ${r.login}? Прежний перестанет работать, открытый сеанс закроется.`)) return;
      const res = await s.ctx.api(`/api/admin/logins/${r.id}/${act === 'reveal' ? 'reveal' : 'regenerate'}`, 'POST');
      if (!res.ok) { fail(res.error); return; }
      secret.innerHTML = `${act === 'reveal' ? 'Пароль' : 'Новый пароль'}: <b class="fig">${esc(res.data.password)}</b>`;
      secret.hidden = false;
      if (act === 'regen') load(true);
      return;
    }
    if (act === 'suspend') {
      const reason = window.prompt(`Почему приостанавливаем ${r.login}? Причина записывается в журнал.`);
      if (!reason) return;
      await done(await s.ctx.api(`/api/admin/access/${r.id}`, 'POST', { suspended: true, reason }), `${r.login}: доступ приостановлен`);
    }
    if (act === 'resume') await done(await s.ctx.api(`/api/admin/access/${r.id}`, 'POST', { suspended: false }), `${r.login}: доступ возобновлён`);
  }

  async function save(event) {
    event.preventDefault();
    const r = s.data.items.find((x) => x.id === s.open);
    const f = event.target.elements;
    const body = {};
    if (f.ends_on && f.ends_on.value && f.ends_on.value !== r.ends_on) body.ends_on = f.ends_on.value;
    if (Number(f.max_sessions.value) !== r.max_sessions) body.max_sessions = Number(f.max_sessions.value);
    if (f.on_limit.value !== r.on_limit) body.on_limit = f.on_limit.value;
    if (f.active.checked !== r.active) body.active = f.active.checked;
    for (const name of ['client', 'phone', 'note']) if (f[name] && f[name].value.trim() !== r[name]) body[name] = f[name].value.trim();
    if (!Object.keys(body).length) { s.ctx.dialog.close(); return; }
    await done(await s.ctx.api(`/api/admin/access/${r.id}`, 'POST', body), `${r.login}: сохранено`);
  }

  window.UralAccess = {
    // Панель зовёт это при каждой своей перерисовке: список обновляется раз в полминуты, отметки «на связи» — сразу
    show(ctx) {
      s.ctx = ctx;
      load();
      draw();
    },
  };
}());
