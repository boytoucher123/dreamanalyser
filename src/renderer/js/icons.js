'use strict';
/* Inline SVG icons (stroke-based, inherit currentColor). */
(function () {
  const p = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICONS = {
    refresh: p('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
    settings: p('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    search: p('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    folder: p('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    sparkle: p('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>'),
    back: p('<path d="M15 18l-6-6 6-6"/>'),
    edit: p('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z"/>'),
    restart: p('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>'),
    trash: p('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>'),
    send: p('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>'),
    close: p('<path d="M18 6 6 18M6 6l12 12"/>'),
    undo: p('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
    next: p('<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>'),
    skip: p('<path d="m5 4 10 8-10 8z"/><path d="M19 5v14"/>'),
    stop: p('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
    play: p('<path d="m6 4 14 8-14 8z"/>'),
    chevron: p('<path d="m9 6 6 6-6 6"/>'),
    moon: p('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
    star: p('<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>'),
    alert: p('<path d="M12 3 2 20h20z"/><path d="M12 10v4"/><path d="M12 17.5v.01"/>'),
    check: p('<path d="M20 6 9 17l-5-5"/>'),
    feather: p('<path d="M20.2 3.8a6 6 0 0 0-8.5 0L5 10.5V19h8.5l6.7-6.7a6 6 0 0 0 0-8.5z"/><path d="M16 8 2 22"/><path d="M17.5 15H9"/>'),
  };
  window.Icons = ICONS;
  window.icon = (name) => ICONS[name] || '';

  function hydrate(root = document) {
    root.querySelectorAll('[data-icon]').forEach((el) => {
      if (!el.dataset.hydrated) {
        el.insertAdjacentHTML('afterbegin', ICONS[el.dataset.icon] || '');
        el.dataset.hydrated = '1';
      }
    });
    root.querySelectorAll('[data-icon-left]').forEach((el) => {
      if (!el.dataset.hydrated) {
        el.insertAdjacentHTML('afterbegin', ICONS[el.dataset.iconLeft] || '');
        el.dataset.hydrated = '1';
      }
    });
  }
  window.hydrateIcons = hydrate;
  document.addEventListener('DOMContentLoaded', () => hydrate());
})();
