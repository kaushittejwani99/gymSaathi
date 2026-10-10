// A short-lived copy of what is read most, so a page does not ask the database for the same thing over and over.
// By default the copies live in this process's memory, which is right for one small server and needs nothing set up.
// With REDIS_URL set they live in Redis instead: that is what several copies of the server need, to share one cache.
// Whatever goes wrong here, the caller just reads the database. A cache must never break a request.
'use strict';

const PREFIX = 'gs:';
const MAX_KEPT = 2000; // entries held in memory; the oldest goes when a new one comes

function memory() {
  const kept = new Map(); // key -> { text, until }
  return {
    async get(key) {
      const entry = kept.get(key);
      if (entry && entry.until < Date.now()) kept.delete(key);
      return kept.has(key) ? entry.text : undefined;
    },
    async set(key, text, seconds) {
      if (!kept.has(key) && kept.size >= MAX_KEPT) kept.delete(kept.keys().next().value);
      kept.set(key, { text, until: Date.now() + seconds * 1000 });
    },
    async del(keys) { for (const key of keys) kept.delete(key); },
    clear() { kept.clear(); },
  };
}

// While Redis cannot be reached every read goes to the database, and the client keeps trying to connect again.
// ponytail: a change made while Redis is unreachable cannot clear its copy there, so that copy may be served for up to
// its lifetime after Redis returns. Keep lifetimes short (they are), or clear by prefix on reconnect if that ever bites.
function redis(url) {
  const client = require('redis').createClient({ url, socket: { reconnectStrategy: (tries) => Math.min(tries * 500, 15000) } });
  let told = false;
  client.on('error', (e) => { if (!told) console.error('Redis cannot be reached, so nothing is cached for now:', e.message); told = true; });
  client.on('ready', () => { told = false; });
  client.connect().catch(() => {});
  return {
    async get(key) { return client.isReady ? (await client.get(key)) ?? undefined : undefined; },
    async set(key, text, seconds) { if (client.isReady) await client.setEx(key, seconds, text); },
    async del(keys) { if (client.isReady) await client.del(keys); },
    clear() {}, // never empties a Redis that may hold other things
  };
}

const store = process.env.REDIS_URL ? redis(process.env.REDIS_URL) : memory();
const quiet = (work) => work.catch((e) => { console.error('Cache:', e.message); return undefined; });
// How many times each key was dropped. A read that began before a drop must not put its old answer back afterwards.
const drops = new Map();

// What is kept under `key`; when nothing is, what `load` reads, which is then kept for `seconds`.
async function through(key, seconds, load) {
  const text = await quiet(store.get(PREFIX + key));
  if (text !== undefined) return JSON.parse(text);
  const before = drops.get(key) || 0, value = await load();
  if (value !== undefined && (drops.get(key) || 0) === before) await quiet(store.set(PREFIX + key, JSON.stringify(value), seconds));
  return value;
}
// Forgets what is kept under these keys. Called after every change to what they hold.
async function drop(...keys) {
  for (const key of keys) drops.set(key, (drops.get(key) || 0) + 1);
  if (drops.size > 50000) drops.clear();
  await quiet(store.del(keys.map((key) => PREFIX + key)));
}

module.exports = { through, drop, clear: () => store.clear(), usingRedis: !!process.env.REDIS_URL };
