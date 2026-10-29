'use strict';

const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
const DEFAULT_PLATFORMS = ['DataAnnotation', 'Mercor', 'Outlier'];

const $ = (s, r = document) => r.querySelector(s);
const state = { me: null, entries: [], year: null, editingId: null, todayRate: null, rateCache: new Map(), authMode: 'login' };

// ---------- theme ----------
try {
  const t = localStorage.getItem('theme');
  if (t) document.documentElement.dataset.theme = t;
} catch {}
$('#theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch {}
});

// ---------- utils ----------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nfPLN = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfUSD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmtPLN = (g) => `${nfPLN.format(g / 100)} zł`;
const fmtUSD = (c) => nfUSD.format(c / 100);
const fmtRate = (e4) => (e4 / 10000).toLocaleString('pl-PL', { minimumFractionDigits: 4 });
const fmtDay = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const toGrosze = (cents, rateE4) => Math.round((cents * rateE4) / 10000);

const yearOf = (d) => Number(d.slice(0, 4));
const qOf = (d) => Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1;
const limitFor = (y) => state.me.limits[y]?.quarterLimitGrosze ?? null;
const quarterEnd = (y, q) => new Date(Date.UTC(y, q * 3, 0)).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const monthName = (y, m) => new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });

function level(used, limit) {
  if (limit == null) return 'none';
  if (used > limit) return 'over';
  return used / limit >= 0.8 ? 'warn' : 'ok';
}

function sumWhere(fn) {
  let usd = 0, pln = 0, n = 0;
  for (const e of state.entries) if (fn(e)) { usd += e.usd_cents; pln += e.pln_grosze; n++; }
  return { usd, pln, n };
}

function parseCents(v) {
  const s = String(v ?? '').trim().replace(/[\s_]/g, '').replace(',', '.');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const [i, f = ''] = s.split('.');
  const c = Number(i) * 100 + Number((f + '00').slice(0, 2));
  return c > 0 ? c : null;
}

function noLimitText(y) {
  return y < 2026 ? 'Monthly limit before 2026 — not tracked' : `No minimum wage set for ${y} in worker.js`;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 5000 : 2500);
}

function getRate(date) {
  if (!state.rateCache.has(date)) {
    const p = api(`/api/rate?date=${encodeURIComponent(date)}`);
    p.catch(() => state.rateCache.delete(date));
    state.rateCache.set(date, p);
  }
  return state.rateCache.get(date);
}

// ---------- auth ----------
function setAuthMode(mode) {
  state.authMode = mode;
  document.querySelectorAll('[data-auth]').forEach((b) => b.classList.toggle('active', b.dataset.auth === mode));
  document.querySelectorAll('.register-only').forEach((el) => { el.hidden = mode !== 'register'; });
  $('#auth-submit').textContent = mode === 'register' ? 'Create account' : 'Log in';
  $('#auth-form').password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('#auth-form').invite.required = mode === 'register';
  $('#auth-error').textContent = '';
  setUsernameHint('');
  if (mode === 'register') checkUsername();
}

// ---------- "username taken" hint (register only) ----------
let usernameSeq = 0, usernameTimer;

function setUsernameHint(text) {
  const h = $('#username-hint');
  h.textContent = text;
  h.hidden = !text;
}

async function checkUsername() {
  const seq = ++usernameSeq;
  const name = $('#auth-form').username.value.trim();
  if (name.length < 3) return;
  try {
    const { available } = await api(`/api/username-available?username=${encodeURIComponent(name)}`);
    if (seq === usernameSeq && state.authMode === 'register' && available === false) setUsernameHint('That username is taken');
  } catch {}
}

$('#auth-form').username.addEventListener('input', () => {
  clearTimeout(usernameTimer);
  usernameSeq++;
  setUsernameHint('');
  if (state.authMode === 'register') usernameTimer = setTimeout(checkUsername, 300);
});
document.querySelectorAll('[data-auth]').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.auth)));

$('#auth-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const btn = $('#auth-submit');
  btn.disabled = true;
  $('#auth-error').textContent = '';
  try {
    const body = { username: f.username.value, password: f.password.value };
    if (state.authMode === 'register') body.invite = f.invite.value;
    await api(state.authMode === 'register' ? '/api/register' : '/api/login', { method: 'POST', body });
    f.reset();
    await boot();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  state.me = null; state.entries = []; state.rateCache.clear();
  showAuth();
});

