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
    outages: '<path d="M2 12h4l2.500-6 3 12 2.500-6h2"/><path d="M18.500 9.500l3.500 5M22 9.500l-3.500 5"/>',
    admins: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.500 7-10V6Z"/><path d="M9.500 12l2 2 3.500-4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.600 5.600l2.100 2.100M16.300 16.300l2.100 2.100M5.600 18.400l2.100-2.100M16.300 7.700l2.100-2.100"/>',
  };

  let me = null; // вошедший администратор
  let live = null; // состояние служб
  let view = 'overview';
  let rows = []; // строки текущего раздела
  let lists = { stations: [], mountpoints: [], clients: [], tariffs: [], subnets: [], layers: [], networks: [] }; // справочники для форм и каталога сети
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
        { name: 'send_catalog', label: 'Раздавать роверам эти координаты вместо тех, что шлёт база', type: 'check', value: false },
        { name: 'antenna_height', label: 'Высота антенны, м', type: 'number' },
        { name: 'antenna_type', label: 'Антенна (справочно, в расчёт и в поток не идёт)', type: 'text' }, { name: 'receiver_type', label: 'Тип приёмника', type: 'text' },
        { name: 'note', label: 'Заметка', type: 'area' },
      ],
    },
    mountpoints: {
      title: 'Точки подключения', path: '/api/admin/mountpoints', needs: ['stations'],
      hint: 'Кроме этих точек есть NEAR — «ближайшая база»: ровер подключается к ней один раз, а сервер сам отдаёт поток ближайшей станции по его положению и переводит на другую, когда он уезжает. У каждой сети раздачи своя такая точка: ИМЯСЕТИ_NEAR.',
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
    subnets: { title: 'Расчётные модули', path: '/api/admin/subnets', map: true, needs: ['stations'], custom: 'subnets' },
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
      title: 'Логины NTRIP', path: '/api/admin/logins', needs: ['clients', 'layers'], search: true,
      hint: 'Один логин — один ровер. Пароль создаёт сервер; он показывается при создании и по кнопке «Показать пароль».',
      cols: [
        ['Логин', (r) => `<span class="fig">${esc(r.login)}</span>`], ['Клиент', (r) => esc(r.staff ? 'служебный' : (r.client_name || '—'))], ['Ровер', (r) => esc(r.device || '—')],
        ['Сеансов', (r) => `<span class="fig">${r.max_sessions}</span>`], ['При втором подключении', (r) => (r.on_limit === 'evict' ? 'вытеснить старое' : 'не пускать новое')],
        ['Состояние', (r) => (r.active ? '<span class="is-online">активен</span>' : '<span class="is-fail">отключён</span>')], ['Область работы', (r) => esc(r.area_layer_name || 'без ограничения')], ['Был на связи', (r) => when(r.last_seen_at)], ['Последний отказ', (r) => esc(r.last_refusal || '—')],
      ],
      fields: [
        { name: 'login', label: 'Логин', type: 'text', required: true, once: true },
        { name: 'staff', label: 'Служебный логин оператора сети', type: 'check' },
        { name: 'client_id', label: 'Клиент', type: 'select', options: clientOptions, numeric: true, empty: '— без клиента —', when: (v) => !v.staff },
        { name: 'device', label: 'Какой ровер', type: 'text' }, { name: 'max_sessions', label: 'Одновременных сеансов', type: 'number', value: 1 },
        { name: 'on_limit', label: 'При втором подключении', type: 'select', options: [['evict', 'вытеснить старое'], ['refuse', 'не пускать новое']], value: 'evict' },
        { name: 'active', label: 'Логин активен', type: 'check', value: true },
        { name: 'area_layer_id', label: 'Область работы (слой с контурами)', type: 'select', options: () => lists.layers.filter((l) => l.polygons).map((l) => [l.id, l.name]), numeric: true, empty: '— без ограничения —', hint: 'вне контуров слоя ровер поправки не получает' },
        { name: 'password', label: 'Свой пароль', type: 'text', virtual: true, hint: 'пусто — сервер создаст сам (только при создании и смене)' },
      ],
      actions: [
        { label: 'Показать пароль', admin: true, run: async (r) => { const res = await api(`/api/admin/logins/${r.id}/reveal`, 'POST'); return res.ok ? `Пароль логина ${res.data.login}: ${res.data.password}` : res.error; } },
        { label: 'Новый пароль', admin: true, confirm: 'Создать новый пароль? Прежний перестанет работать, открытый сеанс закроется.', run: async (r) => { const res = await api(`/api/admin/logins/${r.id}/regenerate`, 'POST'); return res.ok ? `Новый пароль логина ${res.data.login}: ${res.data.password}` : res.error; } },
      ],
    },
    tariffs: {
      title: 'Тарифы', path: '/api/admin/tariffs', needs: ['mountpoints', 'networks'],
      cols: [
        ['Тариф', (r) => esc(r.name)], ['Срок', (r) => `${r.period_days} дн.`], ['Точки', (r) => (r.all_mountpoints ? 'все открытые' : esc(r.mountpoint_ids.map((id) => (lists.mountpoints.find((m) => m.id === id) || {}).name).filter(Boolean).join(', ') || 'не выбраны'))],
        ['Сети', (r) => esc((r.network_ids || []).map((id) => (lists.networks.find((n) => n.id === id) || {}).name).filter(Boolean).join(', ') || '—')],
        ['Сеансов на логин', (r) => `<span class="fig">${r.max_sessions}</span>`], ['Цена', (r) => (r.price === null ? '—' : `${num(r.price, 2)}${NBSP}₽`)], ['Подписок', (r) => `<span class="fig">${r.subscriptions}</span>`],
      ],
      fields: [
        { name: 'name', label: 'Название', type: 'text', required: true }, { name: 'period_days', label: 'Срок, дней', type: 'number', required: true, value: 30 },
        { name: 'all_mountpoints', label: 'Все точки с доступом «все с подпиской»', type: 'check', value: true },
        { name: 'mountpoint_ids', label: 'Точки тарифа', type: 'multi', options: () => lists.mountpoints.filter((m) => !m.network_id).map((m) => [m.id, m.name]), when: (v) => !v.all_mountpoints },
        { name: 'network_ids', label: 'Сети раздачи целиком', type: 'multi', options: () => lists.networks.map((n) => [n.id, `${n.name} — ${netLabel(recipeOf(n))}`]) },
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
      title: 'Сеансы роверов', path: '/api/admin/sessions?limit=300', paged: true, readonly: true, search: true, searchParam: 'login', searchHint: 'Логин целиком', needs: ['fix-stats'],
      hint: 'Открытые сеансы можно закрыть: ровер переподключится сам, если ему это разрешено.',
      summary: () => fixSummaryHtml(),
      cols: [
        ['Логин', (r) => esc(r.login)], ['Точка', (r) => `<span class="fig">${esc(r.mountpoint)}</span>`], ['Начало', (r) => when(r.started_at)],
        ['Конец', (r) => (r.ended_at ? when(r.ended_at) : '<span class="is-online">на связи</span>')], ['Длительность', (r) => esc(duration((r.ended_at ? Date.parse(r.ended_at) : Date.now()) - Date.parse(r.started_at)))],
        ['Передано', (r) => `<span class="fig">${esc(bytes(r.bytes))}</span>`], ['Решение', (r) => esc(KIND[r.last_kind] || (r.last_lat === null ? 'координаты не передавались' : r.last_kind))],
        ['База', (r) => `<span class="fig">${esc(r.station || '—')}</span>${r.fix && r.fix.bases && r.fix.bases.length > 1 ? ` <small class="adm-note">сменил ${r.fix.bases.length - 1}</small>` : ''}`],
        ['До базы, км', (r) => `<span class="fig">${r.fix && r.fix.km != null ? num(r.fix.km, 1) : '—'}</span>`],
        ['До фикса', (r) => { const f = r.fix || {}; return f.ttf != null ? `<span class="fig ${f.ttf <= 30 ? 'is-online' : (f.ttf <= 120 ? 'is-wait' : 'is-fail')}">${span(f.ttf)}</span>` : (f.float || f.other ? '<span class="is-fail">фикса не было</span>' : '—'); }],
        ['В фиксе', (r) => { const f = r.fix || {}; const all = (f.fixed || 0) + (f.float || 0) + (f.other || 0); return all ? `<span class="fig">${num(100 * (f.fixed || 0) / all, 0)}${NBSP}%</span>` : '—'; }],
        ['Срывов', (r) => `<span class="fig">${r.fix && r.fix.lost != null ? r.fix.lost : '—'}</span>`],
        ['Возраст поправки, с', (r) => `<span class="fig">${r.fix && r.fix.age != null ? `${num(r.fix.age, 1)}${r.fix.ageMax > r.fix.age + 2 ? ` · до ${num(r.fix.ageMax, 0)}` : ''}` : '—'}</span>`],
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
    outages: { title: 'Обрывы связи', needs: [], custom: 'outages', readonly: true },
  };
  const TITLE = { subnets: 'расчётный модуль', stations: 'станция', mountpoints: 'точка', clients: 'клиент', tariffs: 'тариф', subscriptions: 'подписка', ntrip_logins: 'логин', admins: 'администратор', settings: 'настройки', sessions: 'сеанс' };
  const NAV = ['overview', 'stations', 'subnets', 'outages', 'mountpoints', 'clients', 'logins', 'tariffs', 'subscriptions', 'sessions', 'refusals', 'audit', 'admins', 'settings'];

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
    badge.outages = () => (live ? live.stations.filter((x) => x.link.state !== 'online').length || '' : '');
    // Разделы — строка мелких значков без подписей: название видно при наведении
    $('nav').innerHTML = NAV.filter((id) => !VIEWS[id].adminOnly || isAdmin()).map((id) => `<button class="tile" type="button" data-view="${id}" data-tip="view:${id}" aria-current="${id === view}" aria-label="${esc(VIEWS[id].title)}">
      <svg viewBox="0 0 24 24" aria-hidden="true">${ICON[id]}</svg></button>`).join('')
      // Внизу ленты — что показывать на карте: значки-переключатели, без отдельного окна
      + `<span class="adm-ribbon-gap"></span>${SHOW_TILES.map(([id, title, icon]) => `<button class="tile adm-show" type="button" role="switch" data-show="${id}" data-tip="show:${id}" aria-checked="${id === 'base' ? true : id === 'radii' ? SHOW.fix || SHOW.float || SHOW.over : (id === 'cs' ? SHOW.msk || SHOW.sk42 || SHOW.gsk : SHOW[id])}" aria-label="${title}"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></button>`).join('')}`;
  }
  // ---------- Каталог сети слева: станции и расчётного модуля, как в приложении ----------

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
  // Что свёрнуто в каталоге, запоминается: блоки «Станции» и «Расчётного модуля» и состав каждой расчётного модуля
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
    html += head('subnets', 'Расчётные модули', String(lists.subnets.length), '<button class="adm-plus" type="button" data-add="subnet" title="Новый расчётный модуль: обвести контур">+</button>');
    if (!isFolded('subnets')) {
      if (!lists.subnets.length) html += '<div class="rail-empty">Расчётных модулей пока нет.</div>';
      for (const g of lists.subnets) {
        // Состав расчётного модуля раскрывается щелчком по уголку; по умолчанию свёрнут
        const open = isFolded(`open-${g.id}`);
        const state = g.calc_state === 'running' ? 'считается' : `${g.station_ids.length} ст.`;
        html += `<button class="station is-group ${g.calc_state === 'running' ? 'is-online' : ''}" type="button" data-net="${g.id}" aria-current="${view === 'subnets' && sub.id === g.id && !sub.fresh}"><i class="adm-twist" data-fold="open-${g.id}" aria-expanded="${open}"></i><span class="station-name">${esc(g.name)}</span><span class="station-figures">${state}</span><span class="adm-gear" title="Шаги расчётного модуля: контур, расчёт, PPP-AR, привязка">⚙</span></button>`;
        if (open) for (const id of g.station_ids) { const s = all.find((x) => x.id === id); if (s) html += railStation(s, true); }
      }
    }
    // Сети раздачи, выпущенные из расчётных модулей: щелчок открывает шаг «Выпуск» её расчётного модуля
    html += head('networks', 'Сети раздачи', String(lists.networks.length), '<button class="adm-plus" type="button" data-add="network" title="Выпустить новую сеть раздачи">+</button>');
    if (!isFolded('networks')) {
      if (!lists.networks.length) html += '<div class="rail-empty">Сетей пока нет. «+» — выпустить сеть из координат расчётного модуля.</div>';
      for (const n of lists.networks) {
        const on = live ? n.points.filter((p) => { const lp = live.points.find((x) => x.name === p.name); return lp && lp.live; }).length : 0;
        html += `<button class="station is-layer is-net is-shown is-${netTone(recipeOf(n))} ${on ? 'is-online' : ''}" type="button" data-network="${n.id}" aria-current="${net.open && net.id === n.id}" title="${esc(n.title || n.name)}: ${netLabel(recipeOf(n))}"><i class="adm-net-mark"></i><span class="station-name">${esc(n.name)}</span><span class="station-figures">в.${n.version} · ${on}/${n.points.length}</span><span class="adm-gear" title="Открыть сеть: что раздаёт, версии, выпуск">⚙</span></button>`;
      }
    }
    // Слои из файлов KML и DXF: щелчок открывает действия со слоем
    html += head('layers', 'Слои', String(lists.layers.length), '<button class="adm-plus" type="button" data-add="layer" title="Загрузить слой из файла KML или DXF">+</button>');
    if (!isFolded('layers')) {
      if (!lists.layers.length) html += '<div class="rail-empty">Слоёв пока нет. «+» — загрузить KML или DXF.</div>';
      for (const l of lists.layers) {
        html += `<button class="station is-layer ${layersShown.has(l.id) ? 'is-shown' : ''}" type="button" data-layer="${l.id}" aria-current="${tipFor === `layer:${l.id}`}"><i class="adm-layer-mark"></i><span class="station-name">${esc(l.name)}</span><span class="station-figures">${l.logins.length ? `${l.logins.length} лог.` : (l.polygons ? `${l.polygons} конт.` : `${l.lines} лин.`)}</span></button>`;
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
      if (add.dataset.add === 'layer') { $('layer-file').value = ''; $('layer-file').click(); return; }
      if (add.dataset.add === 'network') { openNet(null); return; }
      if (add.dataset.add === 'station') { await open('stations'); openForm(null); }
      else { await open('subnets'); sub.fresh = true; sub.draftFor = undefined; openStep('contour'); }
      return;
    }
    const twist = event.target.closest('[data-fold]');
    if (twist) { fold(twist.dataset.fold); return; }
    const layer = event.target.closest('[data-layer]');
    if (layer) { showTip(layer, `layer:${layer.dataset.layer}`); renderRail(); return; }
    const out = event.target.closest('[data-network]');
    if (out) {
      openNet(Number(out.dataset.network));
      return;
    }
    const group = event.target.closest('[data-net]');
    if (group) { await open('subnets'); sub.fresh = false; sub.id = Number(group.dataset.net); render(); showSteps(document.querySelector(`#rail [data-net="${sub.id}"]`)); return; }
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
    // У расчётных модулей вместе с разделом открывается окно с плитками шагов
    if (tile.dataset.view === 'subnets') open('subnets').then(() => showSteps());
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
    // В разделах сети по центру только карта: списки станций и расчётных модулей — в каталоге слева
    $('list-box').hidden = view === 'overview' || Boolean(v.map);
    $('sub-box').hidden = true;
    $('out-box').hidden = view !== 'outages';
    if (view === 'outages') { $('list-box').hidden = true; return renderOutages(); }
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
    $('list-summary').hidden = !v.summary;
    $('list-summary').innerHTML = v.summary ? v.summary() : '';
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
    ['contours', 'Контуры расчётных модулей', '<path d="M5 8 13 4l6 6-3 9-9-2Z" stroke-dasharray="3 3"/>'],
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
  // выбор: светить гарантированный фикс, объективный или оба.

  const TIP_SHOW = {
    labels: 'Коды станций рядом с точками на карте.',
    grid: 'Градусная сетка поверх карты с подписями широт и долгот.',
    regions: 'Граница Свердловской области — светящейся линией, соседние области — тонким пунктиром с названиями.',
    contours: 'Границы расчётных модулей пунктиром с их именами. Контур, который сейчас правят или обводят, виден всегда.',
    vectors: 'Векторы последнего расчёта расчётного модуля: цвет от красного (метр и хуже) к зелёному (5 мм и лучше).',
    rovers: 'Роверы, которые сейчас подключены и передают своё положение: зелёный — фиксированное решение, жёлтый — плавающее, голубой — дифференциальное, розовый — автономное.',
  };
  let tipFor = null;
  let tipTimer = null;
  function tipHtml(key) {
    const [kind, id] = key.split(':');
    if (kind === 'layer') {
      const l = lists.layers.find((x) => x.id === Number(id));
      if (!l) return '<b>Слой</b><p>Такого слоя уже нет.</p>';
      const chip = (act, text, on) => `<button class="adm-chip" type="button" data-layer-act="${act}" data-id="${l.id}" ${on === undefined ? '' : `aria-current="${on}"`}>${text}</button>`;
      return `<b>${esc(l.name)}</b><p>${l.format.toUpperCase()}${l.crs !== 'wgs84' ? `, ${esc(CRS_NAME[l.crs] || l.crs)}` : ''}: контуров ${l.polygons}, линий ${l.lines}.${l.logins.length ? ` Область работы для логинов: ${esc(l.logins.map((u) => u.login).join(', '))}.` : ''}</p>
        <div class="adm-tip-row">${chip('show', 'Показывать на карте', layersShown.has(l.id))}${chip('zoom', 'Приблизить к слою')}${isAdmin() ? `${chip('logins', l.polygons ? 'Область работы для логинов…' : 'Область работы: в слое нет контуров')}${chip('delete', 'Удалить слой')}` : ''}</div>`;
    }
    if (key === 'view:subnets') {
      // Расчётные модули: выбор расчётного модуля и шага прямо здесь
      const nets = view === 'subnets' ? rows : lists.subnets;
      const row = sub.fresh ? null : nets.find((r) => r.id === sub.id) || null;
      const chips = nets.map((r) => `<button class="adm-chip" type="button" data-sub="${r.id}" aria-current="${Boolean(row) && r.id === row.id}">${esc(r.name)}${r.calc_state === 'running' ? ' ·&nbsp;считается' : ''}</button>`).join('')
        + (isAdmin() ? `<button class="adm-chip" type="button" data-sub="new" aria-current="${!row}">+ новая</button>` : '');
      const steps = Object.entries(STEPS).map(([step, title]) => `<button class="adm-chip adm-step" type="button" data-step="${step}" ${!row && step !== 'contour' ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${STEP_ICON[step]}</svg>${title}</button>`).join('');
      return `<b>Расчётные модули</b><p>${row ? `Выбран ${esc(row.name)}: станций ${row.station_ids.length}.` : 'Новый расчётный модуль начинается с контура.'}</p><div class="adm-chips">${chips}</div><div class="adm-tip-row">${steps}</div>`;
    }
    if (kind === 'view') {
      const c = live ? live.counts : null;
      const more = { stations: () => `На связи ${live.stations.filter((s) => s.link.state === 'online').length} из ${c.stations}.`, subnets: () => `Расчётных модулей: ${lists.subnets.length}. Расчётный модуль — чистый расчёт координат: контур, расчёт, PPP-AR, привязка. Раздачу ведут сети раздачи — отдельный блок в каталоге.`,
        mountpoints: () => `Точек подключения: ${c.mountpoints}.`, clients: () => `Клиентов: ${c.clients}.`, logins: () => `Активных логинов ${c.logins_active} из ${c.logins}.`,
        sessions: () => `Роверов на связи: ${live.clients.length}, сеансов за сегодня: ${c.sessions_today}.`, refusals: () => `Отказов за сутки: ${c.refusals_day}.`,
        outages: () => { const d = out.data; const n = d ? d.stations.reduce((a, x) => a + x.count, 0) : 0; return d ? `За ${periodName(out.hours)}: обрывов ${n}. Журнал хранится в базе и не теряется при перезапуске сервера.` : 'Журнал обрывов связи со станциями.'; } }[id];
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
    return `<b>Зоны покрытия</b><p>Где ровер получит фикс — по расчёту сети, вокруг станций на связи.</p>
      <div class="adm-tip-row">${chip('fix', `Гарантированный фикс${one ? ` · до ${num(one.fix_km, 0)} км` : ''}`, reachColors().fix[0])}${chip('float', `Объективный фикс${one ? ` · до ${num(one.float_km, 0)} км` : ''}`, reachColors().float[0])}${chip('over', 'Перекрытие гарантированного · две базы и больше', reachColors().over[0])}</div>
      <p>${one ? `Гарантированный — фикс есть в любое время суток: по худшему часу за ${one.hours >= 23.5 ? 'сутки' : `последние ${num(one.hours, 0)} ч (сутки ещё копятся)`}, ионосфера ${num(one.worst_ppm, 1)} мм на км. Объективный — фикс прямо сейчас, при ${num(one.iono_ppm, 1)} мм на км. Порог один, разница только во времени суток. Это оценка: роверами в поле она не проверена.` : 'Расчёта сети ещё не было: запустите расчёт в расчётном модуле — зоны появятся вокруг его станций.'}</p>`;
  }
  // key — что показать; по умолчанию берётся у самого элемента
  function showTip(el, key) {
    if (!el) return;
    clearTimeout(tipTimer);
    tipFor = key || el.dataset.tip;
    const tip = $('tip');
    tip.innerHTML = tipHtml(tipFor);
    tip.hidden = false;
    const box = el.getBoundingClientRect();
    tip.style.left = `${box.right + 10}px`;
    tip.style.top = `${Math.max(64, Math.min(box.top - 6, window.innerHeight - tip.offsetHeight - 12))}px`;
  }
  function hideTip() {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(closeTip, 220);
  }
  function closeTip() {
    clearTimeout(tipTimer);
    $('tip').hidden = true;
    tipFor = null;
  }
  // Щелчок мимо (по карте, по панелям) и Esc убирают всплывающее окно; Esc без него закрывает окно шага
  document.addEventListener('mousedown', (event) => {
    if (!$('tip').hidden && !event.target.closest('#tip, #nav, #rail')) closeTip();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || sub.drawing) return;
    if (!$('tip').hidden) { closeTip(); return; }
    if (document.querySelector('dialog[open]:modal')) return;
    if ($('sub-dialog').open) $('sub-dialog').close();
    else if ($('net-dialog') && $('net-dialog').open) $('net-dialog').close();
  });
  $('nav').addEventListener('mouseover', (event) => { const el = event.target.closest('[data-tip]'); if (el && el.dataset.tip !== tipFor) showTip(el); else if (el) clearTimeout(tipTimer); });
  $('nav').addEventListener('mouseleave', hideTip);
  $('tip').addEventListener('mouseenter', () => clearTimeout(tipTimer));
  $('tip').addEventListener('mouseleave', hideTip);
  $('tip').addEventListener('click', async (event) => {
    const pick = event.target.closest('[data-sub]');
    if (pick) {
      sub.fresh = pick.dataset.sub === 'new';
      if (!sub.fresh) sub.id = Number(pick.dataset.sub);
      if (view !== 'subnets') await open('subnets'); else render();
      tipFor = 'view:subnets';
      $('tip').innerHTML = tipHtml(tipFor);
      $('tip').hidden = false;
      return;
    }
    const act = event.target.closest('[data-layer-act]');
    if (act) { await layerAction(act.dataset.layerAct, Number(act.dataset.id)); return; }
    const step = event.target.closest('[data-step]');
    if (step) {
      if (step.disabled) return;
      closeTip();
      if (view !== 'subnets') await open('subnets');
      openStep(step.dataset.step);
      return;
    }
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

  // Расчётные радиусы станций: из самого свежего расчёта расчётного модуля, где станция участвовала
  function radiiNow() {
    const out = {};
    const when = {};
    for (const g of lists.subnets) {
      // Радиус один на расчётный модуль: гарантированный фикс (fix_km) — по худшей ионосфере за сутки,
      // объективный (float_km) — по нынешней
      if (!g.reach) continue;
      const at = Date.parse(g.results_at) || 0;
      const r = { fix_km: g.reach.sure_km, float_km: g.reach.real_km, iono_ppm: g.reach.now_ppm, worst_ppm: g.reach.worst_ppm, hours: g.reach.hours };
      for (const code of g.stations) {
        if (!when[code] || at > when[code]) { out[code] = r; when[code] = at; }
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
    // Подписи идут вдоль своих линий, снизу вверх. У каждой системы своя высота на карте, а ГСК-2011
    // (её линии совпадают с СК-42) подписана с другой стороны линии — так подписи не слипаются
    const rows = { msk: 0.12, sk42: 0.4, gsk: 0.4 };
    for (const l of lines) {
      const color = CS_COLOR[l.sys];
      // ГСК-2011 совпадает по линиям с СК-42: рисуется шире и бледнее, чтобы обе были видны
      const wide = l.sys === 'gsk';
      layers.push(L.polyline([[40, l.lon], [75, l.lon]], { pane: 'cszones', color, weight: wide ? 3 : (l.axis ? 1 : 1.5), opacity: wide ? 0.28 : (l.axis ? 0.6 : 0.9), dashArray: l.axis ? '6 7' : null, interactive: false, className: `adm-cs adm-cs-${l.sys}` }));
      if (l.lon <= b.getWest() || l.lon >= b.getEast()) continue;
      const lat = b.getNorth() - (b.getNorth() - b.getSouth()) * rows[l.sys];
      layers.push(L.marker([lat, l.lon], { pane: 'cszones', interactive: false, icon: L.divIcon({ className: `adm-cs-label adm-cs-${l.sys}`, html: `<span style="color:${color}">${esc(l.text)}</span>`, iconSize: [0, 0], iconAnchor: [0, 0] }) }));
    }
    csZones.layer = L.layerGroup(layers).addTo(map);
  }

  // ---------- Слои из KML и DXF ----------

  const CRS_NAME = { 'wgs84': 'широта и долгота WGS-84', 'msk66-1': 'МСК-66, зона 1', 'msk66-2': 'МСК-66, зона 2', 'msk66-3': 'МСК-66, зона 3' };
  let layersShown = new Set();
  try { layersShown = new Set(JSON.parse(localStorage.getItem('admin-layers') || '[]')); } catch (err) { /* ничего не показано */ }
  const layerGeo = new Map(); // номер слоя -> объекты (подгружаются при первом показе)
  const layerDraw = { layer: null, key: '' };
  const keepShown = () => { try { localStorage.setItem('admin-layers', JSON.stringify([...layersShown])); } catch (err) { /* не запомнится */ } };

  async function layerFeatures(id) {
    if (!layerGeo.has(id)) {
      const res = await api(`/api/admin/layers/${id}`);
      if (!res.ok) return null;
      layerGeo.set(id, res.data.features);
    }
    return layerGeo.get(id);
  }

  function drawLayers() {
    if (!map) return;
    const ids = lists.layers.map((l) => l.id).filter((id) => layersShown.has(id));
    // Геометрия подгружается по мере надобности; как придёт — слой дорисуется
    for (const id of ids) if (!layerGeo.has(id)) layerFeatures(id).then((f) => { if (f) drawLayers(); });
    const ready = ids.filter((id) => layerGeo.has(id));
    const key = ready.join();
    if (key === layerDraw.key) return;
    layerDraw.key = key;
    if (layerDraw.layer) { layerDraw.layer.remove(); layerDraw.layer = null; }
    if (!ready.length) return;
    const pane = map.getPane('layers') || map.createPane('layers');
    pane.style.zIndex = 348;
    const shapes = [];
    for (const id of ready) {
      const name = (lists.layers.find((l) => l.id === id) || {}).name || '';
      for (const f of layerGeo.get(id)) {
        const style = { pane: 'layers', color: '#ff8fd0', weight: 1.6, opacity: 0.95, fillColor: '#ff8fd0', fillOpacity: 0.07, className: 'adm-layer-shape' };
        shapes.push((f.kind === 'polygon' ? L.polygon(f.points, style) : L.polyline(f.points, { ...style, fill: false })).bindTooltip(esc(f.name ? `${name}: ${f.name}` : name), { sticky: true }));
      }
    }
    layerDraw.layer = L.layerGroup(shapes).addTo(map);
  }

  async function layerAction(act, id) {
    const l = lists.layers.find((x) => x.id === id);
    if (!l) return;
    if (act === 'show') {
      if (layersShown.has(id)) layersShown.delete(id); else layersShown.add(id);
      keepShown();
      drawLayers();
      renderRail();
      $('tip').innerHTML = tipHtml(`layer:${id}`);
    } else if (act === 'zoom') {
      const f = await layerFeatures(id);
      if (!f) return;
      layersShown.add(id);
      keepShown();
      drawLayers();
      renderRail();
      window.StationMap.fit(f.flatMap((x) => x.points));
      closeTip();
    } else if (act === 'logins' && l.polygons) {
      closeTip();
      const res = await api('/api/admin/logins');
      if (!res.ok) return;
      const chosen = new Set(l.logins.map((u) => u.id));
      $('area-title').textContent = `Область работы · ${l.name}`;
      $('area-list').innerHTML = res.data.map((u) => `<label class="adm-check"><input type="checkbox" value="${u.id}" ${chosen.has(u.id) ? 'checked' : ''}><span class="fig">${esc(u.login)}</span></label>`).join('') || '<p class="hint">Логинов пока нет: заведите их в разделе «Логины NTRIP».</p>';
      $('area-error').hidden = true;
      $('area-dialog').dataset.id = id;
      $('area-dialog').showModal();
    } else if (act === 'delete') {
      if (!window.confirm(`Удалить слой ${l.name}?${l.logins.length ? ' Логины, для которых он был областью работы, останутся без ограничения.' : ''}`)) return;
      const res = await api(`/api/admin/layers/${id}`, 'DELETE');
      toast(res.ok ? 'Слой удалён.' : res.error, 4000);
      if (res.ok) { layersShown.delete(id); layerGeo.delete(id); keepShown(); lists.layers = lists.layers.filter((x) => x.id !== id); }
      closeTip();
      render();
    }
  }
  $('area-cancel').addEventListener('click', () => $('area-dialog').close());
  $('area-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const ids = [...$('area-list').querySelectorAll('input:checked')].map((x) => Number(x.value));
    const res = await api(`/api/admin/layers/${$('area-dialog').dataset.id}/logins`, 'POST', { login_ids: ids });
    if (!res.ok) { $('area-error').textContent = res.error || 'Сохранить не удалось.'; $('area-error').hidden = false; return; }
    $('area-dialog').close();
    toast(ids.length ? `Область работы задана для логинов: ${ids.length}. Раздача применит её в течение нескольких секунд.` : 'Область работы по этому слою снята со всех логинов.', 6000);
    const list = await api('/api/admin/layers');
    if (list.ok) lists.layers = list.data;
    render();
  });

  // Загрузка файла: разбор идёт в браузере, на сервер уходят уже готовые контуры в широте и долготе
  const upload = { text: '', format: '', parsed: null };
  function parseUpload() {
    const LP = window.LayerParse;
    if (upload.format === 'kml') return LP.parseKml(upload.text);
    const crs = $('layer-crs').value;
    const swap = $('layer-axes').value === 'ne';
    const zone = Number(crs.split('-')[1]);
    return LP.parseDxf(upload.text, (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      if (crs === 'wgs84') return swap ? [x, y] : [y, x];
      const g = window.CoordSys.inverse('msk66', swap ? x : y, swap ? y : x, zone);
      return g ? [g.lat, g.lon] : null;
    });
  }
  function syncUpload() {
    upload.parsed = parseUpload();
    const p = upload.parsed;
    $('layer-summary').textContent = p.features.length ? `В файле найдено: контуров ${p.polygons}, линий ${p.lines}, точек ${p.points}.${p.points >= window.LayerParse.MAX_POINTS * 0.95 ? ' Слишком подробные контуры прорежены.' : ''}`
      : (upload.format === 'dxf' ? 'С такой системой координат объекты не попадают на карту: выберите другую систему или порядок осей.' : 'В файле не найдено ни контуров, ни линий.');
  }
  $('layer-file').addEventListener('change', async () => {
    const file = $('layer-file').files[0];
    if (!file) return;
    upload.format = /\.dxf$/i.test(file.name) ? 'dxf' : 'kml';
    upload.text = await file.text();
    $('layer-name').value = file.name.replace(/\.[^.]+$/, '').slice(0, 80);
    $('layer-crs').innerHTML = Object.entries(CRS_NAME).filter(([k]) => k !== 'msk66-3').map(([k, t]) => `<option value="${k}" ${k === 'msk66-1' ? 'selected' : ''}>${t}</option>`).join('');
    $('layer-crs-box').hidden = upload.format !== 'dxf';
    $('layer-axes-box').hidden = upload.format !== 'dxf';
    $('layer-error').hidden = true;
    syncUpload();
    $('layer-dialog').showModal();
  });
  $('layer-crs').addEventListener('change', syncUpload);
  $('layer-axes').addEventListener('change', syncUpload);
  $('layer-cancel').addEventListener('click', () => $('layer-dialog').close());
  $('layer-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const fail = (text) => { $('layer-error').textContent = text; $('layer-error').hidden = false; };
    if (!upload.parsed || !upload.parsed.features.length) return fail('Загружать нечего: в файле нет объектов, попадающих на карту.');
    const res = await api('/api/admin/layers', 'POST', { name: $('layer-name').value.trim(), format: upload.format, crs: upload.format === 'dxf' ? $('layer-crs').value : 'wgs84', features: upload.parsed.features });
    if (!res.ok) return fail(res.error || 'Загрузить не удалось.');
    $('layer-dialog').close();
    layerGeo.set(res.data.id, upload.parsed.features);
    layersShown.add(res.data.id);
    keepShown();
    lists.layers = [...lists.layers, res.data].sort((a, b) => a.name.localeCompare(b.name));
    toast(`Слой «${res.data.name}» загружен и показан на карте.`, 5000);
    render();
    window.StationMap.fit(upload.parsed.features.flatMap((x) => x.points));
  });

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

  // Слои поверх подложки: радиусы решений вокруг станций на связи, контуры расчётных модулей, роверы
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
    // Выбранная станция: её круги гарантированного и объективного фикса выделяются ярче общей зоны
    const chosen = view === 'stations' && picked ? (rows.find((r) => r.id === picked) || {}).code : null;
    const tone = reachColors();
    const key = JSON.stringify([stations, nets, rovers, SHOW.fix, SHOW.float, SHOW.over, chosen, tone]);
    if (key === overlayKey) return;
    overlayKey = key;
    if (overlay) overlay.remove();
    const layers = [];
    // Сначала широкие круги объективного фикса, поверх — гарантированного
    // Зоны, а не круги: круги каждой зоны сливаются в одно ровное пятно без внутренних границ.
    // Жёлтое — объективный фикс, зелёное поверх — гарантированный, без заливки — сеть не покрывает.
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
      if (SHOW.fix) layers.push(L.circle([lat, lon], { radius: fix * 1000, color: tone.fix[0], weight: 1.8, opacity: 1, fillColor: tone.fix[0], fillOpacity: 0.16, interactive: false, className: 'adm-reach-mine' }).bindTooltip(`${esc(code)}: гарантированный фикс до ${num(fix, 0)} км, объективный до ${num(float, 0)} км`, { permanent: false }));
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
      // Обводка контура расчётного модуля: вершина по щелчку, линия тянется за курсором, двойной щелчок — конец
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
    drawLayers();
    drawZones();
    drawContour();
    drawVectors();
    drawOverlay();
  }

  // Свойства станции сбоку, по щелчку — в том же виде, что в приложении: состояние, положение,
  // спутники по системам, поток, состав потока, журнал.
  // ITRF2014 → ITRF2020 на эпоху year (параметры IERS: сдвиги 1,4; 0,9; −1,4 мм и масштаб
  // 0,42·10⁻⁹ на 2015,0, скорости 0; 0,1; −0,2 мм в год; поворотов нет). Разница — миллиметры.
  function to2020(xyz, year) {
    const dt = year - 2015;
    const t = [0.0014, 0.0009 + 0.0001 * dt, -0.0014 - 0.0002 * dt];
    return xyz.map((v, i) => v + t[i] + 0.42e-9 * v);
  }
  // ITRF2014 на эпоху year → ГСК-2011 (это ITRF2008, закреплённая на эпоху 2011,0). Два шага:
  // перенос на 2011,0 по движению Евразийской плиты (модель ITRF2014: поворот −0,085; −0,531;
  // 0,770 мс дуги в год, около 2,5 см в год на Урале) и переход ITRF2014 → ITRF2008 по параметрам
  // IERS (сдвиги 1,6; 1,9; 2,4 мм и масштаб −0,02·10⁻⁹ на 2010,0). Точность — как у модели плиты:
  // 1–2 мм в год, за пятнадцать лет это 2–3 см.
  const GSK = { a: 6378136.5, f: 1 / 298.2564151 };
  function toGsk2011(xyz, year) {
    const mas = Math.PI / 648000000;
    const w = [-0.085 * mas, -0.531 * mas, 0.770 * mas];
    const dt = year - 2011;
    const v = [w[1] * xyz[2] - w[2] * xyz[1], w[2] * xyz[0] - w[0] * xyz[2], w[0] * xyz[1] - w[1] * xyz[0]];
    const then = xyz.map((c, i) => c - v[i] * dt);
    const t = [0.0016, 0.0019, 0.0024 - 0.0001];
    return then.map((c, i) => c + t[i] + 0.01e-9 * c);
  }
  const yearNow = () => { const now = new Date(); const y = now.getUTCFullYear(); return y + (now - Date.UTC(y, 0, 1)) / (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)); };

  // Что показывает «Положение станции»: система координат, вид высоты и набор координат
  const card = { sys: 'msk66', height: 'ell', set: null };
  try { Object.assign(card, JSON.parse(localStorage.getItem('admin-card') || '{}')); } catch (err) { /* по умолчанию */ }
  const CARD_SYSTEMS = [['msk66', 'МСК-66'], ['sk42', 'СК-42'], ['gsk2011', 'ГСК-2011'], ['utm', 'UTM'], ['llh', 'широта, долгота']];

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

    // Все наборы координат станции: цвет — система, отметка «раздаётся» — что получают роверы.
    // Любой набор можно посмотреть в любой системе координат: щелчок по набору выбирает его,
    // плитки над таблицей — систему и высоту.
    const pos = st ? st.position : null;
    {
      const sets = [];
      const stream = pos && pos.source === 'rtcm' ? pos.ecef : null;
      const cat = row.x !== null ? [row.x, row.y, row.z] : null;
      const itrf = lists.subnets.map((g) => ({ g, a: (g.accepted || {})[row.code] })).filter((x) => x.a);
      // Настоящие координаты ITRF станции в каждой её расчётного модуля: принятые из PPP-AR, иначе среднее
      // PPP-AR по суткам, иначе разовый PPP-AR. Сетевой расчёт сюда идёт, только если его опорная
      // задана в ITRF2014, а не координатами основной сети.
      const isShifted = (g, acc) => { const ref = lists.stations.find((x) => x.id === g.reference_station_id); return acc.quality !== 'ppp' && Boolean(ref) && ref.x !== null && g.ref_x !== null && Math.hypot(ref.x - g.ref_x, ref.y - g.ref_y, ref.z - g.ref_z) < 0.05; };
      const realOf = (g) => {
        const acc = (g.accepted || {})[row.code];
        if (acc && !isShifted(g, acc)) return { v14: [acc.x, acc.y, acc.z], epoch: acc.epoch || null, how: acc.quality === 'ppp' ? `принято из PPP-AR${acc.days ? `, среднее по ${acc.days} сут.` : ', разовый расчёт'}` : 'принято из сетевого расчёта от опорной в ITRF2014' };
        const mean = ((g.ppp_mean || {}).stations || {})[row.code];
        if (mean) return { v14: [mean.x, mean.y, mean.z], epoch: mean.epoch || null, how: `PPP-AR, среднее по ${mean.n} сут., ещё не принято` };
        const once = (((g.ppp_results || {}).stations) || {})[row.code];
        if (once && once.x14 !== undefined) return { v14: [once.x14, once.y14, once.z14], v20: [once.x, once.y, once.z], epoch: (g.ppp_results || {}).epoch || null, how: `PPP-AR, разовый расчёт за ${num(once.hours, 1)} ч, ещё не принято` };
        return null;
      };
      const reals = lists.subnets.filter((g) => g.stations.includes(row.code)).map((g) => ({ g, r: realOf(g) })).filter((x) => x.r);
      const gap = (p, q) => (p && q ? Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) : null);
      const plainPoints = (row.mountpoints || []).filter((name) => !lists.networks.some((n) => n.points.some((p) => p.name === name)));
      // Привязка для перехода между настоящими и смещёнными координатами — из расчётного модуля станции
      const bound = lists.subnets.find((g) => g.stations.includes(row.code) && g.link && g.link.params);
      const link = bound ? bound.link.params : null;
      // Что раздаёт обычная точка станции: поток как пришёл либо координаты каталога
      const served = row.send_catalog && cat ? 'catalog' : 'stream';
      const main = served === 'catalog' ? cat : stream;
      if (stream) {
        const same = gap(stream, cat);
        // Поток считается настоящим ITRF2014, только если он совпал с координатами из PPP-AR и при
        // этом не совпадает с каталогом основной сети. Сетевой расчёт для этого не годится: он
        // наследует систему своей опорной станции и может сам быть смещённым.
        const near = reals.length ? gap(stream, reals[0].r.v14) : null;
        const real = near !== null && near < 0.05 && !(same !== null && same < 0.05);
        const sys = same !== null && same < 0.001 ? 'совпадает с каталогом сети 1' : (real ? 'совпадает с ITRF2014' : (cat ? 'свои координаты базы, с каталогом не совпадают' : 'как передаёт база'));
        sets.push({ id: 'stream', cls: 'is-stream', name: 'Поток базы', sys, v: stream, frame: real ? 'itrf' : 'net1', link, on: served === 'stream' ? plainPoints : [] });
      } else if (pos) {
        sets.push({ id: 'rough', cls: 'is-stream', name: 'По наблюдениям', sys: 'вычислено грубо: в потоке координат станции нет, точность метровая', v: pos.ecef, frame: 'net1', link, on: [], rough: true });
      }
      if (cat) sets.push({ id: 'catalog', cls: 'is-cat', name: 'Каталог · сеть 1', sys: 'смещённые, как раздавал Eagle; для работы в МСК', v: cat, frame: 'net1', link, on: served === 'catalog' ? plainPoints : [] });
      // Сетевой расчёт от опорной с координатами основной сети — отдельным набором: он смещённый
      for (const { g, a: acc } of itrf) {
        if (!isShifted(g, acc)) continue;
        const ref = lists.stations.find((x) => x.id === g.reference_station_id);
        sets.push({ id: `calc-${g.id}`, cls: 'is-net', name: `Расчётный модуль ${g.name} · сетевой расчёт`, sys: `от опорной ${ref.code} с координатами основной сети — результат в её системе, не ITRF`, v: [acc.x, acc.y, acc.z], frame: 'net1', link: g.link && g.link.params ? g.link.params : link, on: [] });
      }
      // ITRF2014 и ITRF2020 — по настоящим координатам станции
      for (const { g, r } of reals) {
        const own = g.link && g.link.params ? g.link.params : link;
        const year = r.epoch || yearNow();
        sets.push({ id: `itrf-${g.id}`, cls: 'is-itrf', name: `ITRF2014 · расчётный модуль ${g.name}`, sys: r.how, v: r.v14, frame: 'itrf', link: own, on: [], epoch: r.epoch });
        const v20 = r.v20 || to2020(r.v14, year);
        sets.push({ id: `itrf20-${g.id}`, cls: 'is-itrf', name: `ITRF2020 · расчётный модуль ${g.name}`, sys: `${r.v20 ? 'как получено в PPP-AR' : 'пересчёт из ITRF2014'}, эпоха ${year.toFixed(2)}; от ITRF2014 отличается на ${num(Math.hypot(...v20.map((c, i) => c - r.v14[i])) * 1000, 1)} мм`, v: v20, frame: 'itrf', link: own, on: [], epoch: r.epoch });
      }
      for (const n of lists.networks) {
        const r = ((n.release || {}).stations || {})[row.code];
        const p = n.points.find((x) => x.station === row.code);
        const made = recipeOf(n);
        if (r && r.x !== undefined) sets.push({ id: `net-${n.id}`, cls: made.coords === 'net1' ? 'is-net' : 'is-itrf', name: `Сеть ${n.name} · версия ${n.version}`, sys: made.coords === 'net1' ? 'согласованные, в системе сети 1' : COORDS[made.coords], v: [r.x, r.y, r.z], frame: frameOf(made), link: n.release.params || link, on: p ? [p.name] : [], epoch: n.release.epoch || null });
      }

      // Положение: выбранный набор в выбранной системе. По умолчанию — то, что раздаётся роверам.
      const set = sets.find((c) => c.id === card.set) || sets.find((c) => c.on.length) || sets[0] || null;
      if (set && window.CoordSys) {
        const sys = EXPORT_SYSTEMS.find((x) => x.id === card.sys) || EXPORT_SYSTEMS.find((x) => x.id === 'msk66');
        const geoid = card.height === 'egm2008';
        if (geoid && !exp.geoid) loadGeoid().then((ok) => { if (ok) renderDetail(); });
        const chips = `<div class="adm-card-pick">${CARD_SYSTEMS.map(([id, name]) => `<button class="adm-chip" type="button" data-card-sys="${id}" aria-current="${id === sys.id}">${name}</button>`).join('')}</div>
          <div class="adm-card-pick">${[['ell', 'над эллипсоидом'], ['egm2008', 'по геоиду Russia2008']].map(([id, name]) => `<button class="adm-chip" type="button" data-card-h="${id}" aria-current="${id === card.height}">${name}</button>`).join('')}</div>`;
        const d = set.rough ? 0 : 3;
        const at = toFrame(set.v, set.frame, sys.frame, set.link);
        const p = at ? inSystem(sys, at, set.epoch) : null;
        let rowsHtml = '';
        let side = '';
        let note = '';
        if (!p) {
          note = `Для системы «${sys.name}» нужны ${sys.frame === 'itrf' ? 'настоящие координаты ITRF2014' : 'координаты в системе основной сети'}, а этот набор — ${set.frame === 'itrf' ? 'ITRF2014' : 'смещённый'}. Перейти от одних к другим можно только привязкой расчётного модуля, а её у станции пока нет.`;
        } else {
          const real = toFrame(set.v, set.frame, 'itrf', set.link) || set.v;
          const g = window.CoordSys.toGeodetic(geoid ? real : at, WGS);
          const n = geoid && exp.geoid ? exp.geoid.undulation(g.lat * 180 / Math.PI, g.lon * 180 / Math.PI) : null;
          const hEll = p.h !== undefined ? p.h : g.h;
          const hText = geoid ? (n === null ? `<dd>${exp.geoid ? 'вне области модели' : 'загружается…'}</dd>` : `<dd class="fig">${num(g.h - n, d)}<span>м по геоиду Russia2008</span></dd>`) : `<dd class="fig">${num(hEll, d)}<span>м над эллипсоидом${sys.id === 'gsk2011' ? ' ГСК-2011' : ''}</span></dd>`;
          if (sys.id === 'llh') {
            const la = dms(p.a, 'lat', set.rough ? 1 : 5);
            const lo = dms(p.b, 'lon', set.rough ? 1 : 5);
            rowsHtml = `<dt>Широта</dt><dd class="fig">${la.text}<span>${la.hemi}</span></dd><dt>Долгота</dt><dd class="fig">${lo.text}<span>${lo.hemi}</span></dd><dt>Высота</dt>${hText}`;
            side = 'ITRF2014';
          } else {
            rowsHtml = `<dt>Север, X</dt><dd class="fig">${num(p.a, d)}<span>м</span></dd><dt>Восток, Y</dt><dd class="fig">${num(p.b, d)}<span>м</span></dd><dt>Высота</dt>${hText}`;
            side = `${sys.name.split(' · ')[0]}, зона ${p.zone}`;
            if (p.loose) note += '<b>Параметры этой зоны с каталогом не сверены</b>: расхождение с каталожными координатами возможно. ';
          }
          if (sys.epoch) note += 'ГСК-2011 закреплена на эпоху 2011,0: координаты перенесены на неё по модели движения Евразийской плиты, точность 2–3 см. ';
          if (set.frame !== sys.frame) note += `Пересчитано привязкой расчётного модуля (${set.frame === 'itrf' ? 'ITRF2014 → основная сеть' : 'основная сеть → ITRF2014'}). `;
          if (geoid && n !== null && set.frame === 'net1' && !set.link) note += 'Высота над эллипсоидом взята от смещённых координат: привязки нет, расхождение около 0,2 м. ';
          if (geoid) note += 'Геоид Russia2008 (EGM2008) — тот же файл, что в TBC. ';
        }
        if (set.id === 'stream' && pos.antennaHeight !== null && pos.antennaHeight !== undefined) note += `Высота антенны ${num(pos.antennaHeight, 4)}${NBSP}м. `;
        parts.push(section(`Положение станции <i class="adm-tone ${set.cls}">${esc(set.name.split(' · ')[0].toLowerCase())}</i>`, side, `${chips}${rowsHtml ? `<dl class="coords">${rowsHtml}</dl>` : ''}${xyz(set.v, set.rough ? 0 : 4)}<p class="source">${note}${sets.length > 1 ? 'Другой набор координат выбирается щелчком в списке ниже.' : ''}</p>`));
      } else {
        parts.push(section('Положение станции', '', `<p class="notice is-plain">${st && st.link.state === 'online' ? 'Координаты станции пока не получены.' : 'Координаты появятся, когда пойдут данные.'}</p>`));
      }

      if (sets.length) {
        parts.push(section('Координаты станции', 'X, Y, Z, м', `<div class="adm-coords">${sets.map((c) => {
          const far = main && c.v !== main ? gap(c.v, main) : null;
          return `<div class="adm-coordset ${c.cls} ${c.on.length ? 'is-served' : ''} ${set && c.id === set.id ? 'is-picked' : ''}" role="button" tabindex="0" data-card-set="${c.id}" title="Показать этот набор в выбранной системе координат"><p><b>${esc(c.name)}</b>${c.on.length ? `<span class="adm-served">раздаётся: ${esc(c.on.join(', '))}</span>` : ''}</p>
            <p class="fig">${Number(c.v[0]).toFixed(c.rough ? 0 : 4)}&ensp;${Number(c.v[1]).toFixed(c.rough ? 0 : 4)}&ensp;${Number(c.v[2]).toFixed(c.rough ? 0 : 4)}</p><p class="adm-coordsys">${esc(c.sys)}${far === null ? '' : ` · ${far < 0.0005 ? 'те же, что раздаются' : `${num(far, far < 1 ? 3 : 2)}${NBSP}м от раздаваемых`}`}</p></div>`;
        }).join('')}</div>${stream && cat && !row.send_catalog && gap(stream, cat) > 0.001 ? `<p class="notice">База шлёт координаты, которые отличаются от каталога сети 1 на ${num(gap(stream, cat), 3)}${NBSP}м, и роверы получают их. Чтобы раздавались прежние, включите в карточке «Раздавать роверам эти координаты».</p>` : ''}`));
      }
    }

    // Связь за сутки: полоса времени и счёт обрывов из журнала
    {
      if (Date.now() - out.at > 30000) loadOutages();
      const o = out.data ? out.data.stations.find((x) => x.code === row.code) : null;
      if (o) parts.push(section(`Связь за ${periodName(out.data.hours)}`, `${share(o.availability)}${NBSP}%`, `${timeline(o, out.data)}<p class="source">${o.count ? `Обрывов: ${o.count}, простой ${span(o.down_s)}, самый долгий ${span(o.longest_s)}.` : 'Обрывов не было.'} Поток: ${esc(o.source)}.</p>`));
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
      if (row.antenna_type) add('Антенна', `${esc(row.antenna_type)} <small class="adm-note">по каталогу; координаты станции — фазовый центр</small>`);
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
    const pick = event.target.closest('[data-card-sys], [data-card-h], [data-card-set]');
    if (pick) {
      if (pick.dataset.cardSys) card.sys = pick.dataset.cardSys;
      if (pick.dataset.cardH) card.height = pick.dataset.cardH;
      if (pick.dataset.cardSet) card.set = pick.dataset.cardSet;
      try { localStorage.setItem('admin-card', JSON.stringify({ sys: card.sys, height: card.height })); } catch (err) { /* не запомнится */ }
      renderDetail();
      return;
    }
    if (event.target.closest('#detail-close')) { picked = null; render(); }
    if (event.target.closest('#detail-edit')) openForm(rows.find((r) => r.id === picked));
    if (event.target.closest('#detail-toggle')) toggleStation(rows.find((r) => r.id === picked));
  });

  // ---------- Статистика фикса ----------
  // Сводка над журналом сеансов: как быстро роверы получают фикс в зависимости от расстояния до базы
  function fixSummaryHtml() {
    const d = lists['fix-stats'];
    if (!d || !d.bins) return '';
    if (!d.sessions) return `<p class="hint">Статистика фикса за ${d.days} дней: сеансов с положением ровера пока нет. Она появится, когда роверы начнут работать: считается время до фикса, доля времени в фиксе и срывы — по расстоянию до базы.</p>`;
    const rowsHtml = d.bins.filter((b) => b.sessions).map((b) => `<tr><td class="fig">${b.to === null ? `от ${b.from}` : `${b.from}–${b.to}`}</td><td class="fig">${b.sessions}</td>
      <td class="fig">${b.ttf_median === null ? '<span class="is-fail">фикса не было</span>' : `<span class="${b.ttf_median <= 30 ? 'is-online' : (b.ttf_median <= 120 ? 'is-wait' : 'is-fail')}">${span(b.ttf_median)}</span>`}</td>
      <td class="fig">${b.ttf_worst === null ? '—' : span(b.ttf_worst)}</td><td class="fig">${b.fixed_share === null ? '—' : `${num(b.fixed_share * 100, 0)}${NBSP}%`}</td>
      <td class="fig">${b.lost_per_hour === null ? '—' : num(b.lost_per_hour, 1)}</td><td class="fig">${b.age === null ? '—' : num(b.age, 1)}</td></tr>`).join('');
    return `<div class="adm-scroll adm-fixstats"><table class="messages srv-table adm-rows adm-static"><thead><tr><th>До базы, км</th><th>Сеансов</th><th>До фикса, обычно</th><th>До фикса, худший</th><th>Времени в фиксе</th><th>Срывов в час фикса</th><th>Возраст поправки, с</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
      <p class="hint">Статистика фикса за ${d.days} дней по ${d.sessions} ${plural(d.sessions, 'сеансу', 'сеансам', 'сеансам')}: считается по сообщениям GGA от роверов; сеансы короче минуты не учитываются.</p>`;
  }

  // ---------- Журнал обрывов связи ----------
  // Обрывы пишет служба приёма, хранит база. Здесь — полосы времени по станциям и список.

  const out = { hours: 24, data: null, at: 0, busy: false };
  const PERIODS = [[24, '24 часа'], [72, '3 дня'], [168, '7 дней'], [720, '30 дней']];
  const periodName = (h) => (PERIODS.find((p) => p[0] === h) || [0, `${h} ч`])[1];
  const span = (sec) => { const v = Math.round(sec); return v < 60 ? `${v}${NBSP}с` : (v < 3600 ? `${Math.floor(v / 60)}${NBSP}мин${v % 60 ? ` ${v % 60}${NBSP}с` : ''}` : `${Math.floor(v / 3600)}${NBSP}ч ${Math.floor((v % 3600) / 60)}${NBSP}мин`); };
  const share = (a) => (a >= 0.99995 ? '100' : num(a * 100, a >= 0.999 ? 3 : 2));

  async function loadOutages(force) {
    if (out.busy || (!force && Date.now() - out.at < 30000)) return;
    out.busy = true;
    const res = await api(`/api/admin/outages?hours=${out.hours}`);
    out.busy = false;
    if (!res.ok) return;
    out.data = res.data;
    out.at = Date.now();
    if (view === 'outages') renderOutages(); else if (view === 'stations' || view === 'subnets') renderDetail();
  }

  // Полоса времени станции: зелёное — на связи, красное — обрыв, серое — не работал сервер
  function timeline(st, d) {
    const t0 = Date.parse(d.from);
    const len = Math.max(Date.parse(d.to) - t0, 1);
    return `<div class="adm-tl">${st.items.map((i) => {
      const a = Math.max(0, (Date.parse(i.from) - t0) / len * 100);
      const w = Math.max(0, Math.min(100 - a, (Date.parse(i.to) - Date.parse(i.from)) / len * 100));
      return `<i class="is-${i.kind}${i.open ? ' is-open' : ''}" style="left:${a.toFixed(3)}%;width:${w.toFixed(3)}%" title="${esc(`${when(i.from)} — ${i.open ? 'до сих пор' : span(i.seconds)}${i.reason ? `: ${i.reason}` : ''}`)}"></i>`;
    }).join('')}</div>`;
  }

  function renderOutages() {
    loadOutages();
    const d = out.data;
    const chips = PERIODS.map(([h, name]) => `<button class="adm-chip" type="button" data-hours="${h}" aria-current="${h === out.hours}">${name}</button>`).join('');
    if (!d) { out.html = ''; $('out-box').innerHTML = `<h2 class="ins-title adm-list-head"><span>Обрывы связи</span><span class="adm-list-tools">${chips}</span></h2><p class="hint">Загружаем журнал…</p>`; return; }
    const on = d.stations.filter((x) => x.enabled);
    const total = on.reduce((a, x) => a + x.count, 0);
    const down = on.reduce((a, x) => a + x.down_s, 0);
    const avail = on.length ? on.reduce((a, x) => a + x.availability, 0) / on.length : 1;
    const worst = [...on].sort((a, b) => b.count - a.count || b.down_s - a.down_s)[0];
    const fig = (value, label, cls) => `<div class="adm-figure glass ${cls || ''}"><b>${value}</b><span>${label}</span></div>`;
    const short = Date.parse(d.to) - Date.parse(d.from) < d.hours * 3600000 - 60000;
    const list = [...on].sort((a, b) => b.count - a.count || b.down_s - a.down_s || a.code.localeCompare(b.code));
    const events = on.flatMap((x) => x.items.filter((i) => i.kind === 'link').map((i) => ({ ...i, code: x.code }))).sort((a, b) => Date.parse(b.from) - Date.parse(a.from)).slice(0, 200);
    const mid = new Date((Date.parse(d.from) + Date.parse(d.to)) / 2).toISOString();
    const html = `<h2 class="ins-title adm-list-head"><span>Обрывы связи</span><span class="adm-list-tools">${chips}</span></h2>
      <div class="adm-figures adm-out-figures">${fig(String(total), `${plural(total, 'обрыв', 'обрыва', 'обрывов')} за ${periodName(d.hours)}`, total ? 'is-warn' : 'is-good')}${fig(down ? span(down) : '0', 'общий простой станций')}
        ${fig(`${share(avail)}${NBSP}%`, 'сеть на связи', avail > 0.999 ? 'is-good' : 'is-warn')}${fig(worst && worst.count ? esc(worst.code) : '—', worst && worst.count ? `чаще всех: ${worst.count}` : 'обрывов нет')}</div>
      ${short ? `<p class="hint">Журнал ведётся с ${when(d.journal_start)}: полосы показывают время с этого момента.</p>` : ''}
      <div class="adm-out">${list.map((x) => `<div class="adm-out-row ${x.open ? 'is-open' : ''}"><span class="fig adm-out-code">${esc(x.code)}</span><span class="adm-src ${x.source === 'напрямую' ? 'is-direct' : ''}">${esc(x.source)}</span>
        ${timeline(x, d)}<span class="fig" title="Обрывов">${x.count || '·'}</span><span class="fig" title="Простой">${x.down_s ? span(x.down_s) : '·'}</span><span class="fig adm-out-share" title="Доля времени на связи">${share(x.availability)}${NBSP}%</span></div>`).join('')}
        <div class="adm-out-row is-axis"><span></span><span></span><div class="adm-tl-axis"><span>${when(d.from)}</span><span>${when(mid)}</span><span>сейчас</span></div><span>обрывов</span><span>простой</span><span>на связи</span></div></div>
      <p class="hint"><i class="adm-key is-link"></i>обрыв связи со станцией <i class="adm-key is-service"></i>не работал сервер приёма (в счёт обрывов станции не идёт) <i class="adm-key is-direct"></i>база шлёт напрямую</p>
      <div class="adm-scroll"><table class="messages srv-table adm-rows adm-static"><thead><tr><th>Начало</th><th>Станция</th><th>Длилось</th><th>Причина</th><th>Откуда шёл поток</th></tr></thead>
        <tbody>${events.map((i) => `<tr><td>${when(i.from)}</td><td><span class="fig">${esc(i.code)}</span></td><td class="fig">${i.open ? '<span class="is-fail">до сих пор</span>' : span(i.seconds)}</td><td>${esc(i.reason || '—')}</td><td>${esc(i.source || '—')}</td></tr>`).join('') || '<tr><td colspan="5">Обрывов за это время не было</td></tr>'}</tbody></table></div>`;
    // Страница перерисовывается только при изменениях: прокрутка списка не сбивается
    if (out.html !== html) { out.html = html; $('out-box').innerHTML = html; }
  }
  $('out-box').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-hours]');
    if (!chip) return;
    out.hours = Number(chip.dataset.hours);
    out.data = null;
    renderOutages();
    loadOutages(true);
  });

  // ---------- Расчётного модуля ----------
  // Шаги выбираются плитками в окне раздела: контур, расчёт, подключение.

  const STEPS = { contour: 'Контур', calc: 'Расчёт', ppp: 'PPP-AR', bind: 'Привязка' };
  const STEP_ICON = {
    contour: '<path d="M5 8 13 4l6 6-3 9-9-2Z"/><circle cx="5" cy="8" r="1.3"/><circle cx="13" cy="4" r="1.3"/><circle cx="19" cy="10" r="1.3"/><circle cx="16" cy="19" r="1.3"/><circle cx="7" cy="17" r="1.3"/>',
    calc: '<circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/><circle cx="12" cy="12" r="1.3"/>',
    ppp: '<circle cx="12" cy="12" r="2.200"/><path d="M12 2v5M12 17v5M4.500 7l4 2.500M15.500 14.500l4 2.500M19.500 7l-4 2.500M8.500 14.500l-4 2.500"/>',
    bind: '<circle cx="7" cy="8" r="2.500"/><circle cx="17" cy="16" r="2.500"/><path d="M9.500 9.500l5 5M4 16h6M7 13v6M14 8h6"/>',
  };
  const QUALITY = { ppp: ['PPP-AR', 'is-online'], reference: ['опорная', ''], fix: ['фиксированное', 'is-online'], float: ['плавающее', 'is-wait'], none: ['нет решения', 'is-fail'] };
  const sub = { id: null, fresh: false, step: 'contour', draft: null, draftFor: undefined, drawing: false, layer: null };
  $('sub-dialog').addEventListener('cancel', () => { sub.drawing = false; });

  const subRow = () => (sub.fresh ? null : rows.find((r) => r.id === sub.id) || null);
  const mm = (v) => (v === null || v === undefined ? '—' : num(v * 1000, Math.abs(v) < 0.1 ? 1 : 0));

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

  // Станции, которые сейчас подсвечены на карте: из открытого окна, иначе из выбранной расчётного модуля
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
  // Оценка расчёта по делу, а не по виду решения: на длинных векторах между базами решение почти
  // всегда плавающее, и это не беда — важно, насколько точен ответ и сходится ли он с сетью.
  // sd — оценка точности, resid — невязка с уравненной сетью, обе в метрах.
  function grade(quality, sd, resid) {
    if (quality === 'reference') return ['опорная', '', 'Координаты заданы: от этой станции считается вся сеть.'];
    if (quality === 'none' || sd === null || sd === undefined) return ['нет решения', 'is-fail', 'Расчёт не получился: мало наблюдений или они плохие.'];
    const off = resid || 0;
    const how = quality === 'fix' ? 'Неоднозначности зафиксированы.' : 'Решение плавающее — для векторов между базами это обычно.';
    if (sd <= 0.02 && off <= 0.03) return ['хорошо', 'is-online', `${how} Точность до 2 см, с сетью сходится до 3 см.`];
    if (sd <= 0.05 && off <= 0.08) return ['терпимо', 'is-wait', `${how} Точность до 5 см или невязка до 8 см: для контроля годится, для координат — нет.`];
    return ['проверить', 'is-fail', `${how} Точность хуже 5 см или невязка больше 8 см: мало наблюдений либо что-то не так со станцией.`];
  }

  // Векторы расчёта на карте: линия от соседа к станции, цвет — точность
  function drawVectors() {
    if (!map) return;
    const has = (r) => r.results && r.results.stations;
    const row = SHOW.vectors && view === 'subnets' && !sub.drawing ? (rows.find((r) => r.id === sub.id && has(r)) || rows.find(has)) : null;
    const where = (code) => { const st = liveOf(code); return st && st.position ? [st.position.lat, st.position.lon] : null; };
    // Линии перерисовываются только при новом расчёте или сдвиге станций: иначе подсказка и
    // закреплённое окно вектора пропадали бы при каждом обновлении состояния
    const key = row ? JSON.stringify([row.id, row.results_at, row.stations.map((c) => (where(c) || []).map((v) => v.toFixed(5)))]) : '';
    if (key === sub.vectorsKey && Boolean(sub.vectors) === Boolean(row)) return;
    sub.vectorsKey = key;
    if (sub.vectors) { sub.vectors.remove(); sub.vectors = null; }
    $('map-legend').hidden = !row;
    if (!row) return;
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
      const line = L.polyline([a, b], { color: qualityColor(q), weight: none ? 1 : 1.3, opacity: none ? 0.5 : 0.9, dashArray: none ? '3 6' : null, lineCap: 'round', interactive: false });
      line.glow = none ? '' : `drop-shadow(0 0 2.5px ${qualityColor(q)})`;
      // Тонкую линию трудно поймать мышью: поверх неё лежит широкая невидимая полоса. Наведение
      // показывает данные вектора, щелчок закрепляет их в окне, пока его не закроют
      const info = `${esc(v.a)} → ${esc(v.b)}: ${num(v.length_km, 1)} км, ${grade(v.quality, v.sd, v.resid)[0]}${v.quality === 'fix' ? ' (фикс)' : ''}${v.sd == null ? '' : `, точность ${mm(v.sd)} мм`}${v.resid == null ? '' : `, невязка ${mm(v.resid)} мм`}${v.closure == null ? '' : `, незамыкание треугольника до ${mm(v.closure)} мм`}${v.minutes ? `, ${v.minutes} мин наблюдений` : ''}`;
      const hit = L.polyline([a, b], { color: '#ffffff', weight: 16, opacity: 0.01, lineCap: 'round' });
      hit.bindTooltip(info, { sticky: true, opacity: 1 });
      hit.bindPopup(`<div class="adm-vec">${info.replace(/, /g, '<br>')}</div>`, { closeButton: true, autoPan: false });
      hit.on('click', () => hit.closeTooltip());
      hit.on('mouseover', () => { if (line._path) line._path.style.strokeWidth = '3px'; });
      hit.on('mouseout', () => { if (line._path) line._path.style.strokeWidth = ''; });
      lines.push(line, hit);
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
    // Контур выбранной расчётного модуля скрывается переключателем «Контуры расчётных модулей»; пока контур правят
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
        const [text, cls, why] = r.quality ? grade(r.quality, sd3(r), r.resid) : ['ждём', '', 'Расчёт ещё не дошёл до этой станции.'];
        const a = acc[code];
        return `<tr><td><span class="fig">${esc(code)}</span></td><td class="fig">${r.vectors === undefined ? '—' : r.vectors}</td>
          <td><i class="adm-grade ${cls}" role="img" aria-label="${text}" title="${esc(`${text[0].toUpperCase()}${text.slice(1)}. ${why}`)}"></i>${r.note ? `<small class="adm-note"> ${esc(r.note)}</small>` : ''}</td><td class="fig">${r.minutes === undefined ? '—' : r.minutes}</td>
          <td class="fig">${r.sd ? `<i class="adm-q" style="background:${qualityColor(sd3(r))}"></i>${mm(sd3(r))}` : '—'}</td><td class="fig">${mm(r.resid)}</td><td class="fig">${mm(r.spread)}</td>
          <td class="fig">${r.x === undefined ? '—' : num(r.x, 4)}</td><td class="fig">${r.y === undefined ? '—' : num(r.y, 4)}</td><td class="fig">${r.z === undefined ? '—' : num(r.z, 4)}</td>
          <td class="fig">${r.shift === undefined || r.shift === null ? '—' : num(r.shift, 3)}</td><td>${a ? `${when(a.at)}` : '—'}</td></tr>`;
      }).join('') || '<tr><td colspan="12">В расчётном модуле нет станций</td></tr>';
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
      }).join('') || '<tr><td colspan="10">В расчётном модуле нет станций</td></tr>';
      // Среднее по суточным расчётам: из него принимаются координаты расчётного модуля
      const mean = row.ppp_mean || { days: [], stations: {} };
      $('sub-daily').textContent = `${row.ppp_daily ? 'Суточный расчёт включён: каждые сутки считаются после 03:00 UTC следующего дня.' : 'Суточный расчёт выключен.'} ${mean.days.length ? `Посчитано суток: ${mean.days.length} (${mean.days[0]} — ${mean.days[mean.days.length - 1]}).` : 'Посчитанных суток пока нет: принять можно разовый расчёт из таблицы ниже.'}`;
      $('sub-mean').innerHTML = row.stations.map((code) => {
        const m = mean.stations[code];
        const a = acc[code];
        const moved = m && a && a.quality === 'ppp' ? Math.hypot(m.x - a.x, m.y - a.y, m.z - a.z) : null;
        return `<tr><td><span class="fig">${esc(code)}</span></td><td class="fig">${m ? `${m.n}${m.dropped ? ` <small class="adm-note">отброшено ${m.dropped}</small>` : ''}` : '—'}</td>
          <td class="fig">${m && m.spread !== null ? `<i class="adm-q" style="background:${qualityColor(m.spread)}"></i>${mm(m.spread)}` : '—'}</td>
          <td class="fig">${m ? num(m.x, 4) : '—'}</td><td class="fig">${m ? num(m.y, 4) : '—'}</td><td class="fig">${m ? num(m.z, 4) : '—'}</td>
          <td>${m ? esc(m.products.map((p) => p.slice(-3)).join(', ')) : '—'}</td>
          <td>${a ? `${a.quality === 'ppp' ? (a.days ? `по ${a.days} сут.` : 'разовый') : 'сетевой расчёт'}, ${when(a.at)}` : '—'}</td>
          <td class="fig">${moved === null ? '—' : `<span class="${moved > 0.02 ? 'is-fail' : ''}">${mm(moved)}</span>`}</td></tr>`;
      }).join('');
    } else if (sub.step === 'bind') {
      const link = row.link || {};
      const resid = link.residuals || {};
      const p = link.params;
      const stale = p && row.accepted_at && Date.parse(row.accepted_at) > Date.parse(link.at);
      $('sub-status').textContent = !p ? 'Привязка ещё не считалась.'
        : `Привязка (${link.mode === 'full' ? 'семь параметров' : 'только сдвиг'}) рассчитана ${when(link.at)} по ${link.used.length} станциям. Средняя квадратическая невязка: в плане ${mm(link.rms_plan)} мм, по высоте ${mm(link.rms_height)} мм.${stale ? ' Координаты расчётного модуля приняты позже — пересчитайте привязку.' : ''}`;
      $('sub-params').innerHTML = p ? [['ΔX, м', num(p.tx, 4)], ['ΔY, м', num(p.ty, 4)], ['ΔZ, м', num(p.tz, 4)], ['ωx, ″', num(p.rx, 6)], ['ωy, ″', num(p.ry, 6)], ['ωz, ″', num(p.rz, 6)], ['m, ppm', num(p.m, 5)]]
        .map(([k, v]) => `<div><dt>${k}</dt><dd class="fig">${v}</dd></div>`).join('') : '';
      body.innerHTML = row.stations.map((code) => {
        const a = acc[code];
        const s = lists.stations.find((x) => x.code === code);
        const has = s && s.x !== null;
        const r = resid[code];
        const shift = a && has ? Math.hypot(s.x - a.x, s.y - a.y, s.z - a.z) : null;
        const flat = r ? Math.hypot(r.e, r.n) : null;
        const why = !a ? 'координаты расчётного модуля не приняты' : (!has ? 'нет координат основной сети' : '');
        return `<tr><td><label class="adm-check"><input type="checkbox" data-bind="${esc(code)}" ${r ? (r.used ? 'checked' : '') : (why ? 'disabled' : 'checked')} ${isAdmin() && !why ? '' : 'disabled'}><span class="fig">${esc(code)}</span></label></td>
          <td class="fig">${shift === null ? `<span class="is-wait">${why}</span>` : num(shift, 3)}</td>
          <td class="fig">${r ? mm(r.e) : '—'}</td><td class="fig">${r ? mm(r.n) : '—'}</td><td class="fig">${r ? mm(r.u) : '—'}</td>
          <td class="fig">${r ? `<i class="adm-q" style="background:${qualityColor(flat)}"></i>${mm(flat)}` : '—'}</td>
          <td>${r ? (r.used ? 'в расчёте' : '<span class="is-wait">не в расчёте</span>') : '—'}</td></tr>`;
      }).join('') || '<tr><td colspan="7">В расчётном модуле нет станций</td></tr>';
    }
  }

  // На странице раздела — карта и список расчётных модулей. Шаги открываются в окнах.
  function renderSubList() {
    if (sub.id !== null && !rows.some((r) => r.id === sub.id)) sub.id = null;
    const state = { idle: 'не запускался', running: '<span class="is-online">идёт</span>', stopped: 'выполнен' };
    $('sub-box').innerHTML = `<h2 class="ins-title adm-list-head"><span>Расчётные модули</span><span class="adm-list-tools"><span class="fig">${rows.length || ''}</span>${isAdmin() ? '<button class="btn btn-primary btn-small" type="button" data-sub="new">Добавить</button>' : ''}</span></h2>
      <p class="hint">Расчётный модуль — чистый расчёт координат. Раздачу ведут сети раздачи, отдельный блок в каталоге. Щелчок по расчётному модулю открывает шаги: контур, расчёт, PPP-AR, привязка.</p>
      <div class="adm-scroll"><table class="messages srv-table adm-rows"><thead><tr><th>Расчётный модуль</th><th>Название</th><th>Станций</th><th>Опорная</th><th>Расчёт</th><th>Принято координат</th><th>Выпущенные сети</th></tr></thead>
      <tbody>${rows.map((r) => `<tr data-sub="${r.id}" aria-selected="${r.id === sub.id && !sub.fresh}"><td><span class="fig">${esc(r.name)}</span></td><td>${esc(r.title || '—')}</td><td class="fig">${r.stations.length}</td>
        <td><span class="fig">${esc(r.reference || '—')}</span></td><td>${state[r.calc_state]}</td><td class="fig">${Object.keys(r.accepted || {}).length}</td><td><span class="fig">${esc(r.networks.map((n) => `${n.name} в.${n.version}`).join(', ') || '—')}</span></td></tr>`).join('') || '<tr><td colspan="7">Расчётных модулей пока нет</td></tr>'}</tbody></table></div>`;
    $('draw-bar').hidden = !sub.drawing;
    if (sub.drawing) $('draw-count').textContent = `Обведите расчётный модуль: щёлкайте по карте, ставя вершины. Двойной щелчок — закончить, Esc — отменить. Вершин: ${sub.draft.contour.length}`;
    drawContour();
  }

  function renderSubnets() {
    renderSubList();
    if ($('sub-dialog').open) renderStep();
  }

  // Вступление шага: одной строкой — зачем он, ниже — что делать по порядку
  const lead = (n, name, text, todo) => `<p class="adm-lead"><b>Шаг ${n} из 4 · ${name}.</b> ${text}</p>${todo ? `<p class="adm-todo">${todo.map((t, i) => `<span><i>${i + 1}</i>${t}</span>`).join('')}</p>` : ''}`;

  // Что делает кнопка: всплывает при наведении
  const HINT = {
    draw: 'Обвести область на карте: щелчки ставят вершины, двойной щелчок заканчивает. Станции внутри отметятся сами.',
    clear: 'Убрать контур. Отмеченные станции останутся.',
    save: 'Сохранить имя, контур и состав расчётного модуля.',
    delete: 'Удалить расчётный модуль со всеми его расчётами. Выпущенные из неё сети раздачи останутся и продолжат работать.',
    compute: 'Один расчёт по наблюдениям за последние 6 часов. Ответ через минуту-две. В раздаче ничего не меняет.',
    start: 'Пересчитывать раз в двадцать минут по последним 6 часам, пока не остановите. Нужно для слежения за сетью и для зон покрытия на карте.',
    stop: 'Остановить пересчёт. Последний ответ останется в таблице.',
    run: 'Показать ход расчёта: этапы и строки по каждому вектору.',
    ref: 'Запомнить опорную станцию и её X, Y, Z. От них считаются координаты всех остальных станций.',
    stream: 'Подставить X, Y, Z, которые опорная станция сейчас передаёт сама. Результат получится в системе основной сети (смещённой).',
    'ref-ppp': 'Подставить координаты опорной из шага «PPP-AR». Результат получится в ITRF2014.',
    accept: 'Сохранить результат этого расчёта как координаты расчётного модуля. Обычно принимают координаты из шага «PPP-AR»: они точнее и не зависят от опорной.',
    'ppp-daily': 'Каждый день считать вчерашние сутки целиком и копить ответы. Через несколько суток среднее даёт точность в миллиметры.',
    'ppp-accept': 'Сохранить среднее по суткам как координаты расчётного модуля в ITRF2014. Дальше они сами не меняются. Из них считается привязка и выпускается сеть.',
    'ppp-run': 'Показать ход последнего расчёта PPP-AR по станциям.',
    'ppp-clear': 'Стереть накопленные сутки, например после переноса антенны. Принятые координаты останутся.',
    'ppp-start': 'Посчитать прямо сейчас по сегодняшним наблюдениям старше трёх часов. Грубее суточного, зато сразу.',
    'ppp-stop': 'Остановить разовый расчёт.',
    'bind-auto': 'Найти станции, у которых сдвиг между сетями одинаковый (в пределах 5 см), и посчитать по ним параметры перехода.',
    'bind-picked': 'Посчитать параметры по станциям, отмеченным галочками в таблице.',
    'bind-catalog': 'Записать в каталог станций координаты, которые они сейчас передают в потоке, там, где каталог пуст. На раздачу не влияет.',
    'bind-copy': 'Скопировать семь параметров текстом — для ввода в контроллер.',
    'release-next': 'Обновить сеть свежими координатами из расчётного модуля. Перед выпуском покажется, на сколько сдвинется каждая станция.',
    'release-del': 'Удалить сеть и её точки подключения. Расчётный модуль и расчёты останутся.',
    close: 'Закрыть окно. Несохранённая правка контура пропадёт.',
    'net-close': 'Закрыть окно сетей раздачи.',
    export: 'Скачать таблицу координат станций: X, Y, Z, широта и долгота, МСК-66, СК-42 или UTM; высота над эллипсоидом или по геоиду Russia2008.',
    'net-export': 'Скачать таблицу координат, которые раздаёт эта сеть, в нужной системе; высота над эллипсоидом или по геоиду Russia2008.',
    'net-reset': 'Вернуть блоки к тому, из чего сеть собрана сейчас. Действующую версию это не трогает.',
    'release-new': 'Создать сеть раздачи по собранной схеме: снимок принятых координат и точки подключения ИМЯ_СТАНЦИЯ.',
    'net-new': 'Перейти к выпуску ещё одной сети. Сетей может быть сколько угодно.',
  };
  // Что значит столбец: всплывает при наведении на заголовок
  const TH_HINT = {
    'Векторов': 'Сколько векторов до соседних станций участвует в расчёте этой станции.',
    'Оценка': 'Насколько расчёту станции можно верить: зелёный квадрат — хорошо, жёлтый — терпимо, красный — проверить, пустой — опорная или ещё считается. Хорошо — точность до 2 см и невязка с сетью до 3 см. Терпимо — до 5 и 8 см. Проверить — хуже. Вид решения (фиксированное или плавающее) здесь не главное: между базами оно почти всегда плавающее. Подробности — при наведении на оценку.',
    'Решение': 'Фиксированное — неоднозначности разрешены, точность миллиметры. Плавающее — не разрешены; точность сантиметры.',
    'Минут': 'Сколько минут наблюдений вошло в расчёт.',
    'Точность, мм': 'Оценка точности координаты после уравнивания сети.',
    'Невязка, мм': 'Насколько худший вектор станции разошёлся с уравненной сетью. Большая невязка — признак плохих наблюдений.',
    'Разброс, мм': 'Насколько ответ менялся между расчётами. Это настоящая точность, в отличие от оценки программы.',
    'С потоком, м': 'Расхождение с координатами, которые станция сейчас передаёт сама.',
    'Принято': 'Какие координаты расчётного модуля сейчас приняты и когда.',
    'Суток': 'Сколько суток вошло в среднее.',
    'Продукты': 'По каким орбитам и часам спутников посчитано: RTS — реального времени, RAP — быстрые (точнее), FIN — окончательные.',
    'Ушла от принятых, мм': 'Насколько новое среднее отличается от принятых координат. Больше 2 см — станция сдвинулась или что-то не так.',
    'С сетевым расчётом, м': 'Расхождение с шагом «Расчёт». Общий сдвиг здесь — это сдвиг координат его опорной станции.',
    'Часов': 'Сколько часов наблюдений вошло в расчёт.',
    'Сдвиг сетей, м': 'Расстояние между координатой станции в основной сети (каталог) и в расчётном модуле (ITRF2014).',
    'Невязка на восток, мм': 'Насколько координата станции в основной сети расходится с пересчитанной из расчётного модуля. У станций в расчёте — сантиметры; у остальных это их несогласованность с сетью.',
    'В плане, мм': 'Невязка в плане: восток и север вместе.',
    'Участие': 'Вошла ли станция в расчёт параметров.',
    'Ждёт выпуска': 'Насколько сдвинутся координаты станций, если выпустить новую версию сейчас.',
    'Порт': 'Порт, к которому подключаются роверы этой сети. 2101 — общий; свой порт показывает только точки этой сети.',
    'Расчётный модуль': 'Из какой расчётного модуля сеть берёт координаты при выпуске. Расчётный модуль можно удалить — сеть продолжит раздавать последний выпуск.',
    'Сдвиг при выпуске, мм': 'Насколько изменится координата этой станции, если выпустить новую версию сейчас.',
    'Точка подключения': 'Имя, которое вводится в ровере.',
    'Состояние': 'Идёт ли по этой точке поток роверам.',
    'Раздаётся': 'Сколько точек сети сейчас отдают поток роверам.',
    'Версия': 'Номер выпуска. Каждый выпуск — отдельный снимок координат, к прежнему можно вернуться.',
    'Что раздаёт': 'В чём координаты базы и идёт ли пересчёт в потоке: «как основная сеть» — в координаты уже внесена привязка; ITRF — координаты расчётного модуля как есть; стрелка показывает, в какую систему ровер пересчитывает сам по сообщениям 1021 и 1025.',
  };
  const hintBox = document.createElement('div');
  hintBox.className = 'adm-tip glass adm-hint';
  hintBox.hidden = true;
  document.body.appendChild(hintBox);
  let hintTimer = null;
  function showHint(el, text) {
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      if (!el.isConnected) return;
      hintBox.textContent = text;
      hintBox.hidden = false;
      const box = el.getBoundingClientRect();
      hintBox.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - hintBox.offsetWidth - 8))}px`;
      hintBox.style.top = `${box.bottom + 7 + hintBox.offsetHeight > window.innerHeight ? box.top - hintBox.offsetHeight - 7 : box.bottom + 7}px`;
    }, 250);
  }
  function hideHint() { clearTimeout(hintTimer); hintBox.hidden = true; }
  $('sub-dialog').addEventListener('mouseover', (event) => {
    const btn = event.target.closest('[data-do]');
    const th = btn ? null : event.target.closest('th');
    const text = btn ? HINT[btn.dataset.do] : (th ? TH_HINT[th.textContent.trim()] : null);
    if (text) showHint(btn || th, text); else hideHint();
  });
  $('sub-dialog').addEventListener('mouseleave', hideHint);
  $('sub-dialog').addEventListener('mousedown', hideHint);
  $('sub-dialog').addEventListener('close', hideHint);

  // Содержимое окна шага
  function renderStep() {
    const row = subRow();
    const key = row ? row.id : 'new';
    if (!sub.draft || sub.draftFor !== key) {
      sub.draft = { name: row ? row.name : '', title: row ? row.title : '', contour: row ? row.contour.map((p) => [...p]) : [], ids: new Set(row ? row.station_ids : []) };
      sub.draftFor = key;
    }
    if (!row || !STEPS[sub.step]) sub.step = 'contour';
    const d = sub.draft;
    const admin = isAdmin();
    let body = '';
    if (sub.step === 'contour') {
      body = `${lead(1, 'Состав расчётного модуля', 'Какие станции считать вместе. Расчётный модуль — чистый расчёт: роверам он ничего не раздаёт, публикация — в блоке «Сети раздачи».', ['Обведите область или отметьте станции', 'Сохраните'])}
        <div class="adm-sub-form"><label class="field"><span>Имя латиницей</span><input id="sub-name" type="text" autocomplete="off" value="${esc(d.name)}" ${admin ? '' : 'disabled'}></label>
          <label class="field"><span>Название</span><input id="sub-title" type="text" autocomplete="off" value="${esc(d.title)}" ${admin ? '' : 'disabled'}></label></div>
        ${admin ? `<div class="adm-actions"><button class="btn btn-quiet btn-small" type="button" data-do="draw">${d.contour.length ? 'Продолжить обводку на карте' : 'Обвести на карте'}</button>
          <button class="btn btn-quiet btn-small" type="button" data-do="clear" ${d.contour.length ? '' : 'disabled'}>Очистить контур</button></div>` : ''}
        <p class="hint">${d.contour.length ? `В контуре углов: ${d.contour.length}. ` : ''}Станции внутри контура отмечаются сами. Состав можно поправить галочками.</p>
        <div class="adm-sub-stations">${lists.stations.map((s) => `<label class="adm-check"><input type="checkbox" data-member="${s.id}" ${d.ids.has(s.id) ? 'checked' : ''} ${admin ? '' : 'disabled'}><span class="fig">${esc(s.code)}</span></label>`).join('')}</div>
        ${admin ? `<div class="dialog-actions">${row ? '<button class="btn btn-quiet btn-danger" type="button" data-do="delete">Удалить расчётный модуль</button>' : ''}<span class="adm-grow"></span>
          <span class="hint">станций: ${d.ids.size}</span><button class="btn btn-primary" type="button" data-do="save">Сохранить</button></div>` : ''}`;
    } else if (sub.step === 'calc') {
      const ref = lists.stations.find((s) => s.id === row.reference_station_id);
      // Координаты опорной: сохранённые, иначе из каталога, иначе из потока самой станции
      const xyz = row.ref_x !== null ? [row.ref_x, row.ref_y, row.ref_z] : (ref && ref.x !== null ? [ref.x, ref.y, ref.z] : ((ref && streamXyz(ref.code)) || ['', '', '']));
      const running = row.calc_state === 'running';
      body = `${lead(2, 'Сетевой расчёт', 'Взаимное положение станций по векторам между ними. Это контроль: показывает, насколько станции согласованы между собой. Координаты получаются в той системе, в которой заданы координаты опорной.', ['Выберите опорную и её координаты', 'Вычислите', 'Сравните столбец «С потоком»'])}
        <div class="adm-sub-form is-ref"><label class="field"><span>Опорная станция</span><select id="sub-ref" ${admin && !running ? '' : 'disabled'}><option value="">— выберите —</option>${row.station_ids.map((id) => { const s = lists.stations.find((x) => x.id === id); return s ? `<option value="${id}" ${id === row.reference_station_id ? 'selected' : ''}>${esc(s.code)}</option>` : ''; }).join('')}</select></label>
          ${['X', 'Y', 'Z'].map((k, i) => `<label class="field adm-coord"><span>${k} опорной, м</span><input id="sub-${k.toLowerCase()}" type="text" inputmode="decimal" autocomplete="off" value="${xyz[i] === '' ? '' : Number(xyz[i]).toFixed(4)}" ${admin && !running ? '' : 'disabled'}></label>`).join('')}</div>
        <p class="hint">Координаты опорной из потока — результат в системе основной сети; из PPP-AR — в ITRF2014.</p>
        ${admin ? `<div class="adm-actions">${running ? '<button class="btn btn-quiet btn-small btn-danger" type="button" data-do="stop">Остановить расчёт</button><button class="btn btn-quiet btn-small" type="button" data-do="run">Ход расчёта</button>' : '<button class="btn btn-primary btn-small" type="button" data-do="compute">Вычислить текущие координаты</button><button class="btn btn-quiet btn-small" type="button" data-do="start">Считать непрерывно</button><button class="btn btn-quiet btn-small" type="button" data-do="ref">Сохранить опорную</button><button class="btn btn-quiet btn-small" type="button" data-do="stream">Взять координаты из потока</button><button class="btn btn-quiet btn-small" type="button" data-do="ref-ppp">Взять опорную из PPP-AR</button>'}
          <button class="btn btn-quiet btn-small" type="button" data-do="accept">Принять координаты</button><button class="btn btn-quiet btn-small" type="button" data-do="export">Таблица координат</button></div>` : ''}
        <p class="hint" id="sub-status"></p>
        <div class="adm-scroll"><table class="messages srv-table adm-rows adm-static"><thead><tr><th>Станция</th><th>Векторов</th><th>Оценка</th><th>Минут</th><th>Точность, мм</th><th>Невязка, мм</th><th>Разброс, мм</th><th>X</th><th>Y</th><th>Z</th><th>С потоком, м</th><th>Принято</th></tr></thead><tbody id="sub-rows"></tbody></table></div>
        `;
    } else if (sub.step === 'ppp') {
      const going = row.ppp_state === 'running';
      body = `${lead(3, 'Координаты в ITRF2014', 'Каждая станция считается сама по себе по точным орбитам спутников, без опорной. Отсюда берутся координаты расчётного модуля.', ['Включите расчёт каждые сутки', 'Подождите несколько суток', 'Примите среднее'])}
        ${admin ? `<div class="adm-actions"><button class="btn ${row.ppp_daily ? 'btn-quiet' : 'btn-primary'} btn-small" type="button" data-do="ppp-daily">${row.ppp_daily ? 'Не считать каждые сутки' : 'Считать каждые сутки'}</button>
          <button class="btn btn-primary btn-small" type="button" data-do="ppp-accept">Принять координаты PPP-AR</button><button class="btn btn-quiet btn-small" type="button" data-do="ppp-run">Ход расчёта</button><button class="btn btn-quiet btn-small" type="button" data-do="export">Таблица координат</button>
          <button class="btn btn-quiet btn-small btn-danger" type="button" data-do="ppp-clear">Стереть накопленное</button></div>` : ''}
        <p class="hint" id="sub-daily"></p>
        <div class="adm-scroll"><table class="messages srv-table adm-rows adm-static"><thead><tr><th>Станция</th><th>Суток</th><th>Разброс, мм</th><th>X среднее (ITRF2014)</th><th>Y</th><th>Z</th><th>Продукты</th><th>Принято</th><th>Ушла от принятых, мм</th></tr></thead><tbody id="sub-mean"></tbody></table></div>
        <p class="hint">Ниже — разовый расчёт за часть сегодняшних суток: для быстрой прикидки, пока суточные копятся.</p>
        ${admin ? `<div class="adm-actions">${going ? '<button class="btn btn-quiet btn-small btn-danger" type="button" data-do="ppp-stop">Остановить разовый расчёт</button>' : '<button class="btn btn-quiet btn-small" type="button" data-do="ppp-start">Разовый расчёт сейчас</button>'}</div>` : ''}
        <p class="hint" id="sub-status"></p>
        <div class="adm-scroll"><table class="messages srv-table adm-rows adm-static"><thead><tr><th>Станция</th><th>Решение</th><th>Часов</th><th>Точность, мм</th><th>X (ITRF2014)</th><th>Y</th><th>Z</th><th>С потоком, м</th><th>С сетевым расчётом, м</th><th>Продукты</th></tr></thead><tbody id="sub-rows"></tbody></table></div>
        `;
    } else if (sub.step === 'bind') {
      body = `${lead(4, 'Привязка к основной сети', 'На сколько основная сеть сдвинута относительно ITRF2014. С этими параметрами ровер на новой сети получает те же МСК, что и раньше, но одинаково от любой базы.', ['Рассчитайте привязку', 'Проверьте невязки станций', 'Дальше — «Сети раздачи» в каталоге: «+» выпускает сеть из этих координат'])}
        ${admin ? `<div class="adm-actions"><select class="adm-pick" id="bind-mode" title="Вид привязки"><option value="shift">Только сдвиг (ΔX, ΔY, ΔZ)</option><option value="full" ${row.link && row.link.mode === 'full' ? 'selected' : ''}>Все семь параметров</option></select><button class="btn btn-primary btn-small" type="button" data-do="bind-auto">Рассчитать привязку</button><button class="btn btn-quiet btn-small" type="button" data-do="bind-picked">Пересчитать по отмеченным</button>
          <button class="btn btn-quiet btn-small" type="button" data-do="bind-catalog">Запомнить координаты основной сети из потоков</button><button class="btn btn-quiet btn-small" type="button" data-do="bind-copy">Скопировать параметры</button><button class="btn btn-quiet btn-small" type="button" data-do="export">Таблица координат</button></div>` : ''}
        <p class="hint" id="sub-status"></p>
        <dl class="adm-params" id="sub-params"></dl>
        <div class="adm-scroll"><table class="messages srv-table adm-rows adm-static"><thead><tr><th>Станция</th><th>Сдвиг сетей, м</th><th>Невязка на восток, мм</th><th>На север, мм</th><th>По высоте, мм</th><th>В плане, мм</th><th>Участие</th></tr></thead><tbody id="sub-rows"></tbody></table></div>
        <p class="hint">«Только сдвиг» — повороты и масштаб нулевые, в контроллер вводятся те же семь чисел. Формула по ГОСТ 32453 (поворот системы координат); в программах с обратным знаком поворота углы вводятся с минусом.</p>`;
    }
    sub.seenState = row ? row.calc_state : null;
    sub.seenPpp = row ? row.ppp_state : null;
    $('sub-dialog').classList.toggle('adm-wide', sub.step !== 'contour');
    $('sub-head').textContent = row ? row.name : 'Новый расчётный модуль';
    // Шаги — тут же, в шапке окна: переход без возврата к выбору
    $('sub-jumps').innerHTML = Object.entries(STEPS).map(([step, title]) => `<button class="adm-chip" type="button" data-jump="${step}" aria-current="${step === sub.step}" ${!row && step !== 'contour' ? 'disabled' : ''}>${title}</button>`).join('');
    $('sub-body').innerHTML = body;
    subLive();
  }

  function openStep(step) {
    sub.step = step;
    try { localStorage.setItem('admin-sub-step', step); } catch (err) { /* не запомнится */ }
    sub.drawing = false;
    if (!$('sub-dialog').open) $('sub-dialog').show();
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

  // Список на странице: щелчок по расчётному модулю — окно с шагами, «Добавить» — сразу контур новой
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
    const jump = event.target.closest('[data-jump]');
    if (jump) { if (!jump.disabled) openStep(jump.dataset.jump); return; }
    const btn = event.target.closest('[data-do]');
    if (!btn) return;
    const row = subRow();
    const d = sub.draft;
    const act = btn.dataset.do;
    if (act === 'close') { $('sub-dialog').close(); return; }
    if (act === 'export') { openExport(subnetSources(row), row.name); return; }
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
      const saved = await subCall(row ? `/api/admin/subnets/${row.id}` : '/api/admin/subnets', row ? 'PATCH' : 'POST', body, 'Расчётный модуль сохранён.');
      if (saved) { sub.fresh = false; sub.id = saved.id; sub.draftFor = undefined; }
    } else if (act === 'delete') {
      if (!window.confirm(`Удалить расчётный модуль ${row.name}? Его расчёты и принятые координаты удалятся. Выпущенные из него сети раздачи останутся и продолжат работать.`)) return;
      if (await subCall(`/api/admin/subnets/${row.id}`, 'DELETE', undefined, 'Расчётный модуль удалён.') !== null) { sub.id = null; $('sub-dialog').close(); return; }
    } else if (act === 'ref' || act === 'start' || act === 'compute') {
      const ref = Number($('sub-ref').value) || null;
      const saved = await subCall(`/api/admin/subnets/${row.id}`, 'PATCH', { reference_station_id: ref, ref_x: coordOf('sub-x'), ref_y: coordOf('sub-y'), ref_z: coordOf('sub-z') }, act === 'ref' ? 'Опорная станция сохранена.' : '');
      const begun = saved ? (act === 'start' ? await subCall(`/api/admin/subnets/${row.id}/start`, 'POST', {}, '') : (act === 'compute' ? await subCall(`/api/admin/subnets/${row.id}/compute`, 'POST', {}, '') : null)) : null;
      if (begun) { render(); openRun(row.id, row.name); return; }
    } else if (act === 'stop') {
      await subCall(`/api/admin/subnets/${row.id}/stop`, 'POST', {}, 'Расчёт остановлен. Последний ответ сохранён.');
    } else if (act === 'accept') {
      if (!window.confirm('Принять координаты всех станций, у которых есть решение? Точки подключения расчётного модуля начнут раздавать их сразу.')) return;
      await subCall(`/api/admin/subnets/${row.id}/accept`, 'POST', {}, 'Координаты приняты.');
    } else if (act === 'ref-ppp') {
      // Координаты опорной — из PPP-AR: среднее по суткам, иначе последний разовый расчёт
      const s = lists.stations.find((x) => x.id === Number($('sub-ref').value));
      const m = s ? (row.ppp_mean.stations[s.code] || (((row.ppp_results || {}).stations || {})[s.code])) : null;
      const got = m ? (m.x14 !== undefined ? [m.x14, m.y14, m.z14] : [m.x, m.y, m.z]) : null;
      if (!got || got[0] === undefined) { toast(s ? `По станции ${s.code} расчёта PPP-AR пока нет.` : 'Сначала выберите опорную станцию.', 5000); return; }
      ['x', 'y', 'z'].forEach((k, i) => { $(`sub-${k}`).value = Number(got[i]).toFixed(4); });
      toast('Координаты подставлены. Нажмите «Сохранить опорную».', 4000);
      return;
    } else if (act === 'ppp-daily') {
      await subCall(`/api/admin/subnets/${row.id}/ppp/daily`, 'POST', { on: !row.ppp_daily }, row.ppp_daily ? 'Суточный расчёт выключен. Накопленное сохранено.' : 'Суточный расчёт включён.');
    } else if (act === 'ppp-clear') {
      if (!window.confirm('Стереть все накопленные суточные расчёты расчётного модуля? Принятые координаты останутся.')) return;
      await subCall(`/api/admin/subnets/${row.id}/ppp/clear`, 'POST', {}, 'Накопленные расчёты стёрты.');
    } else if (act === 'ppp-accept') {
      const days = row.ppp_mean.days.length;
      if (!window.confirm(`Принять координаты расчётного модуля из PPP-AR (${days ? `среднее по суткам: ${days}` : 'разовый расчёт'})? Точки подключения расчётного модуля начнут раздавать их сразу.`)) return;
      await subCall(`/api/admin/subnets/${row.id}/ppp/accept`, 'POST', {}, 'Координаты приняты. Если привязка уже считалась — пересчитайте её.');
    } else if (act === 'bind-auto' || act === 'bind-picked') {
      const picked = [...document.querySelectorAll('[data-bind]')].filter((x) => x.checked).map((x) => x.dataset.bind);
      await subCall(`/api/admin/subnets/${row.id}/link`, 'POST', act === 'bind-auto' ? { mode: $('bind-mode').value } : { mode: $('bind-mode').value, stations: picked }, 'Привязка рассчитана.');
    } else if (act === 'bind-catalog') {
      // Координаты основной сети — те, что станции сейчас передают в потоке; записываются в каталог там, где он пуст
      let done = 0;
      for (const code of row.stations) {
        const s = lists.stations.find((x) => x.code === code);
        const got = s && s.x === null ? streamXyz(code) : null;
        if (!got) continue;
        const res = await api(`/api/admin/stations/${s.id}`, 'PATCH', { x: Number(got[0].toFixed(4)), y: Number(got[1].toFixed(4)), z: Number(got[2].toFixed(4)), coords_note: 'из потока станции' });
        if (res.ok) done++;
      }
      const list = await api('/api/admin/stations');
      if (list.ok) lists.stations = list.data;
      toast(done ? `Координаты записаны в каталог: станций ${done}.` : 'Записывать нечего: в каталоге координаты уже есть либо станции их не передают.', 5000);
    } else if (act === 'bind-copy') {
      const p = row.link && row.link.params;
      if (!p) { toast('Привязка ещё не считалась.', 4000); return; }
      const text = `Расчётный модуль ${row.name} -> основная сеть (ГОСТ 32453, поворот системы координат)\nDX ${p.tx} м\nDY ${p.ty} м\nDZ ${p.tz} м\nwx ${p.rx}"\nwy ${p.ry}"\nwz ${p.rz}"\nm ${p.m} ppm`;
      try { await navigator.clipboard.writeText(text); toast('Параметры скопированы.', 3000); } catch (err) { toast(text, 12000); }
      return;
    }
    render();
  });

  // ---------- Таблицы координат ----------
  // Координаты станций в выбранной системе и с выбранной высотой — файлом CSV. Считается в окне:
  // тем же модулем систем координат, что и карточка станции, и модулем геоида EGM2008.
  // У набора точек есть «рамка»: itrf — настоящие координаты ITRF2014, net1 — смещённые, как в
  // основной сети. Плоские системы (МСК-66, СК-42) считаются из net1, UTM и широта с долготой —
  // из itrf; переход между рамками — привязкой расчётного модуля, без неё недоступная система гаснет.

  const WGS = { a: 6378137, f: 1 / 298.257223563 };
  const EXPORT_SYSTEMS = [
    { id: 'xyz-itrf', name: 'X, Y, Z · ITRF2014', frame: 'itrf', kind: 'xyz' },
    { id: 'xyz-itrf20', name: 'X, Y, Z · ITRF2020', frame: 'itrf', kind: 'xyz', to2020: true },
    { id: 'xyz-net1', name: 'X, Y, Z · основная сеть (смещённые)', frame: 'net1', kind: 'xyz' },
    { id: 'llh', name: 'Широта, долгота · ITRF2014 (WGS-84)', frame: 'itrf', kind: 'llh' },
    { id: 'msk66', name: 'МСК-66 · зоны по 6°', frame: 'net1', kind: 'plane' },
    { id: 'sk42', name: 'СК-42 · Гаусса — Крюгера, зоны по 6°', frame: 'net1', kind: 'plane' },
    { id: 'utm', name: 'UTM · WGS-84', frame: 'itrf', kind: 'plane' },
    { id: 'gsk2011', name: 'ГСК-2011 · Гаусса — Крюгера, зоны по 6°', frame: 'itrf', kind: 'plane', epoch: true },
    { id: 'xyz-gsk', name: 'X, Y, Z · ГСК-2011', frame: 'itrf', kind: 'xyz', epoch: true },
  ];
  const exp = { sources: [], name: '', geoid: null, asked: false };
  const expDialog = document.createElement('dialog');
  expDialog.className = 'dialog adm-dialog adm-export';
  document.body.appendChild(expDialog);

  // Привязка расчётного модуля в записи модуля пересчёта и обратный ход (углы малы: достаточно одного шага)
  const linkOf = (p) => ({ dx: p.tx, dy: p.ty, dz: p.tz, rx: p.rx, ry: p.ry, rz: p.rz, scale: p.m });
  function toFrame(xyz, from, to, link) {
    if (from === to) return xyz;
    // Координаты, уже перенесённые в ГСК-2011, обратно в ITRF здесь не возвращаются
    if (from === 'gsk' || to === 'gsk') return null;
    if (!link || !window.Transform) return null;
    const L = linkOf(link);
    if (to === 'net1') return window.Transform.apply(L, xyz);
    const there = window.Transform.apply(L, xyz);
    return xyz.map((v, i) => v - (there[i] - v));
  }
  // Одна точка в выбранной системе: { a, b, zone } — первые две координаты; null — посчитать не из чего
  // year — эпоха координат: нужна системам, закреплённым на свою эпоху (ГСК-2011)
  function inSystem(sys, xyz, year) {
    const C = window.CoordSys;
    if (sys.id === 'xyz-gsk') { const g = toGsk2011(xyz, year || yearNow()); return { a: g[0], b: g[1], c: g[2] }; }
    if (sys.id === 'gsk2011') {
      const g = C.toGeodetic(toGsk2011(xyz, year || yearNow()), GSK);
      const zone = Math.floor((g.lon * 180 / Math.PI) / 6) + 1;
      const p = C.gaussKruger(g.lat, g.lon - (zone * 6 - 3) * Math.PI / 180, GSK);
      // h — высота над эллипсоидом ГСК-2011: он на полметра меньше общеземного
      return { a: p.north, b: p.east + zone * 1e6 + 500000, zone, h: g.h };
    }
    if (sys.kind === 'xyz') return { a: xyz[0], b: xyz[1], c: xyz[2] };
    if (sys.id === 'llh') { const g = C.toGeodetic(xyz, WGS); return { a: g.lat * 180 / Math.PI, b: g.lon * 180 / Math.PI }; }
    if (sys.id === 'msk66') { const p = C.convert('msk66', xyz); return p ? { a: p.north, b: p.east, zone: p.zone, loose: !p.verified } : null; }
    if (sys.id === 'sk42') {
      const g = C.toGeodetic(C.fromWgs84(xyz, C.DATUMS.sk42), C.ELLIPSOIDS.krass);
      const zone = Math.floor((g.lon * 180 / Math.PI) / 6) + 1;
      const p = C.gaussKruger(g.lat, g.lon - (zone * 6 - 3) * Math.PI / 180, C.ELLIPSOIDS.krass);
      return { a: p.north, b: p.east + zone * 1e6 + 500000, zone };
    }
    const g = C.toGeodetic(xyz, WGS);
    const zone = Math.floor((g.lon * 180 / Math.PI + 180) / 6) + 1;
    const p = C.gaussKruger(g.lat, g.lon - (zone * 6 - 183) * Math.PI / 180, WGS);
    return { a: p.north * 0.9996, b: p.east * 0.9996 + 500000, zone };
  }

  // Строки таблицы по выбору в окне: { head, rows, notes }
  function exportTable() {
    const src = exp.sources.find((x) => x.id === $('exp-source').value) || exp.sources[0];
    const sys = EXPORT_SYSTEMS.find((x) => x.id === $('exp-system').value);
    const geoid = $('exp-height').value === 'egm2008';
    const notes = [];
    const rows = [];
    for (const pt of src.points) {
      const at = toFrame(pt.xyz, src.frame, sys.frame, src.link);
      if (!at) continue;
      const xyz = sys.to2020 ? to2020(at, pt.epoch || yearNow()) : at;
      const p = inSystem(sys, xyz, pt.epoch);
      if (!p) continue;
      // Высота: над эллипсоидом — в той же рамке, что координаты; по геоиду — всегда от настоящей высоты ITRF
      const real = toFrame(pt.xyz, src.frame, 'itrf', src.link) || pt.xyz;
      const g = window.CoordSys.toGeodetic(geoid ? real : xyz, WGS);
      let h = p.h !== undefined && !geoid ? p.h : g.h;
      if (geoid) {
        const n = exp.geoid ? exp.geoid.undulation(g.lat * 180 / Math.PI, g.lon * 180 / Math.PI) : null;
        if (n === null) continue;
        h -= n;
      }
      if (p.loose && !notes.includes('zone')) notes.push('zone');
      rows.push({ code: pt.code, ...p, h });
    }
    const hName = geoid ? 'H по Russia2008, м' : 'H над эллипсоидом, м';
    const d = sys.id === 'llh' ? 9 : 4;
    const head = sys.kind === 'xyz' ? ['Станция', 'X, м', 'Y, м', 'Z, м'] : (sys.id === 'llh' ? ['Станция', 'Широта, °', 'Долгота, °', hName] : ['Станция', 'Север (X), м', 'Восток (Y), м', hName, 'Зона']);
    const cells = rows.map((r) => (sys.kind === 'xyz' ? [r.code, r.a.toFixed(4), r.b.toFixed(4), r.c.toFixed(4)]
      : (sys.id === 'llh' ? [r.code, r.a.toFixed(d), r.b.toFixed(d), r.h.toFixed(4)] : [r.code, r.a.toFixed(4), r.b.toFixed(4), r.h.toFixed(4), String(r.zone)])));
    const about = [`Uralsurvey: ${exp.name}`, `Источник: ${src.name}`, `Система: ${sys.name}`];
    if (sys.kind !== 'xyz') about.push(geoid ? 'Высота: над геоидом Russia2008 (модель EGM2008, сетка 1 минута, тот же файл, что в TBC)' : 'Высота: над эллипсоидом');
    if (sys.epoch) about.push(`ГСК-2011 закреплена на эпоху 2011,0: координаты перенесены на неё по модели движения Евразийской плиты (ITRF2014), точность 2–3 см`);
    if (sys.to2020) about.push(`ITRF2020 получена из ITRF2014 по параметрам IERS на эпоху ${(src.points[0] && src.points[0].epoch ? src.points[0].epoch : yearNow()).toFixed(2)}: отличие — миллиметры`);
    if (src.frame !== sys.frame) about.push(`Пересчёт привязкой расчётного модуля: ΔX ${src.link.tx}, ΔY ${src.link.ty}, ΔZ ${src.link.tz} м${src.link.rx || src.link.ry || src.link.rz || src.link.m ? `, повороты ${src.link.rx}; ${src.link.ry}; ${src.link.rz}″, масштаб ${src.link.m} ppm` : ''}`);
    if (geoid && sys.kind !== 'xyz' && src.frame === 'net1' && !src.link) about.push('Внимание: высота над эллипсоидом взята от смещённых координат основной сети — привязки расчётного модуля нет, поправить нечем (расхождение около 0,2 м)');
    if (notes.includes('zone')) about.push('Внимание: параметры зон 2 и 3 МСК-66 с каталогом не сверены');
    about.push(`Выгружено: ${new Date().toLocaleString('ru-RU')}`);
    return { src, sys, geoid, head, cells, about, skipped: src.points.length - rows.length };
  }

  function exportLive() {
    const src = exp.sources.find((x) => x.id === $('exp-source').value) || exp.sources[0];
    // Система, для которой у источника нет привязки, недоступна
    for (const option of $('exp-system').options) {
      const sys = EXPORT_SYSTEMS.find((x) => x.id === option.value);
      option.disabled = sys.frame !== src.frame && !src.link;
      option.textContent = option.disabled ? `${sys.name} — нужна привязка расчётного модуля` : sys.name;
    }
    if ($('exp-system').selectedOptions[0].disabled) $('exp-system').value = [...$('exp-system').options].find((o) => !o.disabled).value;
    const xyzOnly = EXPORT_SYSTEMS.find((x) => x.id === $('exp-system').value).kind === 'xyz';
    $('exp-height').disabled = xyzOnly;
    const t = exportTable();
    $('exp-preview').innerHTML = `<thead><tr>${t.head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${t.cells.slice(0, 6).map((r) => `<tr>${r.map((c, i) => `<td class="${i ? 'fig' : ''}">${i ? esc(c) : `<span class="fig">${esc(c)}</span>`}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${t.head.length}">Точек нет</td></tr>`}</tbody>`;
    $('exp-note').textContent = `Точек: ${t.cells.length}${t.cells.length > 6 ? ', показаны первые шесть' : ''}.${t.skipped ? ` Не вошло: ${t.skipped} (вне области геоида или без координат).` : ''} ${t.geoid && !xyzOnly ? 'Геоид Russia2008 — тот же файл, что в TBC.' : ''}`;
  }

  // Сетка геоида подгружается один раз, когда впервые понадобилась
  async function loadGeoid() {
    if (exp.geoid) return true;
    if (!window.Geoid) return false;
    if (!exp.loading) {
      exp.loading = fetch('/modules/geoid/russia2008-ural.json').then((r) => r.json()).then((grid) => { exp.geoid = window.Geoid.create(grid); return true; }).catch(() => { exp.loading = null; return false; });
    }
    return exp.loading;
  }

  async function openExport(sources, name) {
    exp.sources = sources.filter((x) => x.points.length);
    exp.name = name;
    if (!exp.sources.length) { toast('Выгружать нечего: координат пока нет.', 5000); return; }
    expDialog.innerHTML = `<form method="dialog" novalidate><h2>Таблица координат · ${esc(name)}</h2>
      <label class="field"><span>Какие координаты</span><select id="exp-source">${exp.sources.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Система координат</span><select id="exp-system">${EXPORT_SYSTEMS.map((x) => `<option value="${x.id}">${x.name}</option>`).join('')}</select></label>
      <label class="field"><span>Высота</span><select id="exp-height"><option value="ell">Над эллипсоидом</option><option value="egm2008">По геоиду Russia2008</option></select></label>
      <label class="adm-check"><input type="checkbox" id="exp-about" checked><span>Шапка с описанием в начале файла</span></label>
      <div class="adm-scroll"><table class="messages srv-table adm-rows adm-static" id="exp-preview"></table></div>
      <p class="hint" id="exp-note"></p>
      <div class="dialog-actions"><button class="btn btn-quiet" type="button" data-exp="close">Закрыть</button><button class="btn btn-quiet" type="button" data-exp="copy">Скопировать</button><button class="btn btn-primary" type="button" data-exp="save">Скачать CSV</button></div></form>`;
    try { const last = JSON.parse(localStorage.getItem('admin-export') || '{}'); if (last.system) $('exp-system').value = last.system; if (last.height) $('exp-height').value = last.height; } catch (err) { /* по умолчанию */ }
    if (!expDialog.open) expDialog.showModal();
    await loadGeoid();
    if (!exp.geoid) { $('exp-height').querySelector('[value="egm2008"]').disabled = true; $('exp-height').value = 'ell'; }
    exportLive();
  }
  expDialog.addEventListener('change', exportLive);
  expDialog.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-exp]');
    if (!btn) return;
    if (btn.dataset.exp === 'close') { expDialog.close(); return; }
    const t = exportTable();
    try { localStorage.setItem('admin-export', JSON.stringify({ system: t.sys.id, height: t.geoid ? 'egm2008' : 'ell' })); } catch (err) { /* не запомнится */ }
    const body = [t.head, ...t.cells].map((r) => r.join(';')).join('\r\n');
    const text = `${$('exp-about').checked ? `${t.about.map((line) => `# ${line}`).join('\r\n')}\r\n` : ''}${body}\r\n`;
    if (btn.dataset.exp === 'copy') {
      try { await navigator.clipboard.writeText(text); toast('Таблица скопирована.', 3000); } catch (err) { toast('Буфер обмена недоступен: скачайте файл.', 5000); }
      return;
    }
    const link = document.createElement('a');
    // Метка в начале файла — чтобы Excel открыл русские буквы без подсказок
    link.href = URL.createObjectURL(new Blob(['\ufeff', text], { type: 'text/csv;charset=utf-8' }));
    link.download = `${exp.name}_${t.sys.id}${t.geoid && t.sys.kind !== 'xyz' ? '_egm2008' : ''}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    toast(`Файл ${link.download} скачан.`, 4000);
  });

  // Наборы координат расчётного модуля, которые можно выгрузить
  function subnetSources(row) {
    const link = row.link && row.link.params ? row.link.params : null;
    const acc = Object.entries(row.accepted || {});
    const mean = Object.entries((row.ppp_mean || {}).stations || {});
    const once = Object.entries(((row.ppp_results || {}).stations) || {}).filter(([, r]) => r.x14 !== undefined);
    const cat = row.stations.map((code) => lists.stations.find((s) => s.code === code)).filter((s) => s && s.x !== null);
    return [
      { id: 'accepted', name: 'Принятые координаты расчётного модуля (ITRF2014)', frame: 'itrf', link, points: acc.map(([code, a]) => ({ code, xyz: [a.x, a.y, a.z], epoch: a.epoch || null })) },
      { id: 'mean', name: 'Среднее по суткам PPP-AR (ITRF2014)', frame: 'itrf', link, points: mean.map(([code, m]) => ({ code, xyz: [m.x, m.y, m.z], epoch: m.epoch || null })) },
      { id: 'once', name: 'Разовый расчёт PPP-AR (ITRF2014)', frame: 'itrf', link, points: once.map(([code, r]) => ({ code, xyz: [r.x14, r.y14, r.z14] })) },
      { id: 'catalog', name: 'Каталог основной сети (смещённые)', frame: 'net1', link, points: cat.map((s) => ({ code: s.code, xyz: [s.x, s.y, s.z] })) },
    ];
  }

  // ---------- Сети раздачи ----------
  // Публикация отделена от расчёта: расчётный модуль считает, сеть раздачи отдаёт роверам снимок её
  // координат. Сеть собирается из блоков, как блок-схема: расчётный модуль → станции → координаты базы →
  // пересчёт в потоке → спутники → частота → ближайшая база → порт → ровер. Щелчок по блоку
  // открывает его варианты; ниже всегда видно, что именно уйдёт роверу.

  const COORDS = { itrf2014: 'ITRF2014', itrf2020: 'ITRF2020', net1: 'как основная сеть', gsk2011: 'ГСК-2011', stream: 'как в потоке' };
  const FLOWS = { none: 'не передавать', msk66: 'в МСК-66', sk42: 'в СК-42', gsk2011: 'в ГСК-2011' };
  const SYSTEMS = { G: 'GPS', R: 'ГЛОНАСС', E: 'Galileo', C: 'BeiDou' };
  const RATES = [1, 2, 5, 10];
  const BLOCKS = [
    ['source', 'Источник', '<path d="M5 8 13 4l6 6-3 9-9-2Z"/><circle cx="5" cy="8" r="1.300"/><circle cx="13" cy="4" r="1.300"/><circle cx="19" cy="10" r="1.300"/>'],
    ['stations', 'Станции', '<path d="M12 4 20 19H4Z"/><circle cx="12" cy="14.500" r="1.400"/>'],
    ['coords', 'Координаты базы', '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c3 2.500 3 13.500 0 16M12 4c-3 2.500-3 13.500 0 16"/>'],
    ['transform', 'Пересчёт в потоке', '<path d="M4 8h11l-3-3M20 16H9l3 3"/><circle cx="18.500" cy="8" r="1.500"/><circle cx="5.500" cy="16" r="1.500"/>'],
    ['systems', 'Спутники', '<path d="m7 10 3-3 7 7-3 3ZM5 12l-2 2 3 3 2-2M17 5l2-2 3 3-2 2M14 17a4 4 0 0 0 4 4M14 20.500a1 1 0 0 0 1 1"/>'],
    ['rate', 'Частота', '<circle cx="12" cy="13" r="7.500"/><path d="M12 13V8.500M12 13l3 2M9.500 3h5"/>'],
    ['near', 'Ближайшая база', '<path d="M12 21s6-5.500 6-10.500a6 6 0 0 0-12 0C6 15.500 12 21 12 21Z"/><circle cx="12" cy="10.500" r="2.200"/>'],
    ['port', 'Порт', '<rect x="4" y="6" width="16" height="12" rx="2.500"/><path d="M8 10v4M12 10v4M16 10v4"/>'],
  ];
  const ROVER_ICON = '<path d="M12 3v9M8.500 12h7M7 21l5-9 5 9"/><circle cx="12" cy="3.500" r="1.200"/>';
  const recipeOf = (n) => (n.recipe && n.recipe.coords ? { source: 'subnet', ...n.recipe } : { source: 'subnet', coords: n.kind === 'local' ? 'net1' : 'itrf2014', transform: n.kind === 'itrf_msk' ? 'msk66' : 'none', stations: null, systems: ['G', 'R', 'E', 'C'], rate: 1, near: true });
  const netLabel = (r) => `${COORDS[r.coords]}${r.transform !== 'none' ? ` → ${FLOWS[r.transform].replace('в ', '')}` : ''}`;
  const netTone = (r) => (r.coords === 'net1' || r.coords === 'stream' ? 'local' : (r.transform !== 'none' ? 'itrf_msk' : (r.coords === 'gsk2011' ? 'gsk' : 'itrf')));
  const netChip = (r) => `<span class="adm-kind is-${netTone(r)}">${netLabel(r)}</span>`;
  const frameOf = (r) => (r.coords === 'net1' || r.coords === 'stream' ? 'net1' : (r.coords === 'gsk2011' ? 'gsk' : 'itrf'));

  const net = { open: false, id: null, block: null, draft: null, draftFor: undefined, look: null, lookKey: '', pending: {}, pendingKey: '' };
  const netDialog = document.createElement('dialog');
  netDialog.className = 'dialog adm-dialog adm-panel adm-wide';
  netDialog.id = 'net-dialog';
  document.body.appendChild(netDialog);
  const liveCount = (n) => (live ? n.points.filter((p) => { const lp = live.points.find((x) => x.name === p.name); return lp && lp.live; }).length : 0);
  const shiftText = (look) => {
    const big = Object.entries(look.shifts || {}).filter(([, v]) => v > 0.02).sort((a, b) => b[1] - a[1]);
    return [`Станций: ${look.stations}.`, look.max_shift ? `Наибольший сдвиг координат: ${mm(look.max_shift)} мм (${look.max_station}).` : '',
      big.length ? `Сдвиг больше 2 см: ${big.slice(0, 8).map(([c, v]) => `${c} ${mm(v)} мм`).join(', ')}${big.length > 8 ? ' и другие' : ''}.` : '',
      look.added.length ? `Новые станции: ${look.added.join(', ')}.` : '', look.gone.length ? `Уйдут из сети: ${look.gone.join(', ')}.` : '',
      look.params_changed ? 'Изменится состав потока: пересчёт, спутники, частота или ближайшая база.' : ''].filter(Boolean).join('\n');
  };

  // Что изменится при выпуске новой версии с прежним составом: для столбца «Ждёт выпуска»
  function askPending() {
    const src = (n) => lists.subnets.find((g) => g.id === n.subnet_id) || {};
    const key = lists.networks.map((n) => `${n.id}.${n.version}|${src(n).accepted_at}|${(src(n).link || {}).at}`).join(',');
    if (net.pendingKey === key) return;
    net.pendingKey = key;
    net.pending = {};
    for (const n of lists.networks) {
      if (!n.subnet_id && recipeOf(n).source !== 'main') { net.pending[n.id] = { error: 'расчётный модуль удалён' }; continue; }
      api('/api/admin/networks/preview', 'POST', { network_id: n.id }).then((res) => {
        if (net.pendingKey !== key) return;
        net.pending[n.id] = res.ok ? res.data : { error: res.error || 'не посчитано' };
        if (net.open) netLive();
      });
    }
  }
  const waitText = (n) => {
    const p = net.pending[n.id];
    if (!p) return '…';
    if (p.error) return `<span class="is-wait">${esc(p.error)}</span>`;
    if (!p.max_shift && !p.added.length && !p.gone.length && !p.params_changed) return 'без изменений';
    return `<span class="is-wait">${[p.params_changed ? 'новые параметры' : '', p.max_shift ? `сдвиг до ${mm(p.max_shift)} мм (${esc(p.max_station)})` : '', p.added.length ? `новых: ${p.added.length}` : '', p.gone.length ? `уйдёт: ${p.gone.length}` : ''].filter(Boolean).join(', ')}</span>`;
  };

  // Что передаётся роверу: координаты базы, параметры пересчёта, состав наблюдений — строками,
  // как они уйдут в поток. plan — из действующего выпуска сети либо из расчёта «что будет».
  function whatHtml(plan, title, name) {
    if (!plan || !plan.recipe) return '';
    const r = plan.recipe;
    const p = plan.params;
    const dl = (pairs) => `<dl class="adm-params">${pairs.map(([k, v]) => `<div><dt>${k}</dt><dd class="fig">${v}</dd></div>`).join('')}</dl>`;
    const fx = (v, d) => Number(v).toFixed(d);
    const rowsHtml = [];
    const epoch = plan.epoch ? `, эпоха ${fx(plan.epoch, 2)}` : '';
    const about = { itrf2014: `ITRF2014${epoch} — как приняты в расчётном модуле`, itrf2020: `ITRF2020${epoch} — принятые координаты, пересчитанные из ITRF2014 (миллиметры)`,
      net1: 'в системе основной сети: к координатам ITRF2014 прибавлена привязка', stream: 'те же, что у обычных точек станций: как шлёт база либо из каталога, если у станции включена подмена', gsk2011: 'ГСК-2011, эпоха 2011,0 — перенесены по движению Евразийской плиты, точность 2–3 см' }[r.coords];
    rowsHtml.push(`<p class="adm-what-row"><b>1005 · координаты базы</b> ${about}</p>`);
    if (r.coords === 'net1' && p) {
      rowsHtml.push(`<p class="adm-what-row"><b>Привязка, внесённая в координаты</b> ITRF2014 → основная сеть, ${plan.mode === 'full' ? 'семь параметров' : 'только сдвиг'}${plan.used && plan.used.length ? `, по станциям ${esc(plan.used.join(', '))}` : ''}</p>`);
      rowsHtml.push(dl([['ΔX, м', fx(p.tx, 4)], ['ΔY, м', fx(p.ty, 4)], ['ΔZ, м', fx(p.tz, 4)], ['ωx, ″', fx(p.rx, 6)], ['ωy, ″', fx(p.ry, 6)], ['ωz, ″', fx(p.rz, 6)], ['m, ppm', fx(p.m, 5)]]));
    }
    const flow = plan.transform && window.Transform ? window.Transform.plan(plan.transform) : null;
    // Справочно — переход в МСК-66 для ручного ввода в контроллер, когда сеть отдаёт чистый ITRF
    const hint = !flow && r.transform === 'none' && r.coords === 'itrf2014' && p && window.Transform ? window.Transform.plan({ target: 'msk66', link: p }) : null;
    if (r.transform === 'none') rowsHtml.push(`<p class="adm-what-row"><b>Сообщения пересчёта</b> не передаются.${r.coords === 'net1' || r.coords === 'stream' ? ' В ровере МСК настроена как сейчас — пользователю менять нечего.' : (hint ? ' Чтобы получить из этих координат МСК-66, в контроллер вручную вводятся параметры ниже.' : '')}</p>`);
    const t = flow || hint;
    if (t) {
      const h = t.helmert;
      rowsHtml.push(`<p class="adm-what-row"><b>${flow ? '1021 · семь параметров' : 'Семь параметров (справочно)'}</b> ${esc(h.sourceName)} → ${esc(t.datum)}${t.target === 'gsk2011' ? ': перенос на эпоху 2011,0 по движению плиты и переход к ITRF2008' : ', эллипсоид Красовского; привязка расчётного модуля и параметры ГОСТ сложены вместе'}</p>`);
      rowsHtml.push(dl([['dX, м', fx(h.dx, 3)], ['dY, м', fx(h.dy, 3)], ['dZ, м', fx(h.dz, 3)], ['Rx, ″', fx(h.rx, 5)], ['Ry, ″', fx(h.ry, 5)], ['Rz, ″', fx(h.rz, 5)], ['масштаб, ppm', fx(h.scale, 5)],
        ['эллипсоид ITRF: a, b', `${fx(h.sourceA, 3)} · ${fx(h.sourceB, 3)}`], [`${t.target === 'gsk2011' ? 'ГСК-2011' : 'Красовского'}: a, b`, `${fx(h.targetA, 3)} · ${fx(h.targetB, 3)}`]]));
      rowsHtml.push(`<p class="adm-what-row"><b>${flow ? '1025 · проекция' : 'Проекция (справочно)'}</b> ${esc(t.system)}, поперечная Меркатора (Гаусса — Крюгера)${flow ? '; роверу уходит зона по его положению' : ''}</p>`);
      rowsHtml.push(`<div class="adm-scroll"><table class="messages srv-table adm-rows adm-static adm-zones"><thead><tr><th>Зона</th><th>Осевой меридиан</th><th>Широта начала</th><th>Масштаб</th><th>Смещение на восток, м</th><th>Смещение на север, м</th><th></th></tr></thead><tbody>${t.projections.map((z) => `<tr><td class="fig">${z.zone}</td><td class="fig">${dms(z.lon0, 'lon', 0).text}</td><td class="fig">0°</td><td class="fig">${fx(z.scale, 6)}</td><td class="fig">${fx(z.falseEasting, 3)}</td><td class="fig">${fx(z.falseNorthing, 3)}</td><td>${z.verified ? '' : '<span class="is-wait">с каталогом не сверена</span>'}</td></tr>`).join('')}</tbody></table></div>`);
      if (flow) {
        const a = h.area;
        rowsHtml.push(`<p class="adm-what-row"><b>Как передаётся</b> пара 1021 + 1025 при подключении и каждые 10 с. Область действия: ${fx(a.lat - a.dLat, 1)}–${fx(a.lat + a.dLat, 1)}° с. ш., ${fx(a.lon - a.dLon, 1)}–${fx(a.lon + a.dLon, 1)}° в. д. В ровере включается «система координат из сети». Знак поворотов и признак набора сообщений на живом приёмнике ещё не проверены.</p>`);
      }
    }
    const f = plan.filter || { systems: r.systems, rate: r.rate };
    rowsHtml.push(`<p class="adm-what-row"><b>Наблюдения</b> ${f.systems.map((c) => SYSTEMS[c]).join(', ')} — ${f.rate > 1 ? `раз в ${f.rate} с` : 'каждую секунду'}${f.systems.length < 4 || f.rate > 1 ? '; остальное из потока базы роверу не идёт' : ', как шлёт база'}.</p>`);
    const codes = plan.codes || Object.keys(plan.stations || {});
    rowsHtml.push(`<p class="adm-what-row"><b>Точки подключения</b> ${codes.length} ${plural(codes.length, 'станция', 'станции', 'станций')}: ${esc(name || 'ИМЯ')}_СТАНЦИЯ${(plan.near !== undefined ? plan.near : r.near) ? `, и ${esc(name || 'ИМЯ')}_NEAR — ближайшая база по положению ровера` : '; точки ближайшей базы нет'}.</p>`);
    return `<div class="adm-what is-${netTone(r)}"><p class="adm-what-head">${title} ${netChip(r)}</p>${rowsHtml.join('')}</div>`;
  }

  // Черновик: из чего собирается сеть в окне. Для готовой сети — её состав, который можно поменять
  function draftFor(n) {
    const key = n ? `${n.id}.${n.version}` : 'new';
    if (net.draft && net.draftFor === key) return net.draft;
    const ready = lists.subnets.filter((g) => Object.keys(g.accepted || {}).length);
    net.draft = n ? { name: n.name, title: n.title, subnet_id: n.subnet_id, port: n.port || '', recipe: JSON.parse(JSON.stringify(recipeOf(n))) }
      : { name: '', title: '', subnet_id: ready.length ? ready[0].id : null, port: '', recipe: { source: ready.length ? 'subnet' : 'main', coords: ready.length ? 'itrf2014' : 'stream', transform: 'none', stations: null, systems: ['G', 'R', 'E', 'C'], rate: 1, near: true } };
    net.draftFor = key;
    net.look = null;
    net.lookKey = '';
    return net.draft;
  }
  const draftSubnet = () => lists.subnets.find((g) => g.id === net.draft.subnet_id) || null;
  // Сеть прямо из основной сети: без расчётного модуля, координаты — как в её потоках
  const isMain = () => net.draft.recipe.source === 'main';
  // Станции, из которых можно собрать сеть: включённые станции основной сети либо станции
  // расчётного модуля с принятыми координатами
  const draftCodes = () => (isMain() ? lists.stations.filter((x) => x.enabled).map((x) => x.code).sort() : Object.keys((draftSubnet() || {}).accepted || {}).sort());
  // Правила конструктора: что нельзя собрать и почему
  function blockRules() {
    const g = draftSubnet();
    const bound = Boolean(g && g.link && g.link.params);
    const r = net.draft.recipe;
    const main = isMain();
    const itrf = ['itrf2014', 'itrf2020'].includes(r.coords);
    const flow = (needsLink) => (main ? 'только для сети из расчётного модуля' : (!itrf ? 'только при координатах в ITRF' : (needsLink && !bound ? 'нужна привязка в расчётном модуле' : '')));
    return {
      bound,
      coords: { net1: bound ? '' : 'нужна привязка в расчётном модуле' },
      transform: { msk66: flow(true), sk42: flow(true), gsk2011: flow(false) },
    };
  }
  // Несовместимый выбор исправляется сам: пересчёт снимается, если координаты уже пересчитаны
  function fixDraft() {
    const r = net.draft.recipe;
    if (isMain()) {
      r.coords = 'stream';
      r.transform = 'none';
      net.draft.subnet_id = null;
    } else {
      if (r.coords === 'stream' || blockRules().coords[r.coords]) r.coords = 'itrf2014';
      if (r.transform !== 'none' && blockRules().transform[r.transform]) r.transform = 'none';
    }
    const codes = draftCodes();
    if (r.stations) { r.stations = r.stations.filter((c) => codes.includes(c)); if (!r.stations.length) r.stations = null; }
  }

  // Блок-схема: значение каждого блока одной строкой
  function blockValue(id, n) {
    const d = net.draft;
    const r = d.recipe;
    const g = draftSubnet();
    const all = draftCodes().length;
    if (id === 'source') return isMain() ? `основная сеть · ${all} ст.` : (g ? `${esc(g.name)} · ${all} ст.` : (n && !n.subnet_id ? 'модуль удалён' : 'нет расчётного модуля'));
    if (id === 'stations') return r.stations ? `${r.stations.length} из ${all}` : `все ${all}`;
    if (id === 'coords') return COORDS[r.coords];
    if (id === 'transform') return FLOWS[r.transform];
    if (id === 'systems') return r.systems.length === 4 ? 'все четыре' : r.systems.map((c) => SYSTEMS[c]).join(', ');
    if (id === 'rate') return r.rate > 1 ? `раз в ${r.rate} с` : 'каждую секунду';
    if (id === 'near') return r.near ? 'есть' : 'нет';
    return String(d.port || '2101');
  }
  const blockTone = (id) => {
    const r = net.draft.recipe;
    if (id === 'coords') return r.coords === 'net1' ? 'local' : (r.coords === 'gsk2011' ? 'gsk' : 'itrf');
    if (id === 'transform') return r.transform === 'none' ? 'off' : 'itrf_msk';
    if (id === 'near') return r.near ? 'plain' : 'off';
    return 'plain';
  };
  function flowHtml(n) {
    const was = n ? { ...recipeOf(n), port: n.port || '' } : null;
    const changed = (id) => {
      if (!was) return false;
      const r = net.draft.recipe;
      if (id === 'port') return String(net.draft.port || '') !== String(was.port);
      if (id === 'source') return false;
      return JSON.stringify(r[id]) !== JSON.stringify(was[id]);
    };
    return `<div class="adm-flow">${BLOCKS.map(([id, title, icon]) => `<button class="adm-block is-${blockTone(id)} ${changed(id) ? 'is-changed' : ''}" type="button" data-block="${id}" aria-current="${net.block === id}" ${isAdmin() ? '' : 'disabled'}>
      <svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><span class="adm-block-name">${title}</span><span class="adm-block-value">${blockValue(id, n)}</span></button><i class="adm-flow-link"></i>`).join('')}
      <span class="adm-block is-end"><svg viewBox="0 0 24 24" aria-hidden="true">${ROVER_ICON}</svg><span class="adm-block-name">Ровер</span><span class="adm-block-value">получает</span></span></div>`;
  }

  // Варианты открытого блока
  function optionsHtml(n) {
    const id = net.block;
    if (!id) return '<p class="hint adm-flow-hint">Щёлкните блок, чтобы поменять его. Схема читается слева направо: что берём, как меняем, что получает ровер.</p>';
    const d = net.draft;
    const r = d.recipe;
    const g = draftSubnet();
    const rules = blockRules();
    const tile = (attr, value, text, on, why, tone) => `<button class="adm-opt ${tone ? `is-${tone}` : ''}" type="button" data-opt="${attr}" data-value="${esc(String(value))}" aria-current="${on}" ${why ? 'disabled' : ''}>${text}${why ? `<small>${why}</small>` : ''}</button>`;
    let body = '';
    let note = '';
    if (id === 'source') {
      const ready = lists.subnets.filter((x) => Object.keys(x.accepted || {}).length);
      body = n ? `<span class="adm-opt is-local" aria-current="true">${isMain() ? 'Основная сеть' : esc(n.subnet || 'расчётный модуль удалён')}</span>`
        : `${tile('subnet', 'main', `Основная сеть<small>те же координаты, что раздаются сейчас</small>`, isMain(), '', 'local')}${ready.map((x) => tile('subnet', x.id, `${esc(x.name)}<small>расчётный модуль · принято ${Object.keys(x.accepted).length}${x.link && x.link.params ? ', привязка есть' : ', без привязки'}</small>`, !isMain() && x.id === d.subnet_id, '', 'itrf')).join('')}`;
      note = n ? 'Источник у готовой сети не меняется: для другого источника выпустите новую сеть.'
        : (isMain() ? 'Сеть из станций основной сети: координаты те же, что раздаются сейчас; расчёты не нужны. Дальше выберите станции, спутники, частоту и порт.'
          : 'Сеть из расчётного модуля: его принятые координаты, с выбором системы и пересчёта. Модуль остаётся чистым расчётом.');
    } else if (id === 'stations') {
      const codes = draftCodes();
      body = `${tile('all', 1, `Все станции ${isMain() ? 'основной сети' : 'расчётного модуля'}<small>${codes.length}</small>`, !r.stations)}${codes.map((c) => `<label class="adm-opt adm-opt-check"><input type="checkbox" data-pick="${esc(c)}" ${!r.stations || r.stations.includes(c) ? 'checked' : ''}><span class="fig">${esc(c)}</span></label>`).join('')}`;
      note = 'Какие станции войдут в сеть. У каждой будет своя точка подключения.';
    } else if (id === 'coords' && isMain()) {
      body = '<span class="adm-opt is-local" aria-current="true">как в потоке</span>';
      note = 'Точки этой сети отдают те же координаты базы, что и обычные точки станций: как шлёт база либо из каталога, если у станции включена подмена. Другие системы координат доступны сети из расчётного модуля.';
    } else if (id === 'coords') {    } else if (id === 'coords') {
      body = Object.entries(COORDS).map(([k, name]) => tile('coords', k, name, r.coords === k, rules.coords[k] || '', k === 'net1' ? 'local' : (k === 'gsk2011' ? 'gsk' : 'itrf'))).join('');
      note = { itrf2014: 'Настоящие координаты станций, как приняты в расчётном модуле.', itrf2020: 'То же в ITRF2020: отличие от ITRF2014 — миллиметры.',
        net1: 'В координаты уже внесена привязка: ровер работает в МСК как сейчас, ничего настраивать не надо.',
        gsk2011: 'ГСК-2011 закреплена на 2011 год: координаты перенесены по движению плиты, точность 2–3 см.' }[r.coords];
    } else if (id === 'transform') {
      body = Object.entries(FLOWS).map(([k, name]) => tile('transform', k, name, r.transform === k, k === 'none' ? '' : rules.transform[k], k === 'none' ? '' : 'itrf_msk')).join('');
      note = r.transform === 'none' ? 'Сообщения пересчёта роверу не идут: он получает координаты базы как есть.' : 'Роверу идут сообщения 1021 и 1025: он сам получает выбранную систему, если в нём включена «система координат из сети».';
    } else if (id === 'systems') {
      body = Object.entries(SYSTEMS).map(([k, name]) => tile('system', k, name, r.systems.includes(k), '', '')).join('');
      note = 'Какие спутниковые системы отдавать. GPS обязателен. Убрать лишнее полезно для старых приёмников и слабой связи.';
    } else if (id === 'rate') {
      body = RATES.map((v) => tile('rate', v, v > 1 ? `раз в ${v} с` : 'каждую секунду', r.rate === v)).join('');
      note = 'Как часто отдавать наблюдения. Реже — меньше трафика, но фикс приходит медленнее; для работы в движении оставляйте каждую секунду.';
    } else if (id === 'near') {
      body = `${tile('near', 1, `есть<small>${esc((d.name || 'ИМЯ').toUpperCase())}_NEAR</small>`, r.near)}${tile('near', 0, 'нет', !r.near)}`;
      note = 'Точка, на которой ровер сам получает ближайшую станцию сети по своему положению.';
    } else {
      body = `<label class="adm-port"><span>порт раздачи</span><input id="net-port" type="text" inputmode="numeric" maxlength="5" autocomplete="off" value="${esc(String(d.port || ''))}" placeholder="2101"></label>`;
      note = 'Пусто или 2101 — общий порт вместе с основной сетью. На своём порту ровер видит в таблице источников только точки этой сети. Порт должен быть проброшен на роутере; 2110–2159 заняты приёмом станций.';
    }
    return `<div class="adm-flow-opts">${body}</div><p class="hint adm-flow-hint">${note}</p>`;
  }

  // Что получится, если выпустить сейчас: спрашивается у сервера при каждой правке блоков
  function askLook(n) {
    const d = net.draft;
    if (!d.subnet_id && !isMain()) { net.look = { error: 'Нет расчётного модуля с принятыми координатами: выберите источником основную сеть.' }; return; }
    const key = JSON.stringify([d.subnet_id, d.recipe, n ? `${n.id}.${n.version}` : 'new', (draftSubnet() || {}).accepted_at, ((draftSubnet() || {}).link || {}).at]);
    if (net.lookKey === key) return;
    net.lookKey = key;
    api('/api/admin/networks/preview', 'POST', n ? { network_id: n.id, recipe: d.recipe } : { subnet_id: d.subnet_id, recipe: d.recipe }).then((res) => {
      if (net.lookKey !== key) return;
      net.look = res.ok ? res.data : { error: res.error || 'Не посчитано.' };
      if (net.open) lookLive();
    });
  }
  function lookLive() {
    const box = $('net-what');
    if (!box) return;
    const n = lists.networks.find((x) => x.id === net.id) || null;
    const look = net.look;
    const name = (net.draft.name || (n ? n.name : '')).toUpperCase();
    const touched = n && (JSON.stringify(net.draft.recipe) !== JSON.stringify(recipeOf(n)) || String(net.draft.port || '') !== String(n.port || ''));
    let html = n ? whatHtml({ ...n.release, recipe: recipeOf(n) }, 'Передаётся сейчас:', n.name) : '';
    if (!look) html += '<p class="hint">Считаем, что получится…</p>';
    else if (look.error) html += `<p class="notice">${esc(look.error)}</p>`;
    else if (!n) html += `${whatHtml(look.plan, 'Будет передаваться:', name)}`;
    else if (touched || look.params_changed || look.max_shift || look.added.length || look.gone.length) html += `${whatHtml(look.plan, 'После выпуска новой версии будет:', name)}<p class="hint">${esc(shiftText(look)).replace(/\n/g, ' ')}</p>`;
    if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
  }

  // Живая часть окна: список сетей и точки выбранной. Поля ввода не трогаются.
  function netLive() {
    if (!net.open) return;
    askPending();
    const list = $('net-rows');
    if (list) {
      list.innerHTML = lists.networks.map((n) => `<tr data-net-pick="${n.id}" aria-selected="${n.id === net.id}"><td><span class="fig">${esc(n.name)}</span>${n.title ? ` <small class="adm-note">${esc(n.title)}</small>` : ''}</td>
        <td>${n.subnet ? `<span class="fig">${esc(n.subnet)}</span>` : (recipeOf(n).source === 'main' ? 'основная сеть' : '<span class="is-wait">модуль удалён</span>')}</td><td>${netChip(recipeOf(n))}</td><td class="fig">${n.port || 2101}${n.port ? '' : ' <small class="adm-note">общий</small>'}</td><td class="fig">${n.version}</td><td>${when(n.release.at)}</td>
        <td class="fig">${liveCount(n)} из ${n.points.length}</td><td>${waitText(n)}</td></tr>`).join('') || '<tr><td colspan="8">Сетей раздачи пока нет</td></tr>';
    }
    const n = lists.networks.find((x) => x.id === net.id);
    const pts = $('net-points');
    if (pts && n) {
      const p = net.look && !net.look.error ? net.look : {};
      pts.innerHTML = n.points.map((pt) => {
        const lp = live ? live.points.find((x) => x.name === pt.name) : null;
        const r = n.release.stations[pt.station] || {};
        const sh = p.shifts ? p.shifts[pt.station] : undefined;
        return `<tr><td><span class="fig">${esc(pt.station)}</span></td><td><span class="fig">${esc(pt.name)}</span></td>
          <td>${lp ? (lp.live ? '<span class="is-online">раздаётся</span>' : '<span class="is-fail">станция молчит</span>') : '<span class="is-wait">нет у раздачи</span>'}</td>
          <td class="fig">${r.x === undefined ? '—' : Number(r.x).toFixed(4)}</td><td class="fig">${r.y === undefined ? '—' : Number(r.y).toFixed(4)}</td><td class="fig">${r.z === undefined ? '—' : Number(r.z).toFixed(4)}</td>
          <td class="fig">${sh === undefined ? '—' : (sh ? `<span class="is-wait">${mm(sh)}</span>` : '0')}</td></tr>`;
      }).join('');
    }
    lookLive();
  }

  function renderNet() {
    const admin = isAdmin();
    const n = lists.networks.find((x) => x.id === net.id) || null;
    if (!n) net.id = null;
    const d = draftFor(n);
    fixDraft();
    askLook(n);
    const back = n ? n.history.filter((h) => h.version !== n.version) : [];
    let body = `<p class="adm-lead"><b>Сети раздачи.</b> То, к чему подключаются роверы. Сеть собирается из блоков: из станций основной сети как есть либо из координат расчётного модуля. Сетей может быть сколько угодно.</p>
      <div class="adm-scroll adm-net-list"><table class="messages srv-table adm-rows"><thead><tr><th>Сеть</th><th>Расчётный модуль</th><th>Что раздаёт</th><th>Порт</th><th>Версия</th><th>Выпущена</th><th>Раздаётся</th><th>Ждёт выпуска</th></tr></thead><tbody id="net-rows"></tbody></table></div>`;
    body += n ? `<p class="adm-lead"><b>${esc(n.name)}${n.title ? ` · ${esc(n.title)}` : ''}.</b> Версия ${n.version}${n.release.restored ? `, состав как в версии ${n.release.restored}` : ''}. Поменяйте блок и выпустите новую версию — до этого роверы получают прежнее.</p>`
      : `<p class="adm-lead"><b>Новая сеть.</b> Соберите её из блоков и выпустите.</p>${admin ? `<div class="adm-sub-form is-release"><label class="field"><span>Имя сети латиницей</span><input id="net-name" type="text" autocomplete="off" maxlength="12" placeholder="N3" value="${esc(d.name)}"></label>
        <label class="field"><span>Название</span><input id="net-title" type="text" autocomplete="off" maxlength="80" value="${esc(d.title)}"></label></div>` : ''}`;
    body += `${flowHtml(n)}<div id="net-options">${optionsHtml(n)}</div>`;
    if (admin) {
      body += `<div class="adm-actions">${n ? `<button class="btn btn-primary btn-small" type="button" data-do="release-next" ${n.subnet_id || recipeOf(n).source === 'main' ? '' : 'disabled'}>Выпустить версию ${n.version + 1}</button>
          ${back.length ? `<select class="adm-pick" id="net-back"><option value="">Вернуть версию…</option>${back.map((h) => `<option value="${h.version}">${h.version} — ${when(h.at)}</option>`).join('')}</select>` : ''}
          <button class="btn btn-quiet btn-small" type="button" data-do="net-reset">Сбросить правки</button><button class="btn btn-quiet btn-small" type="button" data-do="net-export">Таблица координат</button>
          <button class="btn btn-quiet btn-small btn-danger" type="button" data-do="release-del">Удалить сеть</button><button class="btn btn-quiet btn-small" type="button" data-do="net-new">Новая сеть</button>`
        : '<button class="btn btn-primary btn-small" type="button" data-do="release-new">Выпустить сеть</button>'}</div>`;
    }
    body += '<div id="net-what"></div>';
    if (n) body += '<div class="adm-scroll"><table class="messages srv-table adm-rows adm-static"><thead><tr><th>Станция</th><th>Точка подключения</th><th>Состояние</th><th>X</th><th>Y</th><th>Z</th><th>Сдвиг при выпуске, мм</th></tr></thead><tbody id="net-points"></tbody></table></div>';
    netDialog.innerHTML = `<button class="icon-btn adm-close" type="button" data-do="net-close" title="Закрыть">×</button><h2><span>Сети раздачи</span><span class="fig adm-note">${lists.networks.length || ''}</span></h2><div>${body}</div>`;
    netLive();
  }

  function openNet(id) {
    net.id = id;
    net.block = null;
    net.draftFor = undefined;
    net.open = true;
    if ($('sub-dialog').open) $('sub-dialog').close();
    if (!netDialog.open) netDialog.show();
    renderNet();
    renderRail();
  }
  netDialog.addEventListener('close', () => { net.open = false; hideHint(); renderRail(); });

  async function reloadNetworks() {
    const [nets, subs] = await Promise.all([api('/api/admin/networks'), api('/api/admin/subnets')]);
    if (nets.ok) lists.networks = nets.data;
    if (subs.ok) { lists.subnets = subs.data; if (view === 'subnets') rows = subs.data; }
    net.pendingKey = '';
    net.draftFor = undefined;
  }
  // Поля ввода пишутся в черновик сразу: перерисовка окна их не сбивает
  netDialog.addEventListener('input', (event) => {
    if (!net.draft) return;
    if (event.target.id === 'net-name') net.draft.name = event.target.value;
    if (event.target.id === 'net-title') net.draft.title = event.target.value;
    if (event.target.id === 'net-port') { net.draft.port = event.target.value.trim(); const v = netDialog.querySelector('[data-block="port"] .adm-block-value'); if (v) v.textContent = net.draft.port || '2101'; }
  });
  netDialog.addEventListener('click', async (event) => {
    const pick = event.target.closest('[data-net-pick]');
    if (pick) { openNet(Number(pick.dataset.netPick)); return; }
    const block = event.target.closest('[data-block]');
    if (block) { net.block = net.block === block.dataset.block ? null : block.dataset.block; renderNet(); return; }
    const opt = event.target.closest('[data-opt]');
    if (opt && net.draft) {
      const r = net.draft.recipe;
      const v = opt.dataset.value;
      if (opt.dataset.opt === 'subnet') { r.source = v === 'main' ? 'main' : 'subnet'; net.draft.subnet_id = v === 'main' ? null : Number(v); r.stations = null; }
      if (opt.dataset.opt === 'all') r.stations = null;
      if (opt.dataset.opt === 'coords') r.coords = v;
      if (opt.dataset.opt === 'transform') r.transform = v;
      if (opt.dataset.opt === 'rate') r.rate = Number(v);
      if (opt.dataset.opt === 'near') r.near = v === '1';
      if (opt.dataset.opt === 'system' && v !== 'G') r.systems = Object.keys(SYSTEMS).filter((c) => (c === v ? !r.systems.includes(c) : r.systems.includes(c)));
      if (opt.dataset.opt === 'system' && v === 'G') toast('GPS обязателен: без него ровер не работает.', 3000);
      renderNet();
      return;
    }
    const btn = event.target.closest('[data-do]');
    if (!btn) return;
    const act = btn.dataset.do;
    const n = lists.networks.find((x) => x.id === net.id);
    const d = net.draft;
    if (act === 'net-close') { netDialog.close(); return; }
    if (act === 'net-new') { openNet(null); return; }
    if (act === 'net-reset') { net.draftFor = undefined; renderNet(); return; }
    if (act === 'net-export' && n) {
      openExport([{ id: 'release', name: `Сеть ${n.name}, версия ${n.version} — то, что раздаётся`, frame: frameOf(recipeOf(n)), link: n.release.params || null,
        points: Object.entries(n.release.stations).filter(([, r]) => r.x !== undefined).map(([code, r]) => ({ code, xyz: [r.x, r.y, r.z], epoch: n.release.epoch || null })) }], n.name);
      return;
    }
    let res = null;
    if (act === 'release-new') {
      const src = draftSubnet();
      const body = { name: d.name.trim(), title: d.title.trim(), subnet_id: d.subnet_id, port: d.port || null, recipe: d.recipe };
      if (!/^[A-Za-z0-9]{1,12}$/.test(body.name)) { toast('Имя сети: латинские буквы и цифры, до 12 знаков. С него начинаются имена точек подключения.', 6000); return; }
      const look = await api('/api/admin/networks/preview', 'POST', { subnet_id: body.subnet_id, recipe: body.recipe });
      if (!look.ok) { toast(look.error || 'Не получилось.', 7000); return; }
      if (!window.confirm(`Выпустить сеть ${body.name.toUpperCase()} (${netLabel(d.recipe)}) ${src ? `из расчётного модуля ${src.name}` : 'из станций основной сети'}?\n${shiftText(look.data)}\nТочки подключения: ${body.name.toUpperCase()}_СТАНЦИЯ, порт ${body.port || '2101 (общий)'}.`)) return;
      res = await api('/api/admin/networks', 'POST', body);
      if (res.ok) net.id = res.data.id;
    } else if (act === 'release-next' && n) {
      const portNew = String(d.port || '') !== String(n.port || '');
      const look = await api('/api/admin/networks/preview', 'POST', { network_id: n.id, recipe: d.recipe });
      if (!look.ok) { toast(look.error || 'Не получилось.', 7000); return; }
      const same = !look.data.max_shift && !look.data.added.length && !look.data.gone.length && !look.data.params_changed && JSON.stringify(d.recipe) === JSON.stringify(recipeOf(n));
      if (same && !portNew) { toast('Изменений нет: координаты в расчётном модуле и состав сети те же, что в действующей версии.', 5000); return; }
      if (!window.confirm(`Сеть ${n.name}: ${same ? 'сменить порт' : `выпустить версию ${n.version + 1}`}?\n${same ? '' : `${shiftText(look.data)}\n`}${portNew ? `Порт раздачи станет ${d.port || '2101 (общий)'}: подключённые роверы отключатся.\n` : ''}Роверы на этой сети получат новое сразу.`)) return;
      if (portNew) {
        const moved = await api(`/api/admin/networks/${n.id}`, 'PATCH', { port: d.port || null });
        if (!moved.ok) { toast(moved.error || 'Порт не сменён.', 7000); return; }
        res = moved;
      }
      if (!same) res = await api(`/api/admin/networks/${n.id}/release`, 'POST', { recipe: d.recipe });
    } else if (act === 'release-del' && n) {
      if (!window.confirm(`Удалить сеть ${n.name}? Её точки подключения (${n.points.length}) исчезнут, роверы на них отключатся. Расчётный модуль и его расчёты останутся.`)) return;
      res = await api(`/api/admin/networks/${n.id}`, 'DELETE');
      if (res.ok) net.id = null;
    }
    if (!res) return;
    if (!res.ok) { toast(res.error || 'Не получилось.', 7000); return; }
    toast(act === 'release-del' ? 'Сеть удалена.' : 'Готово. Раздача подхватит изменения за несколько секунд.', 4000);
    await reloadNetworks();
    net.block = null;
    renderNet();
    renderRail();
  });
  netDialog.addEventListener('change', async (event) => {
    if (event.target.dataset.pick && net.draft) {
      // Галочки станций: снятая галочка превращает «все» в явный список
      const all = draftCodes();
      const on = new Set(net.draft.recipe.stations || all);
      if (event.target.checked) on.add(event.target.dataset.pick); else on.delete(event.target.dataset.pick);
      net.draft.recipe.stations = on.size === all.length || !on.size ? null : all.filter((c) => on.has(c));
      if (!on.size) toast('В сети должна быть хотя бы одна станция: выбраны все.', 3500);
      renderNet();
      return;
    }
    if (event.target.id === 'net-port') { renderNet(); return; }
    if (event.target.id !== 'net-back') return;
    const version = Number(event.target.value);
    const n = lists.networks.find((x) => x.id === net.id);
    if (!n || !version) return;
    event.target.value = '';
    if (!window.confirm(`Сеть ${n.name}: вернуть версию ${version} — её координаты и состав блоков? Это станет версией ${n.version + 1}; роверы получат её сразу.`)) return;
    const res = await api(`/api/admin/networks/${n.id}/rollback`, 'POST', { version });
    if (!res.ok) { toast(res.error || 'Не получилось.', 7000); return; }
    toast(`Сеть ${n.name}: возвращена версия ${version}.`, 4000);
    await reloadNetworks();
    renderNet();
  });
  // Подсказки при наведении — те же, что в окне шага расчётного модуля
  netDialog.addEventListener('mouseover', (event) => {
    const btn = event.target.closest('[data-do]');
    const th = btn ? null : event.target.closest('th');
    const text = btn ? HINT[btn.dataset.do] : (th ? TH_HINT[th.textContent.trim()] : null);
    if (text) showHint(btn || th, text); else hideHint();
  });
  netDialog.addEventListener('mouseleave', hideHint);
  netDialog.addEventListener('mousedown', hideHint);

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

  // Выбор расчётного модуля и шага — во всплывающем окне у значка «Расчётного модуля» или у строки расчётного модуля в каталоге
  function showSteps(anchor) {
    if (sub.id === null && rows.length && !sub.fresh) sub.id = rows[0].id;
    if (!rows.length) sub.fresh = true;
    showTip(anchor || document.querySelector('#nav [data-view="subnets"]'), 'view:subnets');
  }

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
    const [nets, sts, lays, outs] = await Promise.all([api('/api/admin/subnets'), view === 'stations' ? null : api('/api/admin/stations'), api('/api/admin/layers'), api('/api/admin/networks')]);
    if (nets.ok) lists.subnets = nets.data;
    if (outs.ok) lists.networks = outs.data;
    if (lays.ok) lists.layers = lays.data;
    if (sts && sts.ok) lists.stations = sts.data;
    if ($('run-dialog').open) renderRun();
    if (net.open) netLive();
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
