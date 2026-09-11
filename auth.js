// =============================================================================
// auth.js — Shared 4-role authentication for the Burlebo Analytics dashboard
// -----------------------------------------------------------------------------
// Load early in every dashboard page:  <script src="/auth.js"></script>
//
// What this does:
//   1. Defines the 4 roles + their passwords + the page-access matrix.
//   2. Persists the chosen role in sessionStorage so logging in once on any
//      page carries across all dashboard pages until the browser closes.
//   3. Injects the role-pick modal + denied panel HTML so individual pages
//      don't have to copy/paste that boilerplate.
//   4. On page load, checks the stored role against the access matrix for
//      the current page and either:
//        - allowed:  fires window event 'authReady' for the page to start
//        - denied:   shows the denied panel + redirects in 3 seconds
//        - no role:  shows the role-picker modal
//
// Per-page expectations:
//   - Each page must have its own <header id="app-header"> with a
//     <span id="role-pill" onclick="AuthApp.logout()"> inside it.
//   - Each page must have <main id="app-main" class="hidden"> as the wrapper
//     for its content.
//   - Each page provides a function `onAuthReady(role)` that is called once
//     auth completes. (Or listens for the 'authReady' window event.)
//
// View-only:
//   - AuthApp.isViewOnly() returns true if the current role is allowed on
//     this page only in view-only mode. Pages that care should consult this
//     when wiring up edit/delete buttons.
// =============================================================================

