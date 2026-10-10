// Where everything is kept: whole documents under a key ('users', 'sessions', 'gym:<id>').
// With MONGODB_URI set they live in a MongoDB collection (the free Atlas tier is enough), so the app can run on a
// host with no disk of its own. Without it they are JSON files in DATA_DIR, which is all a single computer needs.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.resolve(__dirname, '..', process.env.DATA_DIR || 'data');
const fileOf = (key) => path.join(DATA_DIR, `${key.replace(/[^a-z0-9-]/g, '_')}.json`);

const files = {
  async get(key) {
    try { return JSON.parse(await fs.promises.readFile(fileOf(key), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
  },
  // Written beside the target and renamed over it: a crash leaves the old file or the new one, never half of each.
  async set(key, value) {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    await fs.promises.writeFile(`${fileOf(key)}.tmp`, JSON.stringify(value));
    await fs.promises.rename(`${fileOf(key)}.tmp`, fileOf(key));
  },
};

function mongo(uri) {
  const { MongoClient } = require('mongodb');
  const col = new MongoClient(uri).connect().then((c) => c.db(process.env.MONGODB_DB || 'gymsaathi').collection('docs'));
  col.catch((e) => console.error('Could not connect to MongoDB:', e.message));
  return {
    async get(key) { const doc = await (await col).findOne({ _id: key }); return doc ? doc.value : undefined; },
    async set(key, value) { await (await col).replaceOne({ _id: key }, { _id: key, value }, { upsert: true }); },
  };
}

const store = process.env.MONGODB_URI ? mongo(process.env.MONGODB_URI) : files;

// A document is read, changed and written back whole, so two changes to the same one must not overlap: each waits
// for the one before it.
// ponytail: the queue is in this process, so run one copy of the server; use per-document versions if that changes.
const queues = new Map();
function change(key, fn, fallback) {
  const run = (queues.get(key) || Promise.resolve()).then(async () => {
    const doc = (await store.get(key)) ?? fallback;
    const out = await fn(doc);
    await store.set(key, doc);
    return out;
  });
  queues.set(key, run.catch(() => {}));
  return run;
}

module.exports = { get: (key) => store.get(key), set: (key, value) => store.set(key, value), change, DATA_DIR, usingMongo: !!process.env.MONGODB_URI };
