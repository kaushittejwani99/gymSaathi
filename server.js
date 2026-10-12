// GymSaathi: the HTTP server, sign-in, the routes and every check on what comes in. Only Node's built-in modules,
// plus the MongoDB driver when MONGODB_URI is set.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const ROOT = __dirname, PUBLIC = path.join(ROOT, 'public');
if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env')); // before db.js reads its settings

const G = require('./lib/core');
const db = require('./lib/db');
const cache = require('./lib/cache');
const ai = require('./lib/ai');
const wa = require('./lib/whatsapp');
const sample = require('./lib/sample');

const MAX_BODY = 256 * 1024;
const MAX_FILE = 12 * 1024 * 1024; // a photo or a PDF of old records, sent once to be read
const EXPORT_DAYS = 7;              // every gym, and the owner of the service, saves a backup on their own computer this often
const KEEP_DELETED_DAYS = 30;       // a deleted member or gym can be brought back for this long, then it goes for good
const BACKUP_DAYS = Number(process.env.BACKUP_DAYS) || 7; // how many daily backups of each gym are kept
const CACHE_SECONDS = 300;           // how long a gym's records are kept in the cache when nothing changes them
const SEND_FROM = 6, SEND_TILL = 21; // reminders go out by themselves from 6 in the morning, and never at night
const TRIAL_MONTHS = 1, PRICE = 999; // a gym's first month from its first sign-in is free; after that it pays PRICE a month
const OWNER_DAYS = 30;               // how long the owner of the service stays signed in
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'";
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const MODES = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other'];

// Errors a gym owner may read. Anything thrown without httpStatus is a bug and is answered with a plain 500.
const fail = (status, message) => { throw Object.assign(new Error(message), { httpStatus: status }); };
const newId = () => crypto.randomBytes(8).toString('hex');
const stamp = () => new Date().toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
// A mark of the app as the browser gets it, made from its own files. It is written into the page and told with every
// version check: a page that was left open while the server was updated sees the mark change and loads itself afresh,
// instead of going on with old code that asks the new server for things in the old way (and is told "Not found.").
const BUILD = sha256(['public/index.html', 'public/app.js', 'public/styles.css', 'lib/core.js'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n')).slice(0, 12);
const same = (a, b) => crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const sum = (list, key) => list.reduce((s, x) => s + x[key], 0);
const live = (x) => !x.deletedAt; // a deleted member or gym stays in the store, marked, until it is cleared out
const required = (v, label, max) => G.str(v, max) || fail(400, `${label} is required.`);
const amount = (v, label, max = 1e7) => { const n = Number(v); return n >= 0 && n <= max ? Math.round(n) : fail(400, `${label} must be a number from 0 to ${max.toLocaleString('en-IN')}.`); };
const phoneOf = (v) => { const d = G.lastTen(v); return /^[6-9]\d{9}$/.test(d) ? d : fail(400, 'The mobile number must have 10 digits.'); };
// The ids ticked on a list: each once, well-formed, and not more than a thousand.
const tickedIds = (v) => { const ids = [...new Set(Array.isArray(v) ? v : [])].filter((id) => typeof id === 'string' && /^[a-f0-9]{16}$/.test(id)).slice(0, 1000); return ids.length ? ids : fail(400, 'Tick at least one.'); };
const dateOf = (v, label) => (G.isDate(v) && v >= '2000-01-01' && v <= '2099-12-31' ? v : fail(400, `${label} must be a real date.`));

// ---- accounts (one login per gym, made by the owner of this service)

const hashed = (password, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') });
// The owner of the service is not kept in the database: the login is ADMIN_EMAIL and ADMIN_PASSWORD from the environment.
const adminEmail = () => G.str(process.env.ADMIN_EMAIL).toLowerCase();
const adminOk = (password) => { const real = process.env.ADMIN_PASSWORD || ''; return real.length >= 8 && same(sha256(password), sha256(real)); };
const loginName = (v) => { const s = G.str(v, 100).toLowerCase(); return /^[a-z0-9._@+-]{3,100}$/.test(s) ? s : fail(400, 'A username has 3 to 100 letters, digits, dots or dashes, with no spaces.'); };
const newPassword = (v) => (typeof v === 'string' && v.length >= 8 && v.length <= 200 ? v : fail(400, 'A password needs at least 8 characters.'));
// The same day and time `n` months on (31 Jan -> 28 Feb).
const monthsAfter = (iso, n) => G.addMonths(iso.slice(0, 10), n) + iso.slice(10);
// PAY_NOTE says where the money goes ('UPI name@bank, or call 98290 00000'). It is shown wherever a gym is asked to pay.
const payNote = () => G.str(process.env.PAY_NOTE, 200);
const over = (g) => `Your ${g.renewals.length ? 'plan' : 'free trial'} is over. Pay ₹${PRICE} to start the service again.${payNote() && ` ${payNote()}`}`;
// ---- who is asking, remembered for a minute in this process

// Finding out who a request comes from takes two trips to the database: the session, then its gym. With the database
// far from the server that is most of the time a page takes. So both answers are kept here for AUTH_SECONDS, and
// forgotten the moment that gym changes in any way or anybody is signed out of it.
// This lives in the server's own memory only, never in Redis: it holds sign-ins.
// ponytail: with more than one copy of the server, a change made on one reaches the others only when their minute is
// up. Share the forgetting (a version number on the gym, say) before running two copies.
const AUTH_SECONDS = 60;
const remembered = new Map(); // hash of a session token -> { who, gymId, until }
const gymsKept = new Map();   // gym id -> { g, until }; g is undefined for a gym that does not exist
function forget(gymId) {
  if (gymId === undefined) { remembered.clear(); gymsKept.clear(); return; }
  gymsKept.delete(gymId);
  for (const [key, r] of remembered) if (r.gymId === gymId) remembered.delete(key);
}
async function saveGym(id, patch) {
  await db.update('gyms', { _id: id }, patch);
  forget(id);
}
async function gymById(id) {
  const kept = gymsKept.get(id);
  if (kept && kept.until > Date.now()) return kept.g;
  const g = (await db.find('gyms', { _id: id })).find(live);
  if (gymsKept.size > 5000) gymsKept.clear();
  gymsKept.set(id, { g, until: Date.now() + AUTH_SECONDS * 1000 });
  return g;
}

// `details` is the gym as its Settings page holds it: name, owner, mobile, address, timings, amenities, UPI and prices.
async function createGym(email, password, details) {
  if (email === adminEmail() || (await db.find('gyms', { email })).length) return null;
  const g = { _id: newId(), email, ...hashed(password), createdAt: stamp(), disabled: false, firstLoginAt: null, lastLoginAt: null, validTill: null, renewals: [], sent: {}, details };
  await db.insert('gyms', g);
  return g;
}

// Who a session cookie belongs to. Only the hash of the token is kept, so a leaked copy of the sessions cannot be
// replayed. A gym stays signed in until its time runs out: then every device of it is signed out and told to pay.
async function sessionOf(token) {
  if (!token) return null;
  const key = sha256(token), kept = remembered.get(key);
  // What is remembered still has to be in time: a gym's month can run out within the minute.
  if (kept && kept.until > Date.now() && (kept.who.admin || stamp() < kept.who.account.validTill)) return kept.who;
  const who = await readSession(key);
  if (remembered.size > 20000) remembered.clear();
  if (who) remembered.set(key, { who, gymId: who.account && who.account._id, until: Math.min(Date.now() + AUTH_SECONDS * 1000, who.until || Infinity) });
  else remembered.delete(key);
  return who;
}
async function readSession(key) {
  const [s] = await db.find('sessions', { _id: key });
  if (!s) return null;
  if (s.admin) return s.until > Date.now() ? { admin: true, until: s.until } : null;
  const account = await gymById(s.gymId);
  if (!account || account.disabled) return null;
  if (stamp() >= account.validTill) {
    await db.remove('sessions', { gymId: account._id });
    forget(account._id);
    fail(402, over(account));
  }
  return { account };
}

// ---- plumbing

function send(res, status, type, body, headers) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const json = (res, status, data) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));
const cookieOf = (req) => (/(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '') || [])[1];
// The cookie outlives every session: how long a sign-in lasts is decided here on the server.
const setCookie = (res, token) => res.setHeader('Set-Cookie',
  `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${token ? 400 * 86400 : 0}${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`);

const readBody = (req, limit = MAX_BODY) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => { size += chunk.length; if (size <= limit) chunks.push(chunk); });
  req.on('end', () => resolve(size > limit ? null : Buffer.concat(chunks)));
  req.on('error', reject);
});
async function readJsonBody(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw) fail(413, 'That is too much to send at once.');
  let body;
  try { body = raw.length ? JSON.parse(raw) : {}; } catch { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'The request was not valid JSON.');
  return body;
}

