// GymSaathi: the HTTP server, sign-in, the routes and every check on what comes in. Only Node's built-in modules,
// plus the MongoDB driver when MONGODB_URI is set.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname, PUBLIC = path.join(ROOT, 'public');
if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env')); // before db.js reads its settings

const G = require('./lib/core');
const db = require('./lib/db');
const ai = require('./lib/ai');

const MAX_BODY = 256 * 1024;
const SESSION_DAYS = 30;
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'";
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const MODES = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other'];

// Errors a gym owner may read. Anything thrown without httpStatus is a bug and is answered with a plain 500.
const fail = (status, message) => { throw Object.assign(new Error(message), { httpStatus: status }); };
const newId = () => crypto.randomBytes(8).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const required = (v, label, max) => G.str(v, max) || fail(400, `${label} is required.`);
const amount = (v, label, max = 1e7) => { const n = Number(v); return n >= 0 && n <= max ? Math.round(n) : fail(400, `${label} must be a number from 0 to ${max.toLocaleString('en-IN')}.`); };
const phoneOf = (v) => { const d = G.lastTen(v); return /^[6-9]\d{9}$/.test(d) ? d : fail(400, 'The mobile number must have 10 digits.'); };
const dateOf = (v, label) => (G.isDate(v) && v >= '2000-01-01' && v <= '2099-12-31' ? v : fail(400, `${label} must be a real date.`));

// ---- accounts (one login per gym, made by the owner of this service)

const hashed = (password, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') });
const adminEmail = () => G.str(process.env.ADMIN_EMAIL).toLowerCase();
const isAdmin = (user) => !!adminEmail() && user.email === adminEmail();
const loginName = (v) => { const s = G.str(v, 100).toLowerCase(); return /^[a-z0-9._@+-]{3,100}$/.test(s) ? s : fail(400, 'A username has 3 to 100 letters, digits, dots or dashes, with no spaces.'); };
const newPassword = (v) => (typeof v === 'string' && v.length >= 8 && v.length <= 200 ? v : fail(400, 'A password needs at least 8 characters.'));
const newGym = (name) => ({ gym: { name, owner: '', phone: '', address: '', timings: '', amenities: '', upi: '', price1: 0, price3: 0, price6: 0, price12: 0, ptPrice: 0, dietPrice: 0 },
  members: [], payments: [], sent: {} });

// Makes the login and the gym's own document. The gym's id comes from its name; a taken one gets -2, -3 and so on.
async function createUser(email, password, gymName) {
  return db.change('users', async (users) => {
    if (users.some((u) => u.email === email)) return null;
    const slug = gymName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '') || 'gym';
    let gymId = slug;
    for (let n = 2; users.some((u) => u.gymId === gymId); n++) gymId = `${slug}-${n}`;
    await db.set(`gym:${gymId}`, newGym(gymName));
    const user = { id: newId(), email, ...hashed(password), gymId, gymName, createdAt: new Date().toISOString() };
    users.push(user);
    return user;
  }, []);
}

async function ensureAdmin() {
  const email = adminEmail(), password = process.env.ADMIN_PASSWORD;
  if (!email) return console.log('No ADMIN_EMAIL is set, so nobody can create gym logins. Set ADMIN_EMAIL and ADMIN_PASSWORD.');
  if (((await db.get('users')) || []).some((u) => u.email === email)) return undefined;
  if (!password || password.length < 8) return console.log('Set ADMIN_PASSWORD (8 characters or more) to create the owner account.');
  await createUser(email, password, 'GymSaathi Admin');
  return console.log(`Owner account created: ${email}`);
}

async function verifyUser(email, password) {
  const user = ((await db.get('users')) || []).find((u) => u.email === email);
  // The same work is done for an unknown name, so the time taken does not say which names exist.
  const { hash } = hashed(password, user ? user.salt : '00');
  return user && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.hash)) ? user : null;
}

// Only the hash of a session token is kept, so a leaked copy of the sessions cannot be replayed.
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex'), now = Date.now();
  await db.change('sessions', (all) => {
    for (const k of Object.keys(all)) if (all[k].until < now) delete all[k];
    all[sha256(token)] = { userId, until: now + SESSION_DAYS * 864e5 };
  }, {});
  return token;
}
async function sessionUser(token) {
  const s = token && ((await db.get('sessions')) || {})[sha256(token)];
  if (!s || s.until < Date.now()) return null;
  const user = ((await db.get('users')) || []).find((u) => u.id === s.userId);
  return user && !user.disabled ? user : null;
}
const endSessions = (keep) => db.change('sessions', (all) => { for (const k of Object.keys(all)) if (keep(all[k], k)) delete all[k]; }, {});