function showAuth() {
  $('#auth-view').hidden = false;
  $('#app-view').hidden = true;
  $('#logout').hidden = true;
  $('#whoami').hidden = true;
  setAuthMode(state.authMode);
}

function showApp() {
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  $('#logout').hidden = false;
  $('#whoami').hidden = false;
  $('#whoami').textContent = state.me.user.username;
}

// ---------- rendering ----------
function render() {
  renderHero();
  renderYearTabs();
  renderQuarters();
  renderMonths();
  renderEntries();
  renderPlatforms();
}

function renderHero() {
  const today = state.me.today;
  const y = yearOf(today), q = qOf(today);
  const s = sumWhere((e) => yearOf(e.date) === y && qOf(e.date) === q);
  const lim = limitFor(y);
  const lv = level(s.pln, lim);
  const daysLeft = daysBetween(today, quarterEnd(y, q));

  $('#hero-label').textContent = `Q${q} ${y} · działalność nierejestrowana`;
  $('#hero-used').textContent = fmtPLN(s.pln);
  $('#hero-limit').textContent = lim == null ? '' : `/ ${fmtPLN(lim)}`;

  const meter = $('#hero-meter');
  meter.className = `meter ${lv}`;
  meter.querySelector('.meter-fill').style.width = `${lim ? Math.min(100, (s.pln / lim) * 100) : 0}%`;

  const pill = $('#hero-pill');
  pill.className = `status-pill ${lv}`;
  pill.textContent = { ok: `${pct(s.pln, lim)}% used`, warn: `${pct(s.pln, lim)}% · close to limit`, over: 'Limit exceeded', none: 'No limit set' }[lv];

  const remaining = lim == null ? null : lim - s.pln;
  let remainingUsd = '';
  if (remaining != null && remaining > 0 && state.todayRate) {
    remainingUsd = `≈ ${fmtUSD(Math.floor((remaining * 10000) / state.todayRate.rateE4))} at ${fmtRate(state.todayRate.rateE4)}`;
  }
  const stats = [
    { k: remaining != null && remaining < 0 ? 'Over by' : 'Remaining', v: remaining == null ? '—' : fmtPLN(Math.abs(remaining)), s: remainingUsd },
    { k: 'USD this quarter', v: fmtUSD(s.usd), s: `${s.n} ${s.n === 1 ? 'payout' : 'payouts'}` },
    { k: 'Days left in quarter', v: String(daysLeft), s: `ends ${fmtDay(quarterEnd(y, q))}` },
    { k: 'Year to date', v: fmtPLN(sumWhere((e) => yearOf(e.date) === y).pln), s: fmtUSD(sumWhere((e) => yearOf(e.date) === y).usd) },
  ];
  $('#hero-stats').innerHTML = stats.map((st) => `<div class="stat"><div class="k">${esc(st.k)}</div><div class="v">${esc(st.v)}</div><div class="s">${esc(st.s)}</div></div>`).join('');

  const msg = $('#hero-msg');
  msg.className = `hero-msg ${lv}`;
  msg.textContent = {
    ok: 'Within the limit. Unused room does not carry over to the next quarter.',
    warn: `Getting close: ${fmtPLN(remaining)} left until ${fmtDay(quarterEnd(y, q))}. Consider timing the next payout for next quarter.`,
    over: `Over the limit by ${fmtPLN(-remaining)}. From the day it was exceeded this counts as a business that must be registered — you have 7 days to file in CEIDG.`,
    none: noLimitText(y),
  }[lv];
}

function years() {
  const set = new Set(state.entries.map((e) => yearOf(e.date)));
  set.add(yearOf(state.me.today));
  return [...set].sort((a, b) => a - b);
}

function renderYearTabs() {
  $('#year-tabs').innerHTML = years().map((y) => `<button type="button" data-year="${y}" class="${y === state.year ? 'active' : ''}">${y}</button>`).join('');
  $('#year-tabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    state.year = Number(b.dataset.year);
    renderYearTabs(); renderQuarters(); renderMonths(); renderEntries();
  }));
}

