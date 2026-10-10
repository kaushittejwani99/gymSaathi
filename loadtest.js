// Fills a database of its own with many gyms and measures how the app holds up:
//   node loadtest.js          50 gyms, each with 150 members, 500 memberships, 500 payments and 500 sign-ins
//   node loadtest.js drop     removes that database again
//   node loadtest.js live          puts the same 50 made-up gyms into the REAL database, beside the real gyms, to look at on the live site
//   node loadtest.js live-remove   takes exactly those 50 out of the real database again, and nothing else
// It uses the MongoDB that .env names but only ever the database 'gymsaathi_loadtest', never the real one, and it
// leaves the data there so it can be looked at in Atlas. To open the app on it, start the server with
// MONGODB_DB=gymsaathi_loadtest and sign in as load01 ... load50 with the password below.
'use strict';
const crypto = require('node:crypto');

const DB_NAME = 'gymsaathi_loadtest';
const PASSWORD = 'loadtest-password'; // for these made-up gyms only
const GYMS = 50, MEMBERS = 150, SIGN_INS = 500;
const MODE = process.argv[2] || '', LIVE = MODE.startsWith('live');
// On the real database nothing of the environment is touched: it is whatever .env says.
if (!LIVE) Object.assign(process.env, { MONGODB_DB: DB_NAME, ADMIN_EMAIL: 'owner', ADMIN_PASSWORD: 'owner-loadtest-password', GEMINI_API_KEY: '', WHATSAPP_TOKEN: '', REDIS_URL: '' });

const server = require('./server'); // loads .env, where MONGODB_URI is
const db = require('./lib/db');
const cache = require('./lib/cache');
const G = require('./lib/core');

const id = () => crypto.randomBytes(8).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const FIRST = ['Rahul', 'Priya', 'Amit', 'Neha', 'Suresh', 'Kavita', 'Deepak', 'Sunita', 'Vikram', 'Pooja', 'Arjun', 'Meena', 'Rohit', 'Anjali', 'Manish', 'Kiran', 'Sanjay', 'Ritu', 'Mohan', 'Seema'];
const LAST = ['Sharma', 'Jain', 'Soni', 'Agarwal', 'Mali', 'Rathore', 'Kothari', 'Vyas', 'Singh', 'Tiwari', 'Gupta', 'Joshi', 'Chouhan', 'Mehta', 'Pareek'];
const middle = (times) => { const s = [...times].sort((a, b) => a - b); return Math.round(s[Math.floor(s.length / 2)]); };
const most = (times) => Math.round(Math.max(...times));

// One gym as the app would have made it: its members, a chain of one-month periods for each, the payments for them
// (40 members still owe part of the latest), and its sign-ins. Returns the documents and one sign-in to act as.
function gymDocs(n, today, password = PASSWORD) {
  const gymId = id(), now = new Date().toISOString(), salt = crypto.randomBytes(16).toString('hex'), tag = String(n).padStart(2, '0');
  const gym = { _id: gymId, email: `load${tag}`, salt, hash: crypto.scryptSync(password, salt, 64).toString('hex'), loadtest: true, createdAt: now, disabled: false, firstLoginAt: now, lastLoginAt: now,
    validTill: new Date(Date.now() + 30 * 864e5).toISOString(), renewals: [], sent: {},
    details: { name: `Load Gym ${tag}`, owner: `${FIRST[n % FIRST.length]} ${LAST[n % LAST.length]}`, phone: `98${String(29000000 + n)}`, address: 'Bhilwara', timings: '5 to 10, 4 to 10', amenities: 'Cardio, Weights', upi: '',
      price1: 1000, price3: 2700, price6: 5000, price12: 9000, ptPrice: 2000, dietPrice: 500 } };
  const customers = [], memberships = [], transactions = [], sessions = [];
  for (let i = 0; i < MEMBERS; i++) {
    const customerId = id(), name = `${FIRST[(i + n) % FIRST.length]} ${LAST[(i * 7 + n) % LAST.length]}`, periods = i < 50 ? 4 : 3; // 50 x 4 + 100 x 3 = 500
    const latest = G.addDays(today, -(i % 40)); // the newest period began up to 39 days ago, so some have ended
    customers.push({ _id: customerId, gymId, name, phone: `9${String(100000000 + n * 1000 + i)}`, gender: i % 3 ? 'Male' : 'Female', age: 18 + (i % 35), weight: 55 + (i % 40), height: '', goal: i % 2 ? 'Fitness' : 'Weight loss',
      health: '', batch: i % 2 ? 'Morning' : 'Evening', notes: '', joinedAt: G.addMonths(latest, -(periods - 1)) });
    for (let p = 0; p < periods; p++) {
      const start = G.addMonths(latest, -(periods - 1 - p)), membershipId = id(), newest = p === periods - 1, owes = newest && i % 4 === 0 && i < 160;
      memberships.push({ _id: membershipId, gymId, customerId, months: 1, start, end: G.endOf(start, 1), fee: 1000, pt: false, diet: i % 5 === 0, createdAt: `${start}T06:00:00.000Z` });
      transactions.push({ _id: id(), gymId, customerId, membershipId, name, amount: owes ? 300 : 1000, mode: i % 3 ? 'Cash' : 'UPI', date: start, createdAt: `${start}T06:05:00.000Z` });
    }
  }
  const token = crypto.randomBytes(32).toString('hex');
  for (let s = 0; s < SIGN_INS; s++) sessions.push({ _id: sha256(s ? crypto.randomBytes(32).toString('hex') : token), gymId, loginAt: now });
  return { gym, customers, memberships, transactions, sessions, token };
}

