'use strict';
// Страница состояния сервера: раз в секунду спрашивает службу управления и показывает,
// какие службы работают и что идёт со станций.

(() => {
  const { esc, num, rate, bytes, duration, plural } = window.Fmt;
  const $ = (id) => document.getElementById(id);

  const STATE = {
    online: ['Данные идут', 'is-online'],
    connecting: ['Подключаемся', 'is-wait'],
    waiting: ['Ждём данные', 'is-wait'],
    listening: ['Ждём приёмник', 'is-wait'],
    retry: ['Нет связи', 'is-fail'],
    error: ['Ошибка', 'is-fail'],
    idle: ['Остановлена', ''],
  };

  function tile(title, cls, lines) {
    return `<article class="srv-tile glass ${cls}"><h2>${title}</h2>${lines.map((l) => `<p>${l}</p>`).join('')}</article>`;
  }

  function uptime(service) {
    return `работает ${esc(duration(Date.now() - service.startedAt))}`;
  }

  function renderServices(s) {
    const tiles = [];
    tiles.push(s.ingest.up
      ? tile('Приём', 'is-up', [uptime(s.ingest), `потребителей потока: ${s.ingest.consumers}`])
      : tile('Приём', '', ['Служба не отвечает. Станции не принимаются.']));
    if (!s.caster.up) {
      tiles.push(tile('Раздача', '', ['Служба не отвечает.']));
    } else {
      const link = s.caster.ingestLink ? 'потоки от приёма получает' : 'нет связи со службой приёма';
      const port = s.caster.listening
        ? `NTRIP на порту ${s.caster.port}, сеансов: ${s.caster.sessions}`
        : `порт ${s.caster.port} для роверов выключен в настройках`;
      const cls = !s.caster.ingestLink ? '' : (s.caster.listening ? 'is-up' : 'is-part');
      tiles.push(tile('Раздача', cls, [uptime(s.caster), link, port]));
    }
    tiles.push(tile('Управление', 'is-up', [uptime(s.control), 'эта страница и сводка состояния']));
    $('services').innerHTML = tiles.join('');
  }

  function renderStations(list) {
    const online = list.filter((s) => s.link.state === 'online').length;
    $('station-count').textContent = list.length ? `${online}/${list.length}` : '';
    $('summary').innerHTML = list.length
      ? `Сервер: <b>${online} из ${list.length}</b> ${plural(list.length, 'станции', 'станций', 'станций')} на приёме`
      : 'Сервер: станций в настройках нет';
    $('stations').innerHTML = list.map((st) => {
      const [text, cls] = STATE[st.link.state] || ['Отключена', ''];
      const feed = st.feed ? esc(bytes(st.feed.bytes)) : '—';
      return `<tr>
        <td class="fig">${esc(st.id)}</td>
        <td>${esc(st.name)}</td>
        <td class="${cls}">${text}</td>
        <td class="fig">${st.satTotal}</td>
        <td class="fig">${st.link.state === 'online' ? esc(rate(st.link.bitsPerSec)) : '—'}</td>
        <td class="fig">${num(st.link.reconnects)}</td>
        <td class="fig">${num(st.crcErrors)}</td>
        <td class="fig">${feed}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="8">Станций нет</td></tr>';
  }

  async function tick() {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const state = await res.json();
      $('example-note').hidden = !state.usingExample;
      renderServices(state.services);
      renderStations(state.stations);
    } catch (err) {
      $('summary').textContent = 'Сервер не отвечает: служба управления остановлена или перезапускается';
    }
  }

  function syncTheme() {
    $('theme-btn').textContent = window.Theme.current() === 'dark' ? 'Светлая тема' : 'Тёмная тема';
  }
  $('theme-btn').addEventListener('click', () => window.Theme.set(window.Theme.current() === 'dark' ? 'light' : 'dark'));
  window.addEventListener('themechange', syncTheme);

  syncTheme();
  tick();
  setInterval(tick, 1000);
})();