function renderQuarters() {
  const y = state.year, lim = limitFor(y);
  const today = state.me.today;
  let html = '';
  for (let q = 1; q <= 4; q++) {
    const s = sumWhere((e) => yearOf(e.date) === y && qOf(e.date) === q);
    const lv = level(s.pln, lim);
    const isCurrent = y === yearOf(today) && q === qOf(today);
    let foot;
    if (lim == null) foot = y < 2026 ? 'monthly regime' : 'limit not set';
    else if (lv === 'over') foot = `over by ${fmtPLN(s.pln - lim)}`;
    else foot = `${pct(s.pln, lim)}% · ${fmtPLN(lim - s.pln)} left`;
    html += `<div class="q${isCurrent ? ' current' : ''}">
      <div class="q-head"><span>Q${q}${isCurrent ? ' · now' : ''}</span><span>${s.n || ''}</span></div>
      <div class="q-pln">${fmtPLN(s.pln)}</div>
      <div class="q-usd">${fmtUSD(s.usd)}</div>
      <div class="meter ${lv}"><div class="meter-fill" style="width:${lim ? Math.min(100, (s.pln / lim) * 100) : 0}%"></div></div>
      <div class="q-foot ${lv}">${esc(foot)}</div>
    </div>`;
  }
  $('#quarters').innerHTML = html;
}

function renderMonths() {
  const y = state.year;
  let qCum = 0, yCum = 0, rows = '';
  for (let m = 1; m <= 12; m++) {
    if ((m - 1) % 3 === 0) qCum = 0;
    const key = `${y}-${String(m).padStart(2, '0')}`;
    const s = sumWhere((e) => e.date.startsWith(key));
    qCum += s.pln; yCum += s.pln;
    const cls = [s.n ? '' : 'empty-row', m % 3 === 0 && m < 12 ? 'q-end' : ''].join(' ').trim();
    rows += `<tr class="${cls}">
      <td>${monthName(y, m)}</td>
      <td class="num">${s.n || '—'}</td>
      <td class="num">${s.n ? fmtUSD(s.usd) : '—'}</td>
      <td class="num">${s.n ? fmtPLN(s.pln) : '—'}</td>
      <td class="num dim">${fmtPLN(qCum)}</td>
      <td class="num dim">${fmtPLN(yCum)}</td>
    </tr>`;
  }
  $('#months tbody').innerHTML = rows;
}

function renderEntries() {
  const list = state.entries.filter((e) => yearOf(e.date) === state.year)
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  $('#entries-count').textContent = list.length ? `${list.length} in ${state.year}` : '';
  $('#entries-empty').hidden = list.length > 0;
  $('#entries tbody').innerHTML = list.map((e) => `<tr data-id="${e.id}" class="${e.id === state.editingId ? 'editing' : ''}">
      <td class="mono">${e.date}</td>
      <td class="platform">${esc(e.platform)}${e.note ? `<span class="note">${esc(e.note)}</span>` : ''}</td>
      <td class="num">${fmtUSD(e.usd_cents)}</td>
      <td class="num">${fmtRate(e.rate_e4)}<span class="rate-sub">${esc(e.rate_table)} · ${e.rate_date.slice(5)}</span></td>
      <td class="num">${fmtPLN(e.pln_grosze)}</td>
      <td class="row-actions"><button type="button" data-act="edit">Edit</button><button type="button" class="del" data-act="del">Delete</button></td>
    </tr>`).join('');
}

function renderPlatforms() {
  const set = new Set(DEFAULT_PLATFORMS);
  state.entries.forEach((e) => set.add(e.platform));
  $('#platforms').innerHTML = [...set].map((p) => `<option value="${esc(p)}">`).join('');
}

// ---------- entry form ----------
const form = $('#entry-form');
let previewSeq = 0, previewTimer;

function resetForm(keep = true) {
  const date = form.date.value, platform = form.platform.value;
  form.reset();
  if (keep) { form.date.value = date; form.platform.value = platform; }
  else form.date.value = state.me.today;
  form.date.max = state.me.today;
  state.editingId = null;
  $('#form-title').textContent = 'Add income';
  $('#entry-submit').textContent = 'Add';
  $('#cancel-edit').hidden = true;
  renderEntries();
  updatePreview();
}