// Writes the gyms and all they hold. Returns what was made.
async function fill(password) {
  const today = G.todayISO(), made = [];
  for (let n = 1; n <= GYMS; n++) made.push(gymDocs(n, today, password));
  await db.insert('gyms', made.map((m) => m.gym));
  for (const name of ['customers', 'memberships', 'transactions', 'sessions']) {
    const all = made.flatMap((m) => m[name]);
    for (let at = 0; at < all.length; at += 2000) await db.insert(name, all.slice(at, at + 2000));
  }
  return made;
}

// The real database: the made-up gyms go in beside the real ones, marked, and come out by that mark alone.
async function live(base) {
  if (!db.usingMongo || base.databaseName === DB_NAME) throw new Error('This needs MONGODB_URI in .env, and no MONGODB_DB pointing at the load-test database.');
  const gyms = await db.find('gyms'), old = gyms.filter((g) => g.loadtest === true);
  if (MODE === 'live-remove') {
    for (const g of old) {
      for (const name of ['sessions', 'backups', 'transactions', 'memberships', 'customers']) await db.remove(name, { gymId: g._id });
      await db.remove('gyms', { _id: g._id });
    }
    return console.log(`Took ${old.length} made-up gyms out of the database ${base.databaseName}. ${gyms.length - old.length} real gyms are untouched.`);
  }
  if (MODE !== 'live') throw new Error('Use: node loadtest.js live   or   node loadtest.js live-remove');
  if (old.length) throw new Error(`${old.length} made-up gyms are already in ${base.databaseName}. Take them out first: node loadtest.js live-remove`);
  if (gyms.some((g) => /^load[0-9][0-9]$/.test(g.email))) throw new Error('A real gym already uses a username like load01. Nothing was added.');
  // Nobody can sign in as these: the password is random and kept nowhere. The owner of the service opens them from Accounts.
  const made = await fill(crypto.randomBytes(24).toString('hex'));
  return console.log(`Added ${made.length} made-up gyms to the database ${base.databaseName}: ${made.length * MEMBERS} members, ${made.reduce((n, m) => n + m.transactions.length, 0)} payments, ${made.length * SIGN_INS} sign-ins.
They are named Load Gym 01 to ${GYMS}. Open them from the Accounts page. 'node loadtest.js live-remove' takes them out again.`);
}

