// Checks the date and fee rules, then drives the whole API on a temporary folder: node test.js
// Nothing here reaches Google or WhatsApp, and your real data is never touched.
// `node test.js mongo` runs the same checks on the MongoDB that .env names, in a database of their own
// (gymsaathi_test) that is dropped at the end.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const G = require('./lib/core');

function coreChecks() {
  assert.deepEqual([G.endOf('2026-10-10', 1), G.endOf('2026-10-10', 12), G.endOf('2026-01-31', 1), G.endOf('2024-01-31', 1)], ['2026-11-09', '2027-10-09', '2026-02-27', '2024-02-28']);
  const gym = { name: 'Fit Zone', owner: 'Vikram', price1: 1000, price3: 2700, price12: 9000, ptPrice: 2000, dietPrice: 500 };
  // A price left empty is the monthly price times the months; a trainer and a diet plan are charged per month
  assert.deepEqual([G.feeFor(gym, { months: 1 }), G.feeFor(gym, { months: 3, pt: true }), G.feeFor(gym, { months: 6 }), G.feeFor(gym, { months: 12, pt: true, diet: true })], [1000, 8700, 6000, 39000]);
  // Any whole number of months can be bought; a length the gym has no price for costs the monthly price times the months
  assert.deepEqual([G.okMonths(9), G.okMonths(0), G.okMonths(37), G.okMonths(2.5), G.feeFor(gym, { months: 9 }), G.planLabel(9), G.planLabel(1), G.planLabel(12)], [true, false, false, false, 9000, '9 महीने', '1 महीना', '1 साल']);
  const m = (more) => ({ id: 'm1', name: 'Rahul', phone: '9829011111', joinedAt: '2026-04-01', start: '2026-10-01', end: '2026-10-31', months: 1, fee: 1000, paid: 1000, ...more });
  const kinds = (member, day, sent) => G.reminders({ gym, members: [member], sent: sent || {} }, day).map((r) => r.type);
  assert.deepEqual([G.statusOf(m(), '2026-10-20'), G.statusOf(m(), '2026-10-25'), G.statusOf(m(), '2026-11-01')], ['active', 'expiring', 'expired']);
  // Fees are asked for every day; the end of a membership every day from five days before it to five days after
  assert.deepEqual([kinds(m(), '2026-10-20'), kinds(m({ paid: 400 }), '2026-10-20'), kinds(m(), '2026-10-25'), kinds(m(), '2026-10-26'), kinds(m(), '2026-10-31'), kinds(m(), '2026-11-01'), kinds(m(), '2026-11-05'),
    kinds(m(), '2026-11-06'), kinds(m({ paid: 400 }), '2026-11-06')], [[], ['fees'], [], ['expiring'], ['expiring'], ['expired'], ['expired'], [], ['fees']]);
  assert.deepEqual(kinds(m({ paid: 400 }), '2026-10-20', { '2026-10-20': { 'm1:fees': true } }), []);
  // Each reminder says when the member joined and what length they took. It is a fixed sentence with numbered blanks,
  // and the values for the blanks are what an automatic send hands to WhatsApp
  const text = G.messages(gym, m({ paid: 400, months: 6 })), [fees] = G.reminders({ gym, members: [m({ paid: 400, months: 6 })], sent: {} }, '2026-10-20');
  assert.equal(text.fees, 'नमस्ते Rahul जी, Fit Zone की ओर से सूचना। आपने 1 Apr 2026 को जिम जॉइन किया था और 6 महीने की मेंबरशिप ली है, जो 31 Oct 2026 तक है। आपकी फीस ₹600 बाकी है। कृपया जल्द जमा करवा दें। भुगतान: जिम काउंटर पर। धन्यवाद।');
  assert.deepEqual([fees.params, fees.text], [['Rahul', 'Fit Zone', '1 Apr 2026', '6 महीने', '31 Oct 2026', '₹600', 'जिम काउंटर पर'], text.fees]);
  assert.ok(text.expiring.includes('6 महीने की मेंबरशिप 31 Oct 2026 को खत्म हो रही है') && text.expired.includes('खत्म हो चुकी है') && !/\{\{/.test(text.fees + text.expiring + text.expired), text.expiring);
  for (const t of Object.values(G.TEMPLATES)) assert.deepEqual(t.body.match(/\{\{\d\}\}/g), t.body.match(/\{\{\d\}\}/g).map((x, i) => `{{${i + 1}}}`)); // blanks are numbered in order
  assert.ok(G.waLink('+91 98290-11111', 'नमस्ते').startsWith('https://wa.me/919829011111?text=%E0%A4'));
}

const MONGO = process.argv[2] === 'mongo';

async function apiChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymsaathi-test-'));
  // Set before the server loads .env: what is already set wins, so nothing in .env can steer the test
  Object.assign(process.env, { DATA_DIR: dir, ADMIN_EMAIL: 'owner', ADMIN_PASSWORD: 'owner-password', GEMINI_API_KEY: '', GEMINI_MODEL: '', PAY_NOTE: '', WHATSAPP_TOKEN: '', WHATSAPP_PHONE_ID: '', WHATSAPP_API_VERSION: '', TRUST_PROXY: '', MONGODB_DB: 'gymsaathi_test' });
  if (!MONGO) process.env.MONGODB_URI = '';
  const srv = await require('./server').start(0), db = require('./lib/db');
  assert.equal(db.usingMongo, MONGO, MONGO ? 'Put MONGODB_URI in .env first.' : '');
  if (MONGO) await (await db.ready).dropDatabase(); // what an earlier run that broke off left behind
  const today = G.todayISO();
  const browser = () => {
    let cookie = '';
    return async (method, url, body) => {
      const res = await fetch(`http://127.0.0.1:${srv.address().port}${url}`, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) });
      cookie = (res.headers.get('set-cookie') || cookie).split(';')[0];
      return [res.status, await res.json().catch(() => ({}))];
    };
  };
  const ok = async (call) => { const [status, body] = await call; assert.equal(status, 200, JSON.stringify(body)); return body; };
  const status = async (call) => (await call)[0];
  const owner = browser(), gym = browser(), other = browser(), nobody = browser();
  const listed = async (email) => (await ok(owner('GET', '/api/admin/gyms'))).find((g) => g.email === email);

  try {
    // Only the owner of the service makes gym logins. The owner has no gym of their own
    assert.equal(await status(nobody('GET', '/api/data')), 401);
    await ok(owner('POST', '/api/auth/login', { email: 'owner', password: 'owner-password' }));
    assert.deepEqual([(await ok(owner('GET', '/api/data'))).gym, await status(owner('POST', '/api/members', { name: 'A', phone: '9829011111', months: 1 }))], [null, 400]);
    // A gym is added with its own details filled in: the gym, its owner and how to reach them, and its prices
    const fitZone = { name: 'Fit Zone', owner: 'Vikram', phone: '98290 00001', address: 'Azad Chowk, Bhilwara', amenities: 'Cardio, Steam', timings: '5 to 10', upi: 'fit@upi', price1: 800 };
    await ok(owner('POST', '/api/admin/gyms', { ...fitZone, email: 'fit.zone', password: 'first-password' }));
    await ok(owner('POST', '/api/admin/gyms', { ...fitZone, email: 'second.gym', password: 'first-password' }));
    assert.deepEqual([await status(owner('POST', '/api/admin/gyms', { ...fitZone, email: 'fit.zone', password: 'first-password' })), await status(owner('POST', '/api/admin/gyms', { ...fitZone, email: 'owner', password: 'first-password' })),
      await status(owner('POST', '/api/admin/gyms', { ...fitZone, owner: '', email: 'third.gym', password: 'first-password' })), await status(owner('POST', '/api/admin/gyms', { ...fitZone, phone: '123', email: 'third.gym', password: 'first-password' })),
      await status(owner('POST', '/api/admin/gyms', { ...fitZone, name: '', email: 'third.gym', password: 'first-password' }))], [409, 409, 400, 400, 400]);
    assert.deepEqual([(await listed('fit.zone')).owner, (await listed('fit.zone')).phone, await listed('third.gym')], ['Vikram', '9829000001', undefined]);

    // A gym's free month starts at its first sign-in, to the minute; signing in again does not move it
    assert.deepEqual([(await listed('fit.zone')).firstLoginAt, (await listed('fit.zone')).validTill], [null, null]);
    await ok(gym('POST', '/api/auth/login', { email: 'fit.zone', password: 'first-password' }));
    await ok(other('POST', '/api/auth/login', { email: 'second.gym', password: 'first-password' }));
    const fit = await listed('fit.zone');
    assert.ok(Math.abs(Date.parse(fit.firstLoginAt) - Date.now()) < 60e3, fit.firstLoginAt);
    assert.equal(fit.validTill, G.addMonths(fit.firstLoginAt.slice(0, 10), 1) + fit.firstLoginAt.slice(10));
    assert.deepEqual([await status(gym('GET', '/api/admin/gyms')), await status(gym('POST', '/api/auth/login', { email: 'fit.zone', password: 'wrong' }))], [403, 401]);
    await ok(gym('POST', '/api/auth/login', { email: 'fit.zone', password: 'first-password' }));
    assert.deepEqual([(await listed('fit.zone')).firstLoginAt, (await listed('fit.zone')).validTill, (await ok(gym('GET', '/api/data'))).validTill], [fit.firstLoginAt, fit.validTill, fit.validTill]);

    let data = await ok(gym('GET', '/api/data'));
    assert.deepEqual([data.gym.address, data.gym.amenities, data.gym.upi, data.gym.price1, data.gym.price3], ['Azad Chowk, Bhilwara', 'Cardio, Steam', 'fit@upi', 800, 0]);
    const prices = { name: 'Fit Zone', owner: 'Vikram', price1: 1000, price3: 2700, price12: 9000, ptPrice: 2000, dietPrice: 500 };
    assert.equal((await ok(gym('PUT', '/api/gym', prices))).price3, 2700);

    // The registration talk without AI: one answer at a time, as a gym owner hears them at the counter
    let t = await ok(gym('POST', '/api/register/turn', { form: {} }));
    assert.deepEqual([t.next, t.done, t.say.includes('नाम')], ['name', false, true]);
    const answers = { name: 'Rahul Sharma', phone: '98290 11111', gender: 'पुरुष', age: '25', weight: '70 किलो', height: '5 फुट 8 इंच', goal: 'बॉडी बनाना', health: 'नहीं', batch: 'सुबह',
      pt: 'हाँ चाहिए', diet: 'नहीं', months: '3 महीने', paid: 'बाद में दूँगा' };
    while (!t.done) t = await ok(gym('POST', '/api/register/turn', { form: t.form, asked: t.next, said: answers[t.next], tries: t.tries }));
    assert.deepEqual([t.form.name, t.form.phone, t.form.gender, t.form.age, t.form.weight, t.form.health, t.form.pt, t.form.diet, t.form.months, t.form.paid, t.fee],
      ['Rahul Sharma', '9829011111', 'Male', 25, 70, 'None', true, false, 3, 0, 8700]);
    // What is not understood is asked again; a second miss skips it, unless the record needs it
    let miss = await ok(gym('POST', '/api/register/turn', { form: { name: 'A', phone: '9829011112' }, asked: 'gender', said: 'अरे वो', tries: 0 }));
    assert.deepEqual([miss.next, miss.tries, miss.say.startsWith('माफ़')], ['gender', 1, true]);
    miss = await ok(gym('POST', '/api/register/turn', { form: miss.form, asked: 'gender', said: 'अरे', tries: 1 }));
    assert.deepEqual([miss.next, miss.form.gender], ['age', '']);
    miss = await ok(gym('POST', '/api/register/turn', { form: { name: 'A' }, asked: 'phone', said: '12345', tries: 3 }));
    assert.equal(miss.next, 'phone');

    // Saving the form makes the member. Nothing was paid, so the fee is pending and is asked for today
    const rahul = await ok(gym('POST', '/api/members', { ...t.form, fee: t.fee }));
    assert.deepEqual([rahul.fee, rahul.paid, rahul.pt, rahul.start, rahul.end, rahul.joinedAt], [8700, 0, true, today, G.endOf(today, 3), today]);
    data = await ok(gym('GET', '/api/data'));
    assert.deepEqual(G.reminders({ gym: data.gym, members: data.members, sent: { [today]: data.sent } }, today).map((r) => [r.type, r.name]), [['fees', 'Rahul Sharma']]);
    assert.equal(await status(gym('POST', '/api/members', { name: 'Twin', phone: '+91 98290-11111', months: 1 })), 409); // the same mobile number
    assert.deepEqual([await status(gym('POST', '/api/members', { name: 'No Plan', phone: '9829011113', months: 0 })), await status(gym('POST', '/api/members', { name: 'Long', phone: '9829011113', months: 37 })),
      await status(gym('POST', '/api/members', { name: 'Bad', phone: '12345', months: 1 }))], [400, 400, 400]);
    // A correction changes who the member is, never the period they bought
    const fixed = await ok(gym('PUT', `/api/members/${rahul.id}`, { name: 'Rahul Sharma', phone: '9829011111', age: 26, pt: false, months: 12 }));
    assert.deepEqual([fixed.age, fixed.pt, fixed.months, fixed.fee], [26, true, 3, 8700]);

    // A reminder that went out is not offered again today; a payment brings the dues down, and never below zero
    await ok(gym('POST', '/api/reminders/sent', { memberId: rahul.id, type: 'fees' }));
    assert.deepEqual((await ok(gym('GET', '/api/data'))).sent, { [`${rahul.id}:fees`]: true });
    assert.equal((await ok(gym('POST', `/api/members/${rahul.id}/pay`, { amount: 5000, mode: 'UPI' }))).paid, 5000);
    assert.equal(await status(gym('POST', `/api/members/${rahul.id}/pay`, { amount: 3701 })), 400);

    // Renewing starts the day after the old period ends and carries the dues over. The old period is not changed:
    // the new one is a document of its own, and so is each payment
    const renewed = await ok(gym('POST', `/api/members/${rahul.id}/renew`, { months: 1, pt: false, paid: 1000 }));
    assert.deepEqual([renewed.start, renewed.end, renewed.fee, renewed.paid, renewed.pt], [G.addDays(rahul.end, 1), G.endOf(G.addDays(rahul.end, 1), 1), 1000 + 3700, 1000, false]);
    assert.deepEqual(renewed.history, [{ months: 3, start: today, end: rahul.end, fee: 8700 }]);
    const periods = await db.find('memberships', { customerId: rahul.id }), paid = await db.find('transactions', { customerId: rahul.id });
    assert.deepEqual(periods.map((p) => [p.months, p.fee, p.pt]).sort(), [[1, 1000, false], [3, 8700, true]]);
    assert.deepEqual(paid.map((p) => periods.find((x) => x._id === p.membershipId).months).sort(), [1, 3]); // each payment names the period it was taken in
    data = await ok(gym('GET', '/api/data'));
    assert.deepEqual(data.payments.map((p) => [p.amount, p.mode]), [[5000, 'UPI'], [1000, 'Cash']]);

    // The other gym sees none of it
    assert.deepEqual([(await ok(other('GET', '/api/data'))).members.length, await status(other('PUT', `/api/members/${rahul.id}`, { name: 'X', phone: '9829011111' })),
      await status(other('POST', `/api/members/${rahul.id}/pay`, { amount: 1 })), await status(other('DELETE', `/api/members/${rahul.id}`))], [0, 404, 404, 404]);
    // The owner of the service sees every gym's numbers, and opens any gym to see what it sees
    const seen = await listed('fit.zone');
    assert.deepEqual([seen.gym, seen.owner, seen.members, seen.collected, seen.due, 'hash' in seen || 'salt' in seen], ['Fit Zone', 'Vikram', 1, 6000, 3700, false]);
    const opened = await ok(owner('GET', `/api/data?gym=${seen.id}`));
    assert.deepEqual([opened.gym.name, opened.members.map((m) => m.name), opened.payments.length, opened.user.admin], ['Fit Zone', ['Rahul Sharma'], 2, true]);
    const sly = await ok(gym('GET', `/api/data?gym=${(await listed('second.gym')).id}`)); // a gym naming another still gets its own
    assert.deepEqual([sly.members.length, sly.user.admin], [1, false]);

    // Questions are answered from the gym's own members; 'naya member jodo' starts the registration talk
    const owes = await ok(gym('POST', '/api/chat', { question: 'किसकी फीस बाकी है?', quick: true }));
    assert.ok(owes.answer.includes('Rahul Sharma') && owes.answer.includes('₹3,700'), owes.answer);
    const one = await ok(gym('POST', '/api/chat', { question: 'Rahul ki membership kab khatam hogi', quick: true }));
    assert.ok(one.answer.includes('Rahul Sharma') && one.answer.includes('मेंबरशिप:'), one.answer);
    assert.equal((await ok(gym('POST', '/api/chat', { question: 'नया मेंबर जोड़ो' }))).start, 'register');
    assert.ok(!(await ok(other('POST', '/api/chat', { question: 'किसकी फीस बाकी है?', quick: true }))).answer.includes('Rahul'));

    // With a Gemini key one spoken sentence can fill several answers. The call to Google is stubbed.
    const realFetch = global.fetch;
    let said = JSON.stringify({ name: 'Priya Jain', age: 24, weight: 58, gender: 'Female', paid: 99999, phone: '12' });
    global.fetch = (url, init) => (String(url).startsWith('https://generativelanguage.googleapis.com/')
      ? Promise.resolve(Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: said }] }] })) : realFetch(url, init));
    process.env.GEMINI_API_KEY = 'test-key';
    try {
      const many = await ok(gym('POST', '/api/register/turn', { form: {}, asked: 'name', said: 'इनका नाम प्रिया जैन है, 24 साल की हैं और वज़न 58 किलो' }));
      assert.deepEqual([many.form.name, many.form.age, many.form.weight, many.form.gender, many.form.phone, many.form.paid, many.next], ['Priya Jain', 24, 58, 'Female', undefined, undefined, 'phone']);
      // A reply from the AI that is no JSON falls back to the plain reading of the answer
      said = 'Sorry, I cannot help.';
      const plainly = await ok(gym('POST', '/api/register/turn', { form: { name: 'Priya Jain' }, asked: 'phone', said: 'मेरा नंबर है 98290 22222 लिख लीजिए' }));
      assert.deepEqual([plainly.form.phone, plainly.next], ['9829022222', 'gender']);
    } finally {
      process.env.GEMINI_API_KEY = '';
      global.fetch = realFetch;
    }

    // When the free month is over the gym is signed out everywhere and told to pay; signing in says the same
    const second = await listed('second.gym'), past = '2020-01-01T00:00:00.000Z';
    await db.update('gyms', { _id: second.id }, { validTill: past });
    let [code, body] = await other('GET', '/api/data');
    assert.deepEqual([code, body.error], [402, 'Your free trial is over. Pay ₹999 to start the service again.']);
    assert.equal(await status(other('GET', '/api/data')), 401);
    [code, body] = await other('POST', '/api/auth/login', { email: 'second.gym', password: 'first-password' });
    assert.deepEqual([code, body.error], [402, 'Your free trial is over. Pay ₹999 to start the service again.']);
    // The owner marks it paid: one month from now, and the gym signs in again. The first sign-in stays as it was
    const till = (await ok(owner('PUT', `/api/admin/gyms/${second.id}`, { addMonths: 1 }))).validTill;
    assert.equal(till.slice(0, 10), G.addMonths(new Date().toISOString().slice(0, 10), 1));
    await ok(other('POST', '/api/auth/login', { email: 'second.gym', password: 'first-password' }));
    assert.deepEqual([(await listed('second.gym')).firstLoginAt, (await listed('second.gym')).paidMonths, (await ok(other('GET', '/api/data'))).paying], [second.firstLoginAt, 1, true]);
    // Paying early adds to the time left; and once a paid month is over the message says plan, not trial
    assert.equal((await ok(owner('PUT', `/api/admin/gyms/${second.id}`, { addMonths: 12 }))).validTill, G.addMonths(till.slice(0, 10), 12) + till.slice(10));
    await db.update('gyms', { _id: second.id }, { validTill: past });
    assert.equal((await other('GET', '/api/data'))[1].error, 'Your plan is over. Pay ₹999 to start the service again.');
    assert.equal(await status(owner('PUT', `/api/admin/gyms/${second.id}`, { addMonths: 5 })), 400);

    // With WhatsApp set up the day's reminders go out by themselves: one template message each, with the values for
    // its blanks. One that went is not sent again; one that failed stays for the next run, and for a tap. Meta is stubbed.
    const amit = await ok(gym('POST', '/api/members', { name: 'Amit Soni', phone: '9829011114', months: 9 })); // 9 months, nothing paid
    assert.deepEqual([amit.months, amit.fee, amit.end], [9, 9000, G.endOf(today, 9)]);
    await ok(gym('POST', '/api/members', { name: 'Neha Jain', phone: '9829011115', months: 1 }));
    const posted = [], real = global.fetch;
    let refuse = '919829011115';
    global.fetch = (url, init) => {
      if (!String(url).startsWith('https://graph.facebook.com/')) return real(url, init);
      const sent = JSON.parse(init.body);
      posted.push([url, init.headers.Authorization, sent]);
      return Promise.resolve(Response.json(sent.to === refuse ? { error: { message: 'not on WhatsApp' } } : { messages: [{ id: 'x' }] }, { status: sent.to === refuse ? 400 : 200 }));
    };
    Object.assign(process.env, { WHATSAPP_TOKEN: 'test-token', WHATSAPP_PHONE_ID: '111' });
    try {
      const { runReminders } = require('./server');
      // Rahul's fees reminder went out by a tap earlier today, and the gym whose time is over sends nothing
      assert.deepEqual(await runReminders(today), { sent: 1, failed: 1 });
      const [url, auth, first] = posted[0];
      assert.deepEqual([url, auth, first.to, first.type, first.template.name, first.template.language.code], ['https://graph.facebook.com/v22.0/111/messages', 'Bearer test-token', '919829011114', 'template', 'gs_fees_pending', 'hi']);
      assert.deepEqual(first.template.components[0].parameters.map((p) => p.text), ['Amit Soni', 'Fit Zone', G.fmtDate(today), '9 महीने', G.fmtDate(amit.end), '₹9,000', 'जिम काउंटर पर']);
      data = await ok(gym('GET', '/api/data'));
      assert.deepEqual([Object.keys(data.sent).sort(), data.autoWhatsApp], [[`${amit.id}:fees`, `${rahul.id}:fees`].sort(), true]);
      refuse = '';
      assert.deepEqual([await runReminders(today), await runReminders(today), posted.length], [{ sent: 1, failed: 0 }, { sent: 0, failed: 0 }, 3]);
    } finally {
      process.env.WHATSAPP_TOKEN = '';
      global.fetch = real;
    }

    // The owner of the service can change a gym's username, to one nobody else has; an empty password keeps the old one
    const third = (await ok(owner('POST', '/api/admin/gyms', { ...fitZone, name: 'Ox Fit', email: 'third.gym', password: 'first-password' }))).id;
    assert.deepEqual([await status(owner('PUT', `/api/admin/gyms/${third}`, { email: 'fit.zone' })), await status(owner('PUT', `/api/admin/gyms/${third}`, { email: 'owner' })),
      await status(owner('PUT', `/api/admin/gyms/${third}`, { email: 'third.gym', password: '' })), await status(owner('PUT', `/api/admin/gyms/${third}`, { email: 'OxFit', password: '' }))], [409, 409, 400, 200]);
    assert.deepEqual([await status(browser()('POST', '/api/auth/login', { email: 'third.gym', password: 'first-password' })), await status(browser()('POST', '/api/auth/login', { email: 'Ox Fit', password: 'first-password' })),
      await status(browser()('POST', '/api/auth/login', { email: 'oxfit', password: 'first-password' }))], [401, 401, 200]);

    // Passwords: the gym changes its own; the owner resets one and switches a gym off
    assert.equal(await status(gym('POST', '/api/auth/password', { current: 'wrong-one', password: 'second-password' })), 400);
    await ok(gym('POST', '/api/auth/password', { current: 'first-password', password: 'second-password' }));
    assert.deepEqual([await status(gym('GET', '/api/data')), await status(browser()('POST', '/api/auth/login', { email: 'fit.zone', password: 'first-password' }))], [200, 401]);
    await ok(owner('PUT', `/api/admin/gyms/${seen.id}`, { disabled: true }));
    assert.deepEqual([await status(gym('GET', '/api/data')), await status(gym('POST', '/api/auth/login', { email: 'fit.zone', password: 'second-password' }))], [401, 403]);
    // Deleting a member takes their periods and payments along; the owner signs out
    await ok(owner('DELETE', `/api/members/${rahul.id}?gym=${seen.id}`));
    assert.deepEqual([(await db.find('memberships', { customerId: rahul.id })).length, (await db.find('transactions', { customerId: rahul.id })).length, (await db.find('memberships', { gymId: seen.id })).length], [0, 0, 2]);
    await ok(owner('POST', '/api/auth/logout'));
    assert.equal(await status(owner('GET', '/api/admin/gyms')), 401);
    // One file per collection, and a write without the JSON content type is refused
    if (!MONGO) assert.deepEqual(fs.readdirSync(dir).sort(), ['customers.json', 'gyms.json', 'memberships.json', 'sessions.json', 'transactions.json']);
    const plain = await fetch(`http://127.0.0.1:${srv.address().port}/api/auth/login`, { method: 'POST', body: '{}' });
    assert.equal(plain.status, 415);
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (MONGO) await (await db.ready).dropDatabase();
  }
}

(async () => {
  coreChecks();
  console.log('ok  dates, fees and reminders');
  await apiChecks();
  console.log(`ok  api (${MONGO ? 'MongoDB' : 'files'})`);
  if (MONGO) process.exit(0); // the database connection would keep the process open
})().catch((e) => { console.error(e); process.exit(1); });