async function updatePreview() {
  const seq = ++previewSeq;
  const el = $('#preview');
  const date = form.date.value;
  if (!date) { el.textContent = ''; return; }
  if (date > state.me.today) { el.innerHTML = '<span class="over">Payout date can’t be in the future.</span>'; return; }
  el.textContent = 'Fetching NBP rate…';
  let r;
  try { r = await getRate(date); } catch (err) {
    if (seq === previewSeq) el.innerHTML = `<span class="over">${esc(err.message)}</span>`;
    return;
  }
  if (seq !== previewSeq) return;
  let html = `1 USD = ${fmtRate(r.rateE4)} zł · NBP ${esc(r.table)} of ${r.rateDate}`;
  const cents = parseCents(form.amount_usd.value);
  if (cents) {
    const g = toGrosze(cents, r.rateE4);
    html += ` → <strong>${fmtPLN(g)}</strong>`;
    const y = yearOf(date), q = qOf(date), lim = limitFor(y);
    if (lim != null) {
      const after = sumWhere((e) => e.id !== state.editingId && yearOf(e.date) === y && qOf(e.date) === q).pln + g;
      const lv = level(after, lim);
      const txt = lv === 'over'
        ? `Q${q} ${y} would reach ${fmtPLN(after)} — ${fmtPLN(after - lim)} over the limit.`
        : `Q${q} ${y} after this: ${fmtPLN(after)} (${pct(after, lim)}% of limit).`;
      html += `<br><span class="${lv === 'ok' ? '' : lv}">${txt}</span>`;
    }
  }
  el.innerHTML = html;
}

form.date.addEventListener('change', updatePreview);
form.amount_usd.addEventListener('input', () => { clearTimeout(previewTimer); previewTimer = setTimeout(updatePreview, 150); });

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!form.date.value) return toast('Pick a payout date', true);
  if (!form.platform.value.trim()) return toast('Enter a platform', true);
  if (!parseCents(form.amount_usd.value)) return toast('Enter a USD amount like 125.50', true);

  const body = { date: form.date.value, platform: form.platform.value, amount_usd: form.amount_usd.value, note: form.note.value };
  const btn = $('#entry-submit');
  btn.disabled = true;
  try {
    const editing = state.editingId;
    const { entry } = editing
      ? await api(`/api/entries/${editing}`, { method: 'PUT', body })
      : await api('/api/entries', { method: 'POST', body });
    if (editing) state.entries = state.entries.map((e) => (e.id === editing ? entry : e));
    else state.entries.push(entry);
    state.year = yearOf(entry.date);
    resetForm(true);
    render();

    const y = yearOf(entry.date), q = qOf(entry.date), lim = limitFor(y);
    const used = sumWhere((e) => yearOf(e.date) === y && qOf(e.date) === q).pln;
    if (lim != null && used > lim) toast(`Saved — Q${q} ${y} is now over the limit`, true);
    else toast(editing ? 'Entry updated' : `Added ${fmtPLN(entry.pln_grosze)}`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('#cancel-edit').addEventListener('click', () => resetForm(false));

$('#entries').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.closest('tr').dataset.id);
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) return;

  if (btn.dataset.act === 'edit') {
    state.editingId = id;
    form.date.value = entry.date;
    form.platform.value = entry.platform;
    form.amount_usd.value = (entry.usd_cents / 100).toFixed(2);
    form.note.value = entry.note;
    $('#form-title').textContent = 'Edit entry';
    $('#entry-submit').textContent = 'Save';
    $('#cancel-edit').hidden = false;
    renderEntries();
    updatePreview();
    $('#entry-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    form.amount_usd.focus({ preventScroll: true });
  } else if (btn.dataset.act === 'del') {
    if (!confirm(`Delete ${entry.platform} payout of ${fmtUSD(entry.usd_cents)} from ${entry.date}?`)) return;
    try {
      await api(`/api/entries/${id}`, { method: 'DELETE' });
      state.entries = state.entries.filter((e) => e.id !== id);
      if (state.editingId === id) resetForm(false);
      render();
      toast('Entry deleted');
    } catch (err) {
      toast(err.message, true);
    }
  }
});

