// Checks the date and fee rules, then drives the whole API on a temporary folder: node test.js
// Nothing here reaches Google or WhatsApp, and your real data is never touched.
// `node test.js mongo` runs the same checks on the MongoDB that .env names, in a database of their own
// (gymsaathi_test) that is dropped at the end.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
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

// The cache keeps an answer until it is dropped or its time is up, and never keeps a failure or an answer that a
// change has overtaken.
async function cacheChecks() {
  const cache = require('./lib/cache');
  let reads = 0;
  const load = async () => ++reads;
  assert.deepEqual([await cache.through('k', 60, load), await cache.through('k', 60, load), reads], [1, 1, 1]);
  await cache.drop('k');
  assert.deepEqual([await cache.through('k', 60, load), reads], [2, 2]);
  assert.deepEqual([await cache.through('gone', 0, async () => ({ a: [1] })), await new Promise((r) => setTimeout(r, 5)), await cache.through('gone', 60, async () => 'fresh')], [{ a: [1] }, undefined, 'fresh']);
  // A read that began before a change does not put its old answer back after it
  let finish;
  const slow = cache.through('s', 60, () => new Promise((r) => { finish = () => r('old'); }));
  await new Promise((r) => setImmediate(r));
  await cache.drop('s');
  finish();
  assert.deepEqual([await slow, await cache.through('s', 60, async () => 'new')], ['old', 'new']);
  await assert.rejects(cache.through('f', 60, async () => { throw new Error('database down'); }));
  assert.equal(await cache.through('f', 60, async () => 'up again'), 'up again');
}

