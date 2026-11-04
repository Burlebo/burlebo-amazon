// =============================================================================
// /global/profit-engine.js — the one profit calculation, shared by Profit,
// Big Picture and Snapshot so every page shows the same numbers.
// Needs window.sb (Supabase client) and /global/marketplace.js loaded first.
//
//   await ProfitEngine.loadGroups();
//   await MP.loadFx(start, end);
//   const r = await ProfitEngine.computeMarket('US', start, end);
//   const t = ProfitEngine.sumLines(r.skus);   // revenue, fees, cogs, ads, profit...
//   const overhead = r.overhead.reduce((a, o) => a + o.amount, 0);
// =============================================================================
(function () {
  'use strict';
  // Looked up when used, so this file can load before the page creates its client.
  const sb = { from: (...a) => window.sb.from(...a), rpc: (...a) => window.sb.rpc(...a) };
  // ============================================================================
  // Helpers
  // ============================================================================
  const AMAZON_LEAKAGE_RATE = 0.08;   // estimated mode only: refunds, promos, adjustments
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  function toISO(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0') + '-' + String(d.getUTCDate()).padStart(2,'0'); }
  function parseISO(s) { const p = String(s).slice(0,10).split('-').map(Number); return new Date(Date.UTC(p[0], p[1]-1, p[2])); }
  function addDays(iso, n) { const d = parseISO(iso); d.setUTCDate(d.getUTCDate() + n); return toISO(d); }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }
  function fmtLong(iso) { return parseISO(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
  const money = (n, d = 0) => n == null || !isFinite(n) ? '—' : MP.money(d ? n : Math.round(n), d);
  const fmtN = n => n == null ? '—' : Math.round(n).toLocaleString();
  const fmtP = n => n == null || !isFinite(n) ? '—' : (n * 100).toFixed(1) + '%';
  const cls = n => n < 0 ? 'neg' : '';

  async function fetchPaged(build) {
    const out = []; let off = 0;
    while (true) {
      const { data, error } = await build().order('id', { ascending: true }).range(off, off + 999);
      if (error) throw new Error(error.message);
      out.push(...(data || []));
      if (!data || data.length < 1000) break;
      off += 1000;
    }
    return out;
  }


  // ============================================================================
  // Product groups (COGS is the same everywhere, in USD) + fallback fees
  // ============================================================================
  let PREFIXES = null, FEES = null;
  async function loadGroups() {
    if (PREFIXES) return;
    const [p, f] = await Promise.all([
      sb.from('product_group_prefixes').select('prefix, group_id, product_groups(id, group_name, cogs, fbm_fee, fba_fee)'),
      sb.from('mp_group_fees').select('*'),
    ]);
    if (p.error) throw new Error(p.error.message);
    PREFIXES = (p.data || []).map(x => ({
      prefix: x.prefix.toUpperCase(), group_id: x.group_id,
      group: x.product_groups?.group_name || 'Other',
      cogs: Number(x.product_groups?.cogs || 0),
      fba_fee: Number(x.product_groups?.fba_fee || 0), fbm_fee: Number(x.product_groups?.fbm_fee || 0),
    })).sort((a, b) => b.prefix.length - a.prefix.length);
    FEES = {};
    for (const r of (f.data || [])) FEES[`${r.group_id}|${r.marketplace}`] = r;
  }
  function matchGroup(sku) {
    const s = String(sku || '').toUpperCase();
    return PREFIXES.find(p => s.startsWith(p.prefix)) || null;
  }
  // Fallback fee per unit for estimated mode: this marketplace's fee table,
  // else the US one converted.
  function feeFor(g, code, isFba, date) {
    const own = FEES[`${g.group_id}|${code}`];
    if (own && (isFba ? own.fba_fee : own.fbm_fee) != null) return { amt: MP.toDisplay(Number(isFba ? own.fba_fee : own.fbm_fee), own.currency, date), own: true };
    const us = FEES[`${g.group_id}|US`];
    const usd = us ? Number(isFba ? us.fba_fee : us.fbm_fee) : (isFba ? g.fba_fee : g.fbm_fee);
    return { amt: MP.toDisplay(usd || 0, 'USD', date), own: code === 'US' };
  }

  // ============================================================================
  // One marketplace
  // The heavy lifting (adding up tens of thousands of transaction and ad rows,
  // converting currency at each day's rate) happens in Supabase functions
  // mp_profit_tx / mp_profit_ads / mp_profit_sales, which return one row per SKU.
  // ============================================================================
  async function rpcAll(fn, args) {
    const out = []; let off = 0;
    while (true) {
      const { data, error } = await sb.rpc(fn, args).range(off, off + 999);
      if (error) throw new Error(`${fn}: ${error.message}`);
      out.push(...(data || []));
      if (!data || data.length < 1000) break;
      off += 1000;
    }
    return out;
  }
  const N = v => Number(v) || 0;

  // Friendlier names for Amazon's non-order charges
  function chargeLabel(type, label) {
    const l = String(label || '').trim();
    if (/ReturnPostageBilling/i.test(l)) return 'Return labels for FBM returns';
    if (type === 'Shipping Services') return 'Shipping services: ' + (l || 'other');
    if (!l || /^(other|adjustment)$/i.test(l)) return `${type}${l && l !== type ? ': ' + l : ''}`;
    return l;
  }

  // Refunds and promotions as a share of product sales, from the latest 90 days
  // of actual transactions. Used only for days without a transaction report.
  const LEAK_CACHE = {};
  async function leakageRate(code, spans, ccy) {
    if (!spans.length) return { rate: AMAZON_LEAKAGE_RATE, measured: false };
    const [first, last] = [spans[spans.length - 1][0], spans[spans.length - 1][1]];
    const from = addDays(last, -89) > first ? addDays(last, -89) : first;
    const key = `${code}|${from}|${last}`;
    if (LEAK_CACHE[key]) return LEAK_CACHE[key];
    let os = 0, units = 0, lost = 0;
    for (const r of await rpcAll('mp_profit_tx', { p_mk: code, p_from: from, p_to: last, p_ccy: ccy })) {
      if (!r.sku) continue;
      if (r.type === 'Order') { os += N(r.product_sales); units += N(r.qty); lost += N(r.promotional_rebates); }
      else if (r.type === 'Refund' || /a-to-z/i.test(r.type)) lost += N(r.product_sales) + N(r.promotional_rebates);
    }
    const out = units >= 100 && os > 0
      ? { rate: Math.min(0.3, Math.max(0, -lost / os)), measured: true, window: [from, last] }
      : { rate: AMAZON_LEAKAGE_RATE, measured: false };
    LEAK_CACHE[key] = out;
    return out;
  }

  async function computeMarket(code, s, e) {
    const m = MP.market(code);
    const settings = m.settings || {};
    const notes = [];
    const ccy = MP.displayCurrency();
    const args = { p_mk: code, p_from: s, p_to: e, p_ccy: ccy };

    // Fee source: actual if uploaded transaction reports cover the whole range
    const { data: logs } = await sb.from('mp_uploads').select('date_from, date_to').eq('marketplace', code)
      .eq('report_type', 'transactions').eq('status', 'ok').not('date_from', 'is', null);
    const spans = mergeSpans((logs || []).map(l => [l.date_from, l.date_to]));
    // Split the range: days covered by transaction reports use Amazon's actual
    // fees; any days outside them use estimates.
    const covered = [], uncovered = [];
    for (const [a, b] of spans) { const lo = a > s ? a : s, hi = b < e ? b : e; if (lo <= hi) covered.push([lo, hi]); }
    let cur = s;
    for (const [lo, hi] of covered) { if (cur < lo) uncovered.push([cur, addDays(lo, -1)]); if (addDays(hi, 1) > cur) cur = addDays(hi, 1); }
    if (cur <= e) uncovered.push([cur, e]);
    const mode = !uncovered.length ? 'actual' : !covered.length ? 'estimated' : 'mixed';
    const days = list => list.reduce((t, [a, b]) => t + Math.round((parseISO(b) - parseISO(a)) / 86400000) + 1, 0);

    const [ads, overheadRows, terms] = await Promise.all([
      rpcAll('mp_profit_ads', args),
      sb.from('mp_overhead_monthly').select('*').eq('marketplace', code).gte('month', s.slice(0, 8) + '01').lte('month', e),
      sb.from('mp_agency_terms').select('*').eq('marketplace', code),
    ]);

    const SKU = new Map();
    const unmatched = new Map();
    const line = (sku, g) => {
      let x = SKU.get(sku);
      if (!x) { x = { sku, group: g.group, market: code, units: 0, fbaUnits: 0, refunds: 0, liquidated: 0, revenue: 0, fees: 0, reimb: 0, cogs: 0, ship: 0, ads: 0, leakage: 0 }; SKU.set(sku, x); }
      return x;
    };
    const charges = new Map();
    let adBilled = 0, fbmOrders = 0, fxEst = 0;
    const shipUSD = N(settings.fbm_ship_cost_per_order);   // entered in USD

    // ---- Covered days: actual fees ----
    for (const [a, b] of covered) {
      for (const r of await rpcAll('mp_profit_tx', { ...args, p_from: a, p_to: b })) {
        fxEst += N(r.fx_estimated);
        if (r.type === 'Transfer') continue;                          // payouts to the bank
        if (!r.sku) {
          if (/advertis/i.test(r.label || '')) { adBilled -= N(r.total); continue; }
          const k = chargeLabel(r.type, r.label);
          charges.set(k, (charges.get(k) || 0) - N(r.total));
          continue;
        }
        const rev = N(r.product_sales) + N(r.shipping_credits) + N(r.gift_wrap_credits) + N(r.promotional_rebates);
        const g = matchGroup(r.sku);
        if (!g) { const u = unmatched.get(r.sku) || { units: 0, revenue: 0 }; if (r.type === 'Order') u.units += N(r.qty); u.revenue += rev; unmatched.set(r.sku, u); continue; }
        const x = line(r.sku, g);
        x.revenue += rev;
        if (r.type === 'Adjustment' || /reimburse/i.test(r.type)) {
          x.reimb += N(r.total);                                      // Amazon paying you back (or reversing it)
        } else {
          x.fees -= N(r.selling_fees) + N(r.fba_fees) + N(r.other_transaction_fees) + N(r.other);
        }
        if (r.type === 'Order') {
          x.units += N(r.qty);
          if (r.fulfillment === 'Amazon') x.fbaUnits += N(r.qty);
          x.cogs += g.cogs * N(r.usd_qty);
          if (r.fulfillment === 'Seller') x.ship += shipUSD * N(r.fbm_orders);
        } else if (r.type === 'Liquidations') {
          x.liquidated += N(r.qty);
          x.cogs += g.cogs * N(r.usd_qty);                            // those units are gone too
        } else if (r.type === 'Refund' || /a-to-z/i.test(r.type)) {
          x.refunds += N(r.qty);
        }
      }
    }
    if (fxEst) notes.push(`${fxEst.toLocaleString()} ${m.name} transactions used the backup exchange rate because no daily rate was loaded for their dates.`);

    // ---- Uncovered days: estimates ----
    if (uncovered.length) {
      const leak = await leakageRate(code, spans, ccy);
      let usedUsFees = false;
      for (const [a, b] of uncovered) {
        for (const r of await rpcAll('mp_profit_sales', { ...args, p_from: a, p_to: b })) {
          const g = matchGroup(r.sku);
          if (!g) { const u = unmatched.get(r.sku) || { units: 0, revenue: 0 }; u.units += N(r.units); u.revenue += N(r.revenue); unmatched.set(r.sku, u); continue; }
          const x = line(r.sku, g);
          const q = N(r.units);
          const fee = feeFor(g, code, !!r.is_fba, b);
          if (!fee.own) usedUsFees = true;
          x.units += q; if (r.is_fba) x.fbaUnits += q;
          x.revenue += N(r.revenue);
          x.fees += q * fee.amt;
          x.cogs += g.cogs * N(r.usd_units);
          x.leakage += N(r.revenue) * leak.rate;
        }
      }
      const fmtSpans = list => list.map(([a, b]) => a === b ? fmtLong(a) : `${fmtLong(a)} – ${fmtLong(b)}`).join(', ');
      notes.push(`${days(uncovered)} of ${days(covered) + days(uncovered)} days (${fmtSpans(uncovered)}) have no transaction report yet, so they use estimated fees plus ${(leak.rate * 100).toFixed(1)}% leakage for refunds and promotions${leak.measured ? `, measured from actual ${m.name} transactions for ${fmtSpans([leak.window])}` : ' (default, not enough transaction history to measure)'}.`);
      if (code !== 'US' && usedUsFees) notes.push(`${m.name} estimated fees use the US fee table converted to ${ccy}.`);
    }

    // Ads: by SKU; spend not tied to a known product is spread by revenue share.
    let unattributed = 0, adTotal = 0;
    const spByMonth = {};
    for (const a of ads) {
      const amt = N(a.spend);
      adTotal += amt;
      spByMonth[a.month] = (spByMonth[a.month] || 0) + amt;
      const g = matchGroup(a.sku);
      if (g && a.sku) line(a.sku, g).ads += amt; else unattributed += amt;
    }
    if (!ads.length && adBilled > 0.005) {
      charges.set('Advertising billed by Amazon', adBilled);
      adTotal += adBilled;
      notes.push(`No ${m.name} ad report is loaded for this range, so ad cost uses what Amazon billed in the transaction report (billed in chunks, so it can lag actual spend).`);
    } else if (ads.length && adBilled > 0.005) {
      notes.push(`For reference, Amazon billed ${money(adBilled)} for ${m.name} ads in this range; profit uses the ${money(adTotal)} of spend in the ad reports instead, so nothing is counted twice.`);
    }
    const revTotal = [...SKU.values()].reduce((t, x) => t + Math.max(0, x.revenue), 0);
    if (unattributed && revTotal) for (const x of SKU.values()) x.ads += unattributed * Math.max(0, x.revenue) / revTotal;
    else if (unattributed) charges.set('Ad spend not tied to a product', (charges.get('Ad spend not tied to a product') || 0) + unattributed);

    // Overhead
    const overhead = [];
    const agency = agencyFor(code, s, e, terms.data || [], overheadRows.data || [], spByMonth);
    if (agency.amount) overhead.push({ market: code, label: 'Agency', amount: agency.amount, detail: agency.detail });
    for (const o of (overheadRows.data || []).filter(o => o.category === 'dsp_spend')) {
      const amt = prorate(o.month, s, e) * MP.toDisplay(Number(o.amount), o.currency, o.month);
      if (amt) overhead.push({ market: code, label: 'DSP spend', amount: amt, detail: fmtMonth(o.month) });
    }
    for (const [k, v] of charges) if (Math.abs(v) >= 0.005) overhead.push({ market: code, label: k, amount: v, detail: k === 'Ad spend not tied to a product' ? 'No product sales to spread it across' : 'Amazon charge from the transaction report' });

    return { code, mode, spans, skus: [...SKU.values()], unmatched, overhead, adTotal, fbmOrders, notes };
  }

  // Join overlapping or back-to-back date ranges.
  function mergeSpans(list) {
    const xs = list.filter(([a, b]) => a && b).sort((p, q) => p[0] < q[0] ? -1 : 1);
    const out = [];
    for (const [a, b] of xs) {
      const last = out[out.length - 1];
      if (last && a <= addDays(last[1], 1)) { if (b > last[1]) last[1] = b; } else out.push([a, b]);
    }
    return out;
  }
  function fmtMonth(iso) { return parseISO(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }); }

  // Share of a month (first day `monthISO`) that falls inside [s, e].
  function prorate(monthISO, s, e, from, to) {
    const d = parseISO(monthISO), y = d.getUTCFullYear(), mo = d.getUTCMonth();
    const mStart = toISO(new Date(Date.UTC(y, mo, 1))), mEnd = toISO(new Date(Date.UTC(y, mo, daysInMonth(y, mo))));
    const a = [s, mStart, from].filter(Boolean).sort().pop();
    const b = [e, mEnd, to].filter(Boolean).sort()[0];
    if (a > b) return 0;
    return (Math.round((parseISO(b) - parseISO(a)) / 86400000) + 1) / daysInMonth(y, mo);
  }

  // Agency cost for each month the range touches. For each month:
  // its own entered amount -> the terms' default monthly estimate ->
  // retainer + % of Sponsored Ads spend. Prorated by days.
  function agencyFor(code, s, e, terms, overheadRows, spByMonth) {
    let total = 0; const parts = [];
    const monthly = {};
    for (const o of overheadRows) if (o.category === 'agency_monthly') monthly[o.month.slice(0, 7)] = o;
    for (let mo = s.slice(0, 8) + '01'; mo <= e; mo = nextMonth(mo)) {
      const key = mo.slice(0, 7);
      const t = terms.find(t => t.start_date.slice(0, 7) <= key && (!t.end_date || t.end_date.slice(0, 7) >= key));
      const over = monthly[key];
      if (!t && !over) continue;
      const share = prorate(mo, s, e, over ? null : t.start_date, over ? null : t.end_date);
      if (!share) continue;
      let amt, how;
      if (over) { amt = MP.toDisplay(Number(over.amount), over.currency, mo) * share; how = 'entered for the month'; }
      else if (t.monthly_estimate != null) { amt = MP.toDisplay(Number(t.monthly_estimate), t.retainer_currency, mo) * share; how = 'monthly estimate'; }
      else {
        amt = MP.toDisplay(Number(t.monthly_retainer), t.retainer_currency, mo) * share + Number(t.sp_spend_pct || 0) * (spByMonth[key] || 0);
        how = `retainer + ${(Number(t.sp_spend_pct) * 100).toFixed(0)}% of ad spend`;
      }
      total += amt;
      parts.push(`${fmtMonth(mo)}: ${how}${share < 1 ? ` (${Math.round(share * 100)}% of month)` : ''}`);
    }
    return { amount: total, detail: parts.join('; ') };
  }
  function nextMonth(iso) { const d = parseISO(iso); return toISO(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))); }


  function sumLines(lines) {
    const t = { units: 0, refunds: 0, liquidated: 0, revenue: 0, fees: 0, reimb: 0, cogs: 0, ship: 0, ads: 0, leakage: 0, fbaUnits: 0 };
    for (const x of lines) for (const k of Object.keys(t)) t[k] += x[k] || 0;
    t.profit = t.revenue - t.fees + t.reimb - t.cogs - t.ship - t.ads - t.leakage;
    return t;
  }

  window.ProfitEngine = { loadGroups, computeMarket, sumLines, matchGroup };
})();