// The address a request came from. Behind a proxy you control (TRUST_PROXY=1) it is the last one the proxy reports.
function clientOf(req) {
  return (process.env.TRUST_PROXY === '1' && String(req.headers['x-forwarded-for'] || '').split(',').pop().trim().slice(0, 45)) || req.socket.remoteAddress || '';
}
// ponytail: counters live in this process's memory and reset on restart; move them to the store if more than one copy runs.
const windows = new Map();
function bucket(key, ms) {
  const now = Date.now(), w = windows.get(key);
  if (w && w.until > now) return w;
  const fresh = { n: 0, until: now + ms };
  windows.set(key, fresh);
  return fresh;
}

// ---- the gym's own records

// Changes to one gym wait for the one before, so a double tap cannot add a member or take a payment twice over.
// ponytail: the queue is in this process, so run one copy of the server.
const queues = new Map();
const write = (fn) => (c) => {
  const run = (queues.get(c.gymId) || Promise.resolve()).then(() => fn(c)).finally(() => cache.drop(`records:${c.gymId}`)); // whatever it changed is read afresh
  queues.set(c.gymId, run.catch(() => {}));
  return run;
};

// Sample members are in lib/sample.js and are shown while the gym carries the mark `sample`. Gyms that loaded them
// before that have them as real records: those are known by their name and number, and go when the sample is removed.
const isSample = (c) => c.sample === true || sample.ROWS.some(([name, phone]) => c.name === name && c.phone === phone);
const READ_ONLY = 'This is a sample member, for looking around. It cannot be changed. Remove the sample members and add your own.';

// A member as the screens and the reminders read one: who they are, the period running now, what it cost with
// anything still owed from earlier periods, and what has been paid since it began. So fee - paid is what they owe.
function memberOf(c, periods, paid) {
  periods.sort((a, b) => (a.createdAt > b.createdAt) - (a.createdAt < b.createdAt));
  const now = periods.at(-1), paidNow = sum(paid.filter((t) => t.membershipId === now._id), 'amount');
  const { _id, gymId, ...who } = c;
  return { id: _id, ...who, sample: isSample(c), membershipId: now._id, periodFee: now.fee, pt: now.pt, diet: now.diet, months: now.months, start: now.start, end: now.end,
    fee: sum(periods, 'fee') - sum(paid, 'amount') + paidNow, paid: paidNow, history: periods.slice(0, -1).map(({ months, start, end, fee }) => ({ months, start, end, fee })) };
}
async function memberById(gymId, id) {
  if (sample.isSampleId(id)) {
    const g = await gymById(gymId), kept = g && g.sample ? sample.records(gymId, G.todayISO()) : null, c = kept && kept.customers.find((x) => x._id === id);
    if (!c) fail(404, 'Member not found.');
    return memberOf(c, kept.memberships.filter((p) => p.customerId === id), kept.transactions.filter((t) => t.customerId === id));
  }
  const [[c], periods, paid] = await Promise.all([db.find('customers', { _id: id, gymId }), db.find('memberships', { gymId, customerId: id }), db.find('transactions', { gymId, customerId: id })]);
  if (!c || c.deletedAt) fail(404, 'Member not found.');
  return memberOf(c, periods, paid);
}
// Everything of one gym.
async function loadGym(account) {
  // The three reads below are what every page of a gym needs, so their answer is kept until the gym changes something.
  const own = await cache.through(`records:${account._id}`, keepFor,
    () => Promise.all(['customers', 'memberships', 'transactions'].map((name) => db.find(name, { gymId: account._id }))));
  const shown = account.sample ? sample.records(account._id, G.todayISO()) : { customers: [], memberships: [], transactions: [] };
  const all = [...shown.customers, ...own[0]], periods = [...shown.memberships, ...own[1]], everyPaid = [...shown.transactions, ...own[2]];
  const customers = all.filter(live), here = new Set(customers.map((c) => c._id));
  const paid = everyPaid.filter((t) => here.has(t.customerId)).sort((a, b) => (a.createdAt > b.createdAt) - (a.createdAt < b.createdAt));
  return { gym: account.details, sent: account.sent, deleted: all.filter((c) => c.deletedAt).map((c) => ({ id: c._id, name: c.name, phone: c.phone, deletedAt: c.deletedAt })),
    members: customers.map((c) => memberOf(c, periods.filter((p) => p.customerId === c._id), paid.filter((t) => t.customerId === c._id))),
    payments: paid.map((t) => ({ id: t._id, memberId: t.customerId, name: t.name, amount: t.amount, date: t.date, mode: t.mode })) };
}
// A deleted member is only marked: they leave every screen and every total, and can be brought back for a while.
const dropMember = (gymId, id) => db.update('customers', { _id: id, gymId }, { deletedAt: stamp() });
// For good: the member goes with every period they bought and every payment they made.
async function purgeMember(gymId, id) {
  await db.remove('customers', { _id: id, gymId });
  await db.remove('memberships', { gymId, customerId: id });
  await db.remove('transactions', { gymId, customerId: id });
  await cache.drop(`records:${gymId}`);
}
async function purgeGym(id) {
  for (const name of ['sessions', 'backups', 'exports', 'transactions', 'memberships', 'customers']) await db.remove(name, { gymId: id });
  await db.remove('gyms', { _id: id });
  forget(id);
  await cache.drop(`records:${id}`, `exports:${id}`);
}

