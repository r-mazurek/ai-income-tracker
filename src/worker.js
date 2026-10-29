// Income tracker for działalność nierejestrowana — Cloudflare Worker + D1.
//
// Tax logic in one place:
//  * Quarterly revenue limit = 225% of the minimum wage in force on 1 January
//    of the year (Prawo przedsiębiorców art. 5, quarterly since 1 Jan 2026).
//  * Foreign-currency revenue is converted at the NBP table A average (mid)
//    rate from the last business day BEFORE the day of the revenue
//    (ustawa o PIT art. 11a ust. 1). The entry date here is the payout date.

const NBP_DEFAULT = 'https://api.nbp.pl';
// ~2–3 ms CPU, so login/register stay under the free plan's 10 ms limit.
// Each user's count is stored with the hash, so changing this is safe.
const PBKDF2_ITERATIONS = 20_000;
const SESSION_DAYS = 30;

// Minimum wage (PLN gross / month) in force on 1 January. Add a line each
// September when the next year's rozporządzenie is published.
const MIN_WAGE = {
  2026: 4806, // Dz.U. 2025
  2027: 4950, // Dz.U. 2026 poz. 1213
};

export function limitsTable() {
  const out = {};
  for (const [year, wage] of Object.entries(MIN_WAGE)) {
    // 225% of wage, in grosze: wage * 100 * 2.25 = wage * 225
    out[year] = { minWage: wage, quarterLimitGrosze: wage * 225 };
  }
  return out;
}

// ---------- small helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const enc = new TextEncoder();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function randomBytes(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

async function sha256(str) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(str)));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

async function readJson(req) {
  const ct = req.headers.get('content-type') || '';
  if (!ct.includes('application/json')) throw new HttpError(415, 'Expected a JSON body');
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

export function todayWarsaw(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function checkEntryDate(date) {
  if (!isValidDate(date)) throw new HttpError(400, 'Date must be YYYY-MM-DD');
  if (date < '2020-01-01') throw new HttpError(400, 'Date is too far in the past');
  if (date > todayWarsaw()) throw new HttpError(400, 'Date cannot be in the future');
}

export function parseUsdCents(v) {
  const s = String(v ?? '').trim().replace(/[\s_]/g, '').replace(',', '.');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) {
    throw new HttpError(400, 'Amount must be a positive number with at most 2 decimals');
  }
  const [i, f = ''] = s.split('.');
  const cents = Number(i) * 100 + Number((f + '00').slice(0, 2));
  if (cents <= 0) throw new HttpError(400, 'Amount must be greater than zero');
  return cents;
}

// USD cents x (rate x 10^4) -> PLN grosze, rounded half-up to the grosz.
export function toGrosze(usdCents, rateE4) {
  return Math.round((usdCents * rateE4) / 10_000);
}

// ---------- NBP ----------

// Rate applicable to revenue received on `date`: last table A published
// strictly before that date. Looks back 14 days to cover long holidays.
async function usdRate(env, date) {
  const cached = await env.DB.prepare(
    'SELECT rate_date, mid_e4, table_no FROM rate_cache WHERE currency = ? AND for_date = ?',
  ).bind('USD', date).first();
  if (cached) return { forDate: date, rateDate: cached.rate_date, rateE4: cached.mid_e4, table: cached.table_no };

  const base = env.NBP_BASE || NBP_DEFAULT;
  const url = `${base}/api/exchangerates/rates/a/usd/${addDays(date, -14)}/${addDays(date, -1)}/?format=json`;
  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch {
    throw new HttpError(502, 'Could not reach the NBP API, try again in a moment');
  }
  if (res.status === 404) throw new HttpError(502, 'NBP has no USD rate for the 14 days before this date');
  if (!res.ok) throw new HttpError(502, `NBP API returned ${res.status}`);
  const data = await res.json();
  const rates = Array.isArray(data.rates) ? data.rates : [];
  const last = rates.filter((r) => r.effectiveDate < date).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)).pop();
  if (!last || typeof last.mid !== 'number') throw new HttpError(502, 'Unexpected response from NBP');

  const out = { forDate: date, rateDate: last.effectiveDate, rateE4: Math.round(last.mid * 10_000), table: String(last.no) };
  await env.DB.prepare(
    'INSERT OR IGNORE INTO rate_cache (currency, for_date, rate_date, mid_e4, table_no) VALUES (?, ?, ?, ?, ?)',
  ).bind('USD', date, out.rateDate, out.rateE4, out.table).run();
  return out;
}

