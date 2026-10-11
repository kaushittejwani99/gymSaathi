// The sample members a gym can look around with. They live in this file, not in the database: showing them is a mark
// on the gym, removing them is taking that mark off, and they are the same for every gym. Their dates are counted
// back from today, so there is always somebody whose membership is about to end and somebody who owes a fee.
// They can be looked at, asked about and reminded, but not changed: nothing about them is ever written down.
'use strict';
const G = require('./core');

// name, mobile, months, days since the membership began (as a negative number), fee, paid
const ROWS = [
  ['Rahul Sharma', '9829011101', 3, -80, 2700, 2700],
  ['Priya Jain', '9829011102', 1, -27, 1000, 1000],
  ['Amit Soni', '9829011103', 1, -2, 1000, 0],
  ['Neha Agarwal', '9829011104', 12, -200, 9000, 5000],
  ['Suresh Mali', '9829011105', 1, -40, 1000, 1000],
  ['Kavita Rathore', '9829011106', 3, -10, 2700, 2700],
  ['Deepak Kothari', '9829011107', 1, 0, 3000, 1000],
  ['Sunita Vyas', '9829011108', 1, -29, 1000, 1000],
];

// Ids no real record has: 5a, then 0 for a member, 1 for a membership, 2 for a payment, then the row's number.
const id = (kind, row) => `5a${kind}${String(row).padStart(13, '0')}`;
const isSampleId = (v) => typeof v === 'string' && /^5a[012]\d{13}$/.test(v);

// The sample as the three lists a gym's own records come in.
function records(gymId, today) {
  const customers = [], memberships = [], transactions = [];
  ROWS.forEach(([name, phone, months, ago, fee, paid], row) => {
    const start = G.addDays(today, ago), customerId = id(0, row), membershipId = id(1, row);
    customers.push({ _id: customerId, gymId, name, phone, gender: '', age: '', weight: '', height: '', goal: '', health: '', batch: '', notes: '', joinedAt: start, sample: true });
    memberships.push({ _id: membershipId, gymId, customerId, months, start, end: G.endOf(start, months), fee, pt: fee === 3000, diet: false, createdAt: `${start}T00:00:00.000Z` });
    if (paid > 0) transactions.push({ _id: id(2, row), gymId, customerId, membershipId, name, amount: paid, mode: 'Cash', date: start, createdAt: `${start}T00:00:01.000Z` });
  });
  return { customers, memberships, transactions };
}

module.exports = { ROWS, records, isSampleId };
