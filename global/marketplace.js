// =============================================================================
// /global/marketplace.js — shared marketplace toggle for the multi-marketplace
// dashboard. Load AFTER auth.js and the Supabase client:
//
//   <script src="/global/marketplace.js"></script>
//   ...
//   window.onAuthReady = async function () {
//     loadSharedNav();
//     await MP.init(sb);                 // mounts the switcher in the header
//     MP.onChange(() => render());       // re-render when the user switches
//     render();
//   };
//
// State (sessionStorage, cleared on logout so every login starts on US):
//   blb_mp_market : 'US' | 'CA' | ... | 'ALL'
//   blb_mp_view   : 'LOCAL' | 'USD'   (CAD/USD switch; ALL is always USD)
//
// Main helpers:
//   MP.current()            -> 'US', 'CA', ... or 'ALL'
//   MP.isAll()
//   MP.codes()              -> marketplace codes this view covers (['US','CA'] for ALL)
//   MP.market(code)         -> { code, name, flag, currency, ..., settings }
//   MP.displayCurrency()    -> currency amounts should be shown in right now
//   await MP.loadFx(from, to)        -> load daily rates for the date range
//   MP.toDisplay(amount, currency, date) -> convert one amount for display
//   MP.toUSD(amount, currency, date)
//   MP.money(n, decimals=2) -> formatted in the display currency
//   MP.fxEstimated()        -> how many conversions used the fallback rate
// =============================================================================