// When several members share the name asked about, the assistant picks nobody: it asks which one and lists their mobile
// numbers. The owner answers with the number, its last digits, or the rest of the name, and gets that member.
async function talkChecks() {
  const ai = require('./lib/ai'), today = '2026-10-11';
  const member = (id, name, phone, owed) => ({ id, name, phone, months: 1, start: '2026-10-01', end: '2026-10-31', fee: 1000, paid: 1000 - owed, joinedAt: '2026-10-01' });
  const db = { gym: { name: 'Fit Zone' }, payments: [], members: [member('a', 'Rahul Sharma', '9829011111', 0), member('b', 'Rahul Verma', '9829022222', 400), member('c', 'Rahul Sharma', '9829033333', 1000), member('d', 'Priya Jain', '9829044444', 0)] };
  const talk = [];
  const say = async (question) => { const r = await ai.chat({ question, db, today, quick: true, history: talk.slice(-6) }); talk.push({ who: 'me', text: question }, { who: 'ai', text: r.answer }); return r.answer.split('\n'); };
  const fresh = (question) => { talk.length = 0; return say(question); };
  assert.deepEqual(await fresh('rahul ki fees kitni baaki hai'), ['इस नाम के 3 मेंबर हैं। किसकी बात कर रहे हैं? मोबाइल नंबर बताइए।', '- Rahul Sharma: 9829011111', '- Rahul Verma: 9829022222', '- Rahul Sharma: 9829033333']);
  assert.deepEqual([(await say('98290 33333'))[2], (await say('kab khatam hogi?'))[2]], ['- मोबाइल: 9829033333', '- मोबाइल: 9829033333']); // the number, and then a follow-up about the same one
  assert.deepEqual([(await fresh('rahul sharma ka hisaab')).length, (await say('3333'))[2]], [3, '- मोबाइल: 9829033333']);                        // two share the whole name; the last digits settle it
  assert.deepEqual([(await fresh('rahul ka hisaab')).length, (await say('verma'))[2]], [4, '- मोबाइल: 9829022222']);                                // the rest of the name settles it
  assert.deepEqual([(await fresh('rahul verma ki membership'))[2], (await fresh('priya ki fees kitni baaki hai'))[2]], ['- मोबाइल: 9829022222', '- मोबाइल: 9829044444']); // a name that fits one member asks nothing
  assert.deepEqual([(await fresh('kiski fees baaki hai'))[0], (await say('is mahine kitna aaya'))[0]], ['2 मेंबर की फीस बाकी है, कुल ₹1,400।', 'इस महीने ₹0 जमा हुए, 0 भुगतान में।']);
  // An 'ok' or a thank-you after an answer is not one more question about that member; a real follow-up still is
  assert.deepEqual([await fresh('priya ka hisaab'), await say('Ok.'), await say('theek hai ji'), await say('Thank you!'), await say('bye')].slice(1).map((a) => a.join('|')),
    ['ठीक है। और कुछ पूछना हो तो बताइए।', 'ठीक है। और कुछ पूछना हो तो बताइए।', 'आपका स्वागत है। और कुछ पूछना हो तो बताइए।', 'ठीक है, फिर मिलते हैं।']);
  assert.deepEqual([(await fresh('priya ka hisaab'))[2], (await say('ok'))[0], (await say('kab khatam hogi?'))[2]], ['- मोबाइल: 9829044444', 'ठीक है। और कुछ पूछना हो तो बताइए।', '- मोबाइल: 9829044444']);
  // Said aloud, a name comes in Hindi script and is found by its sound; the everyday words of a question are not names
  db.members.push(member('e', 'Kaushik Tejwani', '9116398862', 1000), member('f', 'Meena Das', '9829066666', 0), member('g', 'Tina Chaudhary', '9829077777', 0));
  assert.deepEqual([(await fresh('कौशिक की फीस जमा हुई है कि नहीं हुई है'))[2], (await fresh('तेजवानी का हिसाब'))[2], (await fresh('प्रिया जैन की मेंबरशिप'))[2], (await fresh('मीना की फीस'))[2], (await fresh('टीना चौधरी'))[2]],
    ['- मोबाइल: 9116398862', '- मोबाइल: 9116398862', '- मोबाइल: 9829044444', '- मोबाइल: 9829066666', '- मोबाइल: 9829077777']);
  assert.deepEqual([(await fresh('इस महीने में कितना पैसा आया'))[0], (await fresh('किसकी फीस बाकी है'))[0].slice(0, 10), (await fresh('तीन दिन में दस मेंबर की मेंबरशिप खत्म होगी क्या'))[0].slice(0, 9)], ['इस महीने ₹0 जमा हुए, 0 भुगतान में।', '3 मेंबर की', '7 दिन में']);
  db.members.length = 4;
  // A question may ask for a detail of the member: the sentence gives it, or says that it is not written down
  db.members[3].goal = 'Weight loss';
  assert.deepEqual([(await fresh('priya ka goal kya h?'))[0], (await fresh('priya ki umar kitni hai'))[0], (await fresh('priya ka goal kya h?')).length], ['Priya Jain का लक्ष्य: Weight loss।', 'Priya Jain की उम्र: लिखा नहीं है।', 7]);
  // Twenty-one Rohits, one of them Rohit bacchan, who is past the fifteen that a list has room for. His full name finds
  // him at once, said in Hindi or typed with another spelling. Asked for by the first name alone, 'which one?' is
  // settled by his number: all of it, part of it, with a space in it. A number nobody has is said to be nobody's
  const crowd = { gym: { name: 'Fit Zone' }, payments: [], members: [...Array.from({ length: 20 }, (x, i) => member(`r${i}`, `Rohit ${['Mali', 'Lodha', 'Pareek', 'Tiwari'][i % 4]}`, `97000${String(10000 + i * 3425).slice(0, 5)}`, 0)), member('rb', 'Rohit bacchan', '9223642960', 0)] };
  const among = async (question, history = []) => { const lines = (await ai.chat({ question, db: crowd, today, history })).answer.split('\n'); return lines[2] === '- मोबाइल: 9223642960' ? 'Rohit bacchan' : lines[0]; };
  const whichRohit = [{ who: 'me', text: 'rohit ki fees kitni baaki hai' }, { who: 'ai', text: (await ai.chat({ question: 'rohit ki fees kitni baaki hai', db: crowd, today })).answer }];
  assert.deepEqual([await among('रोहित बच्चन की फीस कितनी बकाया है'), await among('rohit bachchan ka hisaab'), await among('rohit bachan ki fees'), whichRohit[1].text.split('\n')[0], whichRohit[1].text.includes('9223642960'),
    await among('9223 64296', whichRohit), await among('2960', whichRohit), await among('बच्चन', whichRohit), await among('92236 42960'), await among('64296'), await among('88888 11111', whichRohit), await among('55555')],
    ['Rohit bacchan', 'Rohit bacchan', 'Rohit bacchan', 'इस नाम के 21 मेंबर हैं। किसकी बात कर रहे हैं? मोबाइल नंबर बताइए।', false, 'Rohit bacchan', 'Rohit bacchan', 'Rohit bacchan', 'Rohit bacchan', 'Rohit bacchan',
      'इस नंबर का कोई मेंबर नहीं मिला। नंबर एक बार फिर देखकर बताइए, या पूरा नाम बोलिए।', 'इस नंबर का कोई मेंबर नहीं मिला। नंबर एक बार फिर देखकर बताइए, या पूरा नाम बोलिए।']);
  // Only an order in the imperative is an order. What was done, or is asked about, is answered with where the member
  // stands. The assistant's own words, which the phone's microphone may hear from its loudspeaker, are nobody's order,
  // and while a 'shall I?' waits only a short plain reply is a yes
  const club = { gym: { name: 'Fit Zone', price1: 1000 }, payments: [], deleted: [{ id: 'x1', name: 'Rohit', phone: '9922233344', deletedAt: '2026-10-12T05:00:00.000Z' }, { id: 'x2', name: 'Priya Jain', phone: '9829044400', deletedAt: '2026-10-11T05:00:00.000Z' }],
    members: [member('r1', 'Rohit Mali', '9700001644', 0), member('r2', 'Rohit Lodha', '9700005069', 0), member('rn', 'Rohit', '9922233355', 400), member('p', 'Priya Jain', '9829044444', 400)] };
  const got = async (question, history = [], more = {}) => { const r = await ai.chat({ question, db: club, today, history, ...more }); return r.pending ? `${r.pending.do} ${r.pending.id}` : r.run ? 'run' : r.no ? 'no' : r.answer.split('\n')[0]; };
  const stillHere = (name) => `${name} अभी मेंबर हैं, हटाए नहीं गए हैं। हटाना हो तो बोलिए: "${name} को हटा दो"।`, again = 'माफ़ कीजिए, ठीक से सुनाई नहीं दिया। फिर से बोलिए।';
  const shallI = [{ who: 'me', text: '9922233355 ko hata do' }, { who: 'ai', text: 'Rohit (9922233355) को जिम से हटा दूँ? 30 दिन तक Members के Deleted टैब से वापस ला सकते हैं।' }];
  assert.deepEqual([await got('priya ko hata do'), await got('प्रिया को हटा दो'), await got('priya ko delete kar do'), await got('priya ko nikal do'), await got('9922233355 ko hata do'), await got('priya ko 3 mahine renew kar do')],
    ['delete p', 'delete p', 'delete p', 'delete p', 'delete rn', 'renew p']);
  assert.deepEqual([await got('priya ko hata diya'), await got('प्रिया को हटा दिया'), await got('priya ko hata diya kya'), await got('maine priya ko nikal diya tha'), (await got('priya ka renew ho gaya')).slice(0, 10)],
    [stillHere('Priya Jain'), stillHere('Priya Jain'), stillHere('Priya Jain'), stillHere('Priya Jain'), 'Priya Jain']);
  // The owner's screenshot: the yes got no answer, he asks 'हटा दिया', and is not asked 'shall I delete?' all over again.
  // Once the member has gone, the same words are told so, though two other Rohits remain
  assert.deepEqual([await got('हटा दिया', [...shallI, { who: 'me', text: 'हाँ, कर दो' }]), await got('हटा दिया', [{ who: 'me', text: '9922233344 ko hata do' }, { who: 'ai', text: 'Rohit को हटा दिया। 30 दिन तक Members के Deleted टैब से वापस ला सकते हैं।' }])],
    [stillHere('Rohit'), 'Rohit को हटाया जा चुका है। 30 दिन तक Members के Deleted टैब से वापस ला सकते हैं।']);
  assert.deepEqual([await got('को जिम से हटा दूं 30 दिन तक मेंबर्स के डिलीटेड टैब से वापस ला सकते हैं', shallI), await got('के 400 रुपये कैश में जमा करूं', [{ who: 'me', text: 'priya ki fees jama kar do' }, { who: 'ai', text: 'Priya Jain (9829044444) के ₹400 कैश में जमा करूँ?' }])], [again, again]);
  const waiting = { confirming: true };
  assert.deepEqual([await got('हां कर दो', shallI, waiting), await got('ठीक है', shallI, waiting), await got('कर दीजिए', shallI, waiting), await got('haan ji', shallI, waiting), await got('नहीं रहने दो', shallI, waiting), await got('cancel karo', shallI, waiting),
    await got('जी का फॉर्म तैयार है एक बार देख लीजिए सेव कर दूं', shallI, waiting), await got('सेव कर दूं', shallI, waiting), ['run', 'no'].includes(await got('राहुल जी की फीस कितनी बाकी है ज़रा ठीक से बताओ', shallI, waiting))],
    ['run', 'run', 'run', 'run', 'no', 'no', again, again, false]);
  // A yes is the whole message. Another order given while a deletion waits is that other order, not a yes to the first;
  // and a go-ahead when nothing waits is told so
  const nothingWaits = 'अभी कोई काम "हाँ" के लिए रुका नहीं है। जो करना है, वह फिर से बोलिए।';
  assert.deepEqual([await got('rohit lodha ko delete kar do', shallI, waiting), await got('हाँ हटा दो', shallI, waiting), await got('haan ji kar dijiye', shallI, waiting), ['run', 'no'].includes(await got('theek se number batao', shallI, waiting)),
    await got('हाँ, कर दो'), await got('save kar do'), await got('theek hai ji')], ['delete r2', 'run', 'run', false, nothingWaits, nothingWaits, 'ठीक है। और कुछ पूछना हो तो बताइए।']);
  // The verb of the question, said back, is a yes to that question and to no other. Noise while a 'shall I?' waits
  // leaves it waiting. An 'ok' after a question that was dropped is told that nothing waits; after one that was
  // carried out it is only an 'ok'
  const kept = async (question, kind) => { const r = await ai.chat({ question, db: club, today, history: shallI, confirming: kind }); return r.run ? 'run' : r.no ? 'no' : r.keep ? 'kept' : r.pending ? `${r.pending.do} ${r.pending.id}` : 'other'; };
  assert.deepEqual([await kept('हटा दो', 'delete'), await kept('hata do', 'delete'), await kept('सेव', 'save'), await kept('haan jama kar do', 'pay'), await kept('जमा कर दो', 'delete'), await kept('सहमत हूँ', 'delete'), await kept('मत करो', 'delete'),
    await kept('अच्छा', 'delete'), await kept('hmm', 'delete'), await kept('अरे भाई वो डंबल उधर रख दे', 'delete'), await kept('को जिम से हटा दूं 30 दिन तक', 'delete')],
    ['run', 'run', 'run', 'run', 'pay rn', 'kept', 'no', 'kept', 'kept', 'kept', 'kept']);
  const moved = [...shallI, { who: 'me', text: 'priya ka hisaab' }, { who: 'ai', text: 'Priya Jain की मेंबरशिप 31 Oct 2026 तक है, और ₹400 बाकी है।' }], carried = [...shallI, { who: 'me', text: 'हाँ' }, { who: 'ai', text: 'Rohit को हटा दिया। 30 दिन तक Members के Deleted टैब से वापस ला सकते हैं।' }];
  assert.deepEqual([await got('हाँ', moved), await got('ठीक है', moved), await got('ठीक है', carried), await got('ok')], [nothingWaits, nothingWaits, 'ठीक है। और कुछ पूछना हो तो बताइए।', 'ठीक है। और कुछ पूछना हो तो बताइए।']);
  // Money is taken on an order, or on being told who paid in that very sentence (or by 'usne'). A piece of the
  // assistant's own sentence, a 'diya' beside any number, and what was paid another day are not money received
  const aboutPriya = [{ who: 'me', text: 'priya ka hisaab' }, { who: 'ai', text: 'Priya Jain की मेंबरशिप 31 Oct 2026 तक है, और ₹400 बाकी है।' }];
  assert.deepEqual([await got('priya ne 200 diye'), await got('priya ki fees jama ho gayi'), await got('usne 200 de diye', aboutPriya), await got('fees jama kar do', aboutPriya), await got('priya se 300 mile')], ['pay p', 'pay p', 'pay p', 'pay p', 'pay p']);
  for (const said of ['जमा हो गए', 'के 200 जमा हो गए', 'jama ho gaye', 'priya ka weight 62 kar diya', 'priya ko 3 mahine ka plan diya', 'priya ne kal 200 diye the', 'usne fees de di thi'])
    assert.equal((await ai.chat({ question: said, db: club, today, history: aboutPriya })).pending, undefined, said);
  // The assistant's own sentence, brought back whole by the microphone, is known by its sound (the phone writes the name
  // in Hindi) and dropped. Typed, the same words are the owner's
  const paidPart = [{ who: 'me', text: 'priya ne 200 diye' }, { who: 'ai', text: 'Priya Jain के ₹200 जमा हो गए। अब ₹200 बाकी हैं।' }], heardBack = 'प्रिया जैन के 200 रुपये जमा हो गए अब 200 बाकी हैं';
  assert.deepEqual([(await ai.chat({ question: heardBack, db: club, today, history: paidPart, spoken: true })).echo, (await ai.chat({ question: heardBack, db: club, today, history: paidPart })).echo, (await ai.chat({ question: 'शाम को', db: club, today, history: [{ who: 'ai', text: 'ठीक है। सुबह आएँगे या शाम को?' }], spoken: true })).echo,
    (await ai.chat({ question: 'नया मेंबर जोड़ना हो या कुछ पूछना हो बस बोलिए', db: club, today })).start, (await ai.chat({ question: 'नया मेंबर जोड़ो', db: club, today })).start], [true, undefined, undefined, undefined, 'register']);
  // Once somebody has been deleted the talk is not gone back through past them: 'fees jama kar do' said next is not
  // about whoever was spoken of before
  const afterPriya = { ...club, members: club.members.filter((m) => m.id !== 'p'), deleted: [...club.deleted, { id: 'p', name: 'Priya Jain', phone: '9829044444', deletedAt: '2026-10-12T06:00:00.000Z' }] };
  const longTalk = [{ who: 'me', text: '9922233355 ka hisaab' }, { who: 'ai', text: 'Rohit की मेंबरशिप 31 Oct 2026 तक है, और ₹400 बाकी है।\n- मोबाइल: 9922233355' }, { who: 'me', text: 'priya ko hata do' }, { who: 'ai', text: 'Priya Jain (9829044444) को जिम से हटा दूँ?' }, { who: 'me', text: 'हाँ' }, { who: 'ai', text: 'Priya Jain को हटा दिया। 30 दिन तक Members के Deleted टैब से वापस ला सकते हैं।' }];
  for (const said of ['fees jama kar do', 'हटा दो', 'ise 3 mahine renew kar do']) assert.equal((await ai.chat({ question: said, db: afterPriya, today, history: longTalk })).pending, undefined, said);
  assert.equal((await ai.chat({ question: 'हटा दिया', db: afterPriya, today, history: longTalk })).answer, 'Priya Jain को हटाया जा चुका है। 30 दिन तक Members के Deleted टैब से वापस ला सकते हैं।');
  // The owner's own spelling of the verbs is read ('kerdo', 'krdo', 'hatado'). A mobile number is changed for the member
  // who is NAMED, whoever has that number now: the same number again, a number that is another member's, and one that is
  // no mobile number are each said so, instead of 'I did not understand'
  assert.deepEqual([await got('priya ka mobile number 98290 77777 kerdo'), await got('priya ka weight 62 krdo'), await got('priya ki fees jama kerdo'), await got('priya ko delete kerdo'), await got('priya ko hatado'),
    await got('priya ka mobile number 9829044444 kerdo'), await got('priya का मोबाइल नंबर 97000 01644 कर दो'), await got('priya ka number 98290 kar do'), (await ai.chat({ question: 'priya ka mobile number 98290 77777 kerdo', db: club, today })).pending.body.phone],
    ['edit p', 'edit p', 'pay p', 'delete p', 'delete p', 'Priya Jain का मोबाइल पहले से 9829044444 ही है। कुछ बदलने की ज़रूरत नहीं।', '9700001644 नंबर Rohit Mali का है। एक नंबर दो मेंबर का नहीं हो सकता।',
      '98290 मोबाइल नंबर नहीं हो सकता। मोबाइल नंबर पूरे 10 अंकों का बोलिए।', '9829077777']);
  // What an owner may say, and what each gets without the AI: how the answer begins, and what comes with it (the number
  // of lines, a change to say yes to, a reminder to send, or a page to open)
  const shop = { gym: { name: 'Fit Zone', price1: 1000, price3: 2700, ptPrice: 2000, timings: '6 से 10' }, payments: [{ amount: 1000, date: today, mode: 'Cash' }, { amount: 600, date: '2026-10-10', mode: 'UPI' }, { amount: 900, date: '2026-09-20', mode: 'Cash' }],
    members: [{ ...member('a', 'Rahul Sharma', '9829011111', 0), pt: true }, { ...member('d', 'Priya Jain', '9829044444', 400), gender: 'Female', batch: 'Evening' }, { ...member('f', 'Meena Das', '9829066666', 0), end: '2026-10-05' }, { ...member('s', 'Sample Singh', '9829088888', 300), sample: true }] };
  for (const [said, begins, more] of [
    ['tum kya kya kar sakte ho', 'मैं ये काम कर सकता हूँ।', 7], ['aaj kitna paisa aaya', 'आज ₹1,000 जमा हुए, 1 भुगतान में।', 2], ['kal kitna aaya', 'कल ₹600 जमा हुए', 2], ['pichhle mahine kitna aaya', 'पिछले महीने ₹900 जमा हुए', 2], ['cash kitna aaya upi kitna', 'इस महीने ₹1,600 जमा हुए', 3],
    ['3 mahine ki fees kitni hai', 'जिम की फीस यह है।', 4], ['एक साल का कितना लगता है', 'जिम की फीस यह है।', 4], ['gym ka time kya hai', 'जिम का समय: 6 से 10।', 1], ['fees badha do', 'जिम की फीस Settings में बदलती है।', 1],
    ['personal trainer kis kis ne liya hai', 'पर्सनल ट्रेनर वाले: 1 मेंबर।', 2], ['ladies kitni hain', 'महिला मेंबर: 1 मेंबर।', 2], ['शाम को कौन आता है', 'शाम के बैच में: 1 मेंबर।', 2], ['kitne member hain', 'कुल 4 मेंबर हैं।', 4],
    ['is mahine kitne naye member aaye', 'इस महीने 4 नए मेंबर जुड़े।', 5], ['sabse zyada fees kiski baaki hai', '2 मेंबर की फीस बाकी है, कुल ₹700।', 3], ['aaj mausam kaisa hai', 'यह मुझे समझ नहीं आया', 7],
    ['priya ko reminder bhejo', 'Priya Jain के लिए बाकी फीस का रिमाइंडर तैयार है।', 'fees'], ['मीना को रिमाइंडर भेज दो', 'Meena Das के लिए मेंबरशिप खत्म हो जाने का रिमाइंडर', 'expired'], ['rahul ko reminder bhejo', 'Rahul Sharma की न फीस बाकी है', 1],
    ['sabko reminder bhej do', 'सबको एक साथ भेजना मुझसे नहीं होता।', 'dashboard'], ['priya ko delete kar do', 'Priya Jain (9829044444) को जिम से हटा दूँ?', 'delete'], ['मीना को हटा दो', 'Meena Das (9829066666) को जिम से हटा दूँ?', 'delete'],
    ['priya ka weight 62 kar do', 'Priya Jain (9829044444) की जानकारी बदलूँ?', 'edit'], ['priya ka number 98290 12345 kar do', 'Priya Jain (9829044444) की जानकारी बदलूँ?', 'edit'], ['priya ka number kya hai', 'Priya Jain की मेंबरशिप', 7],
['priya ki fees maaf kar do', 'यह Priya Jain के पेज से होता है', 'members/d'],
    ['प्रिया के कितने दिन बचे हैं', 'Priya Jain की मेंबरशिप 31 Oct 2026 तक है', 7], ['priya ko do saal ke liye renew karo', 'Priya Jain (9829044444) की मेंबरशिप 24 महीने के लिए रिन्यू करूँ?', 'renew'],
    // 'they have all paid': everybody's pending fees in one go, the sample member left out
    ['In sabne kardi fees zama', 'जिन 1 मेंबर की फीस बाकी है, उन सबकी पूरी बाकी फीस, कुल ₹400, कैश में जमा करूँ?', 'payall'], ['sabki fees jama kar do upi se', 'जिन 1 मेंबर की फीस बाकी है, उन सबकी पूरी बाकी फीस, कुल ₹400, UPI से जमा करूँ?', 'payall'],
  ]) {
    const r = await ai.chat({ question: said, db: shop, today }), lines = r.answer.split('\n');
    assert.deepEqual([said, lines[0].startsWith(begins) || lines[0], r.pending ? r.pending.do : r.remind ? r.remind.type : r.page || lines.length], [said, true, more]);
  }
  assert.equal((await ai.chat({ question: 'priya ka hisaab', db: shop, today })).answer.split('\n')[4], '- स्थिति: चालू (20 दिन बाकी)');
  // Somebody deleted is known to be gone, and somebody unknown is said to be unknown
  assert.deepEqual([(await ai.chat({ question: 'गोपाल का हिसाब', db: { ...shop, deleted: [{ id: 'x', name: 'Gopal Mali', phone: '9829099999' }] }, today })).answer.slice(0, 31), (await ai.chat({ question: 'suresh ka hisaab', db: shop, today })).answer.slice(0, 29)],
    ['Gopal Mali को हटाया जा चुका है।', 'इस नाम का कोई मेंबर नहीं मिला']);
  assert.deepEqual([(await ai.chat({ question: 'priya ka number 98290 12345 kar do', db: shop, today })).pending.body.phone, (await ai.chat({ question: 'priya ka weight 62 kar do', db: shop, today })).answer.split('\n')[1]], ['9829012345', '- वज़न: 62']);
  // In a registration: two years is 24 months, half the fee is a sum, 'cancel karo' stops it, and the filled form asks
  // whether to save, which a yes answers
  const full = { name: 'Aman', phone: '9829012345', gender: '', age: '', weight: '', height: '', goal: '', health: '', batch: '', pt: false, diet: false, months: 3 };
  const regTurn = (asked, said, form = full) => ai.turn({ gym: shop.gym, form, asked, said });
  assert.deepEqual([(await regTurn('months', 'do saal', { name: 'Aman', phone: '9829012345' })).form.months, (await regTurn('paid', 'aadha')).form.paid, (await regTurn('paid', 'aadha')).say.endsWith('सेव कर दूँ?'), (await regTurn('paid', 'cancel karo')).cancel,
    (await ai.chat({ question: 'haan save kar do', db: shop, today, confirming: true })).run, (await ai.chat({ question: 'cancel karo', db: shop, today, confirming: true })).no], [24, 1350, true, true, true, true]);
  assert.deepEqual([(await regTurn('batch', 'शाम को', { name: 'Aman', phone: '9829012345' })).form.batch, (await regTurn('goal', 'बॉडी बनानी है', { name: 'Aman', phone: '9829012345' })).form.goal], ['Evening', 'Muscle gain']);
  // Ordinary answers are not misread: 'band kar di' inside an answer does not cancel, 'rehne do ji' is a no and a bare
  // 'ji' a yes, money promised for tomorrow is not paid today. And the question itself, heard back from the
  // loudspeaker, is nobody's answer
  const begun = { name: 'Aman', phone: '9829012345' }, replied = async (asked, said, more = {}) => { const r = await ai.turn({ gym: shop.gym, form: asked === 'paid' ? full : begun, asked, said, ...more }); return r.cancel ? 'cancelled' : r.echo ? 'echo' : r.form[asked]; };
  assert.deepEqual([await replied('health', 'पहले बीपी की दवाई चलती थी अब बंद कर दी'), await replied('pt', 'रहने दो जी'), await replied('diet', 'बाद में देखेंगे जी'), await replied('pt', 'जी'), await replied('pt', 'हाँ जी चाहिए'), await replied('paid', 'कल 500 दूंगा'),
    await replied('paid', '500'), await replied('goal', 'cancel karo'), await replied('gender', 'पुरुष हैं या महिला', { spoken: true }), await replied('gender', 'महिला', { spoken: true }), await replied('batch', 'शाम को आएँगे', { spoken: true })],
    ['पहले बीपी की दवाई चलती थी अब बंद कर दी', false, false, true, true, 0, 500, 'cancelled', 'echo', 'Female', 'Evening']);
  // With the AI on, a question about a member carries that member's whole record, however many members the gym has and
  // wherever in the list the member is. A question about the whole gym carries every member in short
  const big = { gym: { name: 'Big Gym' }, payments: [], members: [...Array.from({ length: 600 }, (x, i) => member(`m${i}`, `Member${i} Test`, `97${10000000 + i}`, 0)), { ...member('z', 'Dinesh Kumar', '9829055555', 2700), goal: 'Muscle gain' }] };
  const realFetch = global.fetch;
  let input = '';
  global.fetch = async (url, init) => { input = JSON.parse(init.body).input; return Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ठीक है।' }] }] }); };
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    const one = await ai.chat({ question: 'dinesh ka goal kya h?', db: big, today });
    assert.deepEqual([one.mode, input.includes('\n\nThe question is about this member (the gym has 601 in all):\nDinesh Kumar | 9829055555'), input.includes('goal: Muscle gain | health: not written'), input.includes('Member0 Test')], ['ai', true, true, false]);
    await ai.chat({ question: 'sabse zyada fees kiski baaki hai?', db: big, today });
    assert.deepEqual([input.includes('\n\nMembers (601):\nMember0 Test'), input.includes('Dinesh Kumar | 9829055555'), input.includes('goal:')], [true, true, false]);
    // A name said aloud reaches the app in Hindi script: by its sound it finds the member typed in English letters.
    // A question that names nobody findable carries the whole list, and with it the member the talk was about
    await ai.chat({ question: 'दिनेश का गोल क्या है?', db: big, today });
    assert.equal(input.includes('\n\nThe question is about this member (the gym has 601 in all):\nDinesh Kumar | 9829055555'), true);
    await ai.chat({ question: 'वर्मा जी की फीस?', db: big, today, history: [{ who: 'me', text: 'dinesh ka hisaab' }, { who: 'ai', text: 'Dinesh Kumar...' }] });
    assert.deepEqual([input.includes('\n\nMembers (601):'), input.includes('Spoken of earlier in this talk, in full:\nDinesh Kumar | 9829055555')], [true, true]);

    // An order is not carried out by the AI. What it understood comes back as JSON, is checked against the records and
    // is put to the owner as a question; the screen sends it only after a yes
    const gymDb = { ...db, gym: { name: 'Fit Zone', price1: 1000, price3: 2700 } };
    const told = async (json, question = 'rahul verma ne paise diye') => { global.fetch = async () => Response.json({ steps: [{ type: 'model_output', content: [{ type: 'text', text: typeof json === 'string' ? json : JSON.stringify(json) }] }] }); return ai.chat({ question, db: gymDb, today }); };
    const paying = await told({ do: 'pay', mobile: '9829022222', amount: 900, mode: 'UPI' });
    assert.deepEqual([paying.answer, paying.pending], ['Rahul Verma के सिर्फ़ ₹400 बाकी हैं। Rahul Verma (9829022222) के ₹400 UPI से जमा करूँ?', { do: 'pay', id: 'b', body: { amount: 400, mode: 'UPI' } }]);
    assert.deepEqual([(await told({ do: 'pay', mobile: '98290 33333' })).pending.body, (await told({ do: 'pay', mobile: '9829044444', amount: 500 })).pending, (await told({ do: 'pay', mobile: '9000000000', amount: 5 })).pending],
      [{ amount: 1000, mode: 'Cash' }, undefined, undefined]); // no amount said is the whole due; nothing due and nobody found change nothing
    const renewing = await told('```json\n{"do":"renew","mobile":"9829044444","months":3,"paid":5000}\n```');
    assert.deepEqual([renewing.answer.split('\n'), renewing.pending], [['Priya Jain (9829044444) की मेंबरशिप 3 महीने के लिए रिन्यू करूँ?', '- 1 Nov 2026 से 31 Jan 2027', '- फीस: ₹2,700', '- अभी जमा: ₹2,700 (कैश में)'], { do: 'renew', id: 'd', body: { months: 3, paid: 2700, mode: 'Cash' } }]);
    assert.deepEqual([(await told({ do: 'renew', mobile: '9829044444' })).answer, (await told({ do: 'renew', mobile: '9829044444', months: 99 })).pending], ['Priya Jain की मेंबरशिप कितने महीने के लिए रिन्यू करनी है?', undefined]);
    const editing = await told({ do: 'edit', mobile: '9829044444', set: { goal: 'Muscle gain', weight: 62, phone: '12345', months: 12, fee: 0, gymId: 'x' } });
    assert.deepEqual([editing.answer.split('\n'), editing.pending.body], [['Priya Jain (9829044444) की जानकारी बदलूँ?', '- वज़न: 62', '- लक्ष्य: Muscle gain'],
      { name: 'Priya Jain', phone: '9829044444', gender: '', age: '', weight: 62, height: '', goal: 'Muscle gain', health: '', batch: '', notes: '' }]); // a bad number and what is no detail of a member are left out
    assert.deepEqual([(await told({ do: 'edit', mobile: '9829044444', set: { goal: 'Weight loss' } })).pending, (await told({ do: 'new' })).start, (await told('{"do": pay')).answer.startsWith('माफ़ कीजिए'), (await told({ do: 'burn', mobile: '9829044444' })).pending, (await told({ do: 'delete', mobile: '9829044444' })).pending.do],
      [undefined, 'register', true, undefined, 'delete']);
    // The AI may not say that it changed something. When it does, it is asked once more for the order; and when it does so
    // again, the owner is told that nothing was changed. A question may be answered with 'जमा कर दी है', truthfully
    const replies = async (texts, question) => { const left = [...texts]; global.fetch = async () => Response.json({ steps: [{ type: 'model_output', content: [{ type: 'text', text: left.shift() }] }] }); const r = await ai.chat({ question, db: gymDb, today }); return [r.pending ? `${r.pending.body.goal}, ${r.pending.body.height}` : r.answer.split('\n')[0].slice(0, 10), left.length]; };
    const claim = 'प्रिया का गोल बदलकर मसल गेन कर दिया गया है।', json = '{"do":"edit","mobile":"9829044444","set":{"goal":"Muscle gain"}}';
    assert.deepEqual([await replies([claim, json], 'priya ka goal muscle gain rakhna hai'), await replies([claim, claim], 'priya ka goal muscle gain rakhna hai'), await replies(['प्रिया ने फीस जमा कर दी है।', json], 'priya ne fees di ya nahi'),
      await replies(['यह मेंबर के पेज पर जाकर होगा।', '{"do":"edit","mobile":"9829044444","set":{"height":"5 ft 8 in"}}'], 'priya ki height 5 foot 8 inch likhni hai'), await replies(['{"do":"edit","mobile":"9829044444","set":{"goal":"मसल गेन"}}', json], 'priya ka goal muscle gain rakhna hai')],
      [['Muscle gain, ', 0], ['माफ़ कीजिए', 0], ['प्रिया ने ', 1], ['Weight loss, 5 ft 8 in', 0], ['Muscle gain, ', 0]]);
    // A new member may be given the details of one who is there already, named in the same breath, even when the
    // microphone heard the name a little wrong (कोशिश for कौशिक). All but the name, the number and the money is filled in
    global.fetch = async () => Response.json({ steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"name":"Rohit"}' }] }] });
    const others = [{ ...member('k', 'Kaushik Tejwani', '9116398862', 0), gender: 'Male', age: 26, goal: 'Muscle gain', batch: 'Morning', months: 3, pt: true }, member('m', 'Rohit Mali', '9700001644', 0), member('n', 'Suresh Jain', '9700001645', 0), member('o', 'Suresh Mali', '9700001646', 0)];
    const opening = (said) => ai.turn({ gym: shop.gym, form: {}, asked: 'name', said, members: others });
    const like = await opening('एक नया मेंबर ऐड करो जिसका नाम रोहित रखो और उसमें सारी की सारी डिटेल्स कोशिश की ऐड कर दो');
    assert.deepEqual([like.say, like.next, like.form], ['Kaushik Tejwani की डिटेल्स भर दी हैं। Rohit जी का मोबाइल नंबर बताइए।', 'phone',
      { name: 'Rohit', height: '', goal: 'Muscle gain', health: '', batch: 'Morning', gender: 'Male', age: 26, weight: '', pt: true, diet: false, months: 3 }]);
    assert.deepEqual([(await opening('नाम रोहित रखो और डिटेल्स सुरेश की डाल दो')).say, (await opening('नाम रोहित है')).say], // two Sureshes: nobody is picked
      ['किसकी डिटेल्स भरनी हैं, यह समझ नहीं आया, इसलिए एक-एक करके पूछ रहा हूँ। Rohit जी का मोबाइल नंबर बताइए।', 'ठीक है। Rohit जी का मोबाइल नंबर बताइए।']);
    // 'Shall I?' is answered without the AI: a yes sends it, a no drops it, anything else is a new message. So are the
    // plain orders: money taken and a renewal, with 'which one?' and 'for how many months?' asked on the way
    global.fetch = () => { throw new Error('the AI is not asked'); };
    const order = async (question, history = []) => { const r = await ai.chat({ question, db: gymDb, today, history }); return r.pending ? [r.pending.do, r.pending.id, ...Object.values(r.pending.body)] : r.answer.split('\n')[0]; };
    assert.deepEqual([await order('rahul verma ne 300 diye'), await order('प्रिया जैन की मेंबरशिप 3 महीने के लिए रिन्यू कर दो'), await order('rahul verma ki fees jama kar do upi se'), await order('priya ko ek saal ke liye renew karo')],
      [['pay', 'b', 300, 'Cash'], ['renew', 'd', 3, 0, 'Cash'], ['pay', 'b', 400, 'UPI'], ['renew', 'd', 12, 0, 'Cash']]);
    const which = [{ who: 'me', text: 'rahul ki fees jama kar do' }, { who: 'ai', text: (await order('rahul ki fees jama kar do')) + '\n- Rahul Sharma: 9829011111\n- Rahul Verma: 9829022222\n- Rahul Sharma: 9829033333' }];
    const months = [{ who: 'me', text: 'priya ki membership renew kar do' }, { who: 'ai', text: await order('priya ki membership renew kar do') }];
    assert.deepEqual([which[1].text.split('\n')[0], await order('3333', which), months[1].text, await order('दो महीने', months), await order('फीस जमा कर दो', [{ who: 'me', text: 'rahul verma ka hisaab' }])],
      ['इस नाम के 3 मेंबर हैं। किसकी बात कर रहे हैं? मोबाइल नंबर बताइए।', ['pay', 'c', 1000, 'Cash'], 'Priya Jain की मेंबरशिप कितने महीने के लिए रिन्यू करनी है?', ['renew', 'd', 2, 0, 'Cash'], ['pay', 'b', 400, 'Cash']]);
    // A question is never an order, and neither is an order about nobody
    process.env.GEMINI_API_KEY = '';
    assert.deepEqual([(await order('rahul verma ki fees jama hui ya nahi')).slice(0, 11), (await order('kabir ne 500 diye')).slice(0, 14), (await order('priya ne kitne diye')).slice(0, 10)], ['Rahul Verma', 'यह मुझे समझ नह', 'Priya Jain']);
    process.env.GEMINI_API_KEY = 'test-key';
    const reply = async (question) => { const r = await ai.chat({ question, db: gymDb, today, confirming: true, quick: true }); return r.run || r.answer.split('\n')[0]; };
    assert.deepEqual([await reply('हाँ, कर दो'), await reply('ok'), await reply('haan ji'), await reply('नहीं'), await reply('nahi rehne do'), await reply('priya ka hisaab')],
      [true, true, true, 'ठीक है, नहीं किया।', 'ठीक है, नहीं किया।', 'Priya Jain की मेंबरशिप 31 Oct 2026 तक है, और कोई फीस बाकी नहीं है।']);
  } finally {
    process.env.GEMINI_API_KEY = '';
    global.fetch = realFetch;
  }
}

async function apiChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymsaathi-test-'));
  // Set before the server loads .env: what is already set wins, so nothing in .env can steer the test
  Object.assign(process.env, { DATA_DIR: dir, ADMIN_EMAIL: 'owner', ADMIN_PASSWORD: 'owner-password', GEMINI_API_KEY: '', GEMINI_MODEL: '', PAY_NOTE: '', WHATSAPP_TOKEN: '', WHATSAPP_PHONE_ID: '', WHATSAPP_API_VERSION: '', TRUST_PROXY: '', MONGODB_DB: 'gymsaathi_test' });
  if (!MONGO) process.env.MONGODB_URI = '';
  const srv = await require('./server').start(0), db = require('./lib/db');
  const afresh = () => { require('./server').forget(); require('./lib/cache').clear(); }; // after changing the store behind the app's back
  assert.equal(db.usingMongo, MONGO, MONGO ? 'Put MONGODB_URI in .env first.' : '');
  if (MONGO) { await (await db.ready).dropDatabase(); await db.indexes(); } // what an earlier run that broke off left behind
  const today = G.todayISO();
  const browser = () => {
    let cookie = '';
    return async (method, url, body, raw) => {
      const res = await fetch(`http://127.0.0.1:${srv.address().port}${url}`, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) });
      cookie = (res.headers.get('set-cookie') || cookie).split(';')[0];
      return [res.status, raw ? Buffer.from(await res.arrayBuffer()) : await res.json().catch(() => ({}))];
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
    // The price for a month is needed too. A gym that has none (made before this rule) is told to fill it in, and no fee of nought is quoted
    assert.equal(await status(owner('POST', '/api/admin/gyms', { ...fitZone, price1: 0, email: 'third.gym', password: 'first-password' })), 400);
    const noPrice = await require('./lib/ai').turn({ gym: { name: 'No Price Gym', price1: 0 }, form: {}, asked: '', said: '' });
    assert.deepEqual([noPrice.setup, noPrice.done, noPrice.next, noPrice.say.includes('फीस भर दीजिए'), noPrice.say.includes('0 रुपये')], [true, false, null, true, false]);

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
    // A gym's page reads its three lists once and then from the cache, until the gym changes something
    const realFind = db.find, asked = [];
    db.find = (name, ...rest) => { asked.push(name); return realFind(name, ...rest); };
    const lists = () => asked.splice(0).filter((name) => ['customers', 'memberships', 'transactions'].includes(name)).length;
    try {
      await ok(gym('GET', '/api/data'));
      lists();
      await ok(gym('GET', '/api/data'));
      await ok(gym('POST', '/api/chat', { question: 'किसकी फीस बाकी है?', quick: true }));
      assert.deepEqual(asked.splice(0), []); // not one trip to the database: who is asking is remembered as well
      const paidOne = await ok(gym('POST', `/api/members/${rahul.id}/pay`, { amount: 1 }));
      lists();
      assert.deepEqual([G.due((await ok(gym('GET', '/api/data'))).members.find((m) => m.id === rahul.id)), lists()], [8699, 3]);
      await ok(gym('DELETE', `/api/payments/${(await db.find('transactions', { customerId: paidOne.id }))[0]._id}`));
    } finally { db.find = realFind; }
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
    // The talk so far goes along with a question. A follow-up that names nobody is about whoever was last named; one that
    // asks who or how many is about everybody, as before
    const soFar = [{ who: 'me', text: 'Rahul ki membership kab shuru hui?' }, { who: 'ai', text: 'Rahul Sharma की मेंबरशिप आज शुरू हुई।' }];
    const follow = await ok(gym('POST', '/api/chat', { question: 'kab khatam hogi?', quick: true, history: soFar }));
    const alone = await ok(gym('POST', '/api/chat', { question: 'kab khatam hogi?', quick: true }));
    const everyone = await ok(gym('POST', '/api/chat', { question: 'kiski fees baaki hai?', quick: true, history: soFar }));
    assert.deepEqual([follow.answer.includes('Rahul Sharma') && follow.answer.includes('मेंबरशिप:'), alone.answer.includes('Rahul Sharma'), alone.answer.includes('खत्म होने वाली'), everyone.answer.includes('मेंबर की फीस बाकी है'),
      await status(gym('POST', '/api/chat', { question: 'kab khatam hogi?', quick: true, history: 'not a list' }))], [true, false, true, true, 200]);
    assert.equal((await ok(gym('POST', '/api/chat', { question: 'नया मेंबर जोड़ो' }))).start, 'register');
    assert.ok(!(await ok(other('POST', '/api/chat', { question: 'किसकी फीस बाकी है?', quick: true }))).answer.includes('Rahul'));
    // What is changed on the screens is what the assistant reads the very next time, and a yes to its 'shall I?' comes
    // back as the word to go ahead
    const dues = async () => /बाकी: (₹[\d,]+)/.exec((await ok(gym('POST', '/api/chat', { question: 'rahul ka hisaab', quick: true }))).answer)[1];
    const before = await dues(), rahulId = (await ok(gym('GET', '/api/data'))).members.find((m) => m.name === 'Rahul Sharma').id;
    await ok(gym('POST', `/api/members/${rahulId}/pay`, { amount: 700, mode: 'UPI' }));
    const lower = await dues();
    await ok(gym('DELETE', `/api/payments/${(await ok(gym('GET', '/api/data'))).payments.find((p) => p.amount === 700 && p.mode === 'UPI').id}`));
    assert.deepEqual([before, lower, await dues(), (await ok(gym('POST', '/api/chat', { question: 'हाँ, कर दो', confirming: true }))).run], ['₹3,700', '₹3,000', '₹3,700', true]);
    // The page carries a mark of the app it was built from, and the version check tells the server's: a page left open over
    // an update sees them differ and loads itself afresh
    const page = String((await nobody('GET', '/', undefined, true))[1]), stamped = (/<meta name="build" content="([a-f0-9]{12})">/.exec(page) || [])[1];
    assert.deepEqual([!!stamped, (await ok(gym('GET', '/api/version'))).build === stamped, page.includes('__BUILD__')], [true, true, false]);
    // Open pages follow a number that moves with every change to their own gym, and with nothing else
    const version = async (as) => (await ok(as('GET', '/api/version'))).n, [mine, theirs, everyones] = [await version(gym), await version(other), await version(owner)];
    await ok(gym('POST', '/api/chat', { question: 'rahul ka hisaab', quick: true }));
    await ok(gym('POST', '/api/reminders/sent', { memberId: rahulId, type: 'fees' }));
    assert.deepEqual([await version(gym) - mine, await version(other) - theirs, await version(owner) - everyones, await status(nobody('GET', '/api/version'))], [1, 0, 1, 401]);
    // 'They have all paid': all that each ticked member owes is taken at once. Another gym's member is not touched
    assert.deepEqual([await ok(other('POST', '/api/members/pay', { ids: [rahulId] })), await status(gym('POST', '/api/members/pay', { ids: [] })), await ok(gym('POST', '/api/members/pay', { ids: [rahulId], mode: 'UPI' })), await dues(),
      await ok(gym('POST', '/api/members/pay', { ids: [rahulId] }))], [{ paid: 0, total: 0 }, 400, { paid: 1, total: 3700 }, '₹0', { paid: 0, total: 0 }]);
    await ok(gym('DELETE', `/api/payments/${(await ok(gym('GET', '/api/data'))).payments.find((p) => p.amount === 3700 && p.mode === 'UPI').id}`));
    assert.equal(await dues(), '₹3,700');
    // The database changed by another hand (in Atlas itself, by a script): the watch reports it, what was kept of that
    // gym is forgotten, and its open pages are told to read again. A report of what the app itself has just written
    // changes nothing more. The watch is played here: the reports are given by hand
    let report = null;
    const realWatch = db.watch, realKind = db.usingMongo;
    Object.assign(db, { usingMongo: true, watch: async (seen) => { report = seen; } });
    require('./server').follow();
    Object.assign(db, { usingMongo: realKind, watch: realWatch });
    const watched = (await listed('fit.zone')).id, v0 = await version(gym), w0 = await version(other);
    report({ name: 'transactions', gymId: watched }); // the app wrote to this gym a moment ago: its own doing
    assert.equal(await version(gym), v0);
    await new Promise((done) => setTimeout(done, 5100));
    await db.insert('transactions', { _id: 'byhand0000000001', gymId: watched, customerId: rahulId, membershipId: (await ok(gym('GET', `/api/data`))).members.find((m) => m.id === rahulId).membershipId, name: 'Rahul Sharma', amount: 200, mode: 'Cash', date: today, createdAt: new Date().toISOString() });
    const stale = await dues();
    report({ name: 'transactions', gymId: watched });
    assert.deepEqual([stale, await dues(), await version(gym) - v0, await version(other) - w0], ['₹3,700', '₹3,500', 1, 0]);
    await db.remove('transactions', { _id: 'byhand0000000001' });
    report({ name: 'transactions' }); // a deletion does not say whose it was: every gym reads again
    assert.deepEqual([await dues(), await version(gym) - v0, await version(other) - w0], ['₹3,700', 2, 1]);

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
      // The AI is given the earlier turns above the question, with dates written out, and never more than the last six
      let sent = '';
      const stubbed = global.fetch;
      global.fetch = (url, init) => { if (String(url).startsWith('https://generativelanguage.googleapis.com/')) sent = JSON.parse(init.body).input; return stubbed(url, init); };
      said = 'Rahul Sharma: 9 Jan 2027 को।';
      const long = [...Array.from({ length: 5 }, (x, i) => ({ who: 'me', text: `old ${i}` })), ...soFar];
      const answered = await ok(gym('POST', '/api/chat', { question: 'kab khatam hogi?', history: long }));
      global.fetch = stubbed;
      assert.deepEqual([answered.mode, answered.answer, sent.includes('Earlier in this talk:\nOwner: old 1\n'), sent.includes('old 0'), sent.includes('Owner: Rahul ki membership kab shuru hui?\nAssistant: Rahul Sharma की मेंबरशिप आज शुरू हुई।\n\nQuestion: kab khatam hogi?'),
        /from \d{1,2} [A-Z][a-z]{2} \d{4} to \d{1,2} [A-Z][a-z]{2} \d{4}/.test(sent), /\d{4}-\d\d-\d\d/.test(sent)], ['ai', 'Rahul Sharma: 9 Jan 2027 को।', true, false, true, true, false]);
      // Every answer has one shape, in Hindi: a sentence, then lines that begin with '- '. The AI is told so, and any
      // markdown it writes all the same is taken out. A bare mobile number or name is answered without the AI at all
      let rules = '', calls = 0;
      global.fetch = (url, init) => { if (String(url).startsWith('https://generativelanguage.googleapis.com/')) { calls++; rules = JSON.parse(init.body).system_instruction; } return stubbed(url, init); };
      said = '**Rahul Sharma** की फीस बाकी है।\n\n\n\n* नाम: Rahul Sharma\n• बाकी: ₹100';
      const shaped = await ok(gym('POST', '/api/chat', { question: 'rahul ka hisaab batao' }));
      const bare = await ok(gym('POST', '/api/chat', { question: ' 98290 11111 ' })), byName = await ok(gym('POST', '/api/chat', { question: 'rahul sharma?' }));
      global.fetch = stubbed;
      assert.deepEqual([shaped.answer, calls, rules.includes('Devanagari') && rules.includes('- बाकी: ₹<due>') && rules.includes('no asterisks'), bare.mode, byName.mode, bare.answer === byName.answer,
        bare.answer.split('\n').slice(1).map((line) => line.split(':')[0])], ['Rahul Sharma की फीस बाकी है।\n\n- नाम: Rahul Sharma\n- बाकी: ₹100', 1, true, 'local', 'local', true, ['- नाम', '- मोबाइल', '- मेंबरशिप', '- स्थिति', '- फीस', '- बाकी']]);
    } finally {
      process.env.GEMINI_API_KEY = '';
      global.fetch = realFetch;
    }

    // When the free month is over the gym is signed out everywhere and told to pay; signing in says the same
    const second = await listed('second.gym'), past = '2020-01-01T00:00:00.000Z';
    await db.update('gyms', { _id: second.id }, { validTill: past });
    afresh();
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
    afresh();
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
    assert.deepEqual([await status(browser()('POST', '/api/auth/login', { email: 'third.gym', password: 'first-password' })), await status(browser()('POST', '/api/auth/login', { email: 'oxfit', password: 'first-password' }))], [401, 200]);
    // A gym can also sign in with its own name, however it is spaced or cased, unless two gyms share that name
    assert.deepEqual([await status(browser()('POST', '/api/auth/login', { email: ' ox  FIT ', password: 'first-password' })), await status(browser()('POST', '/api/auth/login', { email: 'Ox Fit', password: 'wrong-password' })),
      await status(browser()('POST', '/api/auth/login', { email: 'Fit Zone', password: 'first-password' }))], [200, 401, 401]);

    // A gym's old records come in from a file. An Excel file is a zip of XML: its first sheet is read into rows of cells
    const zip = (files) => {
      const parts = [], dir = [];
      let at = 0;
      for (const [name, text] of Object.entries(files)) {
        const raw = Buffer.from(text), packedData = zlib.deflateRawSync(raw), n = Buffer.from(name), local = Buffer.alloc(30), central = Buffer.alloc(46);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(packedData.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
        central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(packedData.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(at, 42);
        parts.push(local, n, packedData); dir.push(central, n); at += 30 + n.length + packedData.length;
      }
      const end = Buffer.alloc(22), cd = Buffer.concat(dir), count = Object.keys(files).length;
      end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(at, 16);
      return Buffer.concat([...parts, cd, end]);
    };
    const book = zip({ 'xl/sharedStrings.xml': '<sst><si><t>Name</t></si><si><r><t>Mo</t></r><r><t>bile</t></r></si><si><t>Start</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Ravi &amp; Sons</t></is></c><c r="C2"><v>46000</v></c></row><row r="3"/></sheetData></worksheet>' });
    assert.deepEqual(require('./lib/xlsx').rows(book), [['Name', 'Mobile', 'Start'], ['Ravi & Sons', '', '46000']]);
    assert.throws(() => require('./lib/xlsx').rows(Buffer.from('not a spreadsheet')));
    // A sheet whose headings name the name and the mobile number is read as it stands, with no AI at all: dates day first
    // or as Excel's day number, 'Quarterly' as three months, rupee signs and spaces dropped. Then each row is made fit
    const b64 = (text) => Buffer.from(text).toString('base64'), read = (file) => gym('POST', '/api/import/read', file);
    const clear = await ok(read({ name: 'old.csv', type: 'application/vnd.ms-excel', data: b64('\ufeffMember Name,Mobile,Joining Date,Months,Fee,Balance\r\n"Devi, Sita",98290 33333,15/01/2026,6,"₹5,000",500\r\nNo Number,,01/03/2026,Quarterly,,\r\n') }));
    assert.deepEqual(clear.rows, [{ name: 'Devi, Sita', phone: '9829033333', start: '2026-01-15', months: 6, fee: 5000, due: 500, gender: '', age: '', batch: '', notes: '' },
      { name: 'No Number', phone: '', start: '2026-03-01', months: 3, fee: '', due: 0, gender: '', age: '', batch: '', notes: '' }]);
    assert.deepEqual((await ok(read({ name: 'Old Members.XLSX', type: '', data: book.toString('base64') }))).rows.map((r) => [r.name, r.phone, r.start, r.months]), [['Ravi & Sons', '', '2025-12-09', 1]]);
    const five = await ok(read({ name: 'gym-500-members.csv', type: 'text/csv', data: b64(['Name,Phone,DOJ,Plan,Total,Due', ...Array.from({ length: 500 }, (x, i) => `Member ${i},9${700000000 + i},05-08-26,1 year,9000,${i % 2 ? 0 : 400}`)].join('\n')) }));
    assert.deepEqual([five.rows.length, five.rows[499]], [500, { name: 'Member 499', phone: '9700000499', start: '2026-08-05', months: 12, fee: 9000, due: 0, gender: '', age: '', batch: '', notes: '' }]);
    const heads = (text) => require('./lib/ai').byHeadings(text.split('\n').map((l) => l.split(',')));
    assert.deepEqual([heads('Naam,Phone No,End Date,Start Date,Due Amount,Total Amount,Gender\nA,9829000001,04.11.2026,2026-08-05,100,900,F\nB,9829000002,,,,,male'), heads('A,B\n1,2'), heads('Name,Roll number\nX,5')],
      [[{ name: 'A', phone: '9829000001', end: '2026-11-04', start: '2026-08-05', due: 100, fee: 900, gender: 'Female' }, { name: 'B', phone: '9829000002', gender: 'Male' }], null, null]);
    // Headings that do not say enough, a photo and a PDF all need the AI, and say so when there is no key
    assert.deepEqual([(await read({ name: 'old.csv', type: 'text/csv', data: b64('a,b\n1,2') }))[1].error.includes('no AI key'), await status(read({ name: 'page1.jpg', type: 'image/jpeg', data: b64('picture') }))], [true, 400]);
    const askedOf = [], realAsk = global.fetch;
    let answer = { rows: [{ name: 'Sita Devi', phone: '98290 33333', start: '2026-01-15', end: '2026-07-14', fee: 5000, due: 500, gender: 'Female', age: 31 },
      { name: 'No Number', start: '2026-03-01', months: 3 }, { name: 'Gita', phone: '9829033334', months: 99, start: '2031-01-01', fee: 'free' }, 'rubbish'] };
    global.fetch = (url, init) => {
      if (!String(url).startsWith('https://generativelanguage.googleapis.com/')) return realAsk(url, init);
      askedOf.push(JSON.parse(init.body).input);
      return Promise.resolve(Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: typeof answer === 'string' ? answer : `Here you are: ${JSON.stringify(answer)}` }] }] }));
    };
    process.env.GEMINI_API_KEY = 'test-key';
    try {
      // With a key the AI works the columns out from the lines of text. What comes back is made fit: the length worked out
      // from the first and last day, a date in the future or a silly value dropped, a number that is no mobile number left empty
      const csv = await ok(read({ name: 'old.csv', type: 'application/vnd.ms-excel', data: b64('\ufeffA,B,"C, d"\r\n"Devi, Sita",98290 33333,15/01/2026\r\n') }));
      assert.equal(askedOf[0], 'A | B | C, d\nDevi, Sita | 98290 33333 | 15/01/2026');
      assert.deepEqual(csv.rows, [{ name: 'Sita Devi', phone: '9829033333', start: '2026-01-15', months: 6, fee: 5000, due: 500, gender: 'Female', age: 31, batch: '', notes: '' },
        { name: 'No Number', phone: '', start: '2026-03-01', months: 3, fee: '', due: 0, gender: '', age: '', batch: '', notes: '' },
        { name: 'Gita', phone: '9829033334', start: today, months: 1, fee: '', due: 0, gender: '', age: '', batch: '', notes: '' }]);
      // A sheet with plain headings still needs no AI; a photo and a PDF go to it as they are
      await ok(read({ name: 'Old Members.XLSX', type: '', data: book.toString('base64') }));
      await ok(read({ name: 'page1.jpg', type: 'image/jpeg', data: b64('picture') }));
      await ok(read({ name: 'list.pdf', type: 'application/pdf', data: b64('%PDF') }));
      assert.deepEqual([askedOf.length, askedOf[1][1], askedOf[2][1]], [3, { type: 'image', data: b64('picture'), mime_type: 'image/jpeg' }, { type: 'document', data: b64('%PDF'), mime_type: 'application/pdf' }]);
      // A long sheet goes sixty lines at a time, each time under its headings
      await ok(read({ name: 'long.csv', type: 'text/csv', data: b64(['X,Y', ...Array.from({ length: 130 }, (x, i) => `M${i},98290${String(40000 + i)}`)].join('\n')) }));
      assert.deepEqual([askedOf.length, askedOf[3].split('\n').length, askedOf[5].split('\n').length, askedOf[5].split('\n')[0]], [6, 61, 11, 'X | Y']);
      // What cannot be read says so in words for the owner; an answer from the AI that is no rows is an AI failure
      assert.deepEqual([(await read({ name: 'old.xls', type: '', data: b64('x') }))[1].error.includes('.xlsx'), await status(read({ name: 'a.xlsx', type: '', data: b64('broken') })), await status(read({ name: 'a.zip', type: '', data: b64('x') })),
        await status(read({ name: 'a.csv', type: '', data: '' })), await status(nobody('POST', '/api/import/read', {}))], [true, 400, 400, 400, 401]);
      answer = 'I could not read it, sorry.';
      assert.equal(await status(read({ name: 'page.png', type: 'image/png', data: b64('x') })), 502);
    } finally {
      process.env.GEMINI_API_KEY = '';
      global.fetch = realAsk;
    }
    // Saving: each row becomes a member with the period it was written with, taken as paid but for what is pending,
    // and its payment dated on the day it started. A row that cannot be a member is skipped and named; the rest go in
    const saved = await ok(gym('POST', '/api/import/save', { rows: [{ name: 'Sita Devi', phone: '9829033333', start: '2026-01-15', months: 6, fee: 5000, due: 500, gender: 'Female', age: 31, notes: 'old register' },
      { name: 'No Number', phone: '', start: '2026-03-01', months: 3 }, { name: 'Rahul Again', phone: rahul.phone, months: 1 }, { name: 'Sita Twin', phone: '9829033333', months: 1 },
      { name: 'Plain One', phone: '9829033335', months: '2', fee: '', due: '', start: '' }] }));
    assert.deepEqual([saved.added, saved.skipped.map((k) => [k.row, k.name, k.why])], [2, [[2, 'No Number', 'The mobile number must have 10 digits.'], [3, 'Rahul Again', 'this mobile number is already a member'], [4, 'Sita Twin', 'this mobile number is already a member']]]);
    data = await ok(gym('GET', '/api/data'));
    const sita = data.members.find((m) => m.name === 'Sita Devi'), plainOne = data.members.find((m) => m.name === 'Plain One');
    assert.deepEqual([sita.joinedAt, sita.start, sita.end, sita.months, sita.fee, sita.paid, sita.gender, sita.age, sita.notes, G.statusOf(sita, today), data.payments.filter((p) => p.memberId === sita.id).map((p) => [p.amount, p.date])],
      ['2026-01-15', '2026-01-15', '2026-07-14', 6, 5000, 4500, 'Female', 31, 'old register', 'expired', [[4500, '2026-01-15']]]);
    assert.deepEqual([plainOne.start, plainOne.months, plainOne.fee, plainOne.paid], [today, 2, 2000, 2000]);
    for (const m of [sita, plainOne]) { // out of the way of what follows
      await db.remove('customers', { _id: m.id });
      for (const name of ['memberships', 'transactions']) await db.remove(name, { customerId: m.id });
    }

    // Mistakes can be corrected. A payment: its amount (never to more than was owed), how it was paid and its date
    const first = (await ok(gym('GET', '/api/data'))).payments.find((p) => p.memberId === rahul.id && p.amount === 5000);
    assert.deepEqual([await status(gym('PUT', `/api/payments/${first.id}`, { amount: 8701 })), await status(gym('PUT', `/api/payments/${first.id}`, { amount: 0 })), await status(gym('PUT', '/api/payments/0123456789abcdef', { amount: 1 }))], [400, 400, 404]);
    await ok(gym('PUT', `/api/payments/${first.id}`, { amount: 5200, mode: 'Cash', date: '2026-01-05' }));
    data = await ok(gym('GET', '/api/data'));
    assert.deepEqual([data.payments.filter((p) => p.id === first.id).map((p) => [p.amount, p.mode, p.date]), G.due(data.members.find((m) => m.id === rahul.id))], [[[5200, 'Cash', '2026-01-05']], 3500]);
    await ok(gym('PUT', `/api/payments/${first.id}`, { amount: 5000, mode: 'UPI', date: today }));
    // The running membership: its length, start, extras and fee. The fee cannot drop below what was already paid
    let fixedPlan = await ok(gym('PUT', `/api/members/${amit.id}/period`, { months: 6, pt: true }));
    assert.deepEqual([fixedPlan.months, fixedPlan.end, fixedPlan.pt, fixedPlan.fee, fixedPlan.history.length], [6, G.endOf(today, 6), true, 6 * 1000 + 6 * 2000, 0]);
    fixedPlan = await ok(gym('PUT', `/api/members/${amit.id}/period`, { months: 6, pt: false, fee: 5500, start: G.addDays(today, 2) }));
    assert.deepEqual([fixedPlan.fee, fixedPlan.start, fixedPlan.end, fixedPlan.pt, (await db.find('memberships', { customerId: amit.id })).length], [5500, G.addDays(today, 2), G.endOf(G.addDays(today, 2), 6), false, 1]);
    await ok(gym('POST', `/api/members/${amit.id}/pay`, { amount: 5500 }));
    assert.deepEqual([await status(gym('PUT', `/api/members/${amit.id}/period`, { months: 6, fee: 5000 })), await status(gym('PUT', `/api/members/${amit.id}/period`, { months: 40 }))], [400, 400]);

    // Mistakes can be taken back. A renewal that money was taken for stays until that payment is deleted; then the
    // period before it runs again. A member's only period cannot go this way
    const wrong = (await ok(gym('GET', '/api/data'))).payments.find((p) => p.memberId === rahul.id && p.amount === 1000);
    assert.deepEqual([await status(gym('DELETE', `/api/members/${rahul.id}/period`)), await status(gym('DELETE', '/api/payments/0123456789abcdef'))], [400, 404]);
    await ok(gym('DELETE', `/api/payments/${wrong.id}`));
    const back = await ok(gym('DELETE', `/api/members/${rahul.id}/period`));
    assert.deepEqual([back.months, back.end, back.fee, back.paid, back.history.length, await status(gym('DELETE', `/api/members/${rahul.id}/period`))], [3, rahul.end, 8700, 5000, 0, 400]);
    // Sample members come from a file, not the database: loading them only marks the gym. They are shown, counted and
    // asked about like any member, but nothing about them can be changed, and nothing is written down for them
    const ox = browser();
    await ok(ox('POST', '/api/auth/login', { email: 'oxfit', password: 'first-password' }));
    assert.equal((await ok(ox('POST', '/api/seed'))).added, 8);
    data = await ok(ox('GET', '/api/data'));
    const amitS = data.members.find((m) => m.name === 'Amit Soni');
    assert.deepEqual([data.members.length, data.members.every((m) => m.sample), amitS.start, G.due(amitS), data.payments.length, data.exportDue, (await db.find('customers', { gymId: third })).length, (await db.find('transactions', { gymId: third })).length],
      [8, true, G.addDays(today, -2), 1000, 7, false, 0, 0]);
    assert.deepEqual([(await ok(ox('POST', '/api/chat', { question: 'किसकी फीस बाकी है?', quick: true }))).answer.includes('Amit Soni'), await status(ox('POST', `/api/members/${amitS.id}/pay`, { amount: 100 })),
      await status(ox('PUT', `/api/members/${amitS.id}`, { name: 'X', phone: '9829011103' })), await status(ox('DELETE', `/api/members/${amitS.id}`)), await status(ox('POST', `/api/members/${amitS.id}/renew`, { months: 1 })),
      await status(ox('DELETE', `/api/payments/${data.payments[0].id}`)), (await ok(ox('POST', '/api/members/delete', { ids: [amitS.id] }))).deleted, await status(ox('POST', '/api/reminders/sent', { memberId: amitS.id, type: 'fees' })),
      await status(ox('POST', '/api/seed')), (await ok(owner('GET', '/api/admin/gyms'))).find((g) => g.email === 'oxfit').members], [true, 400, 400, 400, 400, 400, 0, 200, 200, 0]);
    // The gym's own members sit beside them. Taking the sample away leaves those alone; so does a sample member that an
    // older version wrote into the database, which goes with the rest
    await ok(ox('POST', '/api/members', { name: 'Own Member', phone: '9829011199', months: 1 }));
    await db.insert('memberships', { _id: 'aaaaaaaaaaaaaaa1', gymId: third, customerId: 'aaaaaaaaaaaaaaa0', months: 1, start: today, end: G.endOf(today, 1), fee: 1000, pt: false, diet: false, createdAt: new Date().toISOString() });
    await db.insert('customers', { _id: 'aaaaaaaaaaaaaaa0', gymId: third, name: 'Rahul Sharma', phone: '9829011101', joinedAt: today });
    afresh();
    assert.deepEqual([(await ok(ox('GET', '/api/data'))).members.length, (await ok(ox('DELETE', '/api/sample'))).removed, (await ok(ox('GET', '/api/data'))).members.map((m) => m.name),
      (await db.find('memberships', { gymId: third })).length, (await db.find('transactions', { gymId: third })).length, (await ok(ox('DELETE', '/api/sample'))).removed], [10, 9, ['Own Member'], 1, 0, 0]);
    // The owner of the service deletes a gym: it is signed out and hidden, yet comes back with all it held
    assert.deepEqual([await status(ox('DELETE', `/api/admin/gyms/${third}`)), (await ok(owner('DELETE', `/api/admin/gyms/${third}`))).ok, await status(ox('GET', '/api/data')),
      await status(ox('POST', '/api/auth/login', { email: 'oxfit', password: 'first-password' })), !!(await listed('oxfit')).deletedAt, (await db.find('customers', { gymId: third })).length], [403, true, 401, 401, true, 1]);
    await ok(owner('POST', `/api/admin/gyms/${third}/restore`));
    await ok(ox('POST', '/api/auth/login', { email: 'oxfit', password: 'first-password' }));
    assert.deepEqual([(await ok(ox('GET', '/api/data'))).members.map((m) => m.name), (await listed('oxfit')).deletedAt, await status(owner('POST', `/api/admin/gyms/${third}/restore`))], [['Own Member'], null, 404]);

    // Every day each gym's data is kept. The owner can put a gym back to a kept day, and what it held just before that
    // is kept too, so a restore can itself be taken back. Running the day's work twice makes one backup
    const { daily } = require('./server'), backups = `/api/admin/gyms/${third}/backups`;
    await daily();
    await daily();
    const own = (await ok(ox('GET', '/api/data'))).members[0];
    await ok(ox('POST', `/api/members/${own.id}/pay`, { amount: 300 }));
    await ok(ox('POST', '/api/members', { name: 'Later Member', phone: '9829011198', months: 3 }));
    assert.deepEqual([(await ok(owner('GET', backups))).map((b) => [b.date, b.members]), await status(owner('POST', backups, { date: '2020-01-01' })), await status(ox('GET', backups))], [[[today, 1]], 404, 403]);
    assert.equal((await ok(owner('POST', backups, { date: today }))).members, 1);
    data = await ok(ox('GET', '/api/data'));
    assert.deepEqual([data.members.map((m) => [m.name, m.paid]), data.payments.length, (await ok(owner('GET', backups))).map((b) => [b.date, b.members])], [[['Own Member', 0]], 0, [['before restore', 2], [today, 1]]]);
    await ok(owner('POST', backups, { date: 'before restore' }));
    data = await ok(ox('GET', '/api/data'));
    assert.deepEqual([data.members.map((m) => m.name).sort(), data.payments.map((p) => p.amount)], [['Later Member', 'Own Member'], [300]]);
    // A backup older than a week goes when a newer day's is made
    await daily(new Date(Date.now() + 8 * 864e5));
    assert.deepEqual((await ok(owner('GET', backups))).map((b) => b.date).sort(), [G.addDays(today, 8), 'before restore'].sort());
    // Everything can be downloaded as one compressed file, without the sign-ins
    const all = JSON.parse(zlib.gunzipSync((await owner('GET', '/api/admin/backup', undefined, true))[1]));
    assert.deepEqual([all.gyms.some((g) => g.email === 'oxfit'), all.customers.some((c) => c.name === 'Own Member'), all.transactions.length > 0, 'sessions' in all, await status(ox('GET', '/api/admin/backup'))], [true, true, true, false, 403]);
    // restore.js puts that file back into an empty store, and refuses to without --yes. (Not run against MongoDB: it would replace the real database.)
    if (!MONGO) {
      const into = fs.mkdtempSync(path.join(os.tmpdir(), 'gymsaathi-restore-')), file = path.join(into, 'backup.json.gz');
      fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(all)));
      const run = (...args) => require('node:child_process').spawnSync(process.execPath, ['restore.js', file, ...args], { cwd: __dirname, env: { ...process.env, DATA_DIR: into, MONGODB_URI: '' }, encoding: 'utf8' });
      assert.deepEqual([run().status, fs.existsSync(path.join(into, 'gyms.json'))], [1, false]);
      const done = run('--yes');
      assert.deepEqual([done.status, JSON.parse(fs.readFileSync(path.join(into, 'gyms.json'), 'utf8')).length, JSON.parse(fs.readFileSync(path.join(into, 'customers.json'), 'utf8')).length], [0, all.gyms.length, all.customers.length], done.stderr);
      fs.rmSync(into, { recursive: true, force: true });
    }

    // Every seven days a gym with members, and the owner of the service with gyms, is due to save a backup on their own
    // computer. The gym's file holds its own records and nobody else's. What is noted is when, which file, where, on what
    data = await ok(gym('GET', '/api/data'));
    assert.deepEqual([data.exportDue, data.exports, data.exportDays, (await ok(owner('GET', '/api/data'))).exportDue], [true, [], 7, true]);
    const file = await ok(gym('GET', '/api/backup'));
    assert.deepEqual([file.gym.name, file.customers.length > 0, file.customers.every((c) => c.gymId === seen.id), file.memberships.every((p) => p.gymId === seen.id), file.transactions.every((p) => p.gymId === seen.id), 'hash' in file.gym],
      ['Fit Zone', true, true, true, true, false]);
    assert.deepEqual([await status(nobody('GET', '/api/backup')), await status(owner('GET', '/api/backup')), await status(gym('POST', '/api/exports', { place: 'x' }))], [401, 400, 400]);
    let noted = await ok(gym('POST', '/api/exports', { file: 'Fit-Zone-backup.json', place: 'Folder "Gym Backups"', device: 'Win32 Chrome' }));
    assert.deepEqual([noted.exportDue, noted.exports.map((e) => [e.file, e.place, e.device]), Math.abs(Date.parse(noted.exports[0].at) - Date.now()) < 60e3], [false, [['Fit-Zone-backup.json', 'Folder "Gym Backups"', 'Win32 Chrome']], true]);
    assert.deepEqual([(await ok(gym('GET', '/api/data'))).exportDue, (await ok(owner('GET', '/api/data'))).exportDue, (await listed('fit.zone')).savedPlace, (await listed('fit.zone')).savedDevice, (await listed('second.gym')).savedAt],
      [false, true, 'Folder "Gym Backups"', 'Win32 Chrome', null]);
    // The owner of the service saves under their own name, also while a gym is open; a save with no place is the Downloads folder
    noted = await ok(owner('POST', `/api/exports?gym=${seen.id}`, { file: 'gymsaathi-all-gyms.json.gz' }));
    assert.deepEqual([noted.exports.map((e) => e.place), (await ok(owner('GET', '/api/data'))).exportDue, (await ok(gym('GET', '/api/data'))).exports.length], [['Downloads folder'], false, 1]);
    // Eight days on, both are due again
    for (const e of await db.find('exports')) await db.update('exports', { _id: e._id }, { at: new Date(Date.now() - 8 * 864e5).toISOString() });
    afresh();
    assert.deepEqual([(await ok(gym('GET', '/api/data'))).exportDue, (await ok(owner('GET', '/api/data'))).exportDue], [true, true]);

    // Several members ticked on the list go together, each as one deleted member does; ids of another gym, of nobody,
    // or twice over are passed by. Several gyms go together the same way, for the owner of the service only
    const many = [];
    for (const n of [1, 2, 3]) many.push((await ok(gym('POST', '/api/members', { name: `Batch ${n}`, phone: `982904400${n}`, months: 1 }))).id);
    assert.deepEqual([await status(gym('POST', '/api/members/delete', { ids: [] })), await status(gym('POST', '/api/members/delete', { ids: 'all' })), await status(nobody('POST', '/api/members/delete', { ids: many }))], [400, 400, 401]);
    const outside = (await ok(owner('POST', '/api/admin/gyms', { ...fitZone, name: 'Batch Gym A', email: 'batch.a', password: 'first-password' }))).id;
    const outsider = (await ok(owner('POST', `/api/members?gym=${outside}`, { name: 'Not Yours', phone: '9829044009', months: 1 }))).id;
    assert.equal((await ok(gym('POST', '/api/members/delete', { ids: [many[0], many[1], many[1], outsider, '0123456789abcdef', 'x'] }))).deleted, 2);
    data = await ok(gym('GET', '/api/data'));
    assert.deepEqual([data.members.filter((m) => m.name.startsWith('Batch')).map((m) => m.name), data.deleted.map((d) => d.name).sort(), (await ok(owner('GET', `/api/data?gym=${outside}`))).members.length], [['Batch 3'], ['Batch 1', 'Batch 2'], 1]);
    for (const m of many) { await db.remove('customers', { _id: m }); for (const name of ['memberships', 'transactions']) await db.remove(name, { customerId: m }); } // out of the way of what follows
    await ok(gym('POST', '/api/members/delete', { ids: ['0123456789abcdef'] })); // a change through the app, so the cached list is read afresh
    const second2 = (await ok(owner('POST', '/api/admin/gyms', { ...fitZone, name: 'Batch Gym B', email: 'batch.b', password: 'first-password' }))).id;
    assert.deepEqual([await status(gym('POST', '/api/admin/gyms/delete', { ids: [outside] })), (await ok(owner('POST', '/api/admin/gyms/delete', { ids: [outside, second2, '0123456789abcdef'] }))).deleted,
      !!(await listed('batch.a')).deletedAt, !!(await listed('batch.b')).deletedAt, await status(browser()('POST', '/api/auth/login', { email: 'batch.a', password: 'first-password' })), (await listed('fit.zone')).deletedAt], [403, 2, true, true, 401, null]);
    for (const g of [outside, second2]) { for (const name of ['customers', 'memberships', 'transactions', 'sessions']) await db.remove(name, { gymId: g }); await db.remove('gyms', { _id: g }); }

    // Passwords: the gym changes its own; the owner resets one and switches a gym off
    assert.equal(await status(gym('POST', '/api/auth/password', { current: 'wrong-one', password: 'second-password' })), 400);
    await ok(gym('POST', '/api/auth/password', { current: 'first-password', password: 'second-password' }));
    assert.deepEqual([await status(gym('GET', '/api/data')), await status(browser()('POST', '/api/auth/login', { email: 'fit.zone', password: 'first-password' }))], [200, 401]);
    await ok(owner('PUT', `/api/admin/gyms/${seen.id}`, { disabled: true }));
    assert.deepEqual([await status(gym('GET', '/api/data')), await status(gym('POST', '/api/auth/login', { email: 'fit.zone', password: 'second-password' }))], [401, 403]);
    // A deleted member leaves every screen and every total, and nothing can be done to them
    await ok(owner('DELETE', `/api/members/${rahul.id}?gym=${seen.id}`));
    data = await ok(owner('GET', `/api/data?gym=${seen.id}`));
    assert.deepEqual([data.members.some((m) => m.id === rahul.id), data.payments.some((p) => p.memberId === rahul.id), data.deleted.map((d) => d.name),
      await status(owner('POST', `/api/members/${rahul.id}/pay?gym=${seen.id}`, { amount: 1 }))], [false, false, ['Rahul Sharma'], 404]);
    // They come back with every period and payment, unless their mobile number has gone to someone else meanwhile
    const twin = await ok(owner('POST', `/api/members?gym=${seen.id}`, { name: 'Twin', phone: '9829011111', months: 1 }));
    assert.equal(await status(owner('POST', `/api/members/${rahul.id}/restore?gym=${seen.id}`)), 409);
    await ok(owner('DELETE', `/api/members/${twin.id}?gym=${seen.id}`));
    const again = await ok(owner('POST', `/api/members/${rahul.id}/restore?gym=${seen.id}`));
    assert.deepEqual([again.fee, again.paid, again.months, (await ok(owner('GET', `/api/data?gym=${seen.id}`))).deleted.map((d) => d.name)], [8700, 5000, 3, ['Twin']]);
    // After thirty days what is still deleted goes for good: a member with their periods, a gym with all it held
    await ok(owner('DELETE', `/api/admin/gyms/${third}`));
    await daily(new Date(Date.now() + 31 * 864e5));
    assert.deepEqual([(await db.find('customers', { _id: twin.id })).length, (await db.find('memberships', { customerId: twin.id })).length, (await db.find('customers', { _id: rahul.id })).length,
      (await db.find('gyms', { _id: third })).length, (await db.find('customers', { gymId: third })).length, (await db.find('backups', { gymId: third })).length], [0, 0, 1, 0, 0, 0]);
    await ok(owner('POST', '/api/auth/logout'));
    assert.equal(await status(owner('GET', '/api/admin/gyms')), 401);
    // One file per collection, and a write without the JSON content type is refused
    if (!MONGO) assert.deepEqual(fs.readdirSync(dir).sort(), ['backups.json', 'customers.json', 'exports.json', 'gyms.json', 'memberships.json', 'sessions.json', 'transactions.json']);
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
  await cacheChecks();
  console.log('ok  cache');
  await talkChecks();
  console.log('ok  the assistant asks which member is meant');
  await apiChecks();
  console.log(`ok  api (${MONGO ? 'MongoDB' : 'files'})`);
  if (MONGO) process.exit(0); // the database connection would keep the process open
})().catch((e) => { console.error(e); process.exit(1); });