// ---- backups: once a day, everything each gym holds, compressed, kept for BACKUP_DAYS days

const packed = (data) => zlib.gzipSync(JSON.stringify(data)).toString('base64');
const unpacked = (text) => JSON.parse(zlib.gunzipSync(Buffer.from(text, 'base64'), { maxOutputLength: 200e6 }));
async function snapshot(g, date) {
  const [customers, memberships, transactions] = await Promise.all(['customers', 'memberships', 'transactions'].map((name) => db.find(name, { gymId: g._id })));
  await db.remove('backups', { _id: `${g._id}:${date}` });
  await db.insert('backups', { _id: `${g._id}:${date}`, gymId: g._id, date, at: stamp(), members: customers.filter(live).length, data: packed({ details: g.details, customers, memberships, transactions }) });
}
// The day's housekeeping: what was deleted more than KEEP_DELETED_DAYS ago goes for good, and every gym gets its
// backup for the day. It is safe to run again on the same day.
// ponytail: reads each gym's kept backups to see their dates; store the dates apart if the backups grow large.
async function daily(now = new Date()) {
  const today = G.todayISO(now), cutoff = new Date(now - KEEP_DELETED_DAYS * 864e5).toISOString();
  for (const g of await db.find('gyms')) {
    if (g.deletedAt) { if (g.deletedAt < cutoff) await purgeGym(g._id); continue; }
    for (const c of await db.find('customers', { gymId: g._id })) if (c.deletedAt && c.deletedAt < cutoff) await purgeMember(g._id, c._id);
    const kept = await db.find('backups', { gymId: g._id });
    if (!kept.some((b) => b.date === today)) await snapshot(g, today);
    for (const b of kept) if (G.isDate(b.date) && b.date <= G.addDays(today, -BACKUP_DAYS)) await db.remove('backups', { _id: b._id });
  }
}
const pay = (gymId, customerId, name, membershipId, amt, mode, date) => amt > 0 && db.insert('transactions',
  { _id: newId(), gymId, customerId, membershipId, name, amount: amt, mode: MODES.includes(mode) ? mode : 'Cash', date, createdAt: stamp() });

// Notes that a reminder went out today, so it is not sent or offered again. Older days are dropped.
async function markSent(gymId, today, key) {
  const { sent } = await gymById(gymId);
  await saveGym(gymId, { sent: { [today]: { ...(sent[today] || {}), [key]: true } } });
}

// Sends today's reminders of every gym on WhatsApp. A gym that is switched off or whose time is over sends nothing.
// One that fails stays on that gym's dashboard, where it can still be sent by a tap.
async function runReminders(today = G.todayISO()) {
  const now = stamp(), count = { sent: 0, failed: 0 };
  for (const account of await db.find('gyms')) {
    if (account.deletedAt || account.disabled || !(account.validTill > now)) continue;
    for (const r of G.reminders(await loadGym(account), today).filter((x) => !sample.isSampleId(x.memberId))) {
      try {
        await wa.send(r.phone, G.TEMPLATES[r.type].name, r.params);
        await write(() => markSent(account._id, today, `${r.memberId}:${r.type}`))({ gymId: account._id });
        count.sent++;
      } catch (e) {
        count.failed++;
        console.error(`WhatsApp reminder for a member of ${account.details.name} failed: ${e.message}`);
      }
    }
  }
  return count;
}
// Looks every minute whether today's reminders are due. A host that sleeps (a free one) sends them when it is next
// woken, so something has to open the site a little before six: README.md says how.
let remindedOn = '', tidiedOn = '';
function startReminders() {
  const tick = () => {
    const today = G.todayISO(), hour = new Date().getHours();
    if (tidiedOn !== today) { tidiedOn = today; daily().catch((e) => console.error('The daily backup failed:', e)); }
    if (!wa.enabled() || remindedOn === today || hour < SEND_FROM || hour >= SEND_TILL) return;
    remindedOn = today;
    runReminders(today).then((c) => console.log(`WhatsApp reminders for ${today}: ${c.sent} sent, ${c.failed} failed`), (e) => console.error('WhatsApp reminders failed:', e));
  };
  tick();
  setInterval(tick, 60e3).unref();
}

// What the owner may type or say about a member, apart from the plan and the money.
function person(b, gym) {
  const t = ai.tidy(b, gym), phone = phoneOf(b.phone);
  return { name: required(b.name, 'The name', 80), phone, gender: t.gender || '', age: t.age || '', weight: t.weight || '', height: t.height || '', goal: t.goal || '',
    health: t.health || '', batch: t.batch || '', notes: G.str(b.notes, 500) };
}
async function details(b, account, selfId) {
  const who = person(b, account.details);
  const other = (await db.find('customers', { gymId: account._id, phone: who.phone })).find((c) => c._id !== selfId && live(c));
  if (other) fail(409, `${other.name} already has this mobile number.`);
  return who;
}

// ---- old records: a row the AI read from a file, made fit to look through and then to save