(function () {
  'use strict';

  // ===========================================================================
  // THEME  (added with the BURLEBO retheme)
  // ---------------------------------------------------------------------------
  // Runs before anything paints so there is no flash of the old theme.
  //   light  -> off-white + Kraft Tan, Classic Deer camo  (default)
  //   dark   -> warm brown-black + Kraft Tan, Bendita camo
  // Saved per browser in localStorage, so each person keeps their own choice.
  // The switch is appended to the nav once the page's nav has loaded.
  // ===========================================================================
  const THEME_KEY = 'blb-theme';
  const THEME_DEFAULT = 'light';

  function themeRead() {
    try { return localStorage.getItem(THEME_KEY); } catch { return null; }
  }
  function themeWrite(v) {
    try { localStorage.setItem(THEME_KEY, v); } catch {}
  }
  function themeCurrent() {
    return document.documentElement.getAttribute('data-theme') || THEME_DEFAULT;
  }
  function themeApply(t) {
    document.documentElement.setAttribute('data-theme', t);
  }

  // Set the attribute and pull in the stylesheet immediately.
  (function themeBoot() {
    const saved = themeRead();
    themeApply(saved === 'dark' || saved === 'light' ? saved : THEME_DEFAULT);
    if (!document.getElementById('blb-theme-css')) {
      const link = document.createElement('link');
      link.id = 'blb-theme-css';
      link.rel = 'stylesheet';
      link.href = '/theme.css';
      document.head.appendChild(link);
    }
  })();

  function labelThemeToggle(btn) {
    const dark = themeCurrent() === 'dark';
    btn.textContent = dark ? '\u2600' : '\u263E';   // sun / moon
    btn.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
    btn.setAttribute('aria-label', btn.title);
  }

  // The nav is filled in asynchronously by each page's loadSharedNav(), so
  // this is retried briefly rather than assuming the nav exists yet.
  function mountThemeToggle() {
    if (document.getElementById('theme-toggle')) return true;
    const nav = document.getElementById('main-nav');
    if (!nav) return false;

    const btn = document.createElement('button');
    btn.id = 'theme-toggle';
    btn.className = 'theme-toggle';
    btn.type = 'button';
    labelThemeToggle(btn);
    btn.addEventListener('click', () => {
      const next = themeCurrent() === 'dark' ? 'light' : 'dark';
      themeApply(next);
      themeWrite(next);
      labelThemeToggle(btn);
    });

    // Appended last so it sits to the right of the role pill — loadSharedNav
    // inserts links *before* the pill, so this stays out of its way.
    nav.appendChild(btn);
    return true;
  }

  function startThemeToggle() {
    if (mountThemeToggle()) return;
    let tries = 0;
    const timer = setInterval(() => {
      if (mountThemeToggle() || ++tries > 40) clearInterval(timer);
    }, 100);
  }

  // ---------------------------------------------------------------------------
  // Role definitions
  // ---------------------------------------------------------------------------
  const ROLES = {
    coy:      { name: 'Coy Needham (Owner)', password: 'coyneedham', cls: 'coy'      },
    designer: { name: 'Graphic Designer',    password: 'Graphic',    cls: 'designer' },
    admin:    { name: 'Executive Admin',     password: 'Admin',      cls: 'admin'    },
    employee: { name: 'Employee',            password: 'Burlebo',    cls: 'employee' },
    brooks:   { name: 'Brooks Loria',        password: 'BL',         cls: 'employee' },
    spencer:  { name: 'Assistant',           password: 'Spencer',    cls: 'coy'      },
  };

  // ---------------------------------------------------------------------------
  // Access matrix — keys are page paths, values describe per-role access.
  //   'edit'       → full access
  //   'view'       → access, but in view-only mode (page should consult isViewOnly)
  //   undefined    → no access (will show denied panel + redirect)
  //
  // For paths, we normalize: '/' → '/index.html', strip trailing slashes.
  // ---------------------------------------------------------------------------
  const ACCESS = {
    '/index.html':          { coy: 'edit', designer: 'edit'                                 }, // Tracker
    '/dashboard.html':      { coy: 'edit',                   admin: 'edit'                   },
    '/todo.html':           { coy: 'edit'                                                    },
    '/settings.html':       { coy: 'edit'                                                    },
    '/upload.html':         { coy: 'edit',                   admin: 'edit'                   },
    '/inventory.html':      { coy: 'edit',                   admin: 'edit', employee: 'edit', brooks: 'edit' },
    '/shipment.html':       { coy: 'edit',                   admin: 'edit', employee: 'edit', brooks: 'edit' },
    '/analytics.html':      { coy: 'edit',                   admin: 'edit', employee: 'edit' },
    '/sku.html':            { coy: 'edit',                   admin: 'edit', employee: 'edit' },
    '/snapshot.html':       { coy: 'edit',                   admin: 'edit'                   },
    '/goal.html':           { coy: 'edit',                   admin: 'edit'                   },
    '/ads.html':            { coy: 'edit',                   admin: 'edit'                   },
    '/cannibalization.html':{ coy: 'edit',                   admin: 'edit'                   },
    '/profit.html':         { coy: 'edit',                   admin: 'edit'                   },
    '/report.html':         { coy: 'edit',                   admin: 'edit'                   },
    '/lookout.html':        { coy: 'edit',                   admin: 'edit', brooks: 'edit' },
    '/planner.html':        { coy: 'edit',                   admin: 'edit'                   },
    '/audit.html':          { coy: 'edit',                   admin: 'edit', brooks: 'edit' },
    '/boxcontent.html':     { coy: 'edit',                   admin: 'edit', employee: 'edit', brooks: 'edit' },
    '/bgwhite.html':        { coy: 'edit',                   admin: 'edit', employee: 'edit', brooks: 'edit' },
    '/tools.html':          { coy: 'edit',                   admin: 'edit', employee: 'edit', brooks: 'edit' },
  };

  // The Assistant (Spencer) mirrors Coy's page access exactly. Adding a page to
  // Coy above automatically grants it to Spencer — no second list to maintain.
  for (const path of Object.keys(ACCESS)) {
    if (ACCESS[path].coy) ACCESS[path].spencer = ACCESS[path].coy;
  }

  // Human-readable page names — matches the labels in nav.html so the
  // denied panel's "you can access" list reads naturally.
  const PAGE_LABELS = {
    '/index.html':          'Tracker',
    '/dashboard.html':      'Dashboard',
    '/snapshot.html':       'Snapshot',
    '/upload.html':         'Upload',
    '/analytics.html':      'Analytics',
    '/ads.html':            'Ad Performance',
    '/profit.html':         'Profit',
    '/inventory.html':      'FBA Inventory',
    '/shipment.html':       'FBA Shipment',
    '/lookout.html':        'FBA Lookout',
    '/planner.html':        'Demand Planner',
    '/audit.html':          'Amazon Inventory Audit',
    '/boxcontent.html':     'FBA Box Content Filler',
    '/bgwhite.html':        'White Background Maker',
    '/tools.html':          'Tools',
    '/sku.html':            'SKU Lookup',
    '/report.html':         'Big Picture',
    '/cannibalization.html':'Cannibalization',
    '/todo.html':           'To-Do',
    '/goal.html':           'Goal Tracker',
    '/settings.html':       'Settings',
  };

  // Build the list of pages a role can access. Returns [{path, label}, …]
  // in nav.html order, so users see the same ordering they're used to.
  const PAGE_ORDER = [
    '/index.html', '/dashboard.html', '/snapshot.html', '/upload.html',
    '/analytics.html', '/ads.html', '/profit.html', '/inventory.html',
    '/shipment.html', '/lookout.html', '/planner.html', '/sku.html', '/report.html',
    '/tools.html', '/audit.html', '/boxcontent.html', '/bgwhite.html', '/cannibalization.html', '/todo.html', '/goal.html', '/settings.html',
  ];
  function pagesForRole(role) {
    const out = [];
    for (const path of PAGE_ORDER) {
      if (accessFor(role, path)) {
        out.push({ path, label: PAGE_LABELS[path] || path });
      }
    }
    return out;
  }

  // Track the last *allowed* page the user visited, so when they hit a denied
  // page we can send them back to where they came from. Stored in sessionStorage
  // so it survives a reload but dies when the browser tab closes.
  const LAST_PAGE_KEY = 'burlebo_last_page';
  function rememberLastPage(path) {
    try { sessionStorage.setItem(LAST_PAGE_KEY, path); } catch {}
  }
  function getLastPage() {
    try { return sessionStorage.getItem(LAST_PAGE_KEY); } catch { return null; }
  }

  // ---------------------------------------------------------------------------
  // sessionStorage helpers
  // ---------------------------------------------------------------------------
  const STORAGE_KEY = 'burlebo_role';
  function loadStoredRole() {
    try {
      const r = sessionStorage.getItem(STORAGE_KEY);
      return (r && ROLES[r]) ? r : null;
    } catch { return null; }
  }
  function saveStoredRole(r) {
    try { sessionStorage.setItem(STORAGE_KEY, r); } catch {}
  }
  function clearStoredRole() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
  }

  function currentPath() {
    let p = window.location.pathname.replace(/\/+$/, '');
    if (p === '' || p === '/') return '/index.html';
    return p;
  }

  function accessFor(role, path) {
    const entry = ACCESS[path];
    if (!entry) return 'edit'; // pages not listed are open (won't normally happen)
    return entry[role] || null;
  }

  // ---------------------------------------------------------------------------
  // Public state
  // ---------------------------------------------------------------------------
  let pendingRole = null;
  let redirectTimer = null;

  const AuthApp = {
    role: null,
    access: null, // 'edit' | 'view'
    isViewOnly() { return this.access === 'view'; },
    isAllowed(role, path) { return accessFor(role, path || currentPath()) != null; },
    logout() {
      clearStoredRole();
      window.location.reload();
    },
  };
  window.AuthApp = AuthApp;

  // ---------------------------------------------------------------------------
  // CSS — injected once so every page gets the modal + denied styles
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // CSS — injected once so every page gets the modal + denied styles.
  // All colors are HARDCODED (no var() lookups) so the modal looks identical
  // on the dark dashboard pages AND the light-themed tracker page.
  // ---------------------------------------------------------------------------
  const CSS = `
    .auth-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.72); backdrop-filter: blur(4px);
      display: flex; align-items: center; justify-content: center;
      z-index: 10000;
      font-family: 'Archivo', 'DM Sans', system-ui, sans-serif;
    }
    .auth-card {
      background: var(--panel, #14171c);
      border: 1px solid var(--border, #252a33);
      border-radius: var(--radius, 10px);
      padding: 28px; width: 380px; max-width: calc(100vw - 32px);
      color: var(--text, #e8eaed);
      box-shadow: var(--shadow-lg, 0 24px 64px rgba(0,0,0,0.5));
    }
    .auth-title { font-size: 18px; font-weight: 700; margin: 0 0 6px 0; color: var(--text, #e8eaed); }
    .auth-sub   { font-size: 13px; color: var(--text-dim, #8a92a0); margin: 0 0 20px 0; }
    .auth-options { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
    .auth-option {
      background: var(--panel-2, #1a1e25);
      border: 1px solid var(--border, #252a33);
      color: var(--text, #e8eaed);
      padding: 13px 14px;
      border-radius: var(--radius-sm, 6px);
      font-family: inherit; font-size: 14px; font-weight: 500;
      text-align: left; cursor: pointer;
      display: flex; align-items: center; gap: 10px;
    }
    .auth-option:hover { background: var(--hover, #1f242c); border-color: var(--hover-edge, #2f3540); }
    .auth-option .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .auth-option .dot.coy      { background: var(--coy, var(--accent, #ff6b35)); }
    .auth-option .dot.designer { background: var(--designer, #a78bfa); }
    .auth-option .dot.admin    { background: var(--admin, #4ade80); }
    .auth-option .dot.employee { background: var(--employee, #38bdf8); }

    .auth-pw { display: none; margin-top: 8px; }
    .auth-pw input {
      width: 100%; padding: 11px 12px;
      font-family: 'Archivo', 'DM Sans', sans-serif; font-size: 14px;
      background: var(--bg, #0d0f12); color: var(--text, #e8eaed);
      border: 1px solid var(--border, #252a33);
      border-radius: var(--radius-sm, 6px);
      outline: none; margin-bottom: 8px; box-sizing: border-box;
    }
    .auth-pw input:focus { border-color: var(--slate, var(--accent, #ff6b35)); }
    .auth-err { display: none; font-size: 12px; color: var(--red, #f87171); margin-bottom: 8px; }
    .auth-pw-row { display: flex; gap: 8px; }
    .auth-btn {
      flex: 1; padding: 10px 14px;
      font-family: inherit; font-size: 13px; font-weight: 600;
      border-radius: var(--radius-sm, 6px); cursor: pointer;
      border: 1px solid var(--border, #252a33);
    }
    .auth-btn.ghost   { background: transparent; color: var(--text, #e8eaed); }
    .auth-btn.primary { background: var(--accent, var(--accent, #ff6b35)); color: var(--on-accent, #fff); border-color: var(--accent, var(--accent, #ff6b35)); }
    .auth-btn.ghost:hover   { background: var(--panel-2, #1a1e25); }
    .auth-btn.primary:hover { opacity: 0.92; }

    /* Denied panel — also fully hardcoded so it reads correctly on the
       light tracker theme as well as the dark dashboard pages. */
    .auth-denied {
      max-width: 480px; margin: 80px auto; text-align: center;
      background: var(--panel, #14171c);
      border: 1px solid var(--border, #252a33);
      border-radius: var(--radius, 10px);
      padding: 36px 28px;
      font-family: 'Archivo', 'DM Sans', system-ui, sans-serif;
      color: var(--text, #e8eaed);
      box-shadow: var(--shadow-lg, 0 24px 64px rgba(0,0,0,0.5));
    }
    .auth-denied .icon {
      width: 56px; height: 56px; margin: 0 auto 16px;
      border-radius: 50%; background: var(--red-bg, rgba(248,113,113,0.12));
      display: flex; align-items: center; justify-content: center;
      font-size: 24px;
    }
    .auth-denied h3 { font-size: 17px; font-weight: 700; margin: 0 0 8px 0; color: var(--text, #e8eaed); }
    .auth-denied p  { font-size: 14px; color: var(--text-dim, #8a92a0); margin: 0 0 18px 0; line-height: 1.5; }
    .auth-denied .countdown { font-size: 12px; color: var(--text-dim, #8a92a0); margin-top: 14px; }
    .auth-denied .actions { display: flex; gap: 8px; justify-content: center; }

    /* "Coy can access:" label above the pill list */
    .auth-denied-pages-label {
      font-size: 11px;
      color: var(--text-dim, #8a92a0);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 10px;
    }
    /* Page pills the role can navigate to */
    .auth-denied-pages {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: center;
      margin-bottom: 22px;
    }
    .auth-denied-page {
      display: inline-block;
      padding: 8px 14px;
      border-radius: var(--radius-sm, 6px);
      background: var(--panel-2, #1a1e25);
      border: 1px solid var(--border, #252a33);
      color: var(--text, #e8eaed);
      font-size: 13px;
      font-weight: 500;
      text-decoration: none;
      transition: background 0.15s, border-color 0.15s;
    }
    .auth-denied-page:hover {
      background: var(--hover, #1f242c);
      border-color: var(--accent, #ff6b35);
      color: var(--accent, #ff6b35);
    }
    /* Demoted "Switch role" text link at the very bottom */
    .auth-denied-switch {
      margin-top: 18px;
      padding-top: 14px;
      border-top: 1px solid var(--border, #252a33);
      font-size: 12px;
    }
    .auth-denied-switch a {
      color: var(--text-dim, #8a92a0);
      cursor: pointer;
      text-decoration: underline;
      text-decoration-color: var(--hover-edge, #2f3540);
      text-underline-offset: 3px;
    }
    .auth-denied-switch a:hover { color: var(--text, #e8eaed); text-decoration-color: var(--text-dim, #8a92a0); }
  `;

  function injectStyles() {
    const s = document.createElement('style');
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------------------
  // Modal & denied-panel HTML builders
  // ---------------------------------------------------------------------------
  function buildModalHtml() {
    return `
      <div class="auth-overlay" id="auth-modal">
        <div class="auth-card">
          <div class="auth-title">Burlebo Analytics</div>
          <div class="auth-sub" id="auth-modal-sub">Choose your role to get started.</div>
          <div class="auth-options" id="auth-role-options">
            <button class="auth-option" data-role="coy">      <span class="dot coy"></span>      Coy Needham (Owner) </button>
            <button class="auth-option" data-role="designer"> <span class="dot designer"></span> Graphic Designer    </button>
            <button class="auth-option" data-role="admin">    <span class="dot admin"></span>    Executive Admin     </button>
            <button class="auth-option" data-role="employee"> <span class="dot employee"></span> Employee            </button>
            <button class="auth-option" data-role="brooks">    <span class="dot employee"></span> Brooks Loria        </button>
            <button class="auth-option" data-role="spencer">  <span class="dot coy"></span>      Assistant           </button>
          </div>
          <div class="auth-pw" id="auth-pw-field">
            <input id="auth-pw-input" type="password" placeholder="Enter password" autocomplete="current-password">
            <div class="auth-err" id="auth-pw-err">Incorrect password.</div>
            <div class="auth-pw-row">
              <button class="auth-btn ghost"   id="auth-pw-back">Back</button>
              <button class="auth-btn primary" id="auth-pw-go">Continue</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function buildDeniedHtml(role, target) {
    const roleLabel = ROLES[role]?.name || role;
    const allowed = pagesForRole(role);

    // List of pages this role CAN access (Tracker, FBA Inventory, etc.)
    const pagesHtml = allowed.length > 0 ? `
        <div class="auth-denied-pages-label">${roleLabel.split(' ')[0]} can access:</div>
        <div class="auth-denied-pages">
          ${allowed.map(p =>
            `<a class="auth-denied-page" href="${p.path}">${p.label}</a>`
          ).join('')}
        </div>
    ` : '';

    // Primary action: go back (only when there's a previous page to return to)
    const goBackHtml = target ? `
        <div class="actions">
          <button class="auth-btn primary" id="auth-denied-go">Go back now</button>
        </div>
        <div class="countdown" id="auth-denied-count">Going back in 3s…</div>
    ` : '';

    // Demoted "Switch role" — small text link at the bottom
    return `
      <div class="auth-denied">
        <div class="icon">🔒</div>
        <h3>Access restricted</h3>
        <p>${roleLabel} doesn't have access to this page.</p>
        ${pagesHtml}
        ${goBackHtml}
        <div class="auth-denied-switch">
          <a id="auth-denied-logout">Switch role</a>
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Modal flow
  // ---------------------------------------------------------------------------
  function showModal() {
    const container = document.createElement('div');
    container.id = 'auth-modal-host';
    container.innerHTML = buildModalHtml();
    document.body.appendChild(container);

    // Wire role buttons
    container.querySelectorAll('.auth-option').forEach(btn => {
      btn.addEventListener('click', () => pickRole(btn.dataset.role));
    });
    document.getElementById('auth-pw-back').addEventListener('click', cancelPw);
    document.getElementById('auth-pw-go').addEventListener('click', checkPw);
    const input = document.getElementById('auth-pw-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') checkPw();
      else if (e.key === 'Escape') cancelPw();
    });
  }

  function pickRole(r) {
    pendingRole = r;
    document.getElementById('auth-modal-sub').textContent = `Enter password for ${ROLES[r].name}.`;
    document.getElementById('auth-role-options').style.display = 'none';
    document.getElementById('auth-pw-field').style.display = 'block';
    const input = document.getElementById('auth-pw-input');
    input.value = '';
    document.getElementById('auth-pw-err').style.display = 'none';
    input.focus();
  }

  function cancelPw() {
    pendingRole = null;
    document.getElementById('auth-modal-sub').textContent = 'Choose your role to get started.';
    document.getElementById('auth-role-options').style.display = 'flex';
    document.getElementById('auth-pw-field').style.display = 'none';
  }

  function checkPw() {
    if (!pendingRole) return;
    const val = document.getElementById('auth-pw-input').value;
    if (val === ROLES[pendingRole].password) {
      const path = currentPath();
      const acc = accessFor(pendingRole, path);
      saveStoredRole(pendingRole);
      // Tear down the modal
      const host = document.getElementById('auth-modal-host');
      if (host) host.remove();

      if (acc) {
        completeAuth(pendingRole, acc);
      } else {
        // Logged in but not allowed here — show denied + redirect
        showDenied(pendingRole);
      }
      pendingRole = null;
    } else {
      document.getElementById('auth-pw-err').style.display = 'block';
      const input = document.getElementById('auth-pw-input');
      input.value = '';
      input.focus();
    }
  }

  // ---------------------------------------------------------------------------
  // Denied panel flow
  // ---------------------------------------------------------------------------
  function showDenied(role) {
    const here = currentPath();
    const last = getLastPage();
    // Only auto-redirect if there's a previous page AND it's not the page we're
    // currently on (would be a no-op redirect loop).
    const target = (last && last !== here) ? last : null;

    // Hide existing app shell so user doesn't briefly see the page they
    // can't access while the countdown runs.
    const header = document.getElementById('app-header');
    const main   = document.getElementById('app-main');
    if (header) header.style.display = 'none';
    if (main)   main.classList.add('hidden');

    const host = document.createElement('div');
    host.id = 'auth-denied-host';
    host.innerHTML = buildDeniedHtml(role, target);
    document.body.appendChild(host);

    if (target) {
      let seconds = 3;
      const countEl = document.getElementById('auth-denied-count');
      redirectTimer = setInterval(() => {
        seconds -= 1;
        if (seconds <= 0) {
          clearInterval(redirectTimer);
          window.location.href = target;
        } else {
          countEl.textContent = `Going back in ${seconds}s…`;
        }
      }, 1000);

      const goBtn = document.getElementById('auth-denied-go');
      if (goBtn) {
        goBtn.addEventListener('click', () => {
          clearInterval(redirectTimer);
          window.location.href = target;
        });
      }
    }

    document.getElementById('auth-denied-logout').addEventListener('click', () => {
      if (redirectTimer) clearInterval(redirectTimer);
      AuthApp.logout();
    });
  }

  // ---------------------------------------------------------------------------
  // Completion — page gets to do its thing
  // ---------------------------------------------------------------------------
  function completeAuth(role, access) {
    AuthApp.role = role;
    AuthApp.access = access;

    // Remember this page as the user's last successful destination, so if they
    // navigate to a denied page next we can send them back here.
    rememberLastPage(currentPath());

    // Style the role pill if the page has one
    const pill = document.getElementById('role-pill');
    if (pill) {
      pill.className = 'role-pill ' + ROLES[role].cls;
      pill.textContent = ROLES[role].name + (access === 'view' ? ' (view)' : '') + ' ✕';
      // Make sure it logs out on click — pages may already have onclick="logout()"
      // wired to a local function. We attach a defensive backup.
      if (!pill.dataset.authBound) {
        pill.addEventListener('click', AuthApp.logout);
        pill.dataset.authBound = '1';
      }
    }

    // Drop the light/dark switch into the nav
    startThemeToggle();

    // Reveal app shell if hidden
    const header = document.getElementById('app-header');
    const main   = document.getElementById('app-main');
    if (header && getComputedStyle(header).display === 'none') header.style.display = 'flex';
    if (main && main.classList.contains('hidden')) main.classList.remove('hidden');

    // Notify the page in two ways: a custom event AND, if present, a global hook.
    try { window.dispatchEvent(new CustomEvent('authReady', { detail: { role, access } })); } catch {}
    if (typeof window.onAuthReady === 'function') {
      try { window.onAuthReady(role, access); } catch (e) { console.error('onAuthReady error:', e); }
    }
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  function boot() {
    injectStyles();

    const stored = loadStoredRole();
    if (!stored) {
      showModal();
      return;
    }
    const path = currentPath();
    const acc = accessFor(stored, path);
    if (acc) {
      completeAuth(stored, acc);
    } else {
      showDenied(stored);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