// ---- plumbing

function send(res, status, type, body, headers) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const json = (res, status, data) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));
const cookieOf = (req) => (/(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '') || [])[1];
const setCookie = (res, token) => res.setHeader('Set-Cookie',
  `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${token ? SESSION_DAYS * 86400 : 0}${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`);

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => { size += chunk.length; if (size <= MAX_BODY) chunks.push(chunk); });
  req.on('end', () => resolve(size > MAX_BODY ? null : Buffer.concat(chunks)));
  req.on('error', reject);
});
async function readJsonBody(req) {
  const raw = await readBody(req);
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

// Runs `fn` on the signed-in gym's document and saves it. Changes to one gym never overlap.
const write = (fn) => (c) => db.change(`gym:${c.user.gymId}`, (doc) => fn({ ...c, doc }));
const find = (list, id, what) => list.find((x) => x.id === id) || fail(404, `${what} not found.`);
const pay = (doc, member, sum, mode, date) => {
  if (sum > 0) doc.payments.push({ id: newId(), memberId: member.id, name: member.name, amount: sum, date, mode: MODES.includes(mode) ? mode : 'Cash' });
};

// What the owner may type or say about a member, apart from the plan and the money.
function details(b, doc, self) {
  const t = ai.tidy(b, doc.gym), phone = phoneOf(b.phone);
  const other = doc.members.find((m) => m.phone === phone && m !== self);
  if (other) fail(409, `${other.name} already has this mobile number.`);
  return { name: required(b.name, 'The name', 80), phone, gender: t.gender || '', age: t.age || '', weight: t.weight || '', height: t.height || '', goal: t.goal || '',
    health: t.health || '', batch: t.batch || '', pt: b.pt === true, diet: b.diet === true, notes: G.str(b.notes, 500) };
}
// A membership period and its fee. The fee is the gym's own price unless the owner typed another.
function period(b, gym, today, more) {
  const months = G.PLANS.includes(Number(b.months)) ? Number(b.months) : fail(400, 'Choose 1, 3, 6 or 12 months.');
  const start = b.start ? dateOf(b.start, 'The start date') : today;
  const fee = b.fee === undefined || b.fee === '' ? G.feeFor(gym, { months, ...more }) : amount(b.fee, 'The fee');
  const paid = amount(b.paid || 0, 'The amount paid');
  if (paid > fee) fail(400, 'The amount paid is more than the fee.');
  return { months, start, end: G.endOf(start, months), fee, paid };
}
const gymFields = (b) => ({
  name: required(b.name, 'The gym name', 80), owner: G.str(b.owner, 80), phone: G.str(b.phone, 30), address: G.str(b.address, 300), timings: G.str(b.timings, 150),
  amenities: G.str(b.amenities, 400), upi: G.str(b.upi, 80), ...Object.fromEntries(['price1', 'price3', 'price6', 'price12', 'ptPrice', 'dietPrice'].map((k) => [k, amount(b[k] || 0, 'A price')])),
});

const admin = (fn) => (c) => (isAdmin(c.user) ? fn(c) : fail(403, 'Only the owner of this GymSaathi service can do that.'));

const open = {
  'POST /api/auth/login': async ({ body, req, res }) => {
    const email = G.str(body.email, 100).toLowerCase();
    // Counted per username, and per address across usernames, before any password is worked on.
    const tries = bucket(`login ${clientOf(req)} ${email}`, 15 * 60e3), all = bucket(`login ${clientOf(req)}`, 15 * 60e3);
    if (tries.n >= 10 || all.n >= 50) fail(429, 'Too many wrong attempts. Try again in 15 minutes.');
    const user = typeof body.password === 'string' && await verifyUser(email, body.password);
    if (!user) { tries.n++; all.n++; fail(401, 'Wrong username or password.'); }
    if (user.disabled) fail(403, 'This account is switched off. Contact GymSaathi to switch it back on.');
    setCookie(res, await createSession(user.id));
  },
  'POST /api/auth/logout': async ({ req, res }) => {
    const token = cookieOf(req);
    if (token) await endSessions((s, k) => k === sha256(token));
    setCookie(res, '');
  },
};

const authed = {
  'GET /api/data': async ({ user }) => {
    const doc = await db.get(`gym:${user.gymId}`), today = G.todayISO();
    return { user: { id: user.id, email: user.email, admin: isAdmin(user) }, gym: doc.gym, members: doc.members, payments: doc.payments, sent: doc.sent[today] || {}, aiEnabled: ai.aiEnabled() };
  },
  'POST /api/auth/password': async ({ body, user, req }) => {
    if (typeof body.current !== 'string' || !(await verifyUser(user.email, body.current))) fail(400, 'The current password is not right.');
    const next = hashed(newPassword(body.password));
    await db.change('users', (users) => Object.assign(users.find((u) => u.id === user.id), next), []);
    await endSessions((s, k) => s.userId === user.id && k !== sha256(cookieOf(req))); // every other device is signed out
  },
  'PUT /api/gym': async (c) => {
    const gym = await write(({ doc, body }) => Object.assign(doc.gym, gymFields(body)))(c);
    await db.change('users', (users) => { users.find((u) => u.id === c.user.id).gymName = gym.name; }, []);
    return gym;
  },

  // A new member: who they are, the plan they took and what they paid today. Whatever is left unpaid is asked for
  // every day by the reminders.
  'POST /api/members': write(({ doc, body }) => {
    const today = G.todayISO(), who = details(body, doc);
    const member = { id: newId(), ...who, ...period(body, doc.gym, today, who), joinedAt: today, history: [] };
    doc.members.push(member);
    pay(doc, member, member.paid, body.mode, today);
    return member;
  }),
  'PUT /api/members/:id': write(({ doc, body, id }) => { const m = find(doc.members, id, 'Member'); return Object.assign(m, details(body, doc, m)); }),
  'DELETE /api/members/:id': write(({ doc, id }) => {
    find(doc.members, id, 'Member');
    doc.members = doc.members.filter((m) => m.id !== id);
    doc.payments = doc.payments.filter((p) => p.memberId !== id);
  }),
  // A new period. The one that ends is kept in the member's history; anything still owed on it is carried over.
  'POST /api/members/:id/renew': write(({ doc, body, id }) => {
    const m = find(doc.members, id, 'Member'), today = G.todayISO(), owed = G.due(m);
    const pt = body.pt === undefined ? m.pt : body.pt === true, diet = body.diet === undefined ? m.diet : body.diet === true;
    // It starts the day after the old one ends, or today when that day has passed.
    const next = period({ ...body, start: body.start || (m.end >= today ? G.addDays(m.end, 1) : today) }, doc.gym, today, { pt, diet });
    m.history.push({ months: m.months, start: m.start, end: m.end, fee: m.fee, paid: m.paid });
    Object.assign(m, next, { pt, diet, fee: next.fee + owed });
    pay(doc, m, m.paid, body.mode, today);
    return m;
  }),
  'POST /api/members/:id/pay': write(({ doc, body, id }) => {
    const m = find(doc.members, id, 'Member'), sum = amount(body.amount, 'The amount');
    if (sum <= 0 || sum > G.due(m)) fail(400, `${m.name} owes ${G.money(G.due(m))}. Enter an amount up to that.`);
    m.paid += sum;
    pay(doc, m, sum, body.mode, body.date ? dateOf(body.date, 'The date') : G.todayISO());
    return m;
  }),
  // Noted when the owner opens WhatsApp for a reminder, so the same one is not offered again that day.
  'POST /api/reminders/sent': write(({ doc, body }) => {
    const today = G.todayISO(), m = find(doc.members, G.str(body.memberId, 40), 'Member');
    if (!['fees', 'expiring', 'expired', 'welcome'].includes(body.type)) fail(400, 'Unknown reminder.');
    doc.sent = { [today]: { ...(doc.sent[today] || {}), [`${m.id}:${body.type}`]: true } }; // older days are dropped
  }),

  // The assistant. Each is limited per gym, since every call may reach the AI.
  'POST /api/register/turn': async ({ body, user }) => {
    if (bucket(`ai ${user.gymId}`, 60e3).n++ >= 40) fail(429, 'That is a lot at once. Wait a minute and go on.');
    const doc = await db.get(`gym:${user.gymId}`);
    return ai.turn({ gym: doc.gym, form: body.form && typeof body.form === 'object' ? body.form : {}, asked: G.str(body.asked, 20), said: G.str(body.said, 500), tries: Number(body.tries) || 0 });
  },
  'POST /api/chat': async ({ body, user }) => {
    const quick = body.quick === true;
    if (!quick && bucket(`ai ${user.gymId}`, 60e3).n++ >= 40) fail(429, 'That is a lot of questions. Wait a minute and ask again.');
    return ai.chat({ question: required(body.question, 'A question', 500), db: await db.get(`gym:${user.gymId}`), quick });
  },

  // Sample members, for looking around an empty gym.
  'POST /api/seed': write(({ doc }) => {
    if (doc.members.length) fail(400, 'Sample data is only for an empty gym.');
    const today = G.todayISO();
    Object.assign(doc.gym, { owner: doc.gym.owner || 'Vikram Singh', timings: doc.gym.timings || 'सुबह 5 से 10, शाम 4 से 10', amenities: doc.gym.amenities || 'कार्डियो, वेट ट्रेनिंग, स्टीम, लॉकर',
      price1: doc.gym.price1 || 1000, price3: doc.gym.price3 || 2700, price12: doc.gym.price12 || 9000, ptPrice: doc.gym.ptPrice || 2000, dietPrice: doc.gym.dietPrice || 500 });
    const rows = [['Rahul Sharma', '9829011101', 3, -80, 2700, 2700], ['Priya Jain', '9829011102', 1, -27, 1000, 1000], ['Amit Soni', '9829011103', 1, -2, 1000, 0],
      ['Neha Agarwal', '9829011104', 12, -200, 9000, 5000], ['Suresh Mali', '9829011105', 1, -40, 1000, 1000], ['Kavita Rathore', '9829011106', 3, -10, 2700, 2700],
      ['Deepak Kothari', '9829011107', 1, 0, 3000, 1000], ['Sunita Vyas', '9829011108', 1, -29, 1000, 1000]];
    for (const [name, phone, months, ago, fee, paid] of rows) {
      const start = G.addDays(today, ago), m = { id: newId(), name, phone, gender: '', age: '', weight: '', height: '', goal: '', health: '', batch: '', pt: fee === 3000, diet: false, notes: '',
        months, start, end: G.endOf(start, months), fee, paid, joinedAt: start, history: [] };
      doc.members.push(m);
      pay(doc, m, paid, 'Cash', start);
    }
  }),

  // The service owner's Accounts page: one login per gym.
  'GET /api/admin/users': admin(async () => ((await db.get('users')) || []).map((u) => ({ id: u.id, email: u.email, gym: u.gymName, createdAt: u.createdAt, disabled: !!u.disabled }))),
  'POST /api/admin/users': admin(async ({ body }) => {
    const made = await createUser(loginName(body.email), newPassword(body.password), required(body.gymName, 'The gym name', 80));
    return made ? { id: made.id } : fail(409, 'That username is already taken.');
  }),
  'PUT /api/admin/users/:id': admin(async ({ body, id, user }) => {
    if (id === user.id) fail(400, 'Change your own password under Settings.');
    if (body.password === undefined && typeof body.disabled !== 'boolean') fail(400, 'Nothing to change.');
    const next = body.password === undefined ? {} : hashed(newPassword(body.password));
    await db.change('users', (users) => {
      const u = users.find((x) => x.id === id) || fail(404, 'Account not found.');
      Object.assign(u, next, typeof body.disabled === 'boolean' && { disabled: body.disabled });
    }, []);
    await endSessions((s) => s.userId === id); // a new password or a switched-off account signs that gym out everywhere
  }),
};

async function api(req, res, pathname) {
  let id;
  const key = `${req.method} ${pathname.replace(/\/[a-f0-9]{16}(?=\/|$)/, (m) => { id = m.slice(1); return '/:id'; })}`;
  const route = open[key] || authed[key];
  if (!route) fail(404, 'Not found.');
  // Browsers cannot send this content type across sites without a preflight: with the SameSite cookie, that is the CSRF defence.
  if (req.method !== 'GET' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) fail(415, 'Send the request as application/json.');
  const body = req.method === 'GET' ? {} : await readJsonBody(req);
  const user = open[key] ? null : (await sessionUser(cookieOf(req))) || fail(401, 'Please sign in.');
  const out = await route({ req, res, body, id, user });
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
  } catch { /* no such file: 404 below */ }
  if (body === null) return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  return send(res, 200, type, body, { 'Cache-Control': 'no-cache', ...(type.startsWith('text/html') && { 'Content-Security-Policy': CSP }) });
}

async function start(port) {
  await ensureAdmin();
  const server = http.createServer((req, res) => {
    const pathname = req.url.split('?')[0];
    Promise.resolve().then(() => (pathname.startsWith('/api/') ? api(req, res, pathname) : serveStatic(req, res, pathname))).catch((e) => {
      const status = e && e.httpStatus;
      if (!status) console.error(e); // the stack stays in the log, never in the response
      if (res.headersSent) res.destroy();
      else json(res, status || 500, { error: status ? e.message : 'Something went wrong on our side. Please try again.' });
    });
  });
  return new Promise((resolve, reject) => { server.once('error', reject).listen(port, () => resolve(server)); });
}

module.exports = { start };

if (require.main === module) {
  start(Number(process.env.PORT) || 3000).then(
    (server) => console.log(`GymSaathi is running at http://localhost:${server.address().port} (${db.usingMongo ? 'MongoDB' : 'files in ' + db.DATA_DIR})`),
    (e) => { console.error(e.message); process.exit(1); },
  );
}