(function () {
  'use strict';

  const KEY_MARKET = 'blb_mp_market';
  const KEY_VIEW = 'blb_mp_view';
  const DEFAULT_MARKET = 'US';
  const SYMBOL = { USD: '$', CAD: 'CA$', GBP: '£', AUD: 'A$', EUR: '€' };

  let sb = null;
  let markets = [];            // active marketplaces, in sort order
  const byCode = {};
  const listeners = [];
  const fx = {};               // currency -> [{date, rate}] sorted by date
  let fxEstimatedHits = 0;
  let readyResolve;
  const ready = new Promise(r => { readyResolve = r; });

  function ssGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch {} }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  function current() {
    const v = ssGet(KEY_MARKET);
    if (v === 'ALL') return 'ALL';
    return v && byCode[v] ? v : DEFAULT_MARKET;
  }
  function isAll() { return current() === 'ALL'; }
  function view() { return ssGet(KEY_VIEW) === 'USD' ? 'USD' : 'LOCAL'; }
  function codes() { return isAll() ? markets.map(m => m.code) : [current()]; }
  function market(code) { return byCode[code] || null; }

  function displayCurrency() {
    if (isAll()) return 'USD';
    const m = market(current());
    if (!m) return 'USD';
    return view() === 'USD' ? 'USD' : m.currency;
  }

  function emit() {
    const detail = { marketplace: current(), view: view(), currency: displayCurrency() };
    renderSwitcher();
    for (const fn of listeners) { try { fn(detail); } catch (e) { console.error('MP listener error:', e); } }
    try { window.dispatchEvent(new CustomEvent('marketplaceChange', { detail })); } catch {}
  }
  function set(code) {
    if (code !== 'ALL' && !byCode[code]) return;
    if (code === current()) return;
    ssSet(KEY_MARKET, code);
    emit();
  }
  function setView(v) {
    ssSet(KEY_VIEW, v === 'USD' ? 'USD' : 'LOCAL');
    emit();
  }
  function onChange(fn) { listeners.push(fn); }

  // ---------------------------------------------------------------------------
  // Exchange rates — stored as USD per 1 unit of currency (1 CAD = 0.72 USD)
  // ---------------------------------------------------------------------------
  async function loadFx(from, to) {
    if (!sb) return;
    const needed = [...new Set(markets.map(m => m.currency))].filter(c => c !== 'USD');
    for (const ccy of needed) {
      const rows = [];
      let off = 0;
      while (true) {
        // Start a week early so weekends/holidays at the start of the range
        // can use the last business day before it.
        let q = sb.from('mp_fx_rates').select('date, usd_per_unit').eq('currency', ccy);
        if (from) q = q.gte('date', shiftDate(from, -7));
        if (to) q = q.lte('date', to);
        const { data, error } = await q.order('date', { ascending: true }).range(off, off + 999);
        if (error) { console.error('fx load failed:', error.message); break; }
        rows.push(...(data || []));
        if (!data || data.length < 1000) break;
        off += 1000;
      }
      const merged = new Map((fx[ccy] || []).map(r => [r.date, r.rate]));
      for (const r of rows) merged.set(r.date, Number(r.usd_per_unit));
      fx[ccy] = [...merged.entries()].map(([date, rate]) => ({ date, rate }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));
    }
  }

  function fallbackRate(ccy) {
    const m = markets.find(x => x.currency === ccy && x.settings && x.settings.fallback_usd_rate);
    return m ? Number(m.settings.fallback_usd_rate) : null;
  }

  // Rate on `date`, or the latest one before it.
  function usdRate(ccy, date) {
    if (!ccy || ccy === 'USD') return 1;
    const list = fx[ccy];
    const d = String(date || '').slice(0, 10);
    if (list && list.length && d) {
      let lo = 0, hi = list.length - 1, best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].date <= d) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      // Only trust a rate from within 10 days; older means rates weren't loaded.
      if (best >= 0 && daysApart(list[best].date, d) <= 10) return list[best].rate;
    }
    fxEstimatedHits++;
    return fallbackRate(ccy);
  }

  function toUSD(amount, ccy, date) {
    if (amount == null || !isFinite(amount)) return amount;
    const r = usdRate(ccy, date);
    return r == null ? null : amount * r;
  }

  function convert(amount, fromCcy, toCcy, date) {
    if (amount == null || !isFinite(amount)) return amount;
    if (fromCcy === toCcy) return amount;
    const usd = toUSD(amount, fromCcy, date);
    if (usd == null) return null;
    if (toCcy === 'USD') return usd;
    const r = usdRate(toCcy, date);
    return r ? usd / r : null;
  }

  function toDisplay(amount, fromCcy, date) {
    return convert(amount, fromCcy, displayCurrency(), date);
  }

  function fxEstimated() { return fxEstimatedHits; }
  function resetFxEstimated() { fxEstimatedHits = 0; }

  function money(n, decimals = 2, ccy) {
    if (n == null || !isFinite(n)) return '—';
    const c = ccy || displayCurrency();
    const sym = SYMBOL[c] || (c + ' ');
    const neg = n < 0;
    const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    return (neg ? '-' : '') + sym + s;
  }

  // ---------------------------------------------------------------------------
  // Date helpers (UTC-safe, matching the rest of the dashboard)
  // ---------------------------------------------------------------------------
  function parseISO(s) {
    const p = String(s).slice(0, 10).split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  }
  function toISO(d) {
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  function shiftDate(iso, days) { return toISO(new Date(parseISO(iso).getTime() + days * 86400000)); }
  function daysApart(a, b) { return Math.abs(Math.round((parseISO(b) - parseISO(a)) / 86400000)); }

  // ---------------------------------------------------------------------------
  // Header switcher UI
  // ---------------------------------------------------------------------------
  const CSS = `
    .mp-switch { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .mp-seg { display: inline-flex; background: var(--panel-2); border: 1px solid var(--border);
              border-radius: 999px; padding: 2px; }
    .mp-seg button { border: 0; background: transparent; color: var(--text-dim); cursor: pointer;
              font: inherit; font-size: 12px; font-weight: 600; padding: 5px 11px; border-radius: 999px;
              display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
    .mp-seg button:hover { color: var(--text); }
    .mp-seg button.on { background: var(--accent); color: var(--on-accent); }
    .mp-seg.ccy button { padding: 5px 9px; }
    .mp-seg.ccy button.on { background: var(--tan); color: var(--on-tan); }
    .mp-flag { font-size: 14px; line-height: 1; }
    .mp-badge { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px;
              background: var(--tan-soft); color: var(--text); font-size: 12px; font-weight: 700;
              border: 1px solid var(--tan-edge); vertical-align: middle; }
  `;

  function injectCss() {
    if (document.getElementById('mp-css')) return;
    const s = document.createElement('style');
    s.id = 'mp-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function mountSwitcher() {
    if (document.getElementById('mp-switch')) return;
    const header = document.getElementById('app-header');
    if (!header) return;
    const box = document.createElement('div');
    box.id = 'mp-switch';
    box.className = 'mp-switch';
    const h1 = header.querySelector('h1');
    if (h1 && h1.nextSibling) header.insertBefore(box, h1.nextSibling);
    else header.appendChild(box);
    renderSwitcher();
  }

  function renderSwitcher() {
    const box = document.getElementById('mp-switch');
    if (!box) return;
    const cur = current();
    const opts = markets.map(m => ({ code: m.code, label: m.code, flag: m.flag, title: m.name }));
    if (markets.length > 1) opts.push({ code: 'ALL', label: 'All', flag: '🌎', title: 'All marketplaces (USD)' });

    let html = '<div class="mp-seg" role="group" aria-label="Marketplace">' + opts.map(o =>
      `<button type="button" data-mp="${o.code}" class="${o.code === cur ? 'on' : ''}" title="${o.title}" aria-pressed="${o.code === cur}">` +
      `<span class="mp-flag">${o.flag}</span>${o.label}</button>`).join('') + '</div>';

    const m = cur !== 'ALL' ? market(cur) : null;
    if (m && m.currency !== 'USD') {
      const v = view();
      html += '<div class="mp-seg ccy" role="group" aria-label="Currency">' +
        `<button type="button" data-view="LOCAL" class="${v === 'LOCAL' ? 'on' : ''}" aria-pressed="${v === 'LOCAL'}">${m.currency}</button>` +
        `<button type="button" data-view="USD" class="${v === 'USD' ? 'on' : ''}" aria-pressed="${v === 'USD'}">USD</button>` +
        '</div>';
    }
    box.innerHTML = html;
    box.querySelectorAll('[data-mp]').forEach(b => b.addEventListener('click', () => set(b.dataset.mp)));
    box.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  }

  // Small badge for page titles, e.g. "🇨🇦 Canada · CAD"
  function badgeHtml() {
    if (isAll()) return '<span class="mp-badge">🌎 All marketplaces · USD</span>';
    const m = market(current());
    if (!m) return '';
    return `<span class="mp-badge">${m.flag} ${m.name} · ${displayCurrency()}</span>`;
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  async function init(client, opts = {}) {
    sb = client;
    injectCss();
    const [mk, st] = await Promise.all([
      sb.from('mp_marketplaces').select('*').eq('active', true).order('sort_order'),
      sb.from('mp_marketplace_settings').select('*'),
    ]);
    if (mk.error) {
      console.error('Marketplace load failed:', mk.error.message);
      markets = [{ code: 'US', name: 'United States', flag: '🇺🇸', currency: 'USD', settings: {} }];
    } else {
      const settings = {};
      for (const s of (st.data || [])) settings[s.marketplace] = s;
      markets = mk.data.map(m => ({ ...m, settings: settings[m.code] || {} }));
    }
    markets.forEach(m => { byCode[m.code] = m; });
    if (opts.mount !== false) mountSwitcher();
    readyResolve();
    return MP;
  }

  const MP = {
    init, ready, onChange,
    current, isAll, codes, market, view, set, setView,
    list: () => markets.slice(),
    displayCurrency, loadFx, usdRate, toUSD, convert, toDisplay,
    fxEstimated, resetFxEstimated, money, badgeHtml,
    symbol: c => SYMBOL[c] || c,
  };
  window.MP = MP;
})();