// The length is what is written; else it is worked out from the first and last day; else one month.
function oldRow(r, gym, today) {
  const t = ai.tidy({ ...r, months: undefined, paid: undefined }, gym), start = G.isDate(r.start) && r.start >= '2000-01-01' && r.start <= today ? r.start : '';
  const spanned = start && G.isDate(r.end) && r.end > start ? Math.round(G.daysBetween(start, r.end) / 30.4) : 0;
  const months = G.okMonths(Number(r.months)) ? Number(r.months) : Math.min(36, Math.max(1, spanned));
  const fee = Number(r.fee) > 0 && Number(r.fee) <= 1e7 ? Math.round(Number(r.fee)) : '', due = Number(r.due) > 0 ? Math.round(Number(r.due)) : 0;
  return { name: t.name || '', phone: t.phone || '', start: start || today, months, fee, due, gender: t.gender || '', age: t.age || '', batch: t.batch || '', notes: G.str(r.notes, 200) };
}
// A trainer and a diet plan belong to the period bought. A renewal keeps the last choice unless told otherwise.
const extras = (b, last = {}) => ({ pt: b.pt === undefined ? !!last.pt : b.pt === true, diet: b.diet === undefined ? !!last.diet : b.diet === true });
// A membership period and its fee. The fee is the gym's own price unless the owner typed another.
function period(b, gym, today, more) {
  const months = G.okMonths(Number(b.months)) ? Number(b.months) : fail(400, 'The months must be a whole number from 1 to 36.');
  const start = b.start ? dateOf(b.start, 'The start date') : today;
  const fee = b.fee === undefined || b.fee === '' ? G.feeFor(gym, { months, ...more }) : amount(b.fee, 'The fee');
  const paid = amount(b.paid || 0, 'The amount paid');
  if (paid > fee) fail(400, 'The amount paid is more than the fee.');
  return { months, start, end: G.endOf(start, months), fee, paid };
}
// A period is only ever added, never changed: each one a member buys is its own document.
async function addPeriod(gymId, customerId, name, body, gym, today, more) {
  const { paid, ...plan } = period(body, gym, today, more), _id = newId();
  await db.insert('memberships', { _id, gymId, customerId, ...plan, ...more, createdAt: stamp() });
  return () => pay(gymId, customerId, name, _id, paid, body.mode, today);
}
const gymFields = (b) => ({
  name: required(b.name, 'The gym name', 80), owner: G.str(b.owner, 80), phone: G.str(b.phone, 30), address: G.str(b.address, 300), timings: G.str(b.timings, 150),
  amenities: G.str(b.amenities, 400), upi: G.str(b.upi, 80), ...Object.fromEntries(['price1', 'price3', 'price6', 'price12', 'ptPrice', 'dietPrice'].map((k) => [k, amount(b[k] || 0, 'A price')])),
});

const open = {
  'POST /api/auth/login': async ({ body, req, res }) => {
    const email = G.str(body.email, 100).toLowerCase(), password = typeof body.password === 'string' ? body.password : '';
    // Counted per username, and per address across usernames, before any password is worked on.
    const tries = bucket(`login ${clientOf(req)} ${email}`, 15 * 60e3), all = bucket(`login ${clientOf(req)}`, 15 * 60e3);
    if (tries.n >= 10 || all.n >= 50) fail(429, 'Too many wrong attempts. Try again in 15 minutes.');
    const owner = !!email && email === adminEmail();
    let [g] = owner ? [] : (await db.find('gyms', { email })).filter(live);
    // A gym may also type its own name, as long as no other gym has the same one.
    // ponytail: reads every gym when the username is not found; keep a lowercase name to look up when there are thousands.
    if (!owner && !g && email) {
      const named = (await db.find('gyms')).filter((x) => live(x) && G.str(x.details.name).toLowerCase().replace(/\s+/g, ' ') === email.replace(/\s+/g, ' '));
      if (named.length === 1) [g] = named;
    }
    // The same work is done for an unknown name, so the time taken does not say which names exist.
    const { hash } = hashed(password, g ? g.salt : '00');
    if (!(owner ? adminOk(password) : g && same(hash, g.hash))) { tries.n++; all.n++; fail(401, 'Wrong username or password.'); }
    const token = crypto.randomBytes(32).toString('hex'), at = stamp();
    if (owner) await db.insert('sessions', { _id: sha256(token), admin: true, until: Date.now() + OWNER_DAYS * 864e5 });
    else {
      if (g.disabled) fail(403, 'This account is switched off. Contact GymSaathi to switch it back on.');
      // The free month starts at the first sign-in, on top of anything already paid for.
      const validTill = g.firstLoginAt ? g.validTill : monthsAfter(g.validTill > at ? g.validTill : at, TRIAL_MONTHS);
      if (at >= validTill) fail(402, over(g));
      await saveGym(g._id, { firstLoginAt: g.firstLoginAt || at, lastLoginAt: at, validTill });
      await db.insert('sessions', { _id: sha256(token), gymId: g._id, loginAt: at });
    }
    setCookie(res, token);
  },
  'POST /api/auth/logout': async ({ req, res }) => {
    const token = cookieOf(req);
    if (token) { await db.remove('sessions', { _id: sha256(token) }); remembered.delete(sha256(token)); }
    setCookie(res, '');
  },
};

// ---- a backup on one's own computer

// A browser never tells a site the path a file was saved to. What is noted is what can be known: the day and time,
// the file's name, the folder's name when the person chose a folder for backups (else 'Downloads folder'), and the device.
// The owner of the service saves under 'owner', also while a gym is open; a gym saves under its own id.
const saver = (c) => (c.admin ? 'owner' : c.gymId);
async function exportsOf(who, hasData) {
  const kept = (await cache.through(`exports:${who}`, keepFor, () => db.find('exports', { gymId: who }))).sort((a, b) => (a.at < b.at) - (a.at > b.at));
  const due = hasData && (!kept.length || Date.now() - Date.parse(kept[0].at) > EXPORT_DAYS * 864e5);
  return { exports: kept.slice(0, 5).map(({ at, file, place, device }) => ({ at, file, place, device })), exportDue: due, exportDays: EXPORT_DAYS };
}

// For a gym, and for the owner of the service with or without a gym opened.
// How many times each gym was changed since the server started, and all gyms together under 'all'. An open page asks
// for its number every few seconds and reads everything afresh when it has moved: that is how what is done on the
// phone, on any page or through the assistant, shows on the computer without a reload.
// ponytail: counted in this process, like the write queue, so run one copy of the server.
const changes = new Map();
let elsewhere = 0; // changes that could not be put to one gym: they count for every gym
const versionOf = (gymId) => (changes.get(gymId || 'all') || 0) + elsewhere;
const wrote = new Map(); // gym id, and 'all' -> when this server last changed something there
const mark = (gymId) => { for (const k of ['all', gymId]) if (k) wrote.set(k, Date.now()); };

// What is changed in the database by other hands (in Atlas itself, by a script, by restore.js) is followed too: what
// was kept of that gym is forgotten at once and its open pages are told to read again. A change this server made
// itself has done all that already, and is known by having happened within the last few seconds.
// ponytail: a hand-made change to a gym within 5 seconds of the app changing the same gym waits for the next page change.
let keepFor = CACHE_SECONDS;
function follow() {
  if (!db.usingMongo) return;
  db.watch(({ name, gymId }) => {
    keepFor = CACHE_SECONDS;
    if (Date.now() - (wrote.get(gymId || 'all') || 0) < 5000) return;
    if (name === 'gyms' || name === 'sessions') forget(gymId);
    if (gymId) { cache.drop(`records:${gymId}`, `exports:${gymId}`); for (const k of ['all', gymId]) changes.set(k, (changes.get(k) || 0) + 1); } else { cache.clear(); elsewhere++; }
  }, (e) => {
    // Without the watch nothing is kept for long, so such a change still shows within half a minute.
    if (keepFor !== 30) console.error('The database cannot be watched, so what is read from it is kept for 30 seconds only:', e.message);
    keepFor = 30;
    setTimeout(follow, 60e3).unref();
  }).catch((e) => console.error('The database cannot be watched:', e.message));
}
const QUIET = new Set(['POST /api/chat', 'POST /api/register/turn', 'POST /api/import/read']); // these change nothing