// ---------- Excel export ----------
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.XLSX) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the Excel library'));
    document.head.appendChild(s);
  });
}

// Excel date serial without timezone drift.
function serial(d) {
  const [y, m, dd] = d.split('-').map(Number);
  return (Date.UTC(y, m - 1, dd) - Date.UTC(1899, 11, 30)) / 86400000;
}

function setFormats(ws, cols, firstRow, lastRow) {
  for (const [col, z] of Object.entries(cols)) {
    for (let r = firstRow; r <= lastRow; r++) {
      const cell = ws[`${col}${r}`];
      if (cell && cell.t === 'n') cell.z = z;
    }
  }
}

function monthRange(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

async function exportXlsx() {
  if (!state.entries.length) return toast('Nothing to export yet', true);
  const btn = $('#export');
  btn.disabled = true;
  try {
    await loadScript(XLSX_URL);
    const X = window.XLSX;
    const F = { usd: '"$"#,##0.00', pln: '#,##0.00 "zł"', rate: '0.0000', date: 'yyyy-mm-dd', pct: '0.0%' };
    const rows = [...state.entries].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);

    // Sheet 1: every entry with running totals
    const head = ['date', 'platform', 'income_usd', 'income_pln', 'nbp_rate', 'nbp_rate_date', 'nbp_table',
      'cum_month_usd', 'cum_month_pln', 'cum_quarter_usd', 'cum_quarter_pln', 'cum_total_usd', 'cum_total_pln', 'note'];
    const aoa = [head];
    let mk = null, qk = null, mU = 0, mP = 0, qU = 0, qP = 0, tU = 0, tP = 0;
    for (const e of rows) {
      const m = e.date.slice(0, 7), q = `${yearOf(e.date)}-Q${qOf(e.date)}`;
      if (m !== mk) { mk = m; mU = 0; mP = 0; }
      if (q !== qk) { qk = q; qU = 0; qP = 0; }
      mU += e.usd_cents; mP += e.pln_grosze; qU += e.usd_cents; qP += e.pln_grosze; tU += e.usd_cents; tP += e.pln_grosze;
      aoa.push([serial(e.date), e.platform, e.usd_cents / 100, e.pln_grosze / 100, e.rate_e4 / 10000, serial(e.rate_date), e.rate_table,
        mU / 100, mP / 100, qU / 100, qP / 100, tU / 100, tP / 100, e.note]);
    }
    const last = rows.length + 1;
    aoa.push([]);
    aoa.push(['TOTAL', '', { t: 'n', v: tU / 100, f: `SUM(C2:C${last})` }, { t: 'n', v: tP / 100, f: `SUM(D2:D${last})` }]);
    const ws1 = X.utils.aoa_to_sheet(aoa);
    setFormats(ws1, { A: F.date, F: F.date, E: F.rate, C: F.usd, H: F.usd, J: F.usd, L: F.usd, D: F.pln, I: F.pln, K: F.pln, M: F.pln }, 2, last + 2);
    ws1['!cols'] = [12, 18, 13, 15, 10, 13, 18, 14, 15, 15, 16, 14, 16, 30].map((w) => ({ wch: w }));
    ws1['!autofilter'] = { ref: `A1:N${last}` };

    // Sheet 2: per month (every month from first to last entry)
    const months = monthRange(rows[0].date.slice(0, 7), rows[rows.length - 1].date.slice(0, 7));
    const aoa2 = [['month', 'quarter', 'entries', 'income_usd', 'income_pln', 'cum_quarter_pln', 'cum_year_pln', 'cum_total_usd', 'cum_total_pln']];
    let cq = 0, cy = 0, ctU = 0, ctP = 0, prevQ = null, prevY = null;
    for (const m of months) {
      const y = Number(m.slice(0, 4)), q = Math.floor((Number(m.slice(5)) - 1) / 3) + 1, qKey = `${y}-Q${q}`;
      if (qKey !== prevQ) { prevQ = qKey; cq = 0; }
      if (y !== prevY) { prevY = y; cy = 0; }
      const s = sumWhere((e) => e.date.startsWith(m));
      cq += s.pln; cy += s.pln; ctU += s.usd; ctP += s.pln;
      aoa2.push([m, qKey, s.n, s.usd / 100, s.pln / 100, cq / 100, cy / 100, ctU / 100, ctP / 100]);
    }
    const ws2 = X.utils.aoa_to_sheet(aoa2);
    setFormats(ws2, { D: F.usd, H: F.usd, E: F.pln, F: F.pln, G: F.pln, I: F.pln }, 2, aoa2.length);
    ws2['!cols'] = [10, 10, 8, 13, 15, 16, 15, 14, 16].map((w) => ({ wch: w }));

    // Sheet 3: per quarter vs the limit
    const quarters = [...new Set(months.map((m) => `${m.slice(0, 4)}-Q${Math.floor((Number(m.slice(5)) - 1) / 3) + 1}`))];
    const aoa3 = [['quarter', 'entries', 'income_usd', 'income_pln', 'limit_pln', 'remaining_pln', 'used_pct', 'status', 'cum_total_pln']];
    let cum = 0;
    for (const qk2 of quarters) {
      const y = Number(qk2.slice(0, 4)), q = Number(qk2.slice(-1));
      const s = sumWhere((e) => yearOf(e.date) === y && qOf(e.date) === q);
      const lim = limitFor(y);
      cum += s.pln;
      const lv = level(s.pln, lim);
      aoa3.push([qk2, s.n, s.usd / 100, s.pln / 100,
        lim == null ? 'n/a' : lim / 100,
        lim == null ? 'n/a' : (lim - s.pln) / 100,
        lim == null ? 'n/a' : s.pln / lim,
        { ok: 'within limit', warn: 'over 80%', over: 'EXCEEDED', none: y < 2026 ? 'monthly regime' : 'limit not set' }[lv],
        cum / 100]);
    }
    const ws3 = X.utils.aoa_to_sheet(aoa3);
    setFormats(ws3, { C: F.usd, D: F.pln, E: F.pln, F: F.pln, G: F.pct, I: F.pln }, 2, aoa3.length);
    ws3['!cols'] = [10, 8, 13, 15, 14, 15, 10, 14, 16].map((w) => ({ wch: w }));

    // Sheet 4: how the numbers were made
    const info = [
      ['Exported', state.me.today], ['User', state.me.user.username], [],
      ['Conversion', 'NBP table A average (mid) USD rate from the last business day before the payout date (art. 11a ust. 1 ustawy o PIT).'],
      ['Rounding', 'income_pln = income_usd × nbp_rate, rounded to 0.01 PLN.'],
      ['Limit', 'Quarterly revenue limit = 225% of the minimum wage in force on 1 January of the year (art. 5 ust. 1 Prawa przedsiębiorców).'],
      [],
      ['year', 'minimum_wage_pln', 'quarterly_limit_pln'],
      ...Object.entries(state.me.limits).map(([y, l]) => [Number(y), l.minWage, l.quarterLimitGrosze / 100]),
    ];
    const ws4 = X.utils.aoa_to_sheet(info);
    setFormats(ws4, { B: F.pln, C: F.pln }, 9, info.length);
    ws4['!cols'] = [{ wch: 12 }, { wch: 18 }, { wch: 20 }];

    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, ws1, 'Entries');
    X.utils.book_append_sheet(wb, ws2, 'Monthly');
    X.utils.book_append_sheet(wb, ws3, 'Quarterly');
    X.utils.book_append_sheet(wb, ws4, 'Info');
    X.writeFile(wb, `income_${state.me.user.username}_${state.me.today}.xlsx`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}
$('#export').addEventListener('click', exportXlsx);

// ---------- boot ----------
async function boot() {
  try {
    state.me = await api('/api/me');
  } catch (err) {
    showAuth();
    if (err.status !== 401) toast(err.message, true);
    return;
  }
  const { entries } = await api('/api/entries');
  state.entries = entries;
  state.year = yearOf(state.me.today);
  showApp();
  form.date.value = state.me.today;
  form.date.max = state.me.today;
  render();
  updatePreview();
  getRate(state.me.today).then((r) => { state.todayRate = r; renderHero(); }).catch(() => {});
}

boot();
