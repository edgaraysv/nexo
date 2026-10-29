/**
 * nexo-ui.js — interactividad del Design System Nexo
 * Sin dependencias externas. Módulo ES.
 */

// ── Surface switch ────────────────────────────────────────────
export function initSurfaceSwitch(options = {}) {
  const {
    containerId  = 'nx-shell',
    onSwitch     = () => {},
  } = options;

  const root = containerId ? document.getElementById(containerId) ?? document : document;

  root.querySelectorAll('[data-nx-surface]').forEach(btn => {
    btn.addEventListener('click', () => {
      const surface = btn.dataset.nxSurface;
      root.querySelectorAll('[data-nx-surface]').forEach(b => {
        b.setAttribute('aria-pressed', String(b.dataset.nxSurface === surface));
      });
      announce(`Vista: ${btn.textContent.trim()}`);
      onSwitch(surface, btn);
    });
  });
}

// ── Sidebar nav ───────────────────────────────────────────────
export function initSidebarNav(options = {}) {
  const {
    sidebarId = 'nx-sidebar',
    onNavigate = () => {},
  } = options;

  const sidebar = document.getElementById(sidebarId);
  if (!sidebar) return;

  sidebar.querySelectorAll('[data-nx-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      sidebar.querySelectorAll('[data-nx-view]').forEach(b => {
        b.removeAttribute('aria-current');
        b.classList.remove('is-active');
      });
      btn.setAttribute('aria-current', 'page');
      btn.classList.add('is-active');
      const view = btn.dataset.nxView;
      announce(`Vista: ${btn.textContent.trim()}`);
      onNavigate(view, btn);
    });
  });
}

// ── Tabs ──────────────────────────────────────────────────────
export function initTabs(container) {
  const root = typeof container === 'string'
    ? document.querySelector(container)
    : container;
  if (!root) return;

  const tabs    = Array.from(root.querySelectorAll('[role="tab"]'));
  const panels  = Array.from(root.querySelectorAll('[role="tabpanel"]'));

  function activate(tab) {
    tabs.forEach(t => {
      t.setAttribute('aria-selected', 'false');
      t.setAttribute('tabindex', '-1');
    });
    panels.forEach(p => p.hidden = true);

    tab.setAttribute('aria-selected', 'true');
    tab.setAttribute('tabindex', '0');
    const target = document.getElementById(tab.getAttribute('aria-controls'));
    if (target) target.hidden = false;
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', e => {
      const idx = tabs.indexOf(tab);
      if (e.key === 'ArrowRight') { e.preventDefault(); activate(tabs[(idx + 1) % tabs.length]); tabs[(idx + 1) % tabs.length].focus(); }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); activate(tabs[(idx - 1 + tabs.length) % tabs.length]); tabs[(idx - 1 + tabs.length) % tabs.length].focus(); }
      if (e.key === 'Home')       { e.preventDefault(); activate(tabs[0]); tabs[0].focus(); }
      if (e.key === 'End')        { e.preventDefault(); activate(tabs[tabs.length - 1]); tabs[tabs.length - 1].focus(); }
    });
  });

  // Init: activate first
  if (tabs.length) activate(tabs.find(t => t.getAttribute('aria-selected') === 'true') ?? tabs[0]);
}

// ── Dropdown ──────────────────────────────────────────────────
export function initDropdowns(root = document) {
  root.querySelectorAll('[data-nx-dropdown]').forEach(trigger => {
    const menuId = trigger.getAttribute('aria-controls') ?? trigger.dataset.nxDropdown;
    const menu   = document.getElementById(menuId);
    if (!menu) return;

    let open = false;

    function openMenu() {
      open = true;
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      menu.querySelector('[role="menuitem"],[data-nx-menuitem]')?.focus();
    }
    function closeMenu() {
      open = false;
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }

    trigger.addEventListener('click', e => {
      e.stopPropagation();
      open ? closeMenu() : openMenu();
    });
    trigger.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMenu(); }
      if (e.key === 'Escape') closeMenu();
    });
    menu.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeMenu(); trigger.focus(); }
    });
    document.addEventListener('click', e => {
      if (!trigger.contains(e.target) && !menu.contains(e.target)) closeMenu();
    });

    menu.hidden = true;
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'false');
  });
}

// ── Modal ─────────────────────────────────────────────────────
export function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.hidden = false;
  modal.setAttribute('aria-modal', 'true');
  document.body.style.overflow = 'hidden';
  const first = modal.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  first?.focus();
  _trapFocus(modal);
}

export function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.hidden = true;
  document.body.style.overflow = '';
  modal._cleanup?.();
}

function _trapFocus(el) {
  const focusable = () => Array.from(el.querySelectorAll('button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'));
  const handler = e => {
    if (e.key !== 'Tab') return;
    const els = focusable();
    if (!els.length) return;
    const first = els[0], last = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  el.addEventListener('keydown', handler);
  el._cleanup = () => el.removeEventListener('keydown', handler);
}

// ── Dark mode toggle ──────────────────────────────────────────
export function initThemeToggle(buttonId = 'nx-theme-toggle') {
  const btn = document.getElementById(buttonId);
  if (!btn) return;

  const saved = (() => { try { return localStorage.getItem('nx-theme'); } catch { return null; } })();
  if (saved) document.documentElement.setAttribute('data-theme', saved);

  function update() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    btn.setAttribute('aria-label', dark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
    btn.setAttribute('aria-pressed', String(dark));
  }

  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('nx-theme', next); } catch {}
    update();
  });

  update();
}

// ── Live region announcer ─────────────────────────────────────
let _announcer = null;
export function announce(msg, priority = 'polite') {
  if (!_announcer) {
    _announcer = document.createElement('div');
    _announcer.setAttribute('aria-live', priority);
    _announcer.setAttribute('aria-atomic', 'true');
    _announcer.className = 'nx-sr';
    document.body.appendChild(_announcer);
  }
  _announcer.textContent = '';
  requestAnimationFrame(() => { _announcer.textContent = msg; });
}

// ── Skeleton auto-reveal ──────────────────────────────────────
export function revealOnLoad(skeletonId, contentId, delayMs = 0) {
  const sk = document.getElementById(skeletonId);
  const ct = document.getElementById(contentId);
  if (!sk || !ct) return;
  setTimeout(() => { sk.hidden = true; ct.hidden = false; }, delayMs);
}

// ── Auto-init ─────────────────────────────────────────────────
// Call initAll() to wire up all declarative components in one shot.
export function initAll(options = {}) {
  initSurfaceSwitch(options);
  initSidebarNav(options);
  initDropdowns();
  initThemeToggle();
  document.querySelectorAll('[data-nx-tabs]').forEach(initTabs);
}