const either = {
  'GET /api/version': async ({ gymId }) => ({ n: versionOf(gymId), build: BUILD }),
  'POST /api/exports': async (c) => {
    await db.insert('exports', { _id: newId(), gymId: saver(c), at: stamp(), file: required(c.body.file, 'The file name', 150), place: G.str(c.body.place, 150) || 'Downloads folder', device: G.str(c.body.device, 100) });
    await cache.drop(`exports:${saver(c)}`);
    return exportsOf(saver(c), true);
  },
  'GET /api/data': async ({ admin, account, gymId }) => {
    const version = versionOf(gymId); // read before the records, so a change during the read is asked about again
    const user = { id: account ? account._id : 'owner', email: account ? account.email : adminEmail(), admin };
    // A backup is asked for only where there is something to keep: a gym for the owner, a member for a gym.
    const data = account && await loadGym(account);
    const saved = await exportsOf(admin ? 'owner' : account._id, admin ? (await db.find('gyms', {}, ['deletedAt'])).some(live) : data.members.some((m) => !sample.isSampleId(m.id)));
    if (!account) return { user, version, gym: null, members: [], payments: [], deleted: [], sent: {}, price: PRICE, backupDays: BACKUP_DAYS, ...saved, aiEnabled: ai.aiEnabled() };
    return { user, version, ...data, ...saved, sent: data.sent[G.todayISO()] || {}, validTill: account.validTill, paying: account.renewals.length > 0, price: PRICE, backupDays: BACKUP_DAYS, payNote: payNote(), autoWhatsApp: wa.enabled(), aiEnabled: ai.aiEnabled() };
  },
};

