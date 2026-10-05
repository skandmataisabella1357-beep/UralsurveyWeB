'use strict';
// Панель администратора: разделы плитками, таблицы и формы поверх службы управления.
// Каждый раздел описан одной записью: что показывать в таблице и какие поля в форме.

(() => {
  const { esc, num, dms, rate, bytes, duration, clock, plural, interval, NBSP } = window.Fmt;
  const $ = (id) => document.getElementById(id);

  const LINK = { online: ['Данные идут', 'is-online'], connecting: ['Подключаемся', 'is-wait'], waiting: ['Ждём данные', 'is-wait'],
    listening: ['Ждём приёмник', 'is-wait'], retry: ['Нет связи', 'is-fail'], error: ['Ошибка', 'is-fail'], idle: ['Остановлена', ''] };
  const KIND = { fixed: 'фиксированное', float: 'плавающее', dgps: 'дифференциальное', single: 'автономное' };
  const SUB = { request: ['заявка', 'is-wait'], pending: ['ещё не началась', 'is-wait'], trial: ['пробная', 'is-online'], active: ['действует', 'is-online'],
    expiring: ['истекает', 'is-wait'], expired: ['истекла', 'is-fail'], suspended: ['приостановлена', 'is-fail'] };
  const MODES = { listen: 'база шлёт сама на порт', ntrip: 'с кастера (NTRIP)', tcp: 'порт приёмника', sim: 'имитатор' };
  const ACCESS = { all: 'все с подпиской', tariff: 'только по тарифу', staff: 'служебные логины' };
  const ICON = {
    overview: '<path d="M4 13h6V4H4ZM14 20h6v-9h-6ZM4 20h6v-3H4ZM14 7h6V4h-6Z"/>',
    stations: '<path d="M12 4 21 20H3Z"/><circle cx="12" cy="15" r="1.4"/>',
    subnets: '<path d="M5 8 13 4l6 6-3 9-9-2Z"/><circle cx="5" cy="8" r="1.3"/><circle cx="13" cy="4" r="1.3"/><circle cx="19" cy="10" r="1.3"/>',
    mountpoints: '<path d="M12 21V11"/><path d="M8.5 14.5a5 5 0 0 1 0-7M15.5 7.5a5 5 0 0 1 0 7M6 17a8.5 8.5 0 0 1 0-12M18 5a8.5 8.5 0 0 1 0 12"/>',
    clients: '<path d="M4 20V7l8-3 8 3v13M9 20v-5h6v5M9 10h.01M15 10h.01"/>',
    logins: '<circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H21M17 12v3M20 12v2"/>',
    tariffs: '<path d="M4 7h16v10H4ZM4 11h16M8 15h3"/>',
    subscriptions: '<path d="M5 5h14v15H5ZM5 9h14M9 3v4M15 3v4M9 14l2 2 4-4"/>',
    sessions: '<circle cx="9" cy="9" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 6.2a3 3 0 0 1 0 5.6M17.5 14.6c2 .8 3.5 2.9 3.5 5.4"/>',
    refusals: '<circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/>',
    audit: '<path d="M6 3h9l4 4v14H6ZM9 10h7M9 14h7M9 18h4"/>',
    admins: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.500 7-10V6Z"/><path d="M9.500 12l2 2 3.500-4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.600 5.600l2.100 2.100M16.300 16.300l2.100 2.100M5.600 18.400l2.100-2.100M16.300 7.700l2.100-2.100"/>',
  };

  let me = null; // вошедший администратор
  let live = null; // состояние служб
  let view = 'overview';
  let rows = []; // строки текущего раздела
  let lists = { stations: [], mountpoints: [], clients: [], tariffs: [], subnets: [] }; // справочники для форм и каталога сети
  let picked = null;
  let search = '';
  let liveTimer = null;
  let map = null;
  const isAdmin = () => me && me.role === 'admin';
  const yes = (v) => (v ? 'да' : 'нет');
  const day = (v) => (v ? String(v).slice(0, 10).split('-').reverse().join('.') : '—');
  // Дата и время — по часам того, кто смотрит панель
  const when = (v) => { if (!v) return '—'; const d = new Date(v); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} ${clock(d.getTime())}`; };

  async function api(path, method = 'GET', body) {
    const res = await fetch(path, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/login') showLogin({ configured: true });
    return { ok: res.ok, status: res.status, data, error: data.error };
  }

  let toastTimer = null;
  function toast(text, ms = 3200) {
    $('toast').textContent = text;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, ms);
  }

  // ---------- Разделы ----------
  // cols: [заголовок, функция ячейки]; fields: поля формы; actions: дополнительные кнопки в форме

  const liveOf = (code) => (live ? live.stations.find((s) => s.id === code) : null);
  const stationOptions = () => lists.stations.map((s) => [s.id, `${s.code}${s.name ? ` — ${s.name}` : ''}`]);
  const clientOptions = () => lists.clients.map((c) => [c.id, c.name]);
  const tariffOptions = () => lists.tariffs.map((t) => [t.id, `${t.name} (${t.period_days} дн.)`]);

  const VIEWS = {
    overview: { title: 'Обзор' },
    stations: {
      title: 'Станции', path: '/api/admin/stations', map: true, needs: [],
      hint: 'Координаты станции вводятся в X, Y, Z (метры, до 0,1 мм). Широта, долгота и МСК-66 показываются для контроля.',
      cols: [
        ['Код', (r) => `<span class="fig">${esc(r.code)}</span>`], ['Название', (r) => esc(r.name)],
        ['Связь', (r) => { const s = liveOf(r.code); if (!r.enabled) return 'выключена'; const [t, c] = s ? (LINK[s.link.state] || ['—', '']) : ['нет в приёме', 'is-wait']; return `<span class="${c}">${t}</span>`; }],
        ['Спутников', (r) => { const s = liveOf(r.code); return `<span class="fig">${s ? s.satTotal : '—'}</span>`; }],
        ['Поток', (r) => { const s = liveOf(r.code); return `<span class="fig">${s && s.link.state === 'online' ? esc(rate(s.link.bitsPerSec)) : '—'}</span>`; }],
        ['Источник', (r) => esc(r.source_mode === 'listen' ? `порт ${r.source_port || '—'}` : (r.source_mode === 'sim' ? 'имитатор' : `${r.source_host}:${r.source_port}${r.source_mountpoint ? `/${r.source_mountpoint}` : ''}`))],
        ['Защита', (r) => esc([r.allow_addresses.length ? 'адреса' : '', r.has_station_password ? 'пароль' : ''].filter(Boolean).join(' + ') || '—')],
        ['Координаты', (r) => (r.x === null ? '<span class="is-wait">не заданы</span>' : 'заданы')],
        ['Точки', (r) => esc((r.mountpoints || []).join(', ') || '—')],
      ],
      fields: [
        { name: 'code', label: 'Код станции', type: 'text', required: true, once: true, hint: 'латиница, цифры, _ и -' },
        { name: 'name', label: 'Название', type: 'text' },
        { name: 'enabled', label: 'Станция включена', type: 'check', value: true },
        { name: 'source_mode', label: 'Откуда поток', type: 'select', options: Object.entries(MODES), value: 'listen' },
        { name: 'source_host', label: 'Адрес источника', type: 'text', when: (v) => v.source_mode === 'ntrip' || v.source_mode === 'tcp' },
        { name: 'source_port', label: 'Порт', type: 'number', when: (v) => v.source_mode !== 'sim', hint: 'для базы, которая шлёт сама, — порт на сервере, 2110–2159' },
        { name: 'source_mountpoint', label: 'Точка подключения на кастере', type: 'text', when: (v) => v.source_mode === 'ntrip' },
        { name: 'source_username', label: 'Логин на кастере', type: 'text', when: (v) => v.source_mode === 'ntrip' },
        { name: 'source_password', label: 'Пароль на кастере', type: 'secret', has: 'has_source_password', when: (v) => v.source_mode === 'ntrip' },
        { name: 'allow_addresses', label: 'Разрешённые адреса базы', type: 'list', when: (v) => v.source_mode === 'listen', hint: 'через запятую: 1.2.3.4, 10.0.0.0/8; пусто — любые' },
        { name: 'station_password', label: 'Пароль станции', type: 'secret', has: 'has_station_password', when: (v) => v.source_mode === 'listen', hint: 'только для приёмников в режиме NTRIP-сервера' },
        { name: 'x', label: 'X, м', type: 'coord' }, { name: 'y', label: 'Y, м', type: 'coord' }, { name: 'z', label: 'Z, м', type: 'coord' },
        { name: '_control', type: 'control' },
        { name: 'coords_note', label: 'Причина правки координат', type: 'text', virtual: true },
        { name: 'antenna_height', label: 'Высота антенны, м', type: 'number' },
        { name: 'antenna_type', label: 'Тип антенны', type: 'text' }, { name: 'receiver_type', label: 'Тип приёмника', type: 'text' },
        { name: 'note', label: 'Заметка', type: 'area' },
      ],
    },
    mountpoints: {
      title: 'Точки подключения', path: '/api/admin/mountpoints', needs: ['stations'],
      hint: 'Точку заводит администратор: какую завёл, такая и есть. Тип выдачи в имени писать не обязательно.',
      cols: [
        ['Точка', (r) => `<span class="fig">${esc(r.name)}</span>`], ['Станция', (r) => `<span class="fig">${esc(r.station_code)}</span>`],
        ['Состояние', (r) => { if (!r.enabled) return 'выключена'; const p = live && live.points.find((x) => x.name === r.name); return p ? (p.live ? '<span class="is-online">раздаётся</span>' : '<span class="is-fail">станция молчит</span>') : '<span class="is-wait">нет у раздачи</span>'; }],
        ['Доступ', (r) => ACCESS[r.access]], ['В таблице источников', (r) => (r.listed ? 'да' : 'скрыта')],
        ['Номер станции в потоке', (r) => (r.rtcm_station_id === null ? 'как пришло' : r.rtcm_station_id)],
        ['Сеансов', (r) => { const p = live && live.points.find((x) => x.name === r.name); return `<span class="fig">${p ? p.sessions : 0}</span>`; }],
      ],
      fields: [
        { name: 'name', label: 'Имя точки', type: 'text', required: true, hint: 'латиница, цифры, _ и -; например REFT или REFT_MSM4' },
        { name: 'station_id', label: 'Станция', type: 'select', options: stationOptions, required: true, numeric: true },
        { name: 'access', label: 'Кому доступна', type: 'select', options: Object.entries(ACCESS), value: 'all' },
        { name: 'listed', label: 'Показывать в таблице источников', type: 'check', value: true },
        { name: 'enabled', label: 'Точка включена', type: 'check', value: true },
        { name: 'rtcm_station_id', label: 'Номер станции в потоке', type: 'number', hint: '0–4095; пусто — как пришло с приёмника' },
        { name: 'note', label: 'Заметка', type: 'area' },
      ],
    },
    subnets: { title: 'Подсети', path: '/api/admin/subnets', map: true, needs: ['stations'], custom: 'subnets' },
    clients: {
      title: 'Клиенты', path: '/api/admin/clients', needs: [], search: true,
      cols: [
        ['Клиент', (r) => esc(r.name)], ['ИНН', (r) => `<span class="fig">${esc(r.inn || '—')}</span>`], ['Контакт', (r) => esc([r.contact, r.phone].filter(Boolean).join(', ') || '—')],
        ['Почта', (r) => esc(r.email || '—')], ['Договор', (r) => esc(r.contract_no ? `${r.contract_no} от ${day(r.contract_date)}` : '—')], ['Логинов', (r) => `<span class="fig">${r.logins}</span>`],
        ['Подписка', (r) => (r.subscription ? `<span class="${SUB[r.subscription.state][1]}">${SUB[r.subscription.state][0]}</span> до ${day(r.subscription.ends_on)}` : 'нет')],
      ],
      fields: [
        { name: 'name', label: 'Название или ФИО', type: 'text', required: true }, { name: 'inn', label: 'ИНН', type: 'text', hint: '10 или 12 цифр' },
        { name: 'contact', label: 'Контактное лицо', type: 'text' }, { name: 'phone', label: 'Телефон', type: 'text' }, { name: 'email', label: 'Почта', type: 'text' },
        { name: 'contract_no', label: 'Номер договора', type: 'text' }, { name: 'contract_date', label: 'Дата договора', type: 'date' }, { name: 'note', label: 'Заметка', type: 'area' },
      ],
    },
    logins: {
      title: 'Логины NTRIP', path: '/api/admin/logins', needs: ['clients'], search: true,
      hint: 'Один логин — один ровер. Пароль создаёт сервер; он показывается при создании и по кнопке «Показать пароль».',
      cols: [
        ['Логин', (r) => `<span class="fig">${esc(r.login)}</span>`], ['Клиент', (r) => esc(r.staff ? 'служебный' : (r.client_name || '—'))], ['Ровер', (r) => esc(r.device || '—')],
        ['Сеансов', (r) => `<span class="fig">${r.max_sessions}</span>`], ['При втором подключении', (r) => (r.on_limit === 'evict' ? 'вытеснить старое' : 'не пускать новое')],
        ['Состояние', (r) => (r.active ? '<span class="is-online">активен</span>' : '<span class="is-fail">отключён</span>')], ['Был на связи', (r) => when(r.last_seen_at)], ['Последний отказ', (r) => esc(r.last_refusal || '—')],
      ],
      fields: [
        { name: 'login', label: 'Логин', type: 'text', required: true, once: true },
        { name: 'staff', label: 'Служебный логин оператора сети', type: 'check' },
        { name: 'client_id', label: 'Клиент', type: 'select', options: clientOptions, numeric: true, empty: '— без клиента —', when: (v) => !v.staff },
        { name: 'device', label: 'Какой ровер', type: 'text' }, { name: 'max_sessions', label: 'Одновременных сеансов', type: 'number', value: 1 },
        { name: 'on_limit', label: 'При втором подключении', type: 'select', options: [['evict', 'вытеснить старое'], ['refuse', 'не пускать новое']], value: 'evict' },
        { name: 'active', label: 'Логин активен', type: 'check', value: true },
        { name: 'password', label: 'Свой пароль', type: 'text', virtual: true, hint: 'пусто — сервер создаст сам (только при создании и смене)' },
      ],
      actions: [
        { label: 'Показать пароль', admin: true, run: async (r) => { const res = await api(`/api/admin/logins/${r.id}/reveal`, 'POST'); return res.ok ? `Пароль логина ${res.data.login}: ${res.data.password}` : res.error; } },
        { label: 'Новый пароль', admin: true, confirm: 'Создать новый пароль? Прежний перестанет работать, открытый сеанс закроется.', run: async (r) => { const res = await api(`/api/admin/logins/${r.id}/regenerate`, 'POST'); return res.ok ? `Новый пароль логина ${res.data.login}: ${res.data.password}` : res.error; } },
      ],
    },
    tariffs: {
      title: 'Тарифы', path: '/api/admin/tariffs', needs: ['mountpoints'],
      cols: [
        ['Тариф', (r) => esc(r.name)], ['Срок', (r) => `${r.period_days} дн.`], ['Точки', (r) => (r.all_mountpoints ? 'все открытые' : esc(r.mountpoint_ids.map((id) => (lists.mountpoints.find((m) => m.id === id) || {}).name).filter(Boolean).join(', ') || 'не выбраны'))],
        ['Сеансов на логин', (r) => `<span class="fig">${r.max_sessions}</span>`], ['Цена', (r) => (r.price === null ? '—' : `${num(r.price, 2)}${NBSP}₽`)], ['Подписок', (r) => `<span class="fig">${r.subscriptions}</span>`],
      ],
      fields: [
        { name: 'name', label: 'Название', type: 'text', required: true }, { name: 'period_days', label: 'Срок, дней', type: 'number', required: true, value: 30 },
        { name: 'all_mountpoints', label: 'Все точки с доступом «все с подпиской»', type: 'check', value: true },
        { name: 'mountpoint_ids', label: 'Точки тарифа', type: 'multi', options: () => lists.mountpoints.map((m) => [m.id, m.name]), when: (v) => !v.all_mountpoints },
        { name: 'max_sessions', label: 'Сеансов на логин', type: 'number', value: 1 }, { name: 'price', label: 'Цена, справочно', type: 'number' }, { name: 'note', label: 'Заметка', type: 'area' },
      ],
    },
    subscriptions: {
      title: 'Подписки', path: '/api/admin/subscriptions', needs: ['clients', 'tariffs'], export: '/api/admin/subscriptions.csv',
      cols: [
        ['Клиент', (r) => esc(r.client_name)], ['Тариф', (r) => esc(r.tariff_name)], ['Начало', (r) => day(r.starts_on)], ['Конец', (r) => day(r.ends_on)],
        ['Состояние', (r) => `<span class="${SUB[r.state][1]}">${SUB[r.state][0]}</span>${r.state === 'suspended' && r.suspend_reason ? `: ${esc(r.suspend_reason)}` : ''}`],
        ['Осталось', (r) => (r.days_left < 0 ? '—' : `${r.days_left} дн.`)], ['Оплата', (r) => (r.paid ? 'отмечена' : (r.trial ? 'пробный доступ' : 'нет'))], ['Логинов', (r) => `<span class="fig">${r.logins_limit}</span>`],
      ],
      fields: [
        { name: 'client_id', label: 'Клиент', type: 'select', options: clientOptions, required: true, numeric: true },
        { name: 'tariff_id', label: 'Тариф', type: 'select', options: tariffOptions, required: true, numeric: true },
        { name: 'starts_on', label: 'Начало', type: 'date', required: true, value: () => new Date().toISOString().slice(0, 10) },
        { name: 'ends_on', label: 'Конец', type: 'date', required: true, value: () => new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10) },
        { name: 'logins_limit', label: 'Логинов в подписке', type: 'number', value: 1 }, { name: 'paid', label: 'Оплата отмечена', type: 'check' }, { name: 'trial', label: 'Пробный доступ', type: 'check' },
        { name: 'note', label: 'Заметка', type: 'area' },
      ],
      actions: [
        { label: 'Продлить на срок тарифа', admin: true, run: async (r) => { const res = await api(`/api/admin/subscriptions/${r.id}/extend`, 'POST', {}); return res.ok ? `Продлена до ${day(res.data.ends_on)}` : res.error; } },
        { label: 'Приостановить', admin: true, when: (r) => !r.suspended, ask: 'Причина приостановки (её увидит клиент)', run: async (r, text) => { const res = await api(`/api/admin/subscriptions/${r.id}/suspend`, 'POST', { reason: text }); return res.ok ? 'Подписка приостановлена' : res.error; } },
        { label: 'Возобновить', admin: true, when: (r) => r.suspended, run: async (r) => { const res = await api(`/api/admin/subscriptions/${r.id}/resume`, 'POST'); return res.ok ? 'Подписка возобновлена' : res.error; } },
      ],
    },
    sessions: {
      title: 'Сеансы роверов', path: '/api/admin/sessions?limit=300', paged: true, readonly: true, search: true, searchParam: 'login', searchHint: 'Логин целиком',
      hint: 'Открытые сеансы можно закрыть: ровер переподключится сам, если ему это разрешено.',
      cols: [
        ['Логин', (r) => esc(r.login)], ['Точка', (r) => `<span class="fig">${esc(r.mountpoint)}</span>`], ['Начало', (r) => when(r.started_at)],
        ['Конец', (r) => (r.ended_at ? when(r.ended_at) : '<span class="is-online">на связи</span>')], ['Длительность', (r) => esc(duration((r.ended_at ? Date.parse(r.ended_at) : Date.now()) - Date.parse(r.started_at)))],
        ['Передано', (r) => `<span class="fig">${esc(bytes(r.bytes))}</span>`], ['Решение', (r) => esc(KIND[r.last_kind] || (r.last_lat === null ? 'координаты не передавались' : r.last_kind))],
        ['Адрес', (r) => `<span class="fig">${esc(r.address)}</span>`], ['Программа', (r) => esc(r.agent || '—')], ['Чем закончился', (r) => esc(r.end_reason || '—')],
      ],
      rowAction: { label: 'Закрыть сеанс', when: (r) => !r.ended_at, confirm: (r) => `Закрыть сеанс логина ${r.login}?`, run: async (r) => { const res = await api('/api/admin/sessions/close', 'POST', { id: r.caster_id }); return res.ok ? 'Сеанс закрыт' : res.error; } },
    },
    refusals: {
      title: 'Отказы в подключении', path: '/api/admin/refusals?limit=300', paged: true, readonly: true, search: true, searchParam: 'login', searchHint: 'Логин целиком',
      cols: [['Время', (r) => when(r.at)], ['Логин', (r) => esc(r.login || '—')], ['Точка', (r) => `<span class="fig">${esc(r.mountpoint || '—')}</span>`],
        ['Ответ', (r) => `<span class="fig">${r.code === null ? 'без ответа' : r.code}</span>`], ['Причина', (r) => esc(r.reason)], ['Адрес', (r) => `<span class="fig">${esc(r.address)}</span>`]],
    },
    audit: {
      title: 'Журнал действий', path: '/api/admin/audit?limit=300', paged: true, readonly: true, adminOnly: true,
      hint: 'Журнал только дополняется: править и удалять записи нельзя.',
      cols: [['Время', (r) => when(r.at)], ['Кто', (r) => esc(r.admin_login || '—')], ['Действие', (r) => esc(r.action)], ['Что', (r) => esc([TITLE[r.entity] || r.entity, r.entity_id].filter(Boolean).join(' №'))],
        ['Подробности', (r) => `<span class="adm-json">${esc(Object.entries(r.details || {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('; '))}</span>`], ['Адрес', (r) => `<span class="fig">${esc(r.ip)}</span>`]],
    },
    admins: {
      title: 'Администраторы', path: '/api/admin/admins', adminOnly: true, needs: [],
      hint: 'Администратор может всё. Оператор смотрит, закрывает сеансы и выдаёт пробный доступ.',
      cols: [['Логин', (r) => `<span class="fig">${esc(r.login)}</span>`], ['Имя', (r) => esc(r.full_name || '—')], ['Роль', (r) => (r.role === 'admin' ? 'администратор' : 'оператор')],
        ['Состояние', (r) => (r.active ? '<span class="is-online">активен</span>' : '<span class="is-fail">отключён</span>')], ['Последний вход', (r) => when(r.last_login_at)]],
      fields: [
        { name: 'login', label: 'Логин', type: 'text', required: true, once: true }, { name: 'full_name', label: 'Имя', type: 'text' },
        { name: 'role', label: 'Роль', type: 'select', options: [['admin', 'администратор'], ['operator', 'оператор']], value: 'operator' },
        { name: 'active', label: 'Вход разрешён', type: 'check', value: true },
        { name: 'password', label: 'Пароль', type: 'secret', virtual: true, hint: 'не короче 10 знаков; при правке пусто — оставить прежний' },
      ],
    },
    settings: { title: 'Настройки', path: '/api/admin/settings', custom: 'settings' },
  };
  const TITLE = { subnets: 'подсеть', stations: 'станция', mountpoints: 'точка', clients: 'клиент', tariffs: 'тариф', subscriptions: 'подписка', ntrip_logins: 'логин', admins: 'администратор', settings: 'настройки', sessions: 'сеанс' };
  const NAV = ['overview', 'stations', 'subnets', 'mountpoints', 'clients', 'logins', 'tariffs', 'subscriptions', 'sessions', 'refusals', 'audit', 'admins', 'settings'];

  // ---------- Вход ----------

  function showLogin(info) {
    clearInterval(liveTimer);
    $('app').hidden = true;
    $('login').hidden = false;
    $('login-error').hidden = true;
    $('login-fields').hidden = !info.configured;
    $('login-submit').hidden = !info.configured;
    $('login-hint').textContent = info.configured ? 'Вход для администратора сети Uralsurvey.'
      : 'Администратор ещё не заведён. Его заводит владелец сервера командой python -m uralsurvey_admin create-admin ЛОГИН — после этого здесь появится вход.';
  }

  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const f = $('login-form').elements;
    const res = await api('/api/login', 'POST', { login: f.login.value.trim(), password: f.password.value });
    f.password.value = '';
    if (res.ok) {
      me = res.data.admin;
      begin();
    } else {
      $('login-error').textContent = res.error || 'Войти не удалось.';
      $('login-error').hidden = false;
    }
  });
  $('logout-btn').addEventListener('click', async () => {
    await api('/api/logout', 'POST');
    showLogin({ configured: true });
  });

  // ---------- Навигация ----------

  function renderNav() {
    renderRail();
    const c = live ? live.counts : null;
    // У станций счётчик показывает каталог сети ниже
    const badge = { mountpoints: () => c.mountpoints, clients: () => c.clients,
      logins: () => `${c.logins_active}/${c.logins}`, sessions: () => (live ? live.clients.length : ''), refusals: () => c.refusals_day };
    // Разделы — строка мелких значков без подписей: название видно при наведении
    $('nav').innerHTML = NAV.filter((id) => !VIEWS[id].adminOnly || isAdmin()).map((id) => `<button class="tile" type="button" data-view="${id}" data-tip="view:${id}" aria-current="${id === view}" aria-label="${esc(VIEWS[id].title)}">
      <svg viewBox="0 0 24 24" aria-hidden="true">${ICON[id]}</svg></button>`).join('')
      // Внизу ленты — что показывать на карте: значки-переключатели, без отдельного окна
      + `<span class="adm-ribbon-gap"></span>${SHOW_TILES.map(([id, title, icon]) => `<button class="tile adm-show" type="button" role="switch" data-show="${id}" data-tip="show:${id}" aria-checked="${id === 'base' ? true : id === 'radii' ? SHOW.fix || SHOW.float || SHOW.over : (id === 'cs' ? SHOW.msk || SHOW.sk42 || SHOW.gsk : SHOW[id])}" aria-label="${title}"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></button>`).join('')}`;
  }
  // ---------- Каталог сети слева: станции и подсети, как в приложении ----------

  const MARK = '<svg class="station-mark" viewBox="0 0 28 26" aria-hidden="true"><path d="M14 2.5 25.5 23h-23Z"/><circle cx="14" cy="16" r="2.6"/></svg>';
  const SHORT = { connecting: 'подключение', waiting: 'ждём данные', listening: 'ждём приёмник', retry: 'нет связи', error: 'ошибка', idle: 'остановлена' };
  function railStation(s, child) {
    const st = liveOf(s.code);
    const online = s.enabled && st && st.link.state === 'online';
    const cls = !s.enabled ? '' : (st ? (LINK[st.link.state] || ['', ''])[1] : 'is-wait');
    const figures = online ? `<span class="station-figures fig" title="Спутников в слежении">${st.satTotal}</span>`
      : `<span class="station-figures">${!s.enabled ? 'остановлена' : (st ? (SHORT[st.link.state] || 'отключено') : 'нет в приёме')}</span>`;
    return `<button class="station ${cls}${child ? ' is-child' : ''}" type="button" data-st="${s.id}" aria-current="${view === 'stations' && picked === s.id}">${MARK}<span class="station-name">${esc(s.code)}</span>${figures}</button>`;
  }
  // Что свёрнуто в каталоге, запоминается: блоки «Станции» и «Подсети» и состав каждой подсети
  let folded = [];
  try { folded = JSON.parse(localStorage.getItem('admin-folded') || '["nets"]'); } catch (err) { /* всё развёрнуто */ }
  const isFolded = (id) => folded.includes(id);
  function fold(id) {
    folded = isFolded(id) ? folded.filter((x) => x !== id) : [...folded, id];
    try { localStorage.setItem('admin-folded', JSON.stringify(folded)); } catch (err) { /* не запомнится */ }
    renderRail();
  }

  function renderRail() {
    const all = lists.stations;
    const on = all.filter((s) => { const st = liveOf(s.code); return s.enabled && st && st.link.state === 'online'; }).length;
    const admin = isAdmin();
    const anyOn = all.some((s) => s.enabled);
    const head = (id, title, count, tools) => `<div class="cat-head" role="button" tabindex="0" data-fold="${id}" aria-expanded="${!isFolded(id)}"><i class="adm-twist"></i><span>${title}</span><span class="fig">${count}</span>${admin ? tools : ''}</div>`;
    let html = head('stations', 'Станции', all.length ? `${on}/${all.length}` : '0',
      `${all.length ? `<button class="adm-plus" type="button" data-add="${anyOn ? 'stop' : 'resume'}" title="${anyOn ? 'Остановить приём по сети' : 'Возобновить приём по сети'}">${anyOn ? '■' : '▶'}</button>` : ''}<button class="adm-plus" type="button" data-add="station" title="Добавить станцию">+</button>`);
    if (!isFolded('stations')) html += all.map((s) => railStation(s, false)).join('') || '<div class="rail-empty">Станций пока нет.</div>';
    html += head('subnets', 'Подсети', String(lists.subnets.length), '<button class="adm-plus" type="button" data-add="subnet" title="Новая подсеть: обвести контур">+</button>');
    if (!isFolded('subnets')) {
      if (!lists.subnets.length) html += '<div class="rail-empty">Подсетей пока нет.</div>';
      for (const g of lists.subnets) {
        // Состав подсети раскрывается щелчком по уголку; по умолчанию свёрнут
        const open = isFolded(`open-${g.id}`);
        const state = g.calc_state === 'running' ? 'считается' : `${g.station_ids.length} ст.`;
        html += `<button class="station is-group ${g.calc_state === 'running' ? 'is-online' : ''}" type="button" data-net="${g.id}" aria-current="${view === 'subnets' && sub.id === g.id && !sub.fresh}"><i class="adm-twist" data-fold="open-${g.id}" aria-expanded="${open}"></i><span class="station-name">${esc(g.name)}</span><span class="station-figures">${state}</span></button>`;
        if (open) for (const id of g.station_ids) { const s = all.find((x) => x.id === id); if (s) html += railStation(s, true); }
      }
    }
    const box = $('rail');
    if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
    $('rail-count').textContent = all.length ? `${on}/${all.length}` : '';
  }
  $('rail').addEventListener('click', async (event) => {
    const add = event.target.closest('[data-add]');
    if (add) {
      if (add.dataset.add === 'stop' || add.dataset.add === 'resume') { await toggleNetwork(add.dataset.add === 'stop'); return; }
      if (add.dataset.add === 'station') { await open('stations'); openForm(null); }
      else { await open('subnets'); sub.fresh = true; sub.draftFor = undefined; openStep('contour'); }
      return;
    }
    const twist = event.target.closest('[data-fold]');
    if (twist) { fold(twist.dataset.fold); return; }
    const net = event.target.closest('[data-net]');
    if (net) { await open('subnets'); sub.fresh = false; sub.id = Number(net.dataset.net); render(); showSteps(); return; }
    const st = event.target.closest('[data-st]');
    if (!st) return;
    // Щелчок по станции — её свойства справа, как в приложении
    if (view !== 'stations') await open('stations');
    picked = Number(st.dataset.st);
    render();
  });

  $('nav').addEventListener('click', (event) => {
    const show = event.target.closest('[data-show]');
    if (show) {
      // Зоны покрытия: значок включает и выключает обе сразу; по отдельности — во всплывающем окне
      // Подложка: щелчок по значку переключает на следующую; выбор конкретной — во всплывающем окне
      if (show.dataset.show === 'base') { const ids = Object.keys(BASES); SHOW.base = ids[(ids.indexOf(SHOW.base) + 1) % ids.length]; }
      else if (show.dataset.show === 'cs') { const on = !(SHOW.msk || SHOW.sk42 || SHOW.gsk); SHOW.msk = on; if (!on) { SHOW.sk42 = false; SHOW.gsk = false; } }
      else if (show.dataset.show === 'radii') { const on = !(SHOW.fix || SHOW.float || SHOW.over); SHOW.fix = on; SHOW.float = on; if (!on) SHOW.over = false; }
      else SHOW[show.dataset.show] = !SHOW[show.dataset.show];
      applyDisplay();
      render();
      showTip(document.querySelector(`#nav [data-show="${show.dataset.show}"]`));
      return;
    }
    const tile = event.target.closest('[data-view]');
    if (!tile) return;
    // У подсетей вместе с разделом открывается окно с плитками шагов
    if (tile.dataset.view === 'subnets') open('subnets').then(showSteps);
    else open(tile.dataset.view);
  });

  async function open(id) {
    view = VIEWS[id] && (!VIEWS[id].adminOnly || isAdmin()) ? id : 'overview';
    try { localStorage.setItem('admin-view', view); } catch (err) { /* не запомнится */ }
    picked = null;
    search = '';
    $('list-search').value = '';
    rows = [];
    await load();
  }

  async function load() {
    const v = VIEWS[view];
    for (const name of v.needs || []) {
      const res = await api(`/api/admin/${name}`);
      if (res.ok) lists[name] = res.data;
    }
    if (v.path) {
      let path = v.path;
      if (v.search && search) path += `${path.includes('?') ? '&' : '?'}${v.searchParam || 'search'}=${encodeURIComponent(search)}`;
      const res = await api(path);
      if (res.ok) rows = v.paged ? res.data.items : res.data;
      if (view === 'stations' && res.ok) lists.stations = res.data;
    }
    render();
  }

  // ---------- Отрисовка ----------

  function render() {
    renderNav();
    const v = VIEWS[view];
    const online = live ? live.stations.filter((s) => s.link.state === 'online').length : 0;
    $('summary').innerHTML = live ? `<b>${online} из ${live.stations.length}</b> ${plural(live.stations.length, 'станции', 'станций', 'станций')} на связи, роверов: <b>${live.clients.length}</b>` : 'Ждём состояние служб…';
    $('who').textContent = me ? `${me.login} · ${me.role === 'admin' ? 'администратор' : 'оператор'}` : '';
    $('overview').hidden = view !== 'overview';
    // Карта — фон экрана; разделы без карты открываются панелью поверх неё
    $('main').hidden = Boolean(v.map);
    renderMap();
    // В разделах сети по центру только карта: списки станций и подсетей — в каталоге слева
    $('list-box').hidden = view === 'overview' || Boolean(v.map);
    $('sub-box').hidden = true;
    if (view === 'overview') return renderOverview();
    if (v.custom === 'subnets') {
      renderSubnets();
      renderMap();
      return renderDetail();
    }
    if (view === 'stations') {
      lists.stations = rows.length ? rows : lists.stations;
      renderRail();
      renderMap();
      return renderDetail();
    }
    $('list-title').textContent = v.title;
    $('list-hint').hidden = !v.hint;
    $('list-hint').textContent = v.hint || '';
    $('list-search').hidden = !v.search;
    $('list-search').placeholder = v.searchHint || 'Поиск';
    $('list-add').hidden = v.readonly || v.custom || !isAdmin();
    $('list-export').hidden = !v.export;
    if (v.export) $('list-export').href = v.export;
    if (v.custom === 'settings') return renderSettings();
    $('list-count').textContent = rows.length ? String(rows.length) : '';
    $('list-head').innerHTML = `<tr>${v.cols.map(([t]) => `<th>${t}</th>`).join('')}${v.rowAction ? '<th></th>' : ''}</tr>`;
    $('list-body').innerHTML = rows.map((r, i) => `<tr data-row="${i}" aria-selected="${picked === r.id}">${v.cols.map(([, cell]) => `<td>${cell(r)}</td>`).join('')}${
      v.rowAction ? `<td>${v.rowAction.when(r) ? `<button class="btn btn-quiet btn-small" type="button" data-act="${i}">${v.rowAction.label}</button>` : ''}</td>` : ''}</tr>`).join('')
      || `<tr><td colspan="${v.cols.length + 1}">Записей нет</td></tr>`;
    if (v.map) renderMap();
    renderDetail();
  }

  function tile(title, cls, lines) {
    return `<article class="srv-tile glass ${cls}"><h2>${title}</h2>${lines.map((l) => `<p>${l}</p>`).join('')}</article>`;
  }

  function renderOverview() {
    if (!live) return;
    const s = live.services;
    const c = live.counts;
    const up = (x) => `работает ${esc(duration(Date.now() - x.startedAt))}`;
    const tiles = [s.ingest.up ? tile('Приём', 'is-up', [up(s.ingest), `потребителей потока: ${s.ingest.consumers}`]) : tile('Приём', '', ['Служба не отвечает. Станции не принимаются.'])];
    if (!s.caster.up) tiles.push(tile('Раздача', '', ['Служба не отвечает.']));
    else {
      const lines = [up(s.caster), s.caster.ingestLink ? 'потоки от приёма получает' : 'нет связи со службой приёма', s.caster.listening ? `NTRIP на порту ${s.caster.port}` : `порт ${s.caster.port} для роверов выключен`];
      if (s.caster.openAccess) lines.push('без проверки логина: только для проверки на самом сервере');
      tiles.push(tile('Раздача', !s.caster.ingestLink ? '' : (s.caster.listening ? 'is-up' : 'is-part'), lines));
    }
    tiles.push(tile('Управление', 'is-up', [up(s.control), 'панель и база данных']));
    $('services').innerHTML = tiles.join('');
    const GO = ['stations', 'mountpoints', 'sessions', 'sessions', 'logins', 'clients', 'subscriptions', 'refusals'];
    let n = 0;
    const fig = (value, label) => `<button class="adm-figure glass" type="button" data-go="${GO[n++]}"><b>${value}</b><span>${label}</span></button>`;
    const subs = c.subscriptions || {};
    $('figures').innerHTML = [
      fig(`${live.stations.filter((x) => x.link.state === 'online').length}/${c.stations}`, 'станций на связи'), fig(`${live.points.filter((p) => p.live && p.enabled).length}/${c.mountpoints}`, 'точек раздаётся'),
      fig(String(live.clients.length), 'роверов на связи'), fig(String(c.sessions_today), 'сеансов за сегодня'),
      fig(`${c.logins_active}/${c.logins}`, 'логинов активно'), fig(String(c.clients), 'клиентов'),
      fig(String((subs.active || 0) + (subs.trial || 0) + (subs.expiring || 0)), `подписок действует${subs.expiring ? `, истекает ${subs.expiring}` : ''}`), fig(String(c.refusals_day), 'отказов за сутки'),
    ].join('');
  }

  // ---------- Отображение: что показывать на карте ----------
  // Настройки запоминаются в браузере администратора.

  const SHOW = { base: 'osm', labels: true, grid: true, regions: true, msk: false, sk42: false, gsk: false, fix: false, float: false, over: false, contours: true, vectors: true, rovers: true };
  try { Object.assign(SHOW, JSON.parse(localStorage.getItem('admin-display') || '{}')); } catch (err) { /* настройки по умолчанию */ }
  // Подложки карты. Все открытые, без ключей; filter — как подложка перекрашивается под тёмную тему
  const BASES = {
    osm: { title: 'Схема', about: 'OpenStreetMap: дороги, города, названия.', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', zoom: 19, by: '© участники OpenStreetMap' },
    holo: { title: 'Голограмма', about: 'Та же схема, но светящимися линиями на тёмном поле: дороги, реки, границы и подписи переливаются от бирюзового к фиолетовому.', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', zoom: 19, by: '© участники OpenStreetMap' },
    relief: { title: 'Рельеф', about: 'Цветная отмывка рельефа: хребты Урала, увалы, долины рек. Без подписей — только формы местности.', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}', zoom: 13, by: 'Рельеф: Esri, USGS, NOAA' },
    topo: { title: 'Топокарта', about: 'OpenTopoMap: рельеф с горизонталями, леса, реки и подписи.', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', zoom: 17, by: '© участники OpenStreetMap, SRTM · стиль OpenTopoMap (CC-BY-SA)' },
    sat: { title: 'Спутник', about: 'Космические снимки.', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', zoom: 18, by: 'Снимки: Esri, Maxar, Earthstar Geographics' },
  };
  if (!BASES[SHOW.base]) SHOW.base = 'osm';
  let baseNow = null;
  let baseLayer = null;
  function drawBase() {
    if (!map || baseNow === SHOW.base) return;
    // Первую подложку ставит сама карта приложения: находим её и заменяем
    if (!baseLayer) map.eachLayer((l) => { if (l instanceof L.TileLayer) baseLayer = l; });
    if (baseLayer) baseLayer.remove();
    const b = BASES[SHOW.base];
    baseLayer = L.tileLayer(b.url, { maxZoom: 19, maxNativeZoom: b.zoom, attribution: b.by, referrerPolicy: 'strict-origin-when-cross-origin' }).addTo(map);
    baseLayer.bringToBack();
    for (const id of Object.keys(BASES)) document.body.classList.toggle(`map-${id}`, id === SHOW.base);
    baseNow = SHOW.base;
  }

  const SHOW_TILES = [
    ['base', 'Подложка карты', '<path d="M12 4 3 9l9 5 9-5ZM3 14l9 5 9-5" /><path d="M3 11.500l9 5 9-5" opacity="0.5"/>'],
    ['labels', 'Подписи станций', '<path d="M4 7h16M4 12h10M4 17h7"/>'],
    ['grid', 'Градусная сетка', '<path d="M4 4h16v16H4ZM4 10h16M4 15h16M10 4v16M15 4v16"/>'],
    ['regions', 'Границы областей', '<path d="M6 5l5-2 4 3 4 1 1 6-3 5-6 3-5-3-2-6Z"/><path d="M11 3l1 6-4 4M12 9l5 3" stroke-dasharray="2 2.500"/>'],
    ['cs', 'Зоны систем координат', '<path d="M5 3v18M12 3v18M19 3v18" stroke-dasharray="3 2.500"/><path d="M3 8h18M3 16h18" opacity="0.5"/>'],
    ['radii', 'Зоны покрытия', '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="6.500"/><circle cx="12" cy="12" r="9.500" stroke-dasharray="2 3"/>'],
    ['contours', 'Контуры подсетей', '<path d="M5 8 13 4l6 6-3 9-9-2Z" stroke-dasharray="3 3"/>'],
    ['vectors', 'Векторы расчёта', '<path d="M5 18 12 6l7 12Z"/><circle cx="5" cy="18" r="1.500"/><circle cx="12" cy="6" r="1.500"/><circle cx="19" cy="18" r="1.500"/>'],
    ['rovers', 'Роверы на связи', '<circle cx="12" cy="9" r="3"/><path d="M12 12v9M8 21h8"/>'],
  ];
  function applyDisplay() {
    document.body.classList.toggle('hide-labels', !SHOW.labels);
    document.body.classList.toggle('hide-grid', !SHOW.grid);
    try { localStorage.setItem('admin-display', JSON.stringify(SHOW)); } catch (err) { /* не запомнится */ }
  }
  applyDisplay();

  // ---------- Всплывающее окно у значков ленты ----------
  // Наведение показывает, что значок делает и что сейчас показано. У зон покрытия в окне ещё и
  // выбор: светить фиксированное решение, плавающее или оба.

  const TIP_SHOW = {
    labels: 'Коды станций рядом с точками на карте.',
    grid: 'Градусная сетка поверх карты с подписями широт и долгот.',
    regions: 'Граница Свердловской области — светящейся линией, соседние области — тонким пунктиром с названиями.',
    contours: 'Границы подсетей пунктиром с их именами. Контур, который сейчас правят или обводят, виден всегда.',
    vectors: 'Векторы последнего расчёта подсети: цвет от красного (метр и хуже) к зелёному (5 мм и лучше).',
    rovers: 'Роверы, которые сейчас подключены и передают своё положение: зелёный — фиксированное решение, жёлтый — плавающее, голубой — дифференциальное, розовый — автономное.',
  };
  let tipFor = null;
  let tipTimer = null;
  function tipHtml(key) {
    const [kind, id] = key.split(':');
    if (kind === 'view') {
      const c = live ? live.counts : null;
      const more = { stations: () => `На связи ${live.stations.filter((s) => s.link.state === 'online').length} из ${c.stations}.`, subnets: () => `Подсетей: ${lists.subnets.length}. Щелчок открывает шаги: контур, расчёт, подключение.`,
        mountpoints: () => `Точек подключения: ${c.mountpoints}.`, clients: () => `Клиентов: ${c.clients}.`, logins: () => `Активных логинов ${c.logins_active} из ${c.logins}.`,
        sessions: () => `Роверов на связи: ${live.clients.length}, сеансов за сегодня: ${c.sessions_today}.`, refusals: () => `Отказов за сутки: ${c.refusals_day}.` }[id];
      return `<b>${esc(VIEWS[id].title)}</b>${c && more ? `<p>${more()}</p>` : ''}`;
    }
    const title = SHOW_TILES.find((t) => t[0] === id)[1];
    if (id === 'base') {
      return `<b>Подложка карты</b><p>${BASES[SHOW.base].about}</p>
        <div class="adm-tip-row">${Object.entries(BASES).map(([k, b]) => `<button class="adm-chip" type="button" data-base="${k}" aria-current="${k === SHOW.base}">${b.title}</button>`).join('')}</div>
        <p>Щелчок по значку переключает подложки по кругу.</p>`;
    }
    if (id === 'cs') {
      const chip = (k, text, color) => `<button class="adm-chip" type="button" data-zone="${k}" aria-current="${SHOW[k]}"><i style="background:${color}"></i>${text}</button>`;
      return `<b>Зоны систем координат</b><p>Границы зон и осевые меридианы поверх карты.</p>
        <div class="adm-tip-row">${chip('msk', 'МСК-66 · зоны по 6°, осевые 60°03′ и 66°03′', CS_COLOR.msk)}${chip('sk42', 'СК-42 · зоны Гаусса — Крюгера по 6°', CS_COLOR.sk42)}${chip('gsk', 'ГСК-2011 · зоны по 6°', CS_COLOR.gsk)}</div>
        <p>Сплошная линия — граница зон, пунктир — осевой меридиан.</p>`;
    }
    if (id !== 'radii') return `<b>${title}</b><span class="adm-tip-state ${SHOW[id] ? 'is-on' : ''}">${SHOW[id] ? 'показано' : 'скрыто'}</span><p>${TIP_SHOW[id]}</p>`;
    const one = Object.values(radiiNow())[0];
    const chip = (k, text, color) => `<button class="adm-chip" type="button" data-zone="${k}" aria-current="${SHOW[k]}"><i style="background:${color}"></i>${text}</button>`;
    return `<b>Зоны покрытия</b><p>Где ровер получит решение — по расчёту сети, вокруг станций на связи.</p>
      <div class="adm-tip-row">${chip('fix', `Фиксированное${one ? ` · до ${num(one.fix_km, 0)} км` : ''}`, reachColors().fix[0])}${chip('float', `Плавающее${one ? ` · до ${num(one.float_km, 0)} км` : ''}`, reachColors().float[0])}${chip('over', 'Перекрытие фикса · две базы и больше', reachColors().over[0])}</div>
      <p>${one ? `Ионосфера сейчас: ${num(one.iono_ppm, 1)} мм на км. Вне зон сеть ровера не покрывает.` : 'Расчёта сети ещё не было: запустите расчёт подсети — зоны появятся вокруг её станций.'}</p>`;
  }
  function showTip(el) {
    if (!el) return;
    clearTimeout(tipTimer);
    tipFor = el.dataset.tip;
    const tip = $('tip');
    tip.innerHTML = tipHtml(tipFor);
    tip.hidden = false;
    const box = el.getBoundingClientRect();
    tip.style.left = `${box.right + 10}px`;
    tip.style.top = `${Math.max(64, Math.min(box.top - 6, window.innerHeight - tip.offsetHeight - 12))}px`;
  }
  function hideTip() {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => { $('tip').hidden = true; tipFor = null; }, 220);
  }
  $('nav').addEventListener('mouseover', (event) => { const el = event.target.closest('[data-tip]'); if (el && el.dataset.tip !== tipFor) showTip(el); else if (el) clearTimeout(tipTimer); });
  $('nav').addEventListener('mouseleave', hideTip);
  $('tip').addEventListener('mouseenter', () => clearTimeout(tipTimer));
  $('tip').addEventListener('mouseleave', hideTip);
  $('tip').addEventListener('click', (event) => {
    const base = event.target.closest('[data-base]');
    const zone = event.target.closest('[data-zone]');
    if (!zone && !base) return;
    if (base) SHOW.base = base.dataset.base;
    else SHOW[zone.dataset.zone] = !SHOW[zone.dataset.zone];
    applyDisplay();
    const key = tipFor;
    render();
    tipFor = key;
    $('tip').innerHTML = tipHtml(key);
  });

  // Расчётные радиусы станций: из самого свежего расчёта подсети, где станция участвовала
  function radiiNow() {
    const out = {};
    const when = {};
    for (const g of lists.subnets) {
      const got = g.results && g.results.stations;
      if (!got) continue;
      const at = Date.parse(g.results_at) || 0;
      for (const [code, r] of Object.entries(got)) {
        if (r.fix_km && (!when[code] || at > when[code])) { out[code] = r; when[code] = at; }
      }
    }
    return out;
  }

  // Зоны систем координат: границы зон и осевые меридианы. Все три системы — шестиградусные.
  // МСК-66: осевые 60°03′ и 66°03′, граница зон 63°03′ (со слов заказчика). СК-42 и ГСК-2011 —
  // зоны Гаусса — Крюгера: номер зоны = долгота / 6 + 1.
  const CS_COLOR = { msk: '#c9a6ff', sk42: '#ffc48e', gsk: '#7fe0ff' };
  const csZones = { layer: null, key: '' };
  function csLines() {
    const out = [];
    const deg = (v) => { const d = Math.floor(v); const m = Math.round((v - d) * 60); return `${d}°${m ? `${String(m).padStart(2, '0')}′` : ''}`; };
    if (SHOW.msk) {
      // Зоны МСК-66 шестиградусные: осевой первой зоны 60°03′, второй — 66°03′, граница между ними 63°03′
      [[1, 60.05], [2, 66.05]].forEach(([zone, lon]) => out.push({ sys: 'msk', lon, axis: true, text: `МСК-66 · зона ${zone} · осевой ${deg(lon)}` }));
      out.push({ sys: 'msk', lon: 57.05, axis: false, text: 'МСК-66 · западная граница зоны 1' });
      out.push({ sys: 'msk', lon: 63.05, axis: false, text: 'МСК-66 · граница зон 1 | 2' });
      out.push({ sys: 'msk', lon: 69.05, axis: false, text: 'МСК-66 · восточная граница зоны 2' });
    }
    for (const [sys, name] of [['sk42', 'СК-42'], ['gsk', 'ГСК-2011']]) {
      if (!SHOW[sys]) continue;
      for (let lon = 48; lon <= 78; lon += 6) {
        const zone = lon / 6 + 1;
        out.push({ sys, lon, axis: false, text: `${name} · граница зон ${zone - 1} | ${zone}` });
        out.push({ sys, lon: lon + 3, axis: true, text: `${name} · зона ${zone} · осевой ${deg(lon + 3)}` });
      }
    }
    return out;
  }
  function drawZones() {
    if (!map) return;
    const lines = csLines();
    const b = map.getBounds();
    const key = JSON.stringify([SHOW.msk, SHOW.sk42, SHOW.gsk, b.getNorth().toFixed(2), b.getSouth().toFixed(2), b.getWest().toFixed(2), b.getEast().toFixed(2)]);
    if (key === csZones.key) return;
    csZones.key = key;
    if (csZones.layer) { csZones.layer.remove(); csZones.layer = null; }
    if (!lines.length) return;
    const pane = map.getPane('cszones') || map.createPane('cszones');
    pane.style.zIndex = 345;
    pane.style.pointerEvents = 'none';
    const layers = [];
    // Подписи — у верхнего края видимой карты, у каждой системы своя строка, чтобы не слипались
    const rows = { msk: 0.13, sk42: 0.2, gsk: 0.27 };
    for (const l of lines) {
      const color = CS_COLOR[l.sys];
      // ГСК-2011 совпадает по линиям с СК-42: рисуется шире и бледнее, чтобы обе были видны
      const wide = l.sys === 'gsk';
      layers.push(L.polyline([[40, l.lon], [75, l.lon]], { pane: 'cszones', color, weight: wide ? 3 : (l.axis ? 1 : 1.5), opacity: wide ? 0.28 : (l.axis ? 0.6 : 0.9), dashArray: l.axis ? '6 7' : null, interactive: false, className: `adm-cs adm-cs-${l.sys}` }));
      if (l.lon <= b.getWest() || l.lon >= b.getEast()) continue;
      const lat = b.getNorth() - (b.getNorth() - b.getSouth()) * (rows[l.sys] + (l.axis ? 0 : 0.035));
      layers.push(L.marker([lat, l.lon], { pane: 'cszones', interactive: false, icon: L.divIcon({ className: `adm-cs-label adm-cs-${l.sys}`, html: `<span style="color:${color}">${esc(l.text)}</span>`, iconSize: [10, 14], iconAnchor: [-6, 7] }) }));
    }
    csZones.layer = L.layerGroup(layers).addTo(map);
  }

  // Границы областей: Свердловская — светящейся линией, соседи — тонким пунктиром с названиями
  const regions = { data: null, layer: null, asked: false };
  function drawRegions() {
    if (!map) return;
    if (!SHOW.regions) { if (regions.layer) { regions.layer.remove(); regions.layer = null; } return; }
    if (!regions.data) {
      if (!regions.asked) {
        regions.asked = true;
        fetch('/regions.json').then((r) => r.json()).then((d) => { regions.data = d.regions; drawRegions(); }).catch(() => { regions.asked = false; });
      }
      return;
    }
    if (regions.layer) return;
    const pane = map.getPane('regions') || map.createPane('regions');
    pane.style.zIndex = 340;
    pane.style.pointerEvents = 'none';
    const layers = [];
    for (const r of regions.data) {
      for (const ring of r.rings) {
        if (r.main) {
          // Широкая бледная подсветка и тонкая яркая линия поверх — неоновый контур
          layers.push(L.polygon(ring, { pane: 'regions', color: '#a890ff', weight: 5, opacity: 0.16, fill: false, interactive: false }));
          layers.push(L.polygon(ring, { pane: 'regions', color: '#b9a6ff', weight: 1.4, opacity: 0.95, fillColor: '#a890ff', fillOpacity: 0.035, interactive: false, className: 'adm-region-main' }));
        } else {
          layers.push(L.polygon(ring, { pane: 'regions', color: '#84c8ff', weight: 0.9, opacity: 0.5, dashArray: '2 5', fill: false, interactive: false }));
        }
      }
      const big = r.rings.slice().sort((a, b) => b.length - a.length)[0];
      const c = [big.reduce((sum, p) => sum + p[0], 0) / big.length, big.reduce((sum, p) => sum + p[1], 0) / big.length];
      if (!r.main) layers.push(L.marker(c, { pane: 'regions', interactive: false, icon: L.divIcon({ className: 'adm-region-label', html: esc(r.name), iconSize: [160, 14], iconAnchor: [80, 7] }) }));
    }
    regions.layer = L.layerGroup(layers).addTo(map);
  }

  // Слои поверх подложки: радиусы решений вокруг станций на связи, контуры подсетей, роверы
  let overlay = null;
  let overlayKey = '';
  const reach = { float: null, fix: null, over: null }; // слои зон покрытия: создаются при первой отрисовке

  // Цвета зон подбираются под подложку, чтобы их было хорошо видно: на тёмной схеме и голограмме
  // хватает мягких тонов, на светлой топокарте и на снимках нужны плотные и контрастные.
  // Для каждой зоны: цвет и плотность заливки.
  const REACH_COLORS = {
    dark: { fix: ['#5df2b0', 0.26], float: ['#ffc48e', 0.13], over: ['#84c8ff', 0.34] },
    holo: { fix: ['#c8ff4d', 0.3], float: ['#ff8fd0', 0.16], over: ['#ffffff', 0.3] },
    relief: { fix: ['#6dffb4', 0.36], float: ['#ffd27a', 0.2], over: ['#ffffff', 0.3] },
    light: { fix: ['#00a85a', 0.42], float: ['#ff7a00', 0.22], over: ['#2a4dff', 0.4] },
    sat: { fix: ['#7dffea', 0.36], float: ['#ffd84d', 0.22], over: ['#ff7ad9', 0.4] },
  };
  function reachColors() {
    const lightTheme = window.Theme.current() !== 'dark';
    if (SHOW.base === 'holo') return REACH_COLORS.holo;
    if (SHOW.base === 'sat') return REACH_COLORS.sat;
    if (SHOW.base === 'topo') return REACH_COLORS.light;
    if (SHOW.base === 'relief') return lightTheme ? REACH_COLORS.light : REACH_COLORS.relief;
    return lightTheme ? REACH_COLORS.light : REACH_COLORS.dark;
  }

  // Общая часть зон фиксированного решения двух станций: [[широта, долгота], ...] или null.
  // Точки каждой окружности, попавшие внутрь другой, обходятся по углу вокруг середины.
  function overlapOf([, latA, lonA, rA], [, latB, lonB, rB]) {
    const k = Math.cos((latA + latB) / 2 * Math.PI / 180);
    const km = (lat1, lon1, lat2, lon2) => Math.hypot((lat1 - lat2) * 111.32, (lon1 - lon2) * 111.32 * k);
    if (km(latA, lonA, latB, lonB) >= rA + rB) return null;
    const pts = [];
    for (const [lat, lon, r, lat2, lon2, r2] of [[latA, lonA, rA, latB, lonB, rB], [latB, lonB, rB, latA, lonA, rA]]) {
      for (let a = 0; a < 360; a += 4) {
        const pt = [lat + r / 111.32 * Math.sin(a * Math.PI / 180), lon + r / (111.32 * k) * Math.cos(a * Math.PI / 180)];
        if (km(pt[0], pt[1], lat2, lon2) <= r2) pts.push(pt);
      }
    }
    if (pts.length < 3) return null;
    const c = [pts.reduce((sum, q) => sum + q[0], 0) / pts.length, pts.reduce((sum, q) => sum + q[1], 0) / pts.length];
    return pts.sort((p1, p2) => Math.atan2(p1[0] - c[0], (p1[1] - c[1]) * k) - Math.atan2(p2[0] - c[0], (p2[1] - c[1]) * k));
  }
  const ROVER = { fixed: ['#86e2c0', 'фиксированное'], float: ['#ffc48e', 'плавающее'], dgps: ['#84c8ff', 'дифференциальное'], single: ['#f09ccc', 'автономное'] };
  function drawOverlay() {
    if (!map) return;
    // Радиусы — расчётные: из оценки ионосферы в последнем расчёте сети. Только у станций на связи.
    const radii = SHOW.fix || SHOW.float || SHOW.over ? radiiNow() : {};
    const stations = (live ? live.stations : []).filter((st) => st.position && st.link.state === 'online' && radii[st.id]).map((st) => [st.id, st.position.lat, st.position.lon, radii[st.id].fix_km, radii[st.id].float_km]);
    const nets = SHOW.contours ? lists.subnets.filter((g) => g.contour.length >= 3 && !(view === 'subnets' && sub.id === g.id) && !sub.drawing).map((g) => [g.name, g.contour]) : [];
    const rovers = SHOW.rovers ? (live ? live.clients : []).filter((c) => c.position).map((c) => [c.login, c.point, c.position.lat, c.position.lon, c.position.kind]) : [];
    // Выбранная станция: её круги фикса и плавающего решения выделяются ярче общей зоны
    const chosen = view === 'stations' && picked ? (rows.find((r) => r.id === picked) || {}).code : null;
    const tone = reachColors();
    const key = JSON.stringify([stations, nets, rovers, SHOW.fix, SHOW.float, SHOW.over, chosen, tone]);
    if (key === overlayKey) return;
    overlayKey = key;
    if (overlay) overlay.remove();
    const layers = [];
    // Сначала широкие круги плавающего решения, поверх — фиксированного
    // Зоны, а не круги: круги каждой зоны сливаются в одно ровное пятно без внутренних границ.
    // Жёлтое — плавающее решение, зелёное поверх — фиксированное, без заливки — сеть не покрывает.
    if (!reach.float) {
      for (const [name, z] of [['reachFloat', 350], ['reachFix', 360], ['reachOver', 370]]) {
        const pane = map.createPane(name);
        pane.style.zIndex = z;
        pane.style.pointerEvents = 'none';
      }
      reach.float = L.svg({ pane: 'reachFloat' });
      reach.fix = L.svg({ pane: 'reachFix' });
      reach.over = L.svg({ pane: 'reachOver' });
    }
    const mine = chosen ? stations.find((st) => st[0] === chosen) : null;
    if (mine) {
      const [code, lat, lon, fix, float] = mine;
      if (SHOW.float) layers.push(L.circle([lat, lon], { radius: float * 1000, color: tone.float[0], weight: 1.6, opacity: 0.95, dashArray: '5 6', fillColor: tone.float[0], fillOpacity: 0.06, interactive: false, className: 'adm-reach-mine' }));
      if (SHOW.fix) layers.push(L.circle([lat, lon], { radius: fix * 1000, color: tone.fix[0], weight: 1.8, opacity: 1, fillColor: tone.fix[0], fillOpacity: 0.16, interactive: false, className: 'adm-reach-mine' }).bindTooltip(`${esc(code)}: фикс до ${num(fix, 0)} км, плавающее до ${num(float, 0)} км`, { permanent: false }));
    }
    for (const [name, k] of [['reachFloat', 'float'], ['reachFix', 'fix'], ['reachOver', 'over']]) {
      map.getPane(name).style.opacity = tone[k][1];
      map.getPane(name).style.filter = `drop-shadow(0 0 3px ${tone[k][0]})`;
    }
    // Перекрытие: где фиксированное решение дают сразу две базы и больше — запас на случай,
    // если одна из них пропадёт. Рисуются общие части зон каждой пары станций.
    if (SHOW.over) {
      for (let i = 0; i < stations.length; i++) {
        for (let j = i + 1; j < stations.length; j++) {
          const lens = overlapOf(stations[i], stations[j]);
          if (lens) layers.push(L.polygon(lens, { stroke: false, fillColor: tone.over[0], fillOpacity: 1, interactive: false, pane: 'reachOver', renderer: reach.over }));
        }
      }
    }
    if (SHOW.float) for (const [, lat, lon, , float] of stations) layers.push(L.circle([lat, lon], { radius: float * 1000, stroke: false, fillColor: tone.float[0], fillOpacity: 1, interactive: false, pane: 'reachFloat', renderer: reach.float }));
    if (SHOW.fix) for (const [, lat, lon, fix] of stations) layers.push(L.circle([lat, lon], { radius: fix * 1000, stroke: false, fillColor: tone.fix[0], fillOpacity: 1, interactive: false, pane: 'reachFix', renderer: reach.fix }));
    for (const [name, contour] of nets) layers.push(L.polygon(contour, { color: '#a890ff', weight: 1.5, dashArray: '5 6', fillColor: '#a890ff', fillOpacity: 0.04, interactive: false }).bindTooltip(esc(name), { permanent: true, direction: 'center', className: 'adm-net-label' }));
    for (const [login, point, lat, lon, kind] of rovers) {
      const [color, text] = ROVER[kind] || ['#8a86a8', 'решение неизвестно'];
      layers.push(L.circleMarker([lat, lon], { radius: 5, color: '#1b1736', weight: 1.5, fillColor: color, fillOpacity: 1 }).bindTooltip(`${esc(login)} · ${esc(point)}: ${text}`));
    }
    overlay = L.layerGroup(layers).addTo(map);
  }

  // Карта та же, что в приложении: знаки станций с подписями, градусная сетка, линейка
  async function selectOnMap(code) {
    if (sub.drawing) return;
    if (view !== 'stations') await open('stations');
    const row = rows.find((r) => r.code === code);
    if (!row) return;
    picked = picked === row.id ? null : row.id;
    render();
  }

  function renderMap() {
    if ($('app').hidden || !window.StationMap) return;
    if (!map) {
      window.StationMap.init(selectOnMap);
      map = window.StationMap.map();
      // Обводка контура подсети: вершина по щелчку, линия тянется за курсором, двойной щелчок — конец
      map.on('click', (event) => {
        if (!sub.drawing) return;
        const pts = sub.draft.contour;
        const last = pts[pts.length - 1];
        // Двойной щелчок приходит ещё и двумя одиночными: вторую вершину в ту же точку не ставим
        if (last && map.latLngToContainerPoint(last).distanceTo(event.containerPoint) < 6) return;
        pts.push([Number(event.latlng.lat.toFixed(6)), Number(event.latlng.lng.toFixed(6))]);
        pickByContour();
        render();
      });
      map.on('mousemove', (event) => {
        if (!sub.drawing || !sub.rubber || !sub.draft.contour.length) return;
        sub.rubber.setLatLngs([...sub.draft.contour, event.latlng, sub.draft.contour[0]]);
      });
      map.on('dblclick', () => { if (sub.drawing) openStep('contour'); });
      // Подписи зон систем координат держатся у верхнего края видимой карты
      map.on('moveend', drawZones);
    }
    const selected = view === 'stations' && picked ? (rows.find((r) => r.id === picked) || {}).code : null;
    // Подпись знака — код станции
    window.StationMap.update((live ? live.stations : []).filter((st) => st.position).map((st) => ({ ...st, name: st.id })), selected || null);
    drawBase();
    drawRegions();
    drawZones();
    drawContour();
    drawVectors();
    drawOverlay();
  }

  // Свойства станции сбоку, по щелчку — в том же виде, что в приложении: состояние, положение,
  // спутники по системам, поток, состав потока, журнал.
  function renderDetail() {
    const row = view === 'stations' && picked ? rows.find((r) => r.id === picked) : null;
    const box = $('detail');
    $('detail-box').hidden = !row;
    if (!row) { box.dataset.html = ''; return; }
    const st = liveOf(row.code);
    const [text, cls] = !row.enabled ? ['Приём остановлен', ''] : (st ? (LINK[st.link.state] || ['—', '']) : ['Нет в приёме', 'is-wait']);
    const since = st && st.link.state === 'online' ? `на связи ${duration(Date.now() - st.link.stateSince)}` : (st && st.link.detail ? st.link.detail : '');
    const source = row.source_mode === 'listen' ? `база шлёт сама на порт ${row.source_port || '—'}` : (row.source_mode === 'sim' ? 'имитатор'
      : `${row.source_mode}://${row.source_host}:${row.source_port}${row.source_mountpoint ? `/${row.source_mountpoint}` : ''}`);
    const section = (title, side, body) => `<div class="ins-section ins-rule"><h2 class="ins-title"><span>${title}</span>${side ? `<span>${side}</span>` : ''}</h2>${body}</div>`;
    const xyz = (v, d) => `<dl class="ecef"><div><dt>X</dt><dd class="fig">${num(v[0], d)}<span>м</span></dd></div><div><dt>Y</dt><dd class="fig">${num(v[1], d)}<span>м</span></dd></div><div><dt>Z</dt><dd class="fig">${num(v[2], d)}<span>м</span></dd></div></dl>`;
    const parts = [`<button class="icon-btn adm-close" type="button" id="detail-close" title="Закрыть">×</button>
      <div class="ins-section"><h1 class="head-name">${esc(row.name || row.code)}</h1><p class="head-endpoint fig">${esc(source)}</p>
        <p class="head-state ${cls}"><span>${text}${since ? `<small>${esc(since)}</small>` : ''}</span></p>
        ${isAdmin() ? `<div class="head-actions"><button class="btn btn-quiet btn-small" type="button" id="detail-edit">Изменить</button><button class="btn btn-quiet btn-small ${row.enabled ? 'btn-danger' : ''}" type="button" id="detail-toggle">${row.enabled ? 'Остановить приём' : 'Возобновить приём'}</button></div>` : ''}</div>`];

    // Положение: плоские координаты МСК-66 и X, Y, Z из потока
    const pos = st ? st.position : null;
    if (pos) {
      const exact = pos.source === 'rtcm';
      const flat = window.CoordSys ? window.CoordSys.convert('msk66', pos.ecef) : null;
      let note = exact ? `Координаты переданы самой станцией в сообщении ${pos.messageType}.` : 'Вычислено по наблюдениям: в потоке координат станции нет. Точность метровая, это не каталожные координаты.';
      if (exact && pos.antennaHeight !== null && pos.antennaHeight !== undefined) note += ` Высота антенны ${num(pos.antennaHeight, 4)}${NBSP}м.`;
      let rowsHtml;
      if (flat) {
        rowsHtml = `<dt>Север, X</dt><dd class="fig">${num(flat.north, exact ? 3 : 0)}<span>м</span></dd><dt>Восток, Y</dt><dd class="fig">${num(flat.east, exact ? 3 : 0)}<span>м</span></dd>
          <dt>Высота</dt><dd class="fig">${num(pos.h, exact ? 3 : 0)}<span>м над эллипсоидом WGS-84</span></dd>`;
        note += ` Плоские координаты: ${esc(flat.name)}, зона ${flat.zone}, на основе ${esc(flat.datum)}.`;
        if (!flat.verified) note += ' <b>Параметры этой зоны с каталогом не сверены</b>: расхождение с каталожными координатами возможно.';
      } else {
        const la = dms(pos.lat, 'lat', exact ? 5 : 1);
        const lo = dms(pos.lon, 'lon', exact ? 5 : 1);
        rowsHtml = `<dt>Широта</dt><dd class="fig">${la.text}<span>${la.hemi}</span></dd><dt>Долгота</dt><dd class="fig">${lo.text}<span>${lo.hemi}</span></dd><dt>Высота</dt><dd class="fig">${num(pos.h, exact ? 3 : 0)}<span>м над эллипсоидом</span></dd>`;
      }
      parts.push(section('Положение станции', flat ? `${esc(flat.name)}, зона ${flat.zone}` : 'WGS-84', `<dl class="coords">${rowsHtml}</dl>${xyz(pos.ecef, exact ? 4 : 0)}<p class="source">${note}</p>`));
    } else {
      parts.push(section('Положение станции', '', `<p class="notice is-plain">${st && st.link.state === 'online' ? 'Координаты станции пока не получены.' : 'Координаты появятся, когда пойдут данные.'}</p>`));
    }

    // Каталог: показывается, когда координаты заведены; рядом — расхождение с потоком
    if (row.x !== null) {
      const d = pos ? Math.hypot(pos.ecef[0] - row.x, pos.ecef[1] - row.y, pos.ecef[2] - row.z) : null;
      parts.push(section('Координаты в каталоге', 'X, Y, Z', `${xyz([row.x, row.y, row.z], 4)}${d === null ? '' : `<p class="${d > 10 ? 'notice' : 'source'}">Расхождение с потоком: ${d < 0.001 ? 'нет' : `${num(d, d < 1 ? 4 : 1)}${NBSP}м`}${d > 10 ? '. Больше 10 м: похоже, на станцию пришёл чужой поток.' : ''}</p>`}`));
    }

    // Спутники в слежении: столбик — уровень сигнала
    if (st && st.constellations.length) {
      const sys = st.constellations.map((c) => {
        const bars = c.sats.map((sat) => {
          const k = sat.cnr === null ? 'is-blank' : (sat.cnr < 32 ? 'is-weak' : '');
          const h = sat.cnr === null ? 3 : Math.max(2, Math.min(24, Math.round((sat.cnr - 20) / 35 * 24)));
          return `<span class="bar ${k}" title="${esc(sat.cnr === null ? sat.label : `${sat.label}: ${num(sat.cnr, 0)} дБ·Гц`)}"><span class="bar-track"><i style="height:${h}px"></i></span><span class="fig">${esc(sat.label.slice(1))}</span></span>`;
        }).join('');
        return `<div class="sys"><div><div class="sys-name">${esc(c.name)}</div><div class="sys-count fig">${c.count}</div></div><div class="bars">${bars}</div>
          <div class="sys-signals"><span class="fig">${esc(c.signals.join(' '))}</span><span></span></div></div>`;
      }).join('');
      parts.push(section('Спутники в слежении', `<span class="fig">${st.satTotal}</span>`, sys));
    }

    if (st) {
      const l = st.link;
      const d = st.descriptors || {};
      const g = st.gate;
      const facts = [];
      const add = (name, value, fig) => facts.push(`<dt>${name}</dt><dd${fig ? ' class="fig"' : ''}>${value}</dd>`);
      add('Формат', esc(st.format.label));
      if (l.state === 'online') add('Скорость', esc(rate(l.bitsPerSec)), true);
      add('Принято', esc(bytes(l.bytesTotal)), true);
      if (st.frames) add('Сообщений RTCM', num(st.frames), true);
      if (st.frames) add('Сбоев контрольной суммы', num(st.crcErrors), true);
      add('Переподключений', num(l.reconnects), true);
      if (st.stationId !== null && st.stationId !== undefined) add('Номер станции в потоке', String(st.stationId), true);
      if (d.receiver) add('Приёмник', esc([d.receiver, d.firmware].filter(Boolean).join(', ')));
      if (d.receiverSerial) add('Серийный номер приёмника', esc(d.receiverSerial), true);
      if (d.antenna) add('Антенна', esc(d.antenna));
      if (d.antennaSerial) add('Серийный номер антенны', esc(d.antennaSerial), true);
      if (row.mountpoints && row.mountpoints.length) add('Точки подключения', esc(row.mountpoints.join(', ')), true);
      if (g) {
        add('База', g.current ? `${esc(g.current.address)}, ${esc(duration(Date.now() - g.current.since))}` : 'не подключена');
        add('Отказов шлюза: адрес / пароль / молчание / занято', `${g.refusedAddress} / ${g.refusedPassword} / ${g.refusedSilent} / ${g.refusedBusy}`, true);
      }
      parts.push(section('Поток', '', `<dl class="facts">${facts.join('')}</dl>`));
      if (st.messages && st.messages.length) {
        parts.push(section('Состав потока', '', `<table class="messages"><thead><tr><th>Тип</th><th>Что это</th><th>Период</th><th>Всего</th></tr></thead><tbody>${
          st.messages.map((m) => `<tr><td class="fig">${m.type}</td><td>${esc(m.name)}</td><td class="fig">${esc(interval(m.intervalSec))}</td><td class="fig">${num(m.count)}</td></tr>`).join('')}</tbody></table>`));
      }
      if (st.log.length) {
        parts.push(section('Журнал', '', `<ol class="log">${st.log.slice(-30).reverse().map((e) => `<li class="is-${e.level}"><time class="fig">${clock(e.t)}</time><span>${esc(e.text)}${e.repeat > 1 ? ` (×${e.repeat})` : ''}</span></li>`).join('')}</ol>`));
      }
    }
    // Карточка перерисовывается, только когда в ней что-то изменилось: нажатие на кнопку не теряется
    const html = parts.join('');
    if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
  }
  $('detail').addEventListener('click', (event) => {
    if (event.target.closest('#detail-close')) { picked = null; render(); }
    if (event.target.closest('#detail-edit')) openForm(rows.find((r) => r.id === picked));
    if (event.target.closest('#detail-toggle')) toggleStation(rows.find((r) => r.id === picked));
  });

  // ---------- Подсети ----------
  // Шаги выбираются плитками в окне раздела: контур, расчёт, подключение.

  const STEPS = { contour: 'Контур', calc: 'Расчёт', ppp: 'PPP-AR', link: 'Подключение' };
  const STEP_ICON = {
    contour: '<path d="M5 8 13 4l6 6-3 9-9-2Z"/><circle cx="5" cy="8" r="1.3"/><circle cx="13" cy="4" r="1.3"/><circle cx="19" cy="10" r="1.3"/><circle cx="16" cy="19" r="1.3"/><circle cx="7" cy="17" r="1.3"/>',
    calc: '<circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/><circle cx="12" cy="12" r="1.3"/>',
    ppp: '<circle cx="12" cy="12" r="2.200"/><path d="M12 2v5M12 17v5M4.500 7l4 2.500M15.500 14.500l4 2.500M19.500 7l-4 2.500M8.500 14.500l-4 2.500"/>',
    link: ICON.mountpoints,
  };
  const QUALITY = { reference: ['опорная', ''], fix: ['фиксированное', 'is-online'], float: ['плавающее', 'is-wait'], none: ['нет решения', 'is-fail'] };
  const sub = { id: null, fresh: false, step: 'contour', draft: null, draftFor: undefined, drawing: false, layer: null };
  $('sub-dialog').addEventListener('cancel', () => { sub.drawing = false; });

  const subRow = () => (sub.fresh ? null : rows.find((r) => r.id === sub.id) || null);
  const mm = (v) => (v === null || v === undefined ? '—' : num(v * 1000, v < 0.1 ? 1 : 0));

  // Точка внутри контура: луч вправо пересекает нечётное число сторон
  function inside(lat, lon, poly) {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [la, lo] = poly[i];
      const [lb, lob] = poly[j];
      if ((la > lat) !== (lb > lat) && lon < (lob - lo) * (lat - la) / (lb - la) + lo) hit = !hit;
    }
    return hit;
  }

  // Станции, которые сейчас подсвечены на карте: из открытого окна, иначе из выбранной подсети
  function subIds() {
    if (sub.draft) return sub.draft.ids;
    const row = rows.find((r) => r.id === sub.id);
    return new Set(row && !sub.fresh ? row.station_ids : []);
  }

  // Цвет качества вектора: от красного (метр и хуже) через жёлтый к зелёному (5 мм и лучше).
  // Шкала логарифмическая: по мере накопления наблюдений вектор «зеленеет».
  function qualityColor(sd) {
    if (sd === null || sd === undefined || !Number.isFinite(sd)) return '#8a86a8';
    const t = Math.max(0, Math.min(1, Math.log10(1 / Math.max(sd, 1e-4)) / Math.log10(1 / 0.005)));
    return `hsl(${Math.round(140 * t)} 85% 55%)`;
  }
  const sd3 = (r) => (r && r.sd ? Math.hypot(...r.sd) : null);

  // Векторы расчёта на карте: линия от соседа к станции, цвет — точность
  function drawVectors() {
    if (!map) return;
    if (sub.vectors) { sub.vectors.remove(); sub.vectors = null; }
    const has = (r) => r.results && r.results.stations;
    const row = SHOW.vectors && view === 'subnets' && !sub.drawing ? (rows.find((r) => r.id === sub.id && has(r)) || rows.find(has)) : null;
    $('map-legend').hidden = !row;
    if (!row) return;
    const where = (code) => { const st = liveOf(code); return st && st.position ? [st.position.lat, st.position.lon] : null; };
    const lines = [];
    // Стороны сети: все векторы расчёта; у прежних результатов — цепочка «сосед → станция»
    const list = row.results.vectors || Object.entries(row.results.stations).filter(([, r]) => r.from).map(([code, r]) => ({ a: r.from, b: code, length_km: r.length_km, quality: r.quality, sd: sd3(r), minutes: r.minutes }));
    for (const v of list) {
      const a = where(v.a);
      const b = where(v.b);
      if (!a || !b) continue;
      const none = v.quality === 'none';
      // Цвет — по худшему из двух: оценка точности вектора и его невязка в уравненной сети
      const q = v.sd === null || v.sd === undefined ? null : Math.max(v.sd, v.resid || 0);
      // Тонкая линия с мягким свечением своего цвета; вектор без решения — бледный пунктир
      const line = L.polyline([a, b], { color: qualityColor(q), weight: none ? 1 : 1.3, opacity: none ? 0.5 : 0.9, dashArray: none ? '3 6' : null, lineCap: 'round' });
      line.glow = none ? '' : `drop-shadow(0 0 2.5px ${qualityColor(q)})`;
      line.bindTooltip(`${esc(v.a)} → ${esc(v.b)}: ${num(v.length_km, 1)} км, ${(QUALITY[v.quality] || ['—'])[0]}${v.sd == null ? '' : `, точность ${mm(v.sd)} мм`}${v.resid == null ? '' : `, невязка ${mm(v.resid)} мм`}${v.closure == null ? '' : `, незамыкание треугольника до ${mm(v.closure)} мм`}${v.minutes ? `, ${v.minutes} мин наблюдений` : ''}`, { sticky: true });
      lines.push(line);
    }
    sub.vectors = L.layerGroup(lines).addTo(map);
    for (const line of lines) if (line._path && line.glow) line._path.style.filter = line.glow;
    $('map-legend-name').textContent = `Векторы ${row.name}`;
  }

  // Координаты, которые станция сама передаёт в потоке (сообщения 1005/1006)
  function streamXyz(code) {
    const st = liveOf(code);
    return st && st.position && st.position.source === 'rtcm' ? st.position.ecef : null;
  }

  function pickByContour() {
    const d = sub.draft;
    if (d.contour.length < 3) return;
    d.ids = new Set();
    for (const st of (live ? live.stations : [])) {
      const s = lists.stations.find((x) => x.code === st.id);
      if (s && st.position && inside(st.position.lat, st.position.lon, d.contour)) d.ids.add(s.id);
    }
  }

  const OUTLINE = { color: '#a890ff', weight: 1.5, dashArray: '5 6', fillColor: '#a890ff', fillOpacity: 0.05, interactive: false };
  const DRAFT = { color: '#ffc48e', weight: 2, dashArray: '4 5', interactive: false };
  function drawContour() {
    if (!map) return;
    if (sub.layer) { sub.layer.remove(); sub.layer = null; }
    sub.rubber = null;
    map.getContainer().style.cursor = sub.drawing ? 'crosshair' : '';
    // Пока идёт обводка, двойной щелчок заканчивает контур, а не приближает карту
    if (sub.drawing) map.doubleClickZoom.disable(); else if (!map.doubleClickZoom.enabled()) setTimeout(() => { if (!sub.drawing) map.doubleClickZoom.enable(); }, 300);
    const shown = rows.find((r) => r.id === sub.id);
    // Контур выбранной подсети скрывается переключателем «Контуры подсетей»; пока контур правят
    // или обводят, он виден всегда
    const editing = sub.drawing || $('sub-dialog').open;
    const pts = view !== 'subnets' || (!SHOW.contours && !editing) ? [] : (sub.draft ? sub.draft.contour : (shown && !sub.fresh ? shown.contour : []));
    if (sub.drawing) {
      // Черновик: вершины видны с первого щелчка, линия замыкается на первую вершину
      sub.rubber = L.polyline(pts.length ? [...pts, pts[0]] : [], DRAFT);
      sub.layer = L.layerGroup([sub.rubber, ...pts.map((pt) => L.circleMarker(pt, { radius: 4, color: '#ffc48e', weight: 2, fillColor: '#ffc48e', fillOpacity: 0.9, interactive: false }))]).addTo(map);
      return;
    }
    if (pts.length >= 3) sub.layer = L.polygon(pts, OUTLINE).addTo(map);
  }

  function subStatus(row) {
    const res = row.results || {};
    const solver = live && live.services ? live.services.solver : null;
    const about = () => { const p = []; if (res.window_minutes !== undefined) p.push(`В расчёте последние ${res.window_minutes} мин наблюдений.`); if (res.orbits) p.push(`Орбиты: ${res.orbits}.`); if (res.network && res.network.iono_ppm) p.push(`Ионосфера: ${num(res.network.iono_ppm, 1)} мм на км.`); if (res.network) p.push(`Сеть: векторов ${res.network.vectors}${res.network.failed ? `, без решения ${res.network.failed}` : ''}, треугольников ${res.network.triangles}${res.network.max_closure === null ? '' : `, наибольшее незамыкание ${mm(res.network.max_closure)} мм`}.`); if (res.note) p.push(res.note); return p.join(' '); };
    if (row.calc_state === 'idle') return 'Расчёт ещё не запускался. Сервер постоянно хранит последние часы наблюдений всех станций: «Вычислить текущие координаты» считает по ним сразу.';
    if (row.calc_state === 'stopped') return `${row.results_at ? `Координаты вычислены ${when(row.results_at)}.` : 'Расчёт остановлен, ответа не было.'} ${about()}`;
    if (row.calc_once) return solver ? 'Вычисляем текущие координаты… Ответ придёт в течение минуты.' : 'Служба расчёта не отвечает.';
    const parts = [`Непрерывный расчёт идёт с ${when(row.calc_started_at)}.`];
    if (!solver) parts.push('Служба расчёта не отвечает.');
    else if (solver.rtklib === false) parts.push('На сервере не найден RTKLIB.');
    parts.push(row.results_at ? `Пересчётов: ${res.cycles || 0}, последний — ${when(row.results_at)}.` : 'Первый ответ придёт в течение минуты.');
    parts.push(about());
    return parts.join(' ');
  }

  // Живая часть: состояние расчёта и таблица. Обновляется сама, поля ввода при этом не трогаются.
  function subLive() {
    const row = subRow();
    const body = $('sub-rows');
    if (!row || !body) return;
    const got = (row.results && row.results.stations) || {};
    const acc = row.accepted || {};
    if (sub.step === 'calc') {
      $('sub-status').textContent = subStatus(row);
      body.innerHTML = row.stations.map((code) => {
        const r = got[code] || {};
        const [text, cls] = QUALITY[r.quality] || ['ждём', ''];
        const a = acc[code];
        return `<tr><td><span class="fig">${esc(code)}</span></td><td class="fig">${r.vectors === undefined ? '—' : r.vectors}</td>
          <td><span class="${cls}">${text}</span>${r.note ? `<small class="adm-note"> ${esc(r.note)}</small>` : ''}</td><td class="fig">${r.minutes === undefined ? '—' : r.minutes}</td>
          <td class="fig">${r.sd ? `<i class="adm-q" style="background:${qualityColor(sd3(r))}"></i>${mm(sd3(r))}` : '—'}</td><td class="fig">${mm(r.resid)}</td><td class="fig">${mm(r.spread)}</td>
          <td class="fig">${r.x === undefined ? '—' : num(r.x, 4)}</td><td class="fig">${r.y === undefined ? '—' : num(r.y, 4)}</td><td class="fig">${r.z === undefined ? '—' : num(r.z, 4)}</td>
          <td class="fig">${r.shift === undefined || r.shift === null ? '—' : num(r.shift, 3)}</td><td>${a ? `${when(a.at)}` : '—'}</td></tr>`;
      }).join('') || '<tr><td colspan="12">В подсети нет станций</td></tr>';
    } else if (sub.step === 'ppp') {
      const res = row.ppp_results || {};
      const st = res.stations || {};
      const net = (row.results && row.results.stations) || {};
      $('sub-status').textContent = row.ppp_state === 'idle' ? 'PPP-AR ещё не запускался.'
        : (row.ppp_state === 'running' ? `PPP-AR запущен ${when(row.ppp_started_at)}. ${res.note || 'Идёт расчёт…'}` : `PPP-AR выполнен ${when(row.ppp_results_at)}${res.epoch ? `, эпоха ${num(res.epoch, 3)}` : ''}. ${res.note || ''}`);
      body.innerHTML = row.stations.map((code) => {
        const r = st[code] || {};
        const n = net[code];
        const diff = r.x14 !== undefined && n && n.x !== undefined ? Math.hypot(r.x14 - n.x, r.y14 - n.y, r.z14 - n.z) : null;
        return `<tr><td><span class="fig">${esc(code)}</span></td><td>${r.x === undefined ? `<span class="is-wait">${esc(r.note || 'ждём')}</span>` : (r.fixed ? '<span class="is-online">фиксированное</span>' : '<span class="is-wait">плавающее</span>')}</td>
          <td class="fig">${r.hours === undefined ? '—' : num(r.hours, 1)}</td><td class="fig">${r.sd ? `<i class="adm-q" style="background:${qualityColor(Math.hypot(...r.sd))}"></i>${mm(Math.hypot(...r.sd))}` : '—'}</td>
          <td class="fig">${r.x14 === undefined ? '—' : num(r.x14, 4)}</td><td class="fig">${r.y14 === undefined ? '—' : num(r.y14, 4)}</td><td class="fig">${r.z14 === undefined ? '—' : num(r.z14, 4)}</td>
          <td class="fig">${r.shift === undefined || r.shift === null ? '—' : num(r.shift, 3)}</td><td class="fig">${diff === null ? '—' : num(diff, 3)}</td><td>${esc(r.products || '—')}</td></tr>`;
      }).join('') || '<tr><td colspan="10">В подсети нет станций</td></tr>';
    } else if (sub.step === 'link') {
      body.innerHTML = row.stations.map((code) => {
        const a = acc[code];
        const p = row.mountpoints.find((m) => m.station === code);
        const lp = p && live ? live.points.find((x) => x.name === p.name) : null;
        return `<tr><td><span class="fig">${esc(code)}</span></td><td class="fig">${a ? num(a.x, 4) : '—'}</td><td class="fig">${a ? num(a.y, 4) : '—'}</td><td class="fig">${a ? num(a.z, 4) : '—'}</td>
          <td>${a ? (QUALITY[a.quality] || ['—'])[0] : '<span class="is-wait">координаты не приняты</span>'}</td><td><span class="fig">${p ? esc(p.name) : '—'}</span></td>
          <td>${!p ? '—' : (lp ? (lp.live ? '<span class="is-online">раздаётся</span>' : '<span class="is-fail">станция молчит</span>') : '<span class="is-wait">нет у раздачи</span>')}</td></tr>`;
      }).join('') || '<tr><td colspan="7">В подсети нет станций</td></tr>';
    }
  }

  // На странице раздела — карта и список подсетей. Шаги открываются в окнах.
  function renderSubList() {
    if (sub.id !== null && !rows.some((r) => r.id === sub.id)) sub.id = null;
    const state = { idle: 'не запускался', running: '<span class="is-online">идёт</span>', stopped: 'выполнен' };
    $('sub-box').innerHTML = `<h2 class="ins-title adm-list-head"><span>Подсети</span><span class="adm-list-tools"><span class="fig">${rows.length || ''}</span>${isAdmin() ? '<button class="btn btn-primary btn-small" type="button" data-sub="new">Добавить</button>' : ''}</span></h2>
      <p class="hint">Щелчок по подсети открывает окно с шагами: контур, расчёт, подключение.</p>
      <div class="adm-scroll"><table class="messages srv-table adm-rows"><thead><tr><th>Подсеть</th><th>Название</th><th>Станций</th><th>Опорная</th><th>Расчёт</th><th>Принято координат</th><th>Точек подключения</th></tr></thead>
      <tbody>${rows.map((r) => `<tr data-sub="${r.id}" aria-selected="${r.id === sub.id && !sub.fresh}"><td><span class="fig">${esc(r.name)}</span></td><td>${esc(r.title || '—')}</td><td class="fig">${r.stations.length}</td>
        <td><span class="fig">${esc(r.reference || '—')}</span></td><td>${state[r.calc_state]}</td><td class="fig">${Object.keys(r.accepted || {}).length}</td><td class="fig">${r.mountpoints.length}</td></tr>`).join('') || '<tr><td colspan="7">Подсетей пока нет</td></tr>'}</tbody></table></div>`;
    $('draw-bar').hidden = !sub.drawing;
    if (sub.drawing) $('draw-count').textContent = `Обведите подсеть: щёлкайте по карте, ставя вершины. Двойной щелчок — закончить, Esc — отменить. Вершин: ${sub.draft.contour.length}`;
    drawContour();
  }

  function renderSubnets() {
    renderSubList();
    if ($('sub-dialog').open) renderStep();
  }

  // Содержимое окна шага
  function renderStep() {
    const row = subRow();
    const key = row ? row.id : 'new';
    if (!sub.draft || sub.draftFor !== key) {
      sub.draft = { name: row ? row.name : '', title: row ? row.title : '', contour: row ? row.contour.map((p) => [...p]) : [], ids: new Set(row ? row.station_ids : []) };
      sub.draftFor = key;
    }
    if (!row) sub.step = 'contour';
    const d = sub.draft;
    const admin = isAdmin();
    let body = '';
    if (sub.step === 'contour') {
      body = `<div class="adm-sub-form"><label class="field"><span>Имя латиницей</span><input id="sub-name" type="text" autocomplete="off" value="${esc(d.name)}" ${admin ? '' : 'disabled'}></label>
          <label class="field"><span>Название</span><input id="sub-title" type="text" autocomplete="off" value="${esc(d.title)}" ${admin ? '' : 'disabled'}></label></div>
        ${admin ? `<div class="adm-actions"><button class="btn btn-quiet btn-small" type="button" data-do="draw">${d.contour.length ? 'Продолжить обводку на карте' : 'Обвести на карте'}</button>
          <button class="btn btn-quiet btn-small" type="button" data-do="clear" ${d.contour.length ? '' : 'disabled'}>Очистить контур</button></div>` : ''}
        <p class="hint">${d.contour.length ? `В контуре углов: ${d.contour.length}. ` : ''}Станции внутри контура отмечаются сами. Состав можно поправить галочками.</p>
        <div class="adm-sub-stations">${lists.stations.map((s) => `<label class="adm-check"><input type="checkbox" data-member="${s.id}" ${d.ids.has(s.id) ? 'checked' : ''} ${admin ? '' : 'disabled'}><span class="fig">${esc(s.code)}</span></label>`).join('')}</div>
        ${admin ? `<div class="dialog-actions">${row ? '<button class="btn btn-quiet btn-danger" type="button" data-do="delete">Удалить подсеть</button>' : ''}<span class="adm-grow"></span>
          <span class="hint">станций: ${d.ids.size}</span><button class="btn btn-primary" type="button" data-do="save">Сохранить</button></div>` : ''}`;
    } else if (sub.step === 'calc') {
      const ref = lists.stations.find((s) => s.id === row.reference_station_id);
      // Координаты опорной: сохранённые, иначе из каталога, иначе из потока самой станции
      const xyz = row.ref_x !== null ? [row.ref_x, row.ref_y, row.ref_z] : (ref && ref.x !== null ? [ref.x, ref.y, ref.z] : ((ref && streamXyz(ref.code)) || ['', '', '']));
      const running = row.calc_state === 'running';
      body = `<div class="adm-sub-form is-ref"><label class="field"><span>Опорная станция</span><select id="sub-ref" ${admin && !running ? '' : 'disabled'}><option value="">— выберите —</option>${row.station_ids.map((id) => { const s = lists.stations.find((x) => x.id === id); return s ? `<option value="${id}" ${id === row.reference_station_id ? 'selected' : ''}>${esc(s.code)}</option>` : ''; }).join('')}</select></label>
          ${['X', 'Y', 'Z'].map((k, i) => `<label class="field adm-coord"><span>${k} опорной, м</span><input id="sub-${k.toLowerCase()}" type="text" inputmode="decimal" autocomplete="off" value="${xyz[i] === '' ? '' : Number(xyz[i]).toFixed(4)}" ${admin && !running ? '' : 'disabled'}></label>`).join('')}</div>
        <p class="hint">Координаты опорной — в ${esc(row.frame)}: можно ввести или взять те, что станция передаёт в потоке. Остальные станции считаются от неё сетью взаимных треугольников и получают ту же систему и эпоху.</p>
        ${admin ? `<div class="adm-actions">${running ? '<button class="btn btn-quiet btn-small btn-danger" type="button" data-do="stop">Остановить расчёт</button><button class="btn btn-quiet btn-small" type="button" data-do="run">Ход расчёта</button>' : '<button class="btn btn-primary btn-small" type="button" data-do="compute">Вычислить текущие координаты</button><button class="btn btn-quiet btn-small" type="button" data-do="start">Считать непрерывно</button><button class="btn btn-quiet btn-small" type="button" data-do="ref">Сохранить опорную</button><button class="btn btn-quiet btn-small" type="button" data-do="stream">Взять координаты из потока</button>'}
          <button class="btn btn-quiet btn-small" type="button" data-do="accept">Принять координаты</button></div>` : ''}
        <p class="hint" id="sub-status"></p>
        <div class="adm-scroll"><table class="messages srv-table adm-rows adm-static"><thead><tr><th>Станция</th><th>Векторов</th><th>Решение</th><th>Минут</th><th>Точность, мм</th><th>Невязка, мм</th><th>Разброс, мм</th><th>X</th><th>Y</th><th>Z</th><th>С потоком, м</th><th>Принято</th></tr></thead><tbody id="sub-rows"></tbody></table></div>
        <p class="hint">Станции связаны взаимными треугольниками, сеть уравнена от опорной. «Точность» — оценка после уравнивания, «Невязка» — насколько худший вектор станции разошёлся с уравненной сетью, «Разброс» — насколько ответ менялся за последние пересчёты. «С потоком» — расхождение с координатами, которые станция сейчас передаёт сама. Чем дольше сервер копит наблюдения (до 6 часов), тем точнее ответ.</p>`;
    } else if (sub.step === 'ppp') {
      const going = row.ppp_state === 'running';
      body = `<p class="hint">PPP-AR считает каждую станцию саму по себе, без опорной: по точным орбитам, часам и фазовым поправкам спутников, с фиксацией неоднозначностей. Ответ — абсолютные координаты в ITRF2020 на эпоху измерений; в таблице они пересчитаны в ITRF2014. Продукты спутников выходят с отставанием, поэтому считаются наблюдения старше трёх часов; если их пока мало, расчёт дождётся сам.</p>
        ${admin ? `<div class="adm-actions">${going ? '<button class="btn btn-quiet btn-small btn-danger" type="button" data-do="ppp-stop">Остановить PPP-AR</button>' : '<button class="btn btn-primary btn-small" type="button" data-do="ppp-start">Запустить PPP-AR</button>'}<button class="btn btn-quiet btn-small" type="button" data-do="ppp-run">Ход расчёта</button></div>` : ''}
        <p class="hint" id="sub-status"></p>
        <div class="adm-scroll"><table class="messages srv-table adm-rows adm-static"><thead><tr><th>Станция</th><th>Решение</th><th>Часов</th><th>Точность, мм</th><th>X (ITRF2014)</th><th>Y</th><th>Z</th><th>С потоком, м</th><th>С сетевым расчётом, м</th><th>Продукты</th></tr></thead><tbody id="sub-rows"></tbody></table></div>
        <p class="hint">«С потоком» — расхождение с координатами, которые станция передаёт сама. «С сетевым расчётом» — с результатом шага «Расчёт» (он привязан к вашей опорной станции, поэтому общий сдвиг здесь — это сдвиг её координат).</p>`;
    } else {
      body = `<p class="hint">У подсети свои точки подключения: поток станции тот же, а координаты базы в нём — принятые в подсети. Обычные точки станции при этом не меняются. Точки подсети доступны только по тарифу, где они названы: заведите тариф с этими точками и выдайте клиенту подписку — он получит подсеть целиком.</p>
        ${admin ? '<div class="adm-actions"><button class="btn btn-primary btn-small" type="button" data-do="points">Создать точки подключения</button></div>' : ''}
        <div class="adm-scroll"><table class="messages srv-table adm-rows adm-static"><thead><tr><th>Станция</th><th>X</th><th>Y</th><th>Z</th><th>Решение</th><th>Точка подключения</th><th>Состояние</th></tr></thead><tbody id="sub-rows"></tbody></table></div>`;
    }
    sub.seenState = row ? row.calc_state : null;
    sub.seenPpp = row ? row.ppp_state : null;
    $('sub-dialog').classList.toggle('adm-wide', sub.step !== 'contour');
    $('sub-head').textContent = `${row ? row.name : 'Новая подсеть'} · ${STEPS[sub.step]}`;
    $('sub-body').innerHTML = body;
    subLive();
  }

  function openStep(step) {
    sub.step = step;
    try { localStorage.setItem('admin-sub-step', step); } catch (err) { /* не запомнится */ }
    sub.drawing = false;
    if (!$('sub-dialog').open) $('sub-dialog').showModal();
    render();
  }

  const coordOf = (id) => { const v = $(id).value.trim().replace(',', '.').replace(/\s/g, ''); return v === '' ? null : Number(v); };
  async function subCall(path, method, body, done) {
    const res = await api(path, method, body);
    if (!res.ok) { toast(res.error || 'Не получилось.', 6000); return null; }
    if (done) toast(done, 4000);
    const list = await api('/api/admin/subnets');
    if (list.ok) rows = list.data;
    return res.data;
  }

  // Список на странице: щелчок по подсети — окно с шагами, «Добавить» — сразу контур новой
  $('sub-box').addEventListener('click', (event) => {
    const pick = event.target.closest('[data-sub]');
    if (!pick) return;
    sub.fresh = pick.dataset.sub === 'new';
    if (!sub.fresh) sub.id = Number(pick.dataset.sub);
    if (sub.fresh) openStep('contour'); else { render(); showSteps(); }
  });

  // Окно шага закрыто: несохранённая правка отбрасывается. Обводка контура — исключение:
  // окно на это время убирается, чтобы открыть карту, и черновик остаётся.
  $('sub-dialog').addEventListener('close', () => {
    if (!sub.drawing) { sub.draft = null; sub.draftFor = undefined; if (sub.fresh) sub.fresh = false; }
    render();
  });
  $('sub-dialog').addEventListener('input', (event) => {
    if (event.target.id === 'sub-name') sub.draft.name = event.target.value;
    if (event.target.id === 'sub-title') sub.draft.title = event.target.value;
  });
  $('sub-dialog').addEventListener('change', (event) => {
    const member = event.target.dataset.member;
    if (member) {
      if (event.target.checked) sub.draft.ids.add(Number(member)); else sub.draft.ids.delete(Number(member));
      render();
    }
    if (event.target.id === 'sub-ref') {
      // Если у станции есть координаты в каталоге, подставляем их: править можно
      const s = lists.stations.find((x) => x.id === Number(event.target.value));
      const got = s ? (s.x !== null ? [s.x, s.y, s.z] : streamXyz(s.code)) : null;
      if (got) ['x', 'y', 'z'].forEach((k, i) => { $(`sub-${k}`).value = Number(got[i]).toFixed(4); });
    }
  });
  $('sub-dialog').addEventListener('click', async (event) => {
    if (event.target === $('sub-dialog')) { $('sub-dialog').close(); return; }
    const btn = event.target.closest('[data-do]');
    if (!btn) return;
    const row = subRow();
    const d = sub.draft;
    const act = btn.dataset.do;
    if (act === 'close') { $('sub-dialog').close(); return; }
    if (act === 'steps') { $('sub-dialog').close(); showSteps(); return; }
    if (act === 'draw') { sub.before = d.contour.map((pt) => [...pt]); sub.beforeIds = new Set(d.ids); sub.drawing = true; $('sub-dialog').close(); return; }
    if (act === 'clear') { d.contour = []; render(); return; }
    if (act === 'ppp-run') { openRun(`ppp-${row.id}`, `${row.name} · PPP-AR`); run.since = Date.parse(row.ppp_started_at) || 0; renderRun(); return; }
    if (act === 'ppp-start' || act === 'ppp-stop') {
      const got = await subCall(`/api/admin/subnets/${row.id}/ppp/${act === 'ppp-start' ? 'start' : 'stop'}`, 'POST', {}, act === 'ppp-stop' ? 'PPP-AR остановлен.' : '');
      render();
      if (got && act === 'ppp-start') openRun(`ppp-${row.id}`, `${row.name} · PPP-AR`);
      return;
    }
    if (act === 'run') { openRun(row.id, row.name); run.since = Date.parse(row.calc_started_at) || 0; renderRun(); return; }
    if (act === 'stream') {
      const s = lists.stations.find((x) => x.id === Number($('sub-ref').value));
      const got = s ? streamXyz(s.code) : null;
      if (!got) { toast(s ? `Станция ${s.code} сейчас не передаёт свои координаты.` : 'Сначала выберите опорную станцию.', 5000); return; }
      ['x', 'y', 'z'].forEach((k, i) => { $(`sub-${k}`).value = Number(got[i]).toFixed(4); });
      return;
    }
    if (act === 'save') {
      const body = { name: d.name.trim(), title: d.title.trim(), contour: d.contour, station_ids: [...d.ids] };
      const saved = await subCall(row ? `/api/admin/subnets/${row.id}` : '/api/admin/subnets', row ? 'PATCH' : 'POST', body, 'Подсеть сохранена.');
      if (saved) { sub.fresh = false; sub.id = saved.id; sub.draftFor = undefined; }
    } else if (act === 'delete') {
      if (!window.confirm(`Удалить подсеть ${row.name}? Её точки подключения и принятые координаты удалятся вместе с ней.`)) return;
      if (await subCall(`/api/admin/subnets/${row.id}`, 'DELETE', undefined, 'Подсеть удалена.') !== null) { sub.id = null; $('sub-dialog').close(); return; }
    } else if (act === 'ref' || act === 'start' || act === 'compute') {
      const ref = Number($('sub-ref').value) || null;
      const saved = await subCall(`/api/admin/subnets/${row.id}`, 'PATCH', { reference_station_id: ref, ref_x: coordOf('sub-x'), ref_y: coordOf('sub-y'), ref_z: coordOf('sub-z') }, act === 'ref' ? 'Опорная станция сохранена.' : '');
      const begun = saved ? (act === 'start' ? await subCall(`/api/admin/subnets/${row.id}/start`, 'POST', {}, '') : (act === 'compute' ? await subCall(`/api/admin/subnets/${row.id}/compute`, 'POST', {}, '') : null)) : null;
      if (begun) { render(); openRun(row.id, row.name); return; }
    } else if (act === 'stop') {
      await subCall(`/api/admin/subnets/${row.id}/stop`, 'POST', {}, 'Расчёт остановлен. Последний ответ сохранён.');
    } else if (act === 'accept') {
      if (!window.confirm('Принять координаты всех станций, у которых есть решение? Точки подключения подсети начнут раздавать их сразу.')) return;
      await subCall(`/api/admin/subnets/${row.id}/accept`, 'POST', {}, 'Координаты приняты.');
    } else if (act === 'points') {
      await subCall(`/api/admin/subnets/${row.id}/points`, 'POST', {}, 'Точки подключения созданы. Раздача подхватит их за несколько секунд.');
    }
    render();
  });

  // Esc во время обводки отменяет её: контур и состав возвращаются к тому, что было
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !sub.drawing) return;
    sub.draft.contour = sub.before || [];
    sub.draft.ids = sub.beforeIds || new Set();
    openStep('contour');
  });

  // Обводка контура идёт на карте; «Готово» или двойной щелчок возвращают в окно контура
  $('draw-bar').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-draw]');
    if (!btn) return;
    if (btn.dataset.draw === 'undo') { sub.draft.contour.pop(); pickByContour(); render(); return; }
    openStep('contour');
  });

  // Окно раздела: выбор подсети и шага плитками
  function showSteps() {
    if (sub.id === null && rows.length && !sub.fresh) sub.id = rows[0].id;
    if (!rows.length) sub.fresh = true;
    const row = subRow();
    $('sub-chips').innerHTML = rows.map((r) => `<button class="adm-chip" type="button" data-sub="${r.id}" aria-current="${Boolean(row) && r.id === row.id}">${esc(r.name)}${r.calc_state === 'running' ? ' ·&nbsp;считается' : ''}</button>`).join('')
      + (isAdmin() ? `<button class="adm-chip" type="button" data-sub="new" aria-current="${!row}">+ новая</button>` : '');
    $('sub-steps').innerHTML = Object.entries(STEPS).map(([id, title]) => `<button class="tile" type="button" data-step="${id}" ${!row && id !== 'contour' ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${STEP_ICON[id]}</svg><span>${title}</span></button>`).join('');
    if (!$('sub-fly').open) $('sub-fly').showModal();
  }
  $('sub-fly').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-sub]');
    if (chip) {
      sub.fresh = chip.dataset.sub === 'new';
      if (!sub.fresh) sub.id = Number(chip.dataset.sub);
      showSteps();
      render();
      return;
    }
    const tile = event.target.closest('[data-step]');
    // Щелчок мимо плиток закрывает окно
    if (!tile) { if (event.target === $('sub-fly')) $('sub-fly').close(); return; }
    if (tile.disabled) return;
    $('sub-fly').close();
    openStep(tile.dataset.step);
  });
  $('sub-fly').addEventListener('close', () => { if (sub.fresh && !$('sub-dialog').open) { sub.fresh = false; render(); } });

  // ---------- Остановка приёма: одна станция или вся сеть ----------
  // Остановленная станция не принимается, и её точки подключения роверам не раздаются.

  async function toggleStation(row) {
    if (!row) return;
    if (row.enabled && !window.confirm(`Остановить приём станции ${row.code}? Её точки подключения перестанут раздаваться.`)) return;
    const res = await api(`/api/admin/stations/${row.id}`, 'PATCH', { enabled: !row.enabled });
    toast(res.ok ? (row.enabled ? `Приём станции ${row.code} остановлен.` : `Приём станции ${row.code} возобновлён.`) : res.error, 5000);
    await load();
  }
  async function toggleNetwork(stop) {
    if (stop && !window.confirm('Остановить приём по всей сети? Сервер отключится от всех станций, раздача роверам прекратится.')) return;
    const res = await api('/api/admin/stations/enabled', 'POST', { enabled: !stop });
    toast(res.ok ? (stop ? `Приём остановлен: станций ${res.data.changed}.` : `Приём возобновлён: станций ${res.data.changed}.`) : res.error, 5000);
    const list = await api('/api/admin/stations');
    if (list.ok) { lists.stations = list.data; if (view === 'stations') rows = list.data; }
    render();
  }

  function renderSettings() {
    $('list-count').textContent = '';
    $('list-head').innerHTML = '<tr><th>Настройка</th><th>Значение</th><th>Допустимо</th><th>Изменена</th></tr>';
    $('list-body').innerHTML = rows.map((r, i) => `<tr data-row="${i}"><td>${esc(r.title)}</td><td class="fig">${r.value}</td><td class="fig">${r.min}–${r.max}</td><td>${when(r.updated_at)}</td></tr>`).join('');
  }

  // Настройка правится в окне: щелчок по строке
  let setting = null;
  function openSetting(row) {
    if (!isAdmin()) return;
    setting = row;
    $('set-title').textContent = row.title.charAt(0).toUpperCase() + row.title.slice(1);
    $('set-hint').textContent = `Допустимо от ${row.min} до ${row.max}`;
    $('set-value').value = row.value;
    $('set-value').min = row.min;
    $('set-value').max = row.max;
    $('set-error').hidden = true;
    $('set-dialog').showModal();
    $('set-value').select();
  }
  $('set-cancel').addEventListener('click', () => $('set-dialog').close());
  $('set-dialog').addEventListener('click', (event) => { if (event.target === $('set-dialog')) $('set-dialog').close(); });
  $('set-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const res = await api('/api/admin/settings', 'PATCH', { [setting.key]: Number($('set-value').value) });
    if (!res.ok) { $('set-error').textContent = res.error || 'Сохранить не удалось.'; $('set-error').hidden = false; return; }
    $('set-dialog').close();
    toast('Настройка сохранена. Службы применят её в течение нескольких секунд.', 5000);
    rows = res.data;
    render();
  });

  // ---------- Таблица: выбор строки и действия ----------

  $('list-body').addEventListener('click', async (event) => {
    const v = VIEWS[view];
    const save = event.target.closest('[data-save]');
    if (save) {
      const input = $('list-body').querySelector(`[data-key="${save.dataset.save}"]`);
      const res = await api('/api/admin/settings', 'PATCH', { [save.dataset.save]: Number(input.value) });
      toast(res.ok ? 'Настройка сохранена. Службы применят её в течение нескольких секунд.' : res.error, 5000);
      if (res.ok) { rows = res.data; render(); }
      return;
    }
    const act = event.target.closest('[data-act]');
    if (act) {
      const row = rows[Number(act.dataset.act)];
      if (!window.confirm(v.rowAction.confirm(row))) return;
      toast(await v.rowAction.run(row), 5000);
      await load();
      return;
    }
    const tr = event.target.closest('[data-row]');
    if (tr && v.custom === 'settings') { openSetting(rows[Number(tr.dataset.row)]); return; }
    if (!tr || v.custom) return;
    const row = rows[Number(tr.dataset.row)];
    if (view === 'stations') { picked = picked === row.id ? null : row.id; render(); return; }
    if (!v.readonly && v.fields) openForm(row);
  });
  $('list-add').addEventListener('click', () => openForm(null));
  $('figures').addEventListener('click', (event) => { const go = event.target.closest('[data-go]'); if (go) open(go.dataset.go); });
  let searchTimer = null;
  $('list-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { search = $('list-search').value.trim(); load(); }, 350);
  });

  // ---------- Форма ----------

  const dialog = $('form-dialog');
  let editing = null;
  let needConfirm = false;

  function values() {
    const out = {};
    for (const f of VIEWS[view].fields) {
      const el = $('form').elements[f.name];
      if (!el) continue;
      if (f.type === 'check') out[f.name] = el.checked;
      else if (f.type === 'multi') out[f.name] = [...$('form-fields').querySelectorAll(`[data-multi="${f.name}"]:checked`)].map((x) => Number(x.value));
      else out[f.name] = el.value;
    }
    return out;
  }

  function syncForm() {
    const v = values();
    for (const f of VIEWS[view].fields) {
      const box = $('form-fields').querySelector(`[data-field="${f.name}"]`);
      if (box && f.when) box.hidden = !f.when(v);
    }
    const c = $('form-fields').querySelector('[data-field="_control"]');
    if (c) {
      const xyz = ['x', 'y', 'z'].map((k) => Number(String(v[k]).replace(',', '.').replace(/\s/g, '')));
      const html = v.x === '' && v.y === '' && v.z === '' ? '' : control(xyz);
      c.innerHTML = html ? `<p class="hint">Для контроля, не редактируется:</p>${html}` : (v.x || v.y || v.z ? '<p class="hint">Введите все три координаты: по ним покажутся широта, долгота и МСК-66.</p>' : '');
    }
  }

  function openForm(row) {
    const v = VIEWS[view];
    if (!v.fields || !isAdmin()) return;
    editing = row;
    needConfirm = false;
    $('form-title').textContent = row ? `${v.title}: правка` : `${v.title}: новая запись`;
    $('form-error').hidden = true;
    $('form-note').hidden = true;
    $('form-delete').hidden = !row;
    $('form-delete').textContent = 'Удалить';
    $('form-delete').dataset.armed = '';
    const val = (f) => { if (row && row[f.name] !== undefined && row[f.name] !== null) return row[f.name]; if (row) return ''; return typeof f.value === 'function' ? f.value() : (f.value === undefined ? '' : f.value); };
    const html = v.fields.map((f) => {
      const hint = f.hint ? `<small>${esc(f.hint)}</small>` : '';
      const dis = f.once && row ? 'disabled' : '';
      if (f.type === 'control') return `<div data-field="_control" class="adm-control"></div>`;
      if (f.type === 'check') return `<label class="adm-check" data-field="${f.name}"><input type="checkbox" name="${f.name}" ${val(f) === true || (val(f) === '' && f.value) ? 'checked' : ''}><span>${esc(f.label)}</span></label>`;
      if (f.type === 'select') {
        const opts = (typeof f.options === 'function' ? f.options() : f.options).map(([k, t]) => `<option value="${esc(String(k))}" ${String(val(f)) === String(k) ? 'selected' : ''}>${esc(t)}</option>`).join('');
        return `<label class="field" data-field="${f.name}"><span>${esc(f.label)}</span><select name="${f.name}" ${dis}>${f.empty ? `<option value="">${esc(f.empty)}</option>` : (f.required && !row ? '<option value="">— выберите —</option>' : '')}${opts}</select>${hint}</label>`;
      }
      if (f.type === 'multi') {
        const chosen = new Set(row ? row[f.name] : []);
        return `<fieldset class="adm-multi" data-field="${f.name}"><legend>${esc(f.label)}</legend><input type="hidden" name="${f.name}">${f.options().map(([k, t]) => `<label class="adm-check"><input type="checkbox" data-multi="${f.name}" value="${k}" ${chosen.has(k) ? 'checked' : ''}><span>${esc(t)}</span></label>`).join('') || '<p class="hint">Точек подключения пока нет.</p>'}</fieldset>`;
      }
      if (f.type === 'area') return `<label class="field" data-field="${f.name}"><span>${esc(f.label)}</span><textarea name="${f.name}" rows="2">${esc(String(val(f)))}</textarea></label>`;
      if (f.type === 'secret') return `<label class="field" data-field="${f.name}"><span>${esc(f.label)}</span><input name="${f.name}" type="password" autocomplete="new-password" placeholder="${row && f.has && row[f.has] ? 'задан; пусто — оставить' : ''}">${hint}</label>`;
      const shown = f.type === 'list' ? (Array.isArray(val(f)) ? val(f).join(', ') : val(f)) : (f.type === 'coord' && val(f) !== '' ? Number(val(f)).toFixed(4) : val(f));
      return `<label class="field ${f.type === 'coord' ? 'adm-coord' : ''}" data-field="${f.name}"><span>${esc(f.label)}</span><input name="${f.name}" type="${f.type === 'date' ? 'date' : 'text'}" ${f.type === 'number' || f.type === 'coord' ? 'inputmode="decimal"' : ''} autocomplete="off" value="${esc(String(shown))}" ${dis}>${hint}</label>`;
    }).join('');
    const extra = row && v.actions ? `<div class="adm-actions">${v.actions.filter((a) => !a.when || a.when(row)).map((a, i) => `<button class="btn btn-quiet btn-small" type="button" data-action="${v.actions.indexOf(a)}">${a.label}</button>`).join('')}</div>` : '';
    $('form-fields').innerHTML = html + extra;
    syncForm();
    dialog.showModal();
  }
  $('form').addEventListener('input', syncForm);
  $('form').addEventListener('change', syncForm);
  $('form-cancel').addEventListener('click', () => dialog.close());

  $('form-fields').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    const action = VIEWS[view].actions[Number(btn.dataset.action)];
    let text;
    if (action.confirm && !window.confirm(action.confirm)) return;
    if (action.ask) { text = window.prompt(action.ask, ''); if (text === null) return; }
    const note = await action.run(editing, text);
    $('form-note').textContent = note;
    $('form-note').hidden = false;
    const res = await api(VIEWS[view].path.split('?')[0]);
    if (res.ok) { rows = res.data; editing = rows.find((r) => r.id === editing.id) || editing; render(); }
  });

  $('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const v = VIEWS[view];
    const raw = values();
    const body = {};
    for (const f of v.fields) {
      if (f.type === 'control' || !(f.name in raw)) continue;
      if (f.once && editing) continue;
      const box = $('form-fields').querySelector(`[data-field="${f.name}"]`);
      if (box && box.hidden) continue;
      let value = raw[f.name];
      if (f.type === 'secret' || (f.virtual && f.name !== 'coords_note')) { if (value === '') continue; }
      if (f.type === 'number' || f.type === 'coord') value = value === '' ? null : Number(String(value).replace(',', '.').replace(/\s/g, ''));
      if (f.numeric) value = value === '' ? null : Number(value);
      if (f.type === 'date' && value === '') value = null;
      body[f.name] = value;
    }
    if (needConfirm) body.confirm_shift = true;
    const base = v.path.split('?')[0];
    const res = editing ? await api(`${base}/${editing.id}`, 'PATCH', body) : await api(base, 'POST', body);
    if (!res.ok) {
      // Сдвиг координат больше 10 м: второе нажатие «Сохранить» подтверждает его
      needConfirm = res.status === 409 && /подтвердите/.test(res.error || '');
      $('form-error').textContent = needConfirm ? `${res.error} Нажмите «Сохранить» ещё раз, чтобы подтвердить.` : (res.error || 'Сохранить не удалось.');
      $('form-error').hidden = false;
      return;
    }
    dialog.close();
    toast(res.data.password && !editing ? `Создано. Пароль логина ${res.data.login}: ${res.data.password}` : 'Сохранено. Службы применят изменения в течение нескольких секунд.', res.data.password ? 15000 : 3500);
    await load();
  });

  $('form-delete').addEventListener('click', async () => {
    const btn = $('form-delete');
    if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = 'Точно удалить?'; return; }
    const res = await api(`${VIEWS[view].path.split('?')[0]}/${editing.id}`, 'DELETE');
    if (!res.ok) { $('form-error').textContent = res.error; $('form-error').hidden = false; return; }
    dialog.close();
    toast('Удалено');
    if (picked === editing.id) picked = null;
    await load();
  });

  // ---------- Состояние служб ----------

  async function tick() {
    const res = await api('/api/admin/state').catch(() => null);
    if (!res || !res.ok) return;
    live = res.data;
    // Каталог сети слева виден всегда: его списки обновляются вместе с состоянием
    const [nets, sts] = await Promise.all([api('/api/admin/subnets'), view === 'stations' ? null : api('/api/admin/stations')]);
    if (nets.ok) lists.subnets = nets.data;
    if (sts && sts.ok) lists.stations = sts.data;
    if ($('run-dialog').open) renderRun();
    if (dialog.open) { renderNav(); return; }
    // Журналы и таблицы с живыми данными обновляются сами; формы и поиск при этом не сбиваются
    if (['sessions', 'refusals'].includes(view) && !search) { const r = await api(VIEWS[view].path); if (r.ok) rows = r.data.items; }
    if (view === 'subnets') {
      // Список и таблица расчёта обновляются сами; поля ввода в окне при этом не перерисовываются
      const r = await api('/api/admin/subnets');
      if (r.ok) rows = r.data;
      renderNav();
      renderSubList();
      renderMap();
      // Расчёт закончился или начался, пока окно открыто, — кнопки в нём должны смениться
      const shown = subRow();
      if ($('sub-dialog').open && shown && ((sub.step === 'calc' && sub.seenState !== shown.calc_state) || (sub.step === 'ppp' && sub.seenPpp !== shown.ppp_state))) renderStep();
      subLive();
      return;
    }
    if (view !== 'settings') render(); else renderNav();
  }

  async function begin() {
    $('login').hidden = true;
    $('app').hidden = false;
    try { view = localStorage.getItem('admin-view') || view; } catch (err) { /* начнём с обзора */ }
    await tick();
    await open(view);
    clearInterval(liveTimer);
    liveTimer = setInterval(tick, 2000);
  }

  function syncTheme() { $('theme-btn').textContent = window.Theme.current() === 'dark' ? 'Светлая тема' : 'Тёмная тема'; }
  $('theme-btn').addEventListener('click', () => window.Theme.set(window.Theme.current() === 'dark' ? 'light' : 'dark'));
  window.addEventListener('themechange', syncTheme);
  syncTheme();

  api('/api/me').then((res) => {
    if (res.data.signedIn) { me = res.data.admin; begin(); } else showLogin(res.data);
  }).catch(() => showLogin({ configured: true }));
})();
