'use strict';
// Тема окна. Подключается в <head>, чтобы окно сразу открылось в нужных цветах.
// По умолчанию — как в системе; выбор оператора запоминается.

window.Theme = (() => {
  function stored() {
    try {
      const t = localStorage.getItem('theme');
      return t === 'light' || t === 'dark' ? t : null;
    } catch (err) {
      return null;
    }
  }

  function current() {
    return document.documentElement.dataset.theme;
  }

  function apply(theme) {
    document.documentElement.dataset.theme = theme;
    window.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
  }

  function set(theme) {
    try {
      localStorage.setItem('theme', theme);
    } catch (err) {
      // хранилище недоступно — тема просто не запомнится
    }
    apply(theme);
  }

  const system = window.matchMedia('(prefers-color-scheme: dark)');
  apply(stored() || (system.matches ? 'dark' : 'light'));
  system.addEventListener('change', (e) => {
    if (!stored()) apply(e.matches ? 'dark' : 'light');
  });

  return { current, set };
})();