const gymRoutes = {
  // Everything of this gym as it is kept, for a file on the gym's own computer.
  'GET /api/backup': async ({ account, gymId }) => {
    const [customers, memberships, transactions] = await Promise.all(['customers', 'memberships', 'transactions'].map((name) => db.find(name, { gymId })));
    return { madeAt: stamp(), gym: account.details, customers, memberships, transactions };
  },
  'POST /api/auth/password': async ({ body, account, gymId, req }) => {
    if (typeof body.current !== 'string' || !same(hashed(body.current, account.salt).hash, account.hash)) fail(400, 'The current password is not right.');
    await saveGym(gymId, hashed(newPassword(body.password)));
    const mine = sha256(cookieOf(req) || ''); // every other device is signed out
    for (const s of await db.find('sessions', { gymId })) if (s._id !== mine) await db.remove('sessions', { _id: s._id });
    forget(gymId);
  },
  'PUT /api/gym': async ({ body, gymId }) => {
    const next = gymFields(body);
    await saveGym(gymId, { details: next });
    return next;
  },

  // A new member: who they are, the plan they took and what they paid today. Whatever is left unpaid is asked for
  // every day by the reminders.
  'POST /api/members': write(async ({ body, account, gymId }) => {
    const today = G.todayISO(), who = await details(body, account), id = newId();
    // The period goes in before the member, so a failure in between leaves nothing half-made on the screens.
    const payNow = await addPeriod(gymId, id, who.name, body, account.details, today, extras(body));
    await db.insert('customers', { _id: id, gymId, ...who, joinedAt: today });
    await payNow();
    return memberById(gymId, id);
  }),
  'PUT /api/members/:id': write(async ({ body, account, gymId, id }) => {
    await memberById(gymId, id);
    await db.update('customers', { _id: id, gymId }, await details(body, account, id));
    return memberById(gymId, id);
  }),
  'DELETE /api/members/:id': write(async ({ gymId, id }) => {
    await memberById(gymId, id);
    await dropMember(gymId, id);
  }),
  // Several members at once. Each leaves as a single deleted member does, and can be brought back for 30 days.
  'POST /api/members/delete': write(async ({ body, gymId }) => {
    const ids = tickedIds(body.ids), here = new Set((await db.find('customers', { gymId }, ['deletedAt'])).filter(live).map((c) => c._id));
    const going = ids.filter((id) => here.has(id));
    await Promise.all(going.map((id) => dropMember(gymId, id)));
    return { deleted: going.length };
  }),
  // A deleted member comes back with every period and payment, unless their mobile number has since gone to another.
  'POST /api/members/:id/restore': write(async ({ gymId, id }) => {
    const [c] = await db.find('customers', { _id: id, gymId });
    if (!c || !c.deletedAt) fail(404, 'Member not found.');
    const other = (await db.find('customers', { gymId, phone: c.phone })).find(live);
    if (other) fail(409, `${other.name} now has this mobile number.`);
    await db.update('customers', { _id: id, gymId }, { deletedAt: null });
    return memberById(gymId, id);
  }),
  // Takes the sample members away: nothing is deleted for them, the gym's mark simply comes off.
  'DELETE /api/sample': write(async ({ account, gymId }) => {
    const old = (await db.find('customers', { gymId })).filter((c) => live(c) && isSample(c));
    await Promise.all(old.map((c) => purgeMember(gymId, c._id))); // all together, and for good: nothing here is worth bringing back
    if (account.sample) await saveGym(gymId, { sample: false });
    return { removed: old.length + (account.sample ? sample.ROWS.length : 0) };
  }),
  // A payment typed in wrongly is corrected: its amount, how it was paid, its date. Never to more than was owed.
  'PUT /api/payments/:id': write(async ({ body, gymId, id }) => {
    const [t] = await db.find('transactions', { _id: id, gymId });
    if (!t) fail(404, 'Payment not found.');
    const m = await memberById(gymId, t.customerId), amt = amount(body.amount, 'The amount'), most = t.amount + m.fee - m.paid;
    if (amt <= 0 || amt > most) fail(400, `Enter an amount from 1 to ${most.toLocaleString('en-IN')}.`);
    await db.update('transactions', { _id: id, gymId }, { amount: amt, mode: MODES.includes(body.mode) ? body.mode : t.mode, date: body.date ? dateOf(body.date, 'The date') : t.date });
  }),
  // A payment typed in by mistake. What it paid for is owed again.
  'DELETE /api/payments/:id': write(async ({ gymId, id }) => {
    if (!(await db.find('transactions', { _id: id, gymId })).length) fail(404, 'Payment not found.');
    await db.remove('transactions', { _id: id, gymId });
  }),
  // The running period typed in wrongly is corrected: its length, its start, the trainer and diet, its fee. This is for
  // a mistake; a new purchase is a renewal, which adds a period and leaves this one as it was.
  'PUT /api/members/:id/period': write(async ({ body, account, gymId, id }) => {
    const m = await memberById(gymId, id), [old] = await db.find('memberships', { _id: m.membershipId, gymId }), more = extras(body, m);
    const { paid, ...plan } = period({ ...body, paid: 0, start: body.start || old.start }, account.details, G.todayISO(), more);
    if (m.fee - m.paid - old.fee + plan.fee < 0) fail(400, 'More has already been paid than this fee. Change or delete a payment first.');
    await db.update('memberships', { _id: old._id, gymId }, { ...plan, ...more });
    return memberById(gymId, id);
  }),
  // A renewal made by mistake: the newest period goes and the one before it runs again. The first period of a member
  // cannot go this way, and neither can one that money was taken for.
  'DELETE /api/members/:id/period': write(async ({ gymId, id }) => {
    const m = await memberById(gymId, id);
    if (!m.history.length) fail(400, `This is the only membership ${m.name} has. Delete the member instead.`);
    if ((await db.find('transactions', { gymId, membershipId: m.membershipId })).length) fail(400, 'Money was taken with this renewal. Delete those payments first.');
    await db.remove('memberships', { _id: m.membershipId, gymId });
    return memberById(gymId, id);
  }),
  // A new period, added beside the earlier ones. Anything still owed on those stays owed.
  'POST /api/members/:id/renew': write(async ({ body, account, gymId, id }) => {
    const m = await memberById(gymId, id), today = G.todayISO();
    // It starts the day after the old one ends, or today when that day has passed.
    const payNow = await addPeriod(gymId, id, m.name, { ...body, start: body.start || (m.end >= today ? G.addDays(m.end, 1) : today) }, account.details, today, extras(body, m));
    await payNow();
    return memberById(gymId, id);
  }),
  'POST /api/members/:id/pay': write(async ({ body, gymId, id }) => {
    const m = await memberById(gymId, id), amt = amount(body.amount, 'The amount');
    if (amt <= 0 || amt > G.due(m)) fail(400, `${m.name} owes ${G.money(G.due(m))}. Enter an amount up to that.`);
    await pay(gymId, id, m.name, m.membershipId, amt, body.mode, body.date ? dateOf(body.date, 'The date') : G.todayISO());
    return memberById(gymId, id);
  }),
  // 'They have all paid': everything each of these members still owes is taken, in one go. Whoever owes nothing is passed over.
  'POST /api/members/pay': write(async ({ body, account, gymId }) => {
    const ids = new Set(tickedIds(body.ids)), today = G.todayISO(), mode = MODES.includes(body.mode) ? body.mode : 'Cash';
    const paid = (await loadGym(account)).members.filter((m) => ids.has(m.id) && !m.sample && G.due(m) > 0)
      .map((m) => ({ _id: newId(), gymId, customerId: m.id, membershipId: m.membershipId, name: m.name, amount: G.due(m), mode, date: today, createdAt: stamp() }));
    if (paid.length) await db.insert('transactions', paid);
    return { paid: paid.length, total: sum(paid, 'amount') };
  }),
  // Noted when the owner opens WhatsApp for a reminder, so the same one is not offered again that day.
  'POST /api/reminders/sent': write(async ({ body, gymId }) => {
    const today = G.todayISO(), m = await memberById(gymId, G.str(body.memberId, 40));
    if (!['fees', 'expiring', 'expired', 'welcome'].includes(body.type)) fail(400, 'Unknown reminder.');
    await markSent(gymId, today, `${m.id}:${body.type}`);
  }),

  // The assistant. Each is limited per gym, since every call may reach the AI.
  'POST /api/register/turn': async ({ body, account, gymId }) => {
    if (bucket(`ai ${gymId}`, 60e3).n++ >= 40) fail(429, 'That is a lot at once. Wait a minute and go on.');
    return ai.turn({ gym: account.details, form: body.form && typeof body.form === 'object' ? body.form : {}, asked: G.str(body.asked, 20), said: G.str(body.said, 500), tries: Number(body.tries) || 0, members: (await loadGym(account)).members, spoken: body.spoken === true });
  },
  'POST /api/chat': async ({ body, account, gymId }) => {
    const quick = body.quick === true;
    if (!quick && bucket(`ai ${gymId}`, 60e3).n++ >= 40) fail(429, 'That is a lot of questions. Wait a minute and ask again.');
    return ai.chat({ question: required(body.question, 'A question', 500), db: await loadGym(account), quick, history: body.history, confirming: typeof body.confirming === 'string' ? G.str(body.confirming, 12) || true : body.confirming === true, spoken: body.spoken === true });
  },

  // Old records, step one: the AI reads a photo, a PDF or a spreadsheet into rows. Nothing is saved, and the file is not kept.
  'POST /api/import/read': async ({ body, account, gymId }) => {
    if (bucket(`import ${gymId}`, 10 * 60e3).n++ >= 20) fail(429, 'That is a lot of files at once. Wait ten minutes and go on.');
    const today = G.todayISO();
    let rows;
    try { rows = await ai.readRecords({ file: { name: body.name, type: G.str(body.type, 100), data: body.data }, today }); } catch (e) {
      if (!e.readable) console.error('Reading old records failed:', e.status || '', e.message);
      fail(e.readable ? 400 : 502, e.readable ? e.message : 'The AI could not read this file just now. Try again, or try a clearer photo.');
    }
    return { rows: rows.slice(0, 600).map((r) => oldRow(r, account.details, today)) };
  },
  // Step two: the rows the owner looked through become members. Each has the period it was written with, taken as paid
  // except for what is marked pending. A row that cannot be a member is skipped and named, and the rest still go in.
  'POST /api/import/save': write(async ({ body, account, gymId }) => {
    const today = G.todayISO(), gym = account.details, taken = new Set((await db.find('customers', { gymId })).filter(live).map((c) => c.phone));
    const people = [], periods = [], paid = [], skipped = [];
    for (const [i, r] of (Array.isArray(body.rows) ? body.rows : []).slice(0, 600).entries()) {
      try {
        const who = person(r, gym), id = newId(), membershipId = newId();
        if (taken.has(who.phone)) fail(409, 'this mobile number is already a member');
        const start = r.start ? dateOf(r.start, 'The start date') : today;
        const plan = period({ months: r.months, start, fee: r.fee, paid: 0 }, gym, today, extras({}));
        const got = plan.fee - Math.min(plan.fee, amount(r.due || 0, 'The pending amount'));
        taken.add(who.phone);
        people.push({ _id: id, gymId, ...who, joinedAt: start, imported: today });
        periods.push({ _id: membershipId, gymId, customerId: id, months: plan.months, start: plan.start, end: plan.end, fee: plan.fee, pt: false, diet: false, createdAt: stamp() });
        if (got > 0) paid.push({ _id: newId(), gymId, customerId: id, membershipId, name: who.name, amount: got, mode: 'Cash', date: start, createdAt: stamp() });
      } catch (e) {
        if (!e.httpStatus) throw e;
        skipped.push({ row: i + 1, name: G.str(r && r.name, 80), why: e.message });
      }
    }
    await db.insert('memberships', periods);
    await db.insert('customers', people);
    await db.insert('transactions', paid);
    return { added: people.length, skipped };
  }),

  // Sample members, for looking around an empty gym. Nothing is written for them: the gym is marked, and given
  // prices where it has none so that the assistant can quote a fee.
  'POST /api/seed': write(async ({ account, gymId }) => {
    if ((await db.find('customers', { gymId }, ['deletedAt'])).some(live)) fail(400, 'Sample data is only for an empty gym.');
    const d = account.details;
    await saveGym(gymId, { sample: true, details: { ...d, owner: d.owner || 'Vikram Singh', timings: d.timings || 'सुबह 5 से 10, शाम 4 से 10', amenities: d.amenities || 'कार्डियो, वेट ट्रेनिंग, स्टीम, लॉकर',
      price1: d.price1 || 1000, price3: d.price3 || 2700, price12: d.price12 || 9000, ptPrice: d.ptPrice || 2000, dietPrice: d.dietPrice || 500 } });
    return { added: sample.ROWS.length };
  }),
};