// ---------- auth ----------

function sessionCookie(token, maxAge) {
  return `sid=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function createSession(env, userId) {
  const token = b64url(randomBytes(32));
  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(b64url(await sha256(token)), userId, expires).run();
  return sessionCookie(token, SESSION_DAYS * 86_400);
}

function sessionToken(req) {
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)sid=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

async function getUser(req, env) {
  const token = sessionToken(req);
  if (!token) return null;
  const row = await env.DB.prepare(
    'SELECT u.id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
  ).bind(b64url(await sha256(token))).first();
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, username: row.username };
}

function validateCredentials(body) {
  const username = String(body.username ?? '').trim();
  const password = String(body.password ?? '');
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    throw new HttpError(400, 'Username: 3–32 characters, letters, digits, . _ -');
  }
  if (password.length < 8 || password.length > 200) throw new HttpError(400, 'Password must be at least 8 characters');
  return { username, password };
}

async function register(req, env) {
  const body = await readJson(req);
  if (!env.INVITE_CODE) throw new HttpError(403, 'Registration is closed');
  const ok = safeEqual(await sha256(String(body.invite ?? '')), await sha256(env.INVITE_CODE));
  if (!ok) throw new HttpError(403, 'Invalid invite code');
  const { username, password } = validateCredentials(body);

  const exists = await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(username).first();
  if (exists) throw new HttpError(409, 'That username is taken');

  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  let user;
  try {
    user = await env.DB.prepare(
      'INSERT INTO users (username, pass_hash, salt, iterations) VALUES (?, ?, ?, ?) RETURNING id, username',
    ).bind(username, b64url(hash), b64url(salt), PBKDF2_ITERATIONS).first();
  } catch (err) {
    // Someone registered the same name between the check above and this insert.
    if (String(err?.message).includes('UNIQUE')) throw new HttpError(409, 'That username is taken');
    throw err;
  }

  return json({ user }, 201, { 'set-cookie': await createSession(env, user.id) });
}

// Live "username taken" hint on the register form. Only answers while
// registration is open, so a closed instance doesn't reveal its usernames.
async function usernameAvailable(env, url) {
  if (!env.INVITE_CODE) throw new HttpError(403, 'Registration is closed');
  const username = String(url.searchParams.get('username') ?? '').trim();
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) return json({ available: null });
  const exists = await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(username).first();
  return json({ available: !exists });
}

async function login(req, env) {
  const body = await readJson(req);
  const username = String(body.username ?? '').trim();
  const password = String(body.password ?? '');
  const row = await env.DB.prepare('SELECT id, username, pass_hash, salt, iterations FROM users WHERE username = ?')
    .bind(username).first();

  // Hash even for unknown users so response time doesn't reveal which usernames exist.
  const salt = row ? fromB64url(row.salt) : randomBytes(16);
  const hash = await pbkdf2(password, salt, row ? row.iterations : PBKDF2_ITERATIONS);
  if (!row || !safeEqual(hash, fromB64url(row.pass_hash))) {
    throw new HttpError(401, 'Wrong username or password');
  }

  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run();
  return json({ user: { id: row.id, username: row.username } }, 200, { 'set-cookie': await createSession(env, row.id) });
}

async function logout(req, env) {
  const token = sessionToken(req);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(b64url(await sha256(token))).run();
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
}

// ---------- entries ----------

const ENTRY_COLS = 'id, date, platform, usd_cents, rate_e4, rate_date, rate_table, pln_grosze, note';

function validateEntry(body) {
  const date = String(body.date ?? '');
  checkEntryDate(date);
  const platform = String(body.platform ?? '').trim();
  if (!platform || platform.length > 40) throw new HttpError(400, 'Platform is required (max 40 characters)');
  const usdCents = parseUsdCents(body.amount_usd);
  const note = String(body.note ?? '').trim().slice(0, 200);
  return { date, platform, usdCents, note };
}

async function listEntries(env, user) {
  const { results } = await env.DB.prepare(
    `SELECT ${ENTRY_COLS} FROM entries WHERE user_id = ? ORDER BY date, id`,
  ).bind(user.id).all();
  return json({ entries: results });
}

async function createEntry(req, env, user) {
  const e = validateEntry(await readJson(req));
  const rate = await usdRate(env, e.date);
  const entry = await env.DB.prepare(
    `INSERT INTO entries (user_id, date, platform, usd_cents, rate_e4, rate_date, rate_table, pln_grosze, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${ENTRY_COLS}`,
  ).bind(user.id, e.date, e.platform, e.usdCents, rate.rateE4, rate.rateDate, rate.table, toGrosze(e.usdCents, rate.rateE4), e.note)
    .first();
  return json({ entry }, 201);
}

async function updateEntry(req, env, user, id) {
  const existing = await env.DB.prepare(`SELECT ${ENTRY_COLS} FROM entries WHERE id = ? AND user_id = ?`)
    .bind(id, user.id).first();
  if (!existing) throw new HttpError(404, 'Entry not found');
  const e = validateEntry(await readJson(req));
  const rate = e.date === existing.date
    ? { rateE4: existing.rate_e4, rateDate: existing.rate_date, table: existing.rate_table }
    : await usdRate(env, e.date);
  const entry = await env.DB.prepare(
    `UPDATE entries SET date = ?, platform = ?, usd_cents = ?, rate_e4 = ?, rate_date = ?, rate_table = ?, pln_grosze = ?, note = ?
     WHERE id = ? AND user_id = ? RETURNING ${ENTRY_COLS}`,
  ).bind(e.date, e.platform, e.usdCents, rate.rateE4, rate.rateDate, rate.table, toGrosze(e.usdCents, rate.rateE4), e.note, id, user.id)
    .first();
  return json({ entry });
}

async function deleteEntry(env, user, id) {
  const r = await env.DB.prepare('DELETE FROM entries WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  if (!r.meta.changes) throw new HttpError(404, 'Entry not found');
  return json({ ok: true });
}

// ---------- router ----------

async function api(req, env, url) {
  const { pathname: p } = url;
  const m = req.method;

  // CSRF guard on top of SameSite=Strict: reject cross-origin writes.
  if (m !== 'GET' && m !== 'HEAD') {
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-origin request blocked');
  }

  if (p === '/api/register' && m === 'POST') return register(req, env);
  if (p === '/api/login' && m === 'POST') return login(req, env);
  if (p === '/api/logout' && m === 'POST') return logout(req, env);
  if (p === '/api/username-available' && m === 'GET') return usernameAvailable(env, url);

  const user = await getUser(req, env);
  if (!user) throw new HttpError(401, 'Not signed in');

  if (p === '/api/me' && m === 'GET') {
    return json({ user, limits: limitsTable(), today: todayWarsaw(), registrationOpen: Boolean(env.INVITE_CODE) });
  }
  if (p === '/api/rate' && m === 'GET') {
    const date = url.searchParams.get('date');
    checkEntryDate(date);
    return json(await usdRate(env, date));
  }
  if (p === '/api/entries' && m === 'GET') return listEntries(env, user);
  if (p === '/api/entries' && m === 'POST') return createEntry(req, env, user);
  const em = p.match(/^\/api\/entries\/(\d+)$/);
  if (em && m === 'PUT') return updateEntry(req, env, user, Number(em[1]));
  if (em && m === 'DELETE') return deleteEntry(env, user, Number(em[1]));

  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(req, env, url);
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.message }, err.status);
        console.error(err);
        return json({ error: 'Something went wrong' }, 500);
      }
    }
    return env.ASSETS.fetch(req);
  },
};
