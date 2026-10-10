// Puts everything back from a file saved with 'Download backup' on the Accounts page:
//   node restore.js gymsaathi-backup-2026-10-10.json.gz --yes
// It REPLACES every gym, member, membership and payment in the store that .env names, and signs everyone out.
// It is for the day the database is lost or wrecked; to put one gym back by a day or two, use Backups on the Accounts page.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

if (fs.existsSync(path.join(__dirname, '.env'))) process.loadEnvFile(path.join(__dirname, '.env'));
const db = require('./lib/db');

const NAMES = ['gyms', 'customers', 'memberships', 'transactions'];
const [file, yes] = process.argv.slice(2);

(async () => {
  if (!file || yes !== '--yes') throw new Error('Usage: node restore.js <backup file> --yes\nThis replaces everything in the database with what the file holds.');
  const all = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  if (!NAMES.every((name) => Array.isArray(all[name]))) throw new Error('That is not a GymSaathi backup file.');
  await db.ready;
  for (const name of [...NAMES, 'sessions']) await db.remove(name, {});
  for (const name of NAMES) await db.insert(name, all[name]);
  console.log(`Put back ${all.gyms.length} gyms, ${all.customers.length} members, ${all.memberships.length} memberships and ${all.transactions.length} payments, as they were on ${all.madeAt}.`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