async function main() {
  const base = await db.ready;
  if (LIVE) return live(base);
  if (!db.usingMongo || base.databaseName !== DB_NAME) throw new Error('This needs MONGODB_URI in .env, and it only ever works on the load-test database.');
  if (process.argv[2] === 'drop') { await base.dropDatabase(); return console.log(`Removed the database ${DB_NAME}.`); }

  // ---- fill
  await base.dropDatabase();
  await db.indexes(); // dropping the database took its indexes along
  const today = G.todayISO();
  let began = performance.now();
  const made = await fill(PASSWORD);
  const fillSeconds = Math.round((performance.now() - began) / 1000);

  // ---- measure, through the real server
  const srv = await server.start(0), url = `http://127.0.0.1:${srv.address().port}`, errors = [];
  const call = async (token, method, path, body) => {
    const t = performance.now(), res = await fetch(url + path, { method, headers: { 'Content-Type': 'application/json', cookie: `sid=${token}` }, body: body && JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) errors.push(`${method} ${path} -> ${res.status} ${text.slice(0, 80)}`);
    return { ms: performance.now() - t, bytes: text.length, data: res.ok ? JSON.parse(text) : null };
  };
  const report = [];
  const row = (what, value) => { report.push([what, value]); };

  // one gym's page, read from the database every time, then from the cache
  const one = made[0], cold = [], warm = [];
  for (let i = 0; i < 6; i++) { cache.clear(); cold.push((await call(one.token, 'GET', '/api/data')).ms); }
  const page = await call(one.token, 'GET', '/api/data');
  for (let i = 0; i < 6; i++) warm.push((await call(one.token, 'GET', '/api/data')).ms);
  row('One gym opens its page (from the database)', `${middle(cold)} ms`);
  row('The same page again (from the cache)', `${middle(warm)} ms`);
  row('What that page carries', `${page.data.members.length} members, ${page.data.payments.length} payments, ${Math.round(page.bytes / 1024)} KB`);

  // all fifty gyms open their page in the same instant
  cache.clear();
  began = performance.now();
  let all = await Promise.all(made.map((m) => call(m.token, 'GET', '/api/data')));
  row(`All ${GYMS} gyms open their page at the same instant (from the database)`, `all done in ${Math.round(performance.now() - began)} ms, slowest ${most(all.map((a) => a.ms))} ms`);
  began = performance.now();
  all = await Promise.all(made.map((m) => call(m.token, 'GET', '/api/data')));
  row(`The same again (from the cache)`, `all done in ${Math.round(performance.now() - began)} ms, slowest ${most(all.map((a) => a.ms))} ms`);

  // a busy minute squeezed into one burst: every gym asks four things at once
  began = performance.now();
  all = await Promise.all(made.flatMap((m) => [call(m.token, 'GET', '/api/data'), call(m.token, 'POST', '/api/chat', { question: 'kiski fees baaki hai', quick: true }),
    call(m.token, 'GET', '/api/data'), call(m.token, 'POST', '/api/chat', { question: 'is mahine kitna paisa aaya', quick: true })]));
  row(`${all.length} requests at once (pages and questions)`, `all done in ${Math.round(performance.now() - began)} ms, middle ${middle(all.map((a) => a.ms))} ms, slowest ${most(all.map((a) => a.ms))} ms`);

  // every gym adds a member and takes a payment at the same time, then opens its page
  began = performance.now();
  all = await Promise.all(made.map(async (m, n) => {
    const t = performance.now(), added = await call(m.token, 'POST', '/api/members', { name: 'New Member', phone: `8${String(100000000 + n)}`, months: 3 });
    if (added.data) await call(m.token, 'POST', `/api/members/${added.data.id}/pay`, { amount: 1000, mode: 'UPI' });
    await call(m.token, 'GET', '/api/data');
    return { ms: performance.now() - t };
  }));
  row(`All ${GYMS} gyms add a member, take a payment and reopen the page, together`, `all done in ${Math.round(performance.now() - began)} ms, slowest ${most(all.map((a) => a.ms))} ms`);

  // the owner's page reads every gym
  const login = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner', password: process.env.ADMIN_PASSWORD }) });
  const ownerToken = /sid=([a-f0-9]{64})/.exec(login.headers.get('set-cookie') || '')[1], adminTimes = [];
  let accounts;
  for (let i = 0; i < 3; i++) { accounts = await call(ownerToken, 'GET', '/api/admin/gyms'); adminTimes.push(accounts.ms); }
  row("The owner's Accounts page (reads every gym)", `${middle(adminTimes)} ms for ${accounts.data.length} gyms`);

  // the day's backup of every gym
  began = performance.now();
  await server.daily();
  row(`The daily backup of all ${GYMS} gyms`, `${Math.round((performance.now() - began) / 1000)} s`);

  // what it all weighs
  const stats = await base.stats(), counts = {};
  for (const name of ['gyms', 'customers', 'memberships', 'transactions', 'sessions', 'backups']) counts[name] = await base.collection(name).countDocuments();
  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
  row('Documents', Object.entries(counts).map(([k, v]) => `${k} ${v.toLocaleString('en-IN')}`).join(', '));
  row('Space in MongoDB', `${mb(stats.dataSize)} of data, ${mb(stats.indexSize)} of indexes, ${mb(stats.storageSize + stats.indexSize)} on disk (the free plan holds 512 MB)`);
  row('Memory of this process', `${Math.round(process.memoryUsage().rss / 1048576)} MB, with the test's own copy of all the data in it; the server alone uses less`);
  row('Time to put the data in', `${fillSeconds} s`);
  row('Requests that failed', errors.length ? `${errors.length}: ${[...new Set(errors)].slice(0, 5).join(' | ')}` : 'none');

  const wide = Math.max(...report.map(([what]) => what.length));
  console.log(`\nLoad test on ${DB_NAME}, ${today}\n`);
  for (const [what, value] of report) console.log(`${what.padEnd(wide)}  ${value}`);
  console.log(`\nThe data is still there: look at the database ${DB_NAME} in Atlas. 'node loadtest.js drop' removes it.`);
  srv.close();
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
