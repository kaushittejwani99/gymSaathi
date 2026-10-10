// Where everything is kept: collections of documents, each with its own string _id.
//   gyms          one per gym: its login, its details and prices, when it first signed in and until when it may
//   customers     one per member of a gym: who they are
//   memberships   one per period a member bought. Only ever added: a renewal is a new document, so the history stays
//   transactions  one per payment received. Only ever added
//   sessions      who is signed in
// With MONGODB_URI set these are MongoDB collections (the free Atlas tier is enough), so the app can run on a host
// with no disk of its own. Without it each is a JSON file in DATA_DIR, which is all a single computer needs.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.resolve(__dirname, '..', process.env.DATA_DIR || 'data');
// Filters are plain equality on a few fields: { gymId, customerId }.
const hit = (filter) => (doc) => Object.entries(filter).every(([k, v]) => doc[k] === v);

function files() {
  const cache = new Map(), writing = new Map();
  const fileOf = (name) => path.join(DATA_DIR, `${name}.json`);
  const rows = (name) => {
    if (!cache.has(name)) {
      try { cache.set(name, JSON.parse(fs.readFileSync(fileOf(name), 'utf8'))); } catch (e) { if (e.code !== 'ENOENT') throw e; cache.set(name, []); }
    }
    return cache.get(name);
  };
  // Written beside the target and renamed over it: a crash leaves the old file or the new one, never half of each.
  // Writes of one file wait for the one before.
  const save = (name) => {
    const run = (writing.get(name) || Promise.resolve()).then(async () => {
      await fs.promises.mkdir(DATA_DIR, { recursive: true });
      await fs.promises.writeFile(`${fileOf(name)}.tmp`, JSON.stringify(rows(name)));
      await fs.promises.rename(`${fileOf(name)}.tmp`, fileOf(name));
    });
    writing.set(name, run.catch(() => {}));
    return run;
  };
  return {
    ready: Promise.resolve(),
    async find(name, filter = {}) { return structuredClone(rows(name).filter(hit(filter))); },
    async insert(name, doc) { rows(name).push(structuredClone(doc)); await save(name); },
    async update(name, filter, patch) { for (const doc of rows(name).filter(hit(filter))) Object.assign(doc, structuredClone(patch)); await save(name); },
    async remove(name, filter) { cache.set(name, rows(name).filter((doc) => !hit(filter)(doc))); await save(name); },
  };
}

function mongo(uri) {
  const { MongoClient } = require('mongodb');
  const ready = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 }).connect().then(async (client) => {
    // Always the database 'gymsaathi', whatever name the address ends in, unless MONGODB_DB names another.
    const d = client.db(process.env.MONGODB_DB || 'gymsaathi');
    await Promise.all(['customers', 'memberships', 'transactions', 'sessions'].map((name) => d.collection(name).createIndex({ gymId: 1 })));
    return d;
  }, (e) => { throw new Error(`Could not connect to MongoDB: ${e.message}`); });
  const col = async (name) => (await ready).collection(name);
  return {
    ready,
    async find(name, filter = {}) { return (await col(name)).find(filter).toArray(); },
    async insert(name, doc) { await (await col(name)).insertOne(doc); },
    async update(name, filter, patch) { await (await col(name)).updateMany(filter, { $set: patch }); },
    async remove(name, filter) { await (await col(name)).deleteMany(filter); },
  };
}

module.exports = { ...(process.env.MONGODB_URI ? mongo(process.env.MONGODB_URI) : files()), DATA_DIR, usingMongo: !!process.env.MONGODB_URI };