// The service owner's Accounts page: every gym, its login, its time left and its numbers.
const adminRoutes = {
  'GET /api/admin/gyms': async () => {
    // The members come as bare ids and the money is added up inside the database, one total for each member, so this
    // page does not pull every period and payment of every gym across. A deleted member counts for nothing.
    // ponytail: still one row for each member of every gym; keep running totals on the gym when that gets slow.
    const [gyms, people, fees, paid, saves] = await Promise.all([db.find('gyms'), db.find('customers', {}, ['gymId', 'deletedAt']), db.sums('memberships', 'customerId', 'fee'), db.sums('transactions', 'customerId', 'amount'), db.find('exports')]);
    const lastSave = new Map();
    for (const e of saves) if (!lastSave.has(e.gymId) || lastSave.get(e.gymId).at < e.at) lastSave.set(e.gymId, e);
    const totals = new Map();
    for (const c of people.filter(live)) {
      const t = totals.get(c.gymId) || { members: 0, fee: 0, got: 0 };
      totals.set(c.gymId, { members: t.members + 1, fee: t.fee + (fees.get(c._id) || 0), got: t.got + (paid.get(c._id) || 0) });
    }
    return gyms.map((g) => {
      const t = totals.get(g._id) || { members: 0, fee: 0, got: 0 };
      return { id: g._id, email: g.email, gym: g.details.name, owner: g.details.owner, phone: g.details.phone, createdAt: g.createdAt, disabled: g.disabled, firstLoginAt: g.firstLoginAt,
        lastLoginAt: g.lastLoginAt, validTill: g.validTill, deletedAt: g.deletedAt || null, paidMonths: sum(g.renewals, 'months'), members: t.members, collected: t.got, due: t.fee - t.got,
        savedAt: (lastSave.get(g._id) || {}).at || null, savedPlace: (lastSave.get(g._id) || {}).place || '', savedDevice: (lastSave.get(g._id) || {}).device || '' };
    });
  },
  'POST /api/admin/gyms': async ({ body }) => {
    // The gym is handed over filled in: who owns it and how to reach them are needed, the rest may follow in its Settings.
    const details = { ...gymFields(body), owner: required(body.owner, "The owner's name", 80), phone: phoneOf(body.phone) };
    if (!details.price1) fail(400, 'The price for 1 month is needed: the assistant works every fee out from it.');
    const made = await createGym(loginName(body.email), newPassword(body.password), details);
    return made ? { id: made._id } : fail(409, 'That username is already taken.');
  },
  // A deleted gym is signed out and hidden, with everything it holds kept for KEEP_DELETED_DAYS days in case it was a mistake.
  'DELETE /api/admin/gyms/:id': async ({ id }) => {
    if (!(await gymById(id))) fail(404, 'Gym not found.');
    await db.remove('sessions', { gymId: id });
    await saveGym(id, { deletedAt: stamp() });
  },
  // Several gyms at once, each deleted as one is: signed out, hidden, and kept for KEEP_DELETED_DAYS days.
  'POST /api/admin/gyms/delete': async ({ body }) => {
    const ids = tickedIds(body.ids), at = stamp(), going = (await db.find('gyms')).filter((g) => live(g) && ids.includes(g._id));
    await Promise.all(going.map(async (g) => { await db.remove('sessions', { gymId: g._id }); await saveGym(g._id, { deletedAt: at }); }));
    return { deleted: going.length };
  },
  'POST /api/admin/gyms/:id/restore': async ({ id }) => {
    const [g] = await db.find('gyms', { _id: id });
    if (!g || !g.deletedAt) fail(404, 'Gym not found.');
    await saveGym(id, { deletedAt: null });
  },
  // The days a gym can be put back to, newest first.
  'GET /api/admin/gyms/:id/backups': async ({ id }) => (await db.find('backups', { gymId: id })).map((b) => ({ date: b.date, at: b.at, members: b.members })).sort((a, b) => (a.at < b.at) - (a.at > b.at)),
  // Puts a gym's members, periods and payments back to how a kept day had them. What it holds now is kept first, as
  // 'before restore', so a restore to the wrong day can itself be taken back. The login and the time left do not change.
  'POST /api/admin/gyms/:id/backups': async ({ body, id }) => {
    const g = (await gymById(id)) || fail(404, 'Gym not found.');
    const [b] = await db.find('backups', { _id: `${id}:${G.str(body.date, 20)}` });
    if (!b) fail(404, 'There is no backup of that day.');
    return write(async () => {
      const then = unpacked(b.data);
      if (b.date !== 'before restore') await snapshot(g, 'before restore');
      for (const name of ['transactions', 'memberships', 'customers']) await db.remove(name, { gymId: id });
      for (const name of ['customers', 'memberships', 'transactions']) await db.insert(name, then[name].filter((d) => d.gymId === id));
      await saveGym(id, { details: then.details });
      return { members: then.customers.filter(live).length };
    })({ gymId: id });
  },
  // Everything, in one compressed file, to keep somewhere other than the database. restore.js puts it back.
  'GET /api/admin/backup': async ({ res }) => {
    const all = {};
    for (const name of ['gyms', 'customers', 'memberships', 'transactions']) all[name] = await db.find(name);
    const body = zlib.gzipSync(JSON.stringify({ madeAt: stamp(), ...all }));
    send(res, 200, 'application/gzip', body, { 'Content-Disposition': `attachment; filename="gymsaathi-backup-${G.todayISO()}.json.gz"` });
  },
  'PUT /api/admin/gyms/:id': async ({ body, id }) => {
    const g = (await gymById(id)) || fail(404, 'Gym not found.');
    if ([1, 12].includes(body.addMonths)) {
      // The gym paid: it runs that many months more, from the day its time ends, or from now when that has passed.
      const at = stamp(), till = monthsAfter(g.validTill > at ? g.validTill : at, body.addMonths);
      await saveGym(id, { validTill: till, renewals: [...g.renewals, { at, months: body.addMonths, till }] });
      return { validTill: till };
    }
    // The login: another username, another password (left empty it stays as it is), or the account switched off or on.
    const email = body.email === undefined ? g.email : loginName(body.email), password = body.password || undefined;
    if (email === g.email && password === undefined && typeof body.disabled !== 'boolean') fail(400, 'Nothing to change.');
    if (email !== g.email && (email === adminEmail() || (await db.find('gyms', { email })).length)) fail(409, 'That username is already taken.');
    await saveGym(id, { email, ...(password !== undefined && hashed(newPassword(password))), ...(typeof body.disabled === 'boolean' && { disabled: body.disabled }) });
    await db.remove('sessions', { gymId: id }); // a changed login or a switched-off account signs that gym out everywhere
    forget(id);
    return undefined;
  },
};

