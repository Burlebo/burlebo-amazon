// =============================================================================
// /global/pace.js — seasonal goal pace, shared by Big Picture and Snapshot
// (same math as the Analytics pace cards). Needs window.sb and marketplace.js.
//
//   const p = await Pace.forMarkets(['US','CA']);   // { US: {...}, CA: {...} }
//   p.US.state: 'ok' | 'nogoal' | 'future' | 'nodata'
//   p.US.goal, actual, expected, paceDiff, projected, frac, cutoff, start, end
// Amounts are USD (goals are set in USD).
// =============================================================================
(function () {
  'use strict';
  const sb = { from: (...a) => window.sb.from(...a) };
  function toISO(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0') + '-' + String(d.getUTCDate()).padStart(2,'0'); }
  function parseISO(s) { const p = String(s).slice(0,10).split('-').map(Number); return new Date(Date.UTC(p[0], p[1]-1, p[2])); }
  function addDays(d, n) { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; }
  function todayUTC() { const n = new Date(); return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())); }

  async function fetchTotals(codes, fromISO) {
    const out = []; let off = 0;
    while (true) {
      const { data, error } = await sb.from('mp_daily_totals').select('marketplace, date, revenue_usd, rate_estimated')
        .in('marketplace', codes).gte('date', fromISO).order('date').range(off, off + 999);
      if (error) throw new Error(error.message);
      out.push(...(data || []));
      if (!data || data.length < 1000) break;
      off += 1000;
    }
    return out;
  }

  function monthKey(iso) { return iso.slice(0, 7); }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }

  // 12 shares (Jan..Dec) summing to 1, from the last 12 complete months of US sales.
  function seasonalCurve(usRows) {
    if (!usRows.length) return { shares: Array(12).fill(1 / 12), months: 0 };
    const byMonth = {}; const daysSeen = {};
    for (const r of usRows) { const k = monthKey(r.date); byMonth[k] = (byMonth[k] || 0) + Number(r.revenue_usd || 0); daysSeen[k] = (daysSeen[k] || 0) + 1; }
    const complete = Object.keys(byMonth).filter(k => {
      const [y, m] = k.split('-').map(Number); return daysSeen[k] >= daysInMonth(y, m - 1) - 1;  // allow one missing day
    }).sort().slice(-12);
    const tot = Array(12).fill(null);
    for (const k of complete) tot[Number(k.slice(5, 7)) - 1] = byMonth[k];
    const known = tot.filter(v => v != null);
    const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
    const filled = tot.map(v => v == null ? avg : v);
    const sum = filled.reduce((a, b) => a + b, 0) || 1;
    return { shares: filled.map(v => v / sum), months: complete.length };
  }

  function curveFor(m, usCurve) {
    const c = m.settings && m.settings.seasonal_curve;
    if (Array.isArray(c) && c.length === 12) {
      const sum = c.reduce((a, b) => a + Number(b || 0), 0) || 1;
      return { shares: c.map(v => Number(v || 0) / sum), custom: true };
    }
    return { shares: usCurve.shares, custom: false };
  }

  function paceFor(m, rows, curve) {
    const s = m.settings || {};
    if (!s.annual_goal || !s.goal_start || !s.goal_end) return { state: 'nogoal' };
    const goal = Number(s.annual_goal), start = s.goal_start, end = s.goal_end;
    const mine = rows.filter(r => r.marketplace === m.code && r.date >= start && r.date <= end);
    const today = toISO(new Date());
    if (today < start) return { state: 'future', goal, start, end };
    const cutoff = mine.length ? mine[mine.length - 1].date : null;
    const w = iso => { const d = parseISO(iso); return curve.shares[d.getUTCMonth()] / daysInMonth(d.getUTCFullYear(), d.getUTCMonth()); };
    let wAll = 0, wToDate = 0;
    for (let d = parseISO(start); d <= parseISO(end); d = addDays(d, 1)) {
      const iso = toISO(d), x = w(iso); wAll += x; if (cutoff && iso <= cutoff) wToDate += x;
    }
    const actual = mine.reduce((a, r) => a + Number(r.revenue_usd || 0), 0);
    const frac = wAll ? wToDate / wAll : 0;
    const expected = goal * frac;
    return {
      state: cutoff ? 'ok' : 'nodata', goal, start, end, cutoff, actual, expected, frac,
      paceDiff: expected ? actual / expected - 1 : null,
      projected: frac ? actual / frac : null,
      estimated: mine.some(r => r.rate_estimated),
    };
  }


  async function forMarkets(codes) {
    const markets = codes.map(c => MP.market(c)).filter(Boolean);
    const starts = markets.map(m => m.settings && m.settings.goal_start).filter(Boolean).sort();
    const since = toISO(addDays(todayUTC(), -400));
    const from = starts.length && starts[0] < since ? starts[0] : since;
    const rows = await fetchTotals([...new Set(['US', ...codes])], from);
    const usCurve = seasonalCurve(rows.filter(r => r.marketplace === 'US'));
    const out = {};
    for (const m of markets) {
      const curve = curveFor(m, usCurve);
      out[m.code] = { ...paceFor(m, rows, curve), customCurve: curve.custom, curveMonths: usCurve.months };
    }
    return out;
  }

  // Combine several marketplaces' pace into one goal (USD). Only markets whose
  // goal period has started and has sales count. Returns null if none do.
  function summary(paceMap, codes) {
    const ok = codes.map(c => paceMap[c]).filter(p => p && p.state === 'ok');
    if (!ok.length) return null;
    const goal = ok.reduce((a, p) => a + p.goal, 0), actual = ok.reduce((a, p) => a + p.actual, 0);
    const expected = ok.reduce((a, p) => a + p.expected, 0), projected = ok.reduce((a, p) => a + (p.projected || 0), 0);
    const cutoff = ok.map(p => p.cutoff).sort().pop(), end = ok.map(p => p.end).sort().pop();
    const daysLeft = Math.max(1, Math.round((parseISO(end) - parseISO(cutoff)) / 86400000));
    return { goal, actual, expected, projected, cutoff, end,
             paceDiff: expected ? actual / expected - 1 : 0, pct: goal ? actual / goal : 0,
             dailyRequired: Math.max(0, goal - actual) / daysLeft, markets: ok.length };
  }

  window.Pace = { forMarkets, summary };
})();
