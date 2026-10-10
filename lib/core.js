// What the server and the screens both need to agree on: dates, fees, a membership's state and the WhatsApp messages.
//   Node:    const G = require('./lib/core')
//   Browser: <script src="/lib/core.js"></script>  ->  window.Gym
(function (root) {
  'use strict';

  const pad = (n) => String(n).padStart(2, '0');
  const todayISO = (d) => { d = d || new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const isDate = (s) => /^\d{4}-\d\d-\d\d$/.test(s || '') && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
  const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  // A month later on the same day, or on the month's last day when it is shorter (31 Jan -> 28 Feb).
  function addMonths(iso, months) {
    const [y, m, d] = iso.split('-').map(Number), last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m - 1 + months, Math.min(d, last))).toISOString().slice(0, 10);
  }
  const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 864e5);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDate = (iso) => (isDate(iso) ? `${Number(iso.slice(8))} ${MONTHS[iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}` : '');
  const money = (n) => `₹${(Math.round(Number(n) || 0)).toLocaleString('en-IN')}`;
  const str = (v, max = 200) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '').trim().slice(0, max);
  const num = (v, max = 1e7) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0; };

  // A membership runs for 1, 3, 6 or 12 months. The gym sets a price for each; one left blank is the monthly price
  // times the months. A personal trainer and a diet plan are charged per month on top.
  const PLANS = [1, 3, 6, 12];
  const planLabel = (months) => (months === 12 ? '1 साल' : `${months} महीने`.replace('1 महीने', '1 महीना'));
  const planPrice = (gym, months) => num(gym[`price${months}`]) || months * num(gym.price1);
  const feeFor = (gym, f) => planPrice(gym, f.months) + (f.pt ? num(gym.ptPrice) * f.months : 0) + (f.diet ? num(gym.dietPrice) * f.months : 0);
  // The last day of a membership that starts on `start`: one day short of the same date `months` later.
  const endOf = (start, months) => addDays(addMonths(start, months), -1);
  const due = (m) => Math.max(0, Math.round(num(m.fee) - num(m.paid)));
  // active, expiring (7 days or fewer left) or expired.
  const statusOf = (m, today) => { const left = daysBetween(today, m.end); return left < 0 ? 'expired' : left <= 7 ? 'expiring' : 'active'; };
  const lastTen = (s) => String(s || '').replace(/\D/g, '').slice(-10);

  // The WhatsApp messages, in plain Hindi. They are fixed text with the gym's own details, so they cost nothing to
  // make and say the same thing every time.
  function messages(gym, m) {
    const from = [gym.name, gym.owner && `(${gym.owner})`].filter(Boolean).join(' '), hi = `नमस्ते ${m.name} जी 🙏`;
    const prices = PLANS.filter((p) => planPrice(gym, p) > 0 && (p === 1 || num(gym[`price${p}`]))).map((p) => `${planLabel(p)} ${money(planPrice(gym, p))}`).join(' | ');
    const pay = gym.upi ? ` UPI: ${gym.upi}` : '';
    return {
      welcome: [`${hi}`, `${gym.name} में आपका स्वागत है! 💪`, `आपकी मेंबरशिप ${fmtDate(m.start)} से ${fmtDate(m.end)} तक है।`,
        gym.timings && `समय: ${gym.timings}`, gym.amenities && `सुविधाएँ: ${gym.amenities}`,
        `फीस ${money(m.fee)}, जमा ${money(m.paid)}${due(m) ? `, बाकी ${money(due(m))}` : ''}.`, `- ${from}`].filter(Boolean).join('\n'),
      fees: `${hi}\n${gym.name} में आपकी फीस ${money(due(m))} बाकी है। कृपया जल्द जमा करवा दें।${pay}\nधन्यवाद।\n- ${from}`,
      expiring: `${hi}\n${gym.name} में आपकी मेंबरशिप ${fmtDate(m.end)} को खत्म हो रही है।\nरिन्यू के लिए: ${prices}\nआज ही रिन्यू करवाएँ 💪\n- ${from}`,
      expired: `${hi}\n${gym.name} में आपकी मेंबरशिप ${fmtDate(m.end)} को खत्म हो चुकी है।\nदोबारा शुरू करने के लिए: ${prices}\nहम आपका इंतज़ार कर रहे हैं 💪\n- ${from}`,
    };
  }

  // Who gets a message today, and which one. Fees are asked for every day while anything is owed. A membership is
  // mentioned on its last four days, and after it ended on days 1, 3, 7 and 15, so nobody is pestered for ever.
  // `sent` holds what was already sent today: { 'memberId:type': true }.
  function reminders(db, today) {
    const sent = (db.sent && db.sent[today]) || {}, out = [];
    for (const m of db.members) {
      const left = daysBetween(today, m.end), text = messages(db.gym, m);
      const add = (type) => { if (!sent[`${m.id}:${type}`] && lastTen(m.phone).length === 10) out.push({ memberId: m.id, name: m.name, phone: m.phone, type, text: text[type] }); };
      if (due(m) > 0) add('fees');
      if (left >= 0 && left <= 3) add('expiring');
      else if ([1, 3, 7, 15].includes(-left)) add('expired');
    }
    return out;
  }
  // Opens WhatsApp on this member's number with the message typed in: the owner only presses Send.
  const waLink = (phone, text) => `https://wa.me/91${lastTen(phone)}?text=${encodeURIComponent(text)}`;

  const api = { todayISO, isDate, addDays, addMonths, daysBetween, fmtDate, money, str, num, PLANS, planLabel, planPrice, feeFor, endOf, due, statusOf, lastTen,
    messages, reminders, waLink };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Gym = api;
}(typeof self !== 'undefined' ? self : this));