async function api(req, res, url) {
  let id;
  const key = `${req.method} ${url.pathname.replace(/\/[a-f0-9]{16}(?=\/|$)/, (m) => { id = m.slice(1); return '/:id'; })}`;
  const route = open[key] || either[key] || gymRoutes[key] || adminRoutes[key];
  if (!route) fail(404, 'Not found.');
  // Browsers cannot send this content type across sites without a preflight: with the SameSite cookie, that is the CSRF defence.
  if (req.method !== 'GET' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) fail(415, 'Send the request as application/json.');
  if (id && sample.isSampleId(id) && req.method !== 'GET') fail(400, READ_ONLY);
  const c = { req, res, id };
  if (!open[key]) {
    const who = (await sessionOf(cookieOf(req))) || fail(401, 'Please sign in.'); // before the body is read: a stranger cannot make the server hold a large one
    c.admin = !!who.admin;
    if (adminRoutes[key] && !c.admin) fail(403, 'Only the owner of this GymSaathi service can do that.');
    // The owner of the service opens any gym by naming it (?gym=<id>) and then sees and does what that gym can.
    const view = c.admin && url.searchParams.get('gym');
    c.account = view ? (/^[a-f0-9]{16}$/.test(view) && await gymById(view)) || fail(404, 'Gym not found.') : who.account;
    if (gymRoutes[key] && !c.account) fail(400, 'Open a gym from the Accounts page first.');
    c.gymId = c.account && c.account._id;
  }
  c.body = req.method === 'GET' ? {} : await readJsonBody(req, key === 'POST /api/import/read' ? MAX_FILE : MAX_BODY);
  const changing = req.method !== 'GET' && !QUIET.has(key);
  if (changing) mark(c.gymId);
  const out = await route(c);
  if (changing) { mark(c.gymId); for (const k of ['all', c.gymId]) if (k) changes.set(k, (changes.get(k) || 0) + 1); }
  if (!res.headersSent) json(res, 200, out || { ok: true });
}

function serveStatic(req, res, pathname) {
  let file = '';
  try { pathname = decodeURIComponent(pathname); } catch { pathname = '\0'; }
  if (pathname === '/') file = path.join(PUBLIC, 'index.html');
  else if (pathname === '/lib/core.js') file = path.join(ROOT, 'lib', 'core.js');
  else if (!pathname.includes('\0')) file = path.resolve(PUBLIC, '.' + pathname);
  const type = MIME[path.extname(file).toLowerCase()];
  const inside = file.startsWith(PUBLIC + path.sep) || pathname === '/lib/core.js';
  let body = null;
  try {
    if (type && inside && ['GET', 'HEAD'].includes(req.method) && fs.statSync(file).isFile()) body = fs.readFileSync(file);
    if (body && pathname === '/') body = Buffer.from(String(body).replace('__BUILD__', BUILD));
  } catch { /* no such file: 404 below */ }
  if (body === null) return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  return send(res, 200, type, body, { 'Cache-Control': 'no-cache', ...(type.startsWith('text/html') && { 'Content-Security-Policy': CSP }) });
}

async function start(port) {
  await db.ready; // a wrong MONGODB_URI stops the server here, with the reason, instead of failing every request
  follow();
  if (!adminEmail() || (process.env.ADMIN_PASSWORD || '').length < 8) console.log('Set ADMIN_EMAIL and ADMIN_PASSWORD (8 characters or more): without them nobody can create gym logins.');
  const server = http.createServer((req, res) => {
    Promise.resolve().then(() => {
      const url = new URL(req.url.split('#')[0], 'http://localhost');
      if (url.pathname === '/ping') return send(res, 200, 'text/plain; charset=utf-8', 'ok'); // for an uptime pinger: keeps a free host awake
      return url.pathname.startsWith('/api/') ? api(req, res, url) : serveStatic(req, res, url.pathname);
    }).catch((e) => {
      const status = e && e.httpStatus;
      if (!status) console.error(e); // the stack stays in the log, never in the response
      if (res.headersSent) res.destroy();
      else json(res, status || 500, { error: status ? e.message : 'Something went wrong on our side. Please try again.' });
    });
  });
  return new Promise((resolve, reject) => { server.once('error', reject).listen(port, () => resolve(server)); });
}

module.exports = { start, runReminders, daily, forget, follow };

if (require.main === module) {
  start(Number(process.env.PORT) || 3000).then(
    (server) => {
      console.log(`GymSaathi is running at http://localhost:${server.address().port} (${db.usingMongo ? 'MongoDB' : 'files in ' + db.DATA_DIR}; cache in ${cache.usingRedis ? 'Redis' : 'memory'}; WhatsApp reminders ${wa.enabled() ? `go out by themselves from ${SEND_FROM} o'clock` : 'are sent by a tap'})`);
      startReminders();
    },
    (e) => { console.error(e.message); process.exit(1); },
  );
}
