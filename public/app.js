// GymSaathi screens: state, the server calls, routing, one delegated listener, the pages and the talking assistant.
'use strict';

const G = window.Gym;
const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main'), dlg = $('#dialog');

let S = null;         // the GET /api/data payload; null when signed out
let current = '';     // route name on screen
let accounts = null;  // the owner's list of gyms
let view = '';        // the gym the owner of the service has opened; every call then carries ?gym=<id>
let notice = '';      // why the gym was signed out: its free trial or its plan is over
let F = { tab: '', q: '', month: '' };
const picked = new Set(); // what is ticked on the list in view, to delete together
let imp = { rows: null, done: null }; // old records read from a file and not yet saved, and what the last save did
const views = {};     // route name -> (id, query) => html
const actions = {};   // data-action name -> (el, event) => void | Promise

// ---- small helpers

// Every dynamic value written into HTML goes through esc().
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const money = (n) => esc(G.money(n));
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const byId = (list, id) => list.find((x) => x.id === id);
const today = () => G.todayISO();
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const opts = (list, selected) => list.map((o) => {
  const [value, label] = Array.isArray(o) ? o : [o, o];
  return `<option value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}>${esc(label)}</option>`;
}).join('');
const field = (label, control, cls = '') => `<label class="field ${cls}"><span>${label}</span>${control}</label>`;
const input = (name, value, attrs = 'maxlength="200"') => `<input name="${name}" value="${esc(value)}" ${attrs}>`;
const check = (label, attrs) => `<label class="check"><input type="checkbox" ${attrs}>${label}</label>`;
const NUM = 'type="number" step="1" min="0" inputmode="numeric"';
const page = (title, buttons, body) => `<div class="page-head"><h1>${title}</h1><div class="actions">${buttons}</div></div>${body}`;
const empty = (title, text, cta = '') => `<div class="empty"><strong>${title}</strong><p class="muted">${text}</p><div class="actions">${cta}</div></div>`;
const table = (cols, rows) => `<div class="table-wrap"><table><thead><tr>${cols.map((c) => (c[0] === '#' ? `<th class="num">${c.slice(1)}</th>` : `<th>${c}</th>`)).join('')}</tr></thead>
  <tbody>${rows.join('')}</tbody></table></div>`;
const dialogForm = (title, action, id, body, submit = 'Save') => `
  <form data-action="${action}" data-id="${esc(id)}">
    <header class="dialog-head"><h2>${esc(title)}</h2>
      <button type="button" class="btn ghost icon" data-action="dialog-close" aria-label="Close">${icon('x')}</button></header>
    <div class="dialog-body">${body}</div>
    <footer class="dialog-foot"><button type="button" class="btn secondary" data-action="dialog-close">Cancel</button>
      <button class="btn primary">${submit}</button></footer>
  </form>`;
const fd = (form) => Object.fromEntries(new FormData(form));
const notFound = `<div class="card">${empty('Nothing here', 'This record does not exist any more.', '<a class="btn primary" href="#/dashboard">Go to dashboard</a>')}</div>`;

// Asks before something is deleted. `action` runs on Yes, with `id` on the button.
const sure = (title, text, action, id, yes) => openDialog(`<div class="dialog-body"><h2>${esc(title)}</h2><p class="muted">${esc(text)}</p></div>
  <footer class="dialog-foot"><button class="btn secondary" data-action="dialog-close">Cancel</button><button class="btn danger" data-action="${action}" data-id="${esc(id)}">${esc(yes)}</button></footer>`);
const payDel = (p) => (sampleId(p.id) ? '' : `<button class="btn ghost icon" data-action="payment-edit" data-id="${esc(p.id)}" aria-label="Change payment">${icon('edit')}</button><button class="btn ghost icon" data-action="payment-delete" data-id="${esc(p.id)}" data-name="${esc(p.name)}" data-amount="${money(p.amount)}" aria-label="Delete payment">${icon('trash')}</button>`);

// Saves a table as a .csv file, which Excel opens. A cell that starts like a formula is written as plain text.
function saveTable(name, rows) {
  const cell = (v) => { const t = String(v == null ? '' : v); return `"${(/^[=+\-@]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"`; };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  a.download = `${S.gym.name.replace(/[^\w]+/g, '-')}-${name}-${today()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const yes = (v) => (v ? 'Yes' : 'No');

// Ticking rows of a list. The bar above the list says how many are ticked and deletes them together.
const PICK_ALL = '<input type="checkbox" data-action="pick-all" aria-label="Tick all">';
const sampleId = (id) => /^5a[012]\d{13}$/.test(id); // a member, membership or payment out of the sample file
const pickBox = (id, name) => (sampleId(id) ? '<td class="pick"></td>' : `<td class="pick"><input type="checkbox" data-action="pick" value="${esc(id)}" ${picked.has(id) ? 'checked' : ''} aria-label="Tick ${esc(name)}"></td>`);
const bulkBar = () => `<div class="bulk" id="bulk" ${picked.size ? '' : 'hidden'}><strong id="bulkCount">${picked.size} ticked</strong>
  <button class="btn danger" data-action="bulk-delete">${icon('trash')}Delete ticked</button><button class="btn ghost" data-action="pick-none">Untick all</button></div>`;
function showPicked() {
  const bar = $('#bulk');
  if (!bar) return;
  bar.hidden = !picked.size;
  $('#bulkCount').textContent = `${picked.size} ticked`;
  const boxes = [...document.querySelectorAll('[data-action="pick"]')], all = $('[data-action="pick-all"]');
  for (const box of boxes) box.checked = picked.has(box.value);
  if (all) all.checked = boxes.length > 0 && boxes.every((box) => box.checked);
}

// Marks a button as off, with the reason on hover, while there is nothing for it to work on.
const off = (nothing, why) => (nothing ? `disabled title="${why}"` : '');

const STATUS = { active: ['paid', 'Active'], expiring: ['partial', 'Ending soon'], expired: ['overdue', 'Ended'] };
const pill = (m) => { const [cls, label] = STATUS[G.statusOf(m, today())]; return `<span class="pill ${cls}">${label}</span>`; };
const planName = (months) => (months === 12 ? '1 year' : `${months} month${months > 1 ? 's' : ''}`);
const WHAT = { fees: 'Fees pending', expiring: 'Membership ending', expired: 'Membership ended', welcome: 'Welcome' };
// A WhatsApp button: it opens the chat with the message typed in, and notes that this reminder went out today.
const waBtn = (m, type, label, cls = 'secondary') => `<a class="btn ${cls}" target="_blank" rel="noopener" href="${esc(G.waLink(m.phone, G.messages(S.gym, m)[type]))}"
  data-action="remind" data-id="${esc(m.id)}" data-type="${type}">${label}</a>`;

// ---- server

// While anything is being fetched a bar runs along the top of the page, so a slow answer never looks like a dead button.
let waiting = 0;
const loading = (by) => { waiting += by; document.body.classList.toggle('loading', waiting > 0); };
async function api(method, path, body) {
  loading(1);
  try { return await ask(method, path, body); } finally { loading(-1); }
}
async function ask(method, path, body) {
  // Every write carries a JSON content type: the server's CSRF defence rejects anything else.
  const init = method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) };
  const res = await fetch(view ? `${path}?gym=${view}` : path, init).catch(() => { throw new Error('Could not reach the server. Check your connection and try again.'); });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  if (res.status === 402) notice = data.error; // the time this gym had is over: the sign-in page says so
  if ((res.status === 401 || res.status === 402) && S) { setData(null); location.hash = '#/login'; } // the session ended while working
  else if (res.status === 402) route();
  throw Object.assign(new Error(data.error || `Something went wrong (${res.status}).`), { status: res.status });
}

// The one place S changes. Another gym, or none, never sees what the last one said to the assistant.
function setData(data) {
  if (!S || !data || S.user.id !== data.user.id) {
    F = { tab: '', q: '', month: '' };
    accounts = null;
    imp = { rows: null, done: null };
    talk = [];
    reg = null;
    stopVoice();
    if (dlg.open) dlg.close();
  }
  if (!data) view = '';
  S = data;
}
async function refresh() { setData(await api('GET', '/api/data')); }
async function load() { await refresh(); route(); }

// ---- routing

function route() {
  const [path, query] = location.hash.slice(1).split('?');
  const [name = '', id] = path.split('/').filter(Boolean);
  document.body.className = S ? '' : 'auth';
  if (!S) {
    if (name !== 'login') return location.replace('#/login');
    main.innerHTML = authView();
    return undefined;
  }
  // The owner of the service has the Accounts page, and a gym's own pages once one is opened from there.
  if (!Object.hasOwn(views, name) || (!S.gym && name !== 'accounts')) return location.replace(S.gym ? '#/dashboard' : '#/accounts');
  current = name;
  picked.clear();
  main.innerHTML = views[name](id, new URLSearchParams(query)) || notFound;
  // In its last five days a gym is told on its dashboard that its time is ending, and what to pay.
  const left = S.validTill ? Math.ceil((Date.parse(S.validTill) - Date.now()) / 864e5) : 99;
  if (name === 'dashboard' && !view && left <= 5) {
    main.insertAdjacentHTML('afterbegin', `<p class="pay-note">Your ${S.paying ? 'plan' : 'free trial'} ends ${left <= 1 ? 'today' : `in ${left} days`}, on ${esc(G.fmtDate(G.todayISO(new Date(S.validTill))))}.
      Pay ${money(S.price)} to keep GymSaathi running. ${esc(S.payNote)}</p>`);
  }
  for (const a of document.querySelectorAll('.sidebar nav a')) {
    a.hidden = a.id === 'navAccounts' ? !S.user.admin : !S.gym;
    if (a.hash === `#/${name === 'import' ? 'members' : name}`) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  $('#gymName').textContent = S.gym ? S.gym.name : 'All gyms';
  $('#planNote').textContent = S.gym && S.validTill ? `${S.paying ? 'Plan' : 'Free trial'} till ${G.fmtDate(G.todayISO(new Date(S.validTill)))}` : '';
  $('#viewClose').hidden = !view;
  document.title = `${{ bolo: 'Assistant', import: 'Import old members' }[name] || cap(name)} - GymSaathi`;
  if (name === 'bolo') renderTalk();
  weeklyBackup().then(hello).catch((e) => toast(e.message, true));
  return undefined;
}
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
window.addEventListener('hashchange', () => {
  if (dlg.open) dlg.close();
  if (!location.hash.startsWith('#/bolo')) stopVoice(); // the assistant stops talking when its page is left
  route();
  window.scrollTo(0, 0);
});

// data-action fires on submit for a <form>, on change or input for a field, and on click for anything else.
async function dispatch(e) {
  if (!(e.target instanceof Element)) return;
  if (e.type === 'submit') e.preventDefault();
  if (e.type === 'click' && e.target.closest('.sidebar a')) document.body.classList.remove('nav-open');
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const on = el.tagName === 'FORM' ? 'submit' : el.matches('select, [type=checkbox]') ? 'change' : el.matches('input, textarea') ? 'input' : 'click';
  if (on !== e.type || el.dataset.busy) return; // busy: a second click while the first request is in flight
  el.dataset.busy = 1;
  try {
    await actions[el.dataset.action](el, e);
  } catch (err) {
    console.error(err);
    toast(err.message, true);
  } finally {
    delete el.dataset.busy;
  }
}
for (const type of ['click', 'submit', 'input', 'change']) document.addEventListener(type, dispatch);

function toast(message, bad) {
  const host = $('#toasts'), t = document.createElement('div');
  t.className = bad ? 'toast error' : 'toast';
  t.textContent = message;
  host.append(t);
  if (host.showPopover) {
    if (host.matches(':popover-open')) host.hidePopover();
    host.showPopover();
  }
  setTimeout(() => t.remove(), bad ? 7000 : 3500);
}
function openDialog(html) {
  dlg.innerHTML = html;
  if (!dlg.open) dlg.showModal();
}

Object.assign(actions, {
  'nav-toggle': () => document.body.classList.toggle('nav-open'),
  'dialog-close': () => dlg.close(),
  retry: () => location.reload(),
  go: (el) => { location.hash = el.dataset.href; },
  // The link itself opens WhatsApp; this only records that today's reminder went out.
  async remind(el) {
    await api('POST', '/api/reminders/sent', { memberId: el.dataset.id, type: el.dataset.type });
    S.sent[`${el.dataset.id}:${el.dataset.type}`] = true;
    if (current === 'dashboard') route();
  },
});

// ---- sign in

const authView = () => `
  <form class="card auth-card" data-action="login">
    <div><div class="wordmark"><img class="mark" src="/favicon.svg" alt="" width="24" height="24">GymSaathi</div>
      <p class="tagline">Run your gym by talking</p></div>
    <div><h1>Sign in</h1><p class="muted">Welcome back.</p></div>
    ${notice ? `<p class="pay-note" role="alert">${esc(notice)}</p>` : ''}
    ${field('Username or gym name', '<input name="email" required maxlength="100" autocomplete="username" autocapitalize="none" spellcheck="false">')}
    ${field('Password', '<input name="password" type="password" required autocomplete="current-password">')}
    <button class="btn primary">Sign in</button>
    <p class="muted">Sign in with the username GymSaathi gave you, or with your gym's name. No login yet, or forgot the password? Ask GymSaathi.</p>
  </form>`;

Object.assign(actions, {
  async login(form) {
    await api('POST', '/api/auth/login', fd(form));
    notice = '';
    helloDue = true;
    await refresh();
    go('#/dashboard');
  },
  async logout() {
    view = '';
    await api('POST', '/api/auth/logout');
    setData(null);
    go('#/login');
  },
  async 'view-open'(el) { view = el.dataset.id; await refresh(); go(el.dataset.to || '#/dashboard'); },
  async 'view-close'() { view = ''; await refresh(); go('#/accounts'); },
});

// ---- dashboard

views.dashboard = () => {
  const t = today(), ms = S.members, count = (s) => ms.filter((m) => G.statusOf(m, t) === s).length;
  const newBtn = `<a class="btn primary" href="#/bolo?new=1">${icon('mic')}New member by voice</a>`;
  if (!ms.length) {
    return page('Dashboard', '', `<div class="card">${empty(`Welcome to ${esc(S.gym.name)}`,
      S.gym.price1 ? 'Add your first member: the assistant asks the questions and you answer aloud.' : 'First set your prices in Settings. The assistant quotes them to every new member.',
      `<a class="btn secondary" href="#/settings">Gym details and prices</a>${newBtn}<button class="btn secondary" data-action="seed">Load sample members</button>`)}</div>`);
  }
  const owed = ms.reduce((s, m) => s + G.due(m), 0), month = S.payments.filter((p) => p.date.startsWith(t.slice(0, 7))).reduce((s, p) => s + p.amount, 0);
  const todo = G.reminders({ gym: S.gym, members: ms, sent: { [t]: S.sent } }, t);
  const kpi = (label, value, hint, bad) => `<div class="card kpi"><div class="muted">${label}</div><div class="kpi-value ${bad ? 'bad' : ''}">${value}</div><div class="hint">${hint}</div></div>`;
  const sample = ms.some((m) => m.sample) ? '<button class="btn secondary" data-action="sample-clear">Remove sample members</button>' : '';
  return page('Dashboard', sample + newBtn, `
    <div class="kpis">${kpi('Active members', count('active') + count('expiring'), `${count('expiring')} ending within 7 days`)}
      ${kpi('Membership ended', count('expired'), 'not renewed yet', count('expired') > 0)}
      ${kpi('Fees pending', money(owed), `${ms.filter((m) => G.due(m) > 0).length} members`, owed > 0)}
      ${kpi('Collected this month', money(month), 'payments received')}</div>
    <section class="card">
      <div class="card-head"><h2>Today's WhatsApp reminders (${todo.length})</h2><span class="hint">${S.autoWhatsApp ? 'These go out by themselves every morning at 6. What is listed has not gone yet: press to send it yourself.'
        : 'Press a button, WhatsApp opens with the message typed in, press Send.'}</span></div>
      ${todo.length ? table(['Member', 'Reminder', ''], todo.map((r) => { const m = byId(ms, r.memberId); return `<tr>
        <td><a href="#/members/${esc(m.id)}">${esc(m.name)}</a><br><span class="muted">${esc(m.phone)}</span></td>
        <td>${WHAT[r.type]}${r.type === 'fees' ? `: ${money(G.due(m))}` : `: ${esc(G.fmtDate(m.end))}`}</td>
        <td class="num">${waBtn(m, r.type, 'Send on WhatsApp', 'primary')}</td></tr>`; }))
      : empty('Nothing to send today', 'Fees pending and memberships about to end show up here every day.')}
    </section>`);
};

// ---- members

const TABS = [['', 'All'], ['active', 'Active'], ['expiring', 'Ending soon'], ['expired', 'Ended'], ['due', 'Fees pending'], ['paid', 'Fees paid']];
// Deleted members wait here for 30 days, then they are gone for good.
function deletedRows() {
  if (!S.deleted.length) return empty('Nothing deleted', 'A deleted member waits here for 30 days and can be brought back.');
  return table(['Member', 'Deleted on', 'Gone for good on', ''], S.deleted.map((d) => { const on = G.todayISO(new Date(d.deletedAt)); return `<tr>
    <td>${esc(d.name)}<br><span class="muted">${esc(d.phone)}</span></td><td>${esc(G.fmtDate(on))}</td><td>${esc(G.fmtDate(G.addDays(on, 30)))}</td>
    <td class="num"><button class="btn secondary" data-action="member-restore" data-id="${esc(d.id)}">Bring back</button></td></tr>`; }));
}
function memberRows() {
  if (F.tab === 'deleted') return deletedRows();
  const q = F.q.trim().toLowerCase(), t = today();
  const rows = S.members.filter((m) => (!F.tab || (F.tab === 'due' ? G.due(m) > 0 : F.tab === 'paid' ? !G.due(m) : G.statusOf(m, t) === F.tab)) && (!q || `${m.name} ${m.phone}`.toLowerCase().includes(q)))
    .sort((a, b) => (a.end > b.end) - (a.end < b.end));
  if (!rows.length) return empty('No members here', S.members.length ? 'Change the tab or the search.' : 'Add your first member.');
  return table([PICK_ALL, 'Member', 'Plan', 'Ends', '#Fee due', 'Status'], rows.map((m) => `<tr data-action="go" data-href="#/members/${esc(m.id)}">
    ${pickBox(m.id, m.name)}<td><a href="#/members/${esc(m.id)}">${esc(m.name)}</a><br><span class="muted">${esc(m.phone)}</span></td>
    <td>${planName(m.months)}${m.pt ? ' + trainer' : ''}${m.diet ? ' + diet' : ''}</td><td>${esc(G.fmtDate(m.end))}</td>
    <td class="num ${G.due(m) ? 'low' : ''}">${G.due(m) ? money(G.due(m)) : ''}</td><td>${pill(m)}</td></tr>`));
}
// Any number of months can be typed. The gym's own prices are shown beside the box; another length costs the monthly price times the months.
const monthsField = (months) => field(`Months (${G.PLANS.filter((p) => p === 1 || G.num(S.gym[`price${p}`])).map((p) => `${p}: ${G.money(G.planPrice(S.gym, p))}`).join(', ')})`,
  input('months', months || 1, `${NUM} min="1" max="36" required`));
const MODES = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other'];
// The typed form: for a correction, or where speaking is not possible. `plan` adds the membership and money fields.
const memberForm = (m, plan) => `<div class="grid">
  ${field('Name', input('name', m.name, 'required maxlength="80"'))}
  ${field('Mobile number', input('phone', m.phone, 'required type="tel" inputmode="numeric" maxlength="15"'))}
  ${field('Gender', `<select name="gender">${opts([['', 'Not said'], 'Male', 'Female'], m.gender)}</select>`)}
  ${field('Age', input('age', m.age, NUM))}
  ${field('Weight (kg)', input('weight', m.weight, 'type="number" step="0.1" min="0" inputmode="decimal"'))}
  ${field('Height', input('height', m.height, 'maxlength="30"'))}
  ${field('Goal', input('goal', m.goal, 'maxlength="100"'))}
  ${field('Health problem, injury', input('health', m.health, 'maxlength="150"'))}
  ${field('Batch', input('batch', m.batch, 'maxlength="40" placeholder="Morning or Evening"'))}
  ${plan ? `<div class="row">${check('Personal trainer', `name="pt" ${m.pt ? 'checked' : ''}`)}${check('Diet plan', `name="diet" ${m.diet ? 'checked' : ''}`)}</div>
  ${monthsField(m.months)}
  ${field('Starts on', `<input type="date" name="start" value="${esc(m.start || today())}">`)}
  ${field('Fee (leave empty for the gym\'s price)', input('fee', m.fee == null ? '' : m.fee, NUM))}
  ${field('Paid now', input('paid', m.paid || '', NUM))}
  ${field('Paid by', `<select name="mode">${opts(MODES, 'Cash')}</select>`)}` : ''}</div>`;
// The trainer and the diet plan are part of a period bought, so they are asked with a plan and not on a correction.
const memberBody = (form) => ({ ...fd(form), ...(form.pt && { pt: form.pt.checked, diet: form.diet.checked }) });

views.members = (id) => {
  if (!id) {
    const tabs = S.deleted.length || F.tab === 'deleted' ? [...TABS, ['deleted', `Deleted (${S.deleted.length})`]] : TABS;
    return page('Members', `<a class="btn secondary" href="#/import">Import old members</a><button class="btn secondary" data-action="export-members" ${off(!S.members.length, 'There is no member to download yet')}>Download Excel</button><button class="btn secondary" data-action="member-new">${icon('plus')}Add by typing</button><a class="btn primary" href="#/bolo?new=1">${icon('mic')}New member by voice</a>`, `
      <div class="card"><div class="tabs">${tabs.map(([v, label]) => `<button class="tab" data-action="tab" data-value="${v}" ${F.tab === v ? 'aria-pressed="true"' : ''}>${label}</button>`).join('')}</div>
        <div class="filters"><input type="search" data-action="search" value="${esc(F.q)}" placeholder="Search name or mobile number" aria-label="Search members"></div>
        ${bulkBar()}<div id="list">${memberRows()}</div></div>`);
  }
  const m = byId(S.members, id);
  if (!m) return '';
  const owed = G.due(m), pays = S.payments.filter((p) => p.memberId === m.id).sort((a, b) => (a.date < b.date) - (a.date > b.date));
  const row = (label, value) => (value || value === 0 ? `<tr><td class="muted">${label}</td><td>${esc(value)}</td></tr>` : '');
  // A sample member is for looking at: it has no button that would change it.
  return page(`${esc(m.name)} ${pill(m)}`, m.sample ? '<span class="pill partial">Sample member</span>' : `<button class="btn secondary" data-action="member-edit" data-id="${esc(m.id)}">${icon('edit')}Edit</button>
      <button class="btn danger" data-action="member-delete" data-id="${esc(m.id)}" data-name="${esc(m.name)}">${icon('trash')}Delete</button>`, `
    <div class="cols">
      <section class="card"><div class="card-head"><h2>Membership</h2></div><div class="card-body">
        <p><strong>${planName(m.months)}</strong>${m.pt ? ' + personal trainer' : ''}${m.diet ? ' + diet plan' : ''}<br>${esc(G.fmtDate(m.start))} to ${esc(G.fmtDate(m.end))}</p>
        <p>Fee ${money(m.fee)}, paid ${money(m.paid)}${owed ? `, <span class="low">pending ${money(owed)}</span>` : ', nothing pending'}</p>
        ${m.sample ? '<p class="hint">This is a sample member, for looking around. Add your own member to take a payment or renew.</p>' : `<div class="actions">
          ${owed ? `<button class="btn primary" data-action="pay-full" data-id="${esc(m.id)}" data-mode="Cash">Got ${money(owed)} in cash</button>
            <button class="btn secondary" data-action="pay-full" data-id="${esc(m.id)}" data-mode="UPI">Got it by UPI</button>
            <button class="btn secondary" data-action="pay-part" data-id="${esc(m.id)}">Part payment</button>` : ''}
          <button class="btn ${owed ? 'secondary' : 'primary'}" data-action="renew" data-id="${esc(m.id)}">Renew</button>
          <button class="btn ghost" data-action="period-edit" data-id="${esc(m.id)}">Correct this membership</button>
          ${m.history.length ? `<button class="btn ghost" data-action="period-delete" data-id="${esc(m.id)}" data-name="${esc(m.name)}">Undo this renewal</button>` : ''}</div>`}
      </div></section>
      <section class="card"><div class="card-head"><h2>WhatsApp</h2></div><div class="card-body">
        <p class="muted">Opens WhatsApp on ${esc(m.phone)} with the message typed in.</p>
        <div class="actions">${owed ? waBtn(m, 'fees', 'Fees reminder', 'primary') : ''}${waBtn(m, G.statusOf(m, today()) === 'expired' ? 'expired' : 'expiring', 'Renewal reminder')}${waBtn(m, 'welcome', 'Welcome message')}</div>
      </div></section>
    </div>
    <div class="cols">
      <section class="card"><div class="card-head"><h2>Details</h2></div><div class="table-wrap"><table><tbody>
        ${row('Mobile', m.phone)}${row('Gender', m.gender)}${row('Age', m.age)}${row('Weight', m.weight && `${m.weight} kg`)}${row('Height', m.height)}${row('Goal', m.goal)}
        ${row('Health', m.health)}${row('Batch', m.batch)}${row('Joined', G.fmtDate(m.joinedAt))}${row('Notes', m.notes)}</tbody></table></div></section>
      <section class="card"><div class="card-head"><h2>Payments</h2></div>
        ${pays.length ? table(['Date', 'Paid by', '#Amount', ''], pays.map((p) => `<tr><td>${esc(G.fmtDate(p.date))}</td><td>${esc(p.mode)}</td><td class="num">${money(p.amount)}</td><td class="num">${payDel(p)}</td></tr>`)) : empty('No payment yet', '')}
        ${m.history.length ? `<div class="card-body"><p class="hint">Earlier memberships: ${m.history.map((h) => `${planName(h.months)}, ${esc(G.fmtDate(h.start))} to ${esc(G.fmtDate(h.end))}, ${money(h.fee)}`).join('; ')}</p></div>` : ''}
      </section>
    </div>`);
};

Object.assign(actions, {
  tab(el) { F.tab = el.dataset.value; route(); },
  search(el) { F.q = el.value; $('#list').innerHTML = memberRows(); showPicked(); },
  pick(el) { if (el.checked) picked.add(el.value); else picked.delete(el.value); showPicked(); },
  'pick-all'(el) { for (const box of document.querySelectorAll('[data-action="pick"]')) { if (el.checked) picked.add(box.value); else picked.delete(box.value); } showPicked(); },
  'pick-none'() { picked.clear(); showPicked(); },
  'bulk-delete'() {
    const n = picked.size, gyms = current === 'accounts';
    sure(`Delete ${n} ${gyms ? 'gym' : 'member'}${n > 1 ? 's' : ''}?`, gyms ? 'Each gym leaves at once with everything it holds and is signed out. For 30 days you can bring them back from Deleted gyms on this page; after that they are gone for good.'
      : 'They leave every list and total, with their payments. For 30 days you can bring them back from Members, under Deleted; after that they are gone for good.', 'bulk-delete-yes', '', `Delete ${n}`);
  },
  async 'bulk-delete-yes'() {
    const gyms = current === 'accounts', r = await api('POST', gyms ? '/api/admin/gyms/delete' : '/api/members/delete', { ids: [...picked] });
    dlg.close();
    toast(`${r.deleted} deleted. They can be brought back for 30 days.`);
    if (gyms) { picked.clear(); await loadAccounts(); } else await load();
  },
  async seed() { await api('POST', '/api/seed'); toast('Sample members loaded'); await load(); },
  'member-new'() { openDialog(dialogForm('New member', 'member-save', '', memberForm({}, true), 'Save member')); },
  'member-edit'(el) { openDialog(dialogForm('Edit member', 'member-save', el.dataset.id, memberForm(byId(S.members, el.dataset.id)))); },
  async 'member-save'(form) {
    const id = form.dataset.id, m = await api(id ? 'PUT' : 'POST', `/api/members${id ? `/${id}` : ''}`, memberBody(form));
    dlg.close();
    toast(id ? 'Saved' : `${m.name} is added`);
    if (reg && !id) reg = null; // the form the assistant had filled was saved from here
    await refresh();
    go(`#/members/${m.id}`);
  },
  'payment-edit'(el) {
    const p = byId(S.payments, el.dataset.id);
    openDialog(dialogForm(`Payment from ${p.name}`, 'payment-edit-save', p.id, `<div class="grid">${field('Amount', input('amount', p.amount, `${NUM} required`))}
      ${field('Paid by', `<select name="mode">${opts(MODES, p.mode)}</select>`)}${field('Date', `<input type="date" name="date" value="${esc(p.date)}" required>`)}</div>`));
  },
  async 'payment-edit-save'(form) { await api('PUT', `/api/payments/${form.dataset.id}`, fd(form)); dlg.close(); toast('Payment changed'); await load(); },
  'period-edit'(el) {
    const m = byId(S.members, el.dataset.id);
    openDialog(dialogForm(`${m.name}'s membership`, 'period-edit-save', m.id, `<div class="grid">${monthsField(m.months)}
      ${field('Starts on', `<input type="date" name="start" value="${esc(m.start)}" required>`)}
      <div class="row span2">${check('Personal trainer', `name="pt" ${m.pt ? 'checked' : ''}`)}${check('Diet plan', `name="diet" ${m.diet ? 'checked' : ''}`)}</div>
      ${field(`Fee (now ${G.money(m.periodFee)}; leave empty for the gym's price)`, input('fee', '', NUM), 'span2')}</div>
      <p class="hint">This corrects a mistake in the membership that is running. When a member buys again, use Renew: that keeps this one in the history.</p>`));
  },
  async 'period-edit-save'(form) { await api('PUT', `/api/members/${form.dataset.id}/period`, memberBody(form)); dlg.close(); toast('Membership corrected'); await load(); },
  'payment-delete'(el) {
    sure(`Delete this payment of ${el.dataset.amount}?`, `${el.dataset.name} will owe this amount again. Use this for a payment typed in by mistake. This cannot be undone.`, 'payment-delete-yes', el.dataset.id, 'Delete payment');
  },
  async 'payment-delete-yes'(el) { await api('DELETE', `/api/payments/${el.dataset.id}`); dlg.close(); toast('Payment deleted'); await load(); },
  'period-delete'(el) {
    sure(`Undo ${el.dataset.name}'s last renewal?`, 'The newest membership is removed and the one before it runs again. Use this for a renewal made by mistake. This cannot be undone.', 'period-delete-yes', el.dataset.id, 'Undo renewal');
  },
  async 'period-delete-yes'(el) { await api('DELETE', `/api/members/${el.dataset.id}/period`); dlg.close(); toast('Renewal undone'); await load(); },
  'sample-clear'() {
    sure('Remove the sample members?', 'Every sample member goes, with their memberships and payments. Members you added yourself stay. This cannot be undone.', 'sample-clear-yes', '', 'Remove sample members');
  },
  async 'sample-clear-yes'() { const r = await api('DELETE', '/api/sample'); dlg.close(); toast(`${r.removed} sample members removed`); await load(); },
  async 'member-restore'(el) { const m = await api('POST', `/api/members/${el.dataset.id}/restore`); toast(`${m.name} is back`); await refresh(); F.tab = S.deleted.length ? 'deleted' : ''; route(); },
  'export-members'() {
    const t = today();
    saveTable('members', [['Name', 'Mobile', 'Gender', 'Age', 'Weight (kg)', 'Height', 'Goal', 'Health', 'Batch', 'Joined', 'Months', 'Starts', 'Ends', 'Personal trainer', 'Diet plan', 'Fee', 'Paid', 'Pending', 'Status', 'Notes'],
      ...S.members.map((m) => [m.name, m.phone, m.gender, m.age, m.weight, m.height, m.goal, m.health, m.batch, m.joinedAt, m.months, m.start, m.end, yes(m.pt), yes(m.diet), m.fee, m.paid, G.due(m), STATUS[G.statusOf(m, t)][1], m.notes])]);
  },
  'export-payments'() {
    const phone = Object.fromEntries(S.members.map((m) => [m.id, m.phone]));
    saveTable(`payments${F.month ? `-${F.month}` : ''}`, [['Date', 'Member', 'Mobile', 'Paid by', 'Amount'],
      ...S.payments.filter((p) => !F.month || p.date.startsWith(F.month)).sort((a, b) => (a.date < b.date) - (a.date > b.date)).map((p) => [p.date, p.name, phone[p.memberId] || '', p.mode, p.amount])]);
  },
  'member-delete'(el) {
    openDialog(`<div class="dialog-body"><h2>Delete ${esc(el.dataset.name)}?</h2><p class="muted">The member leaves every list and total, with their payments. For 30 days you can bring them back from Members, under Deleted; after that they are gone for good.</p></div>
      <footer class="dialog-foot"><button class="btn secondary" data-action="dialog-close">Cancel</button>
        <button class="btn danger" data-action="member-delete-yes" data-id="${esc(el.dataset.id)}">Delete</button></footer>`);
  },
  async 'member-delete-yes'(el) {
    await api('DELETE', `/api/members/${el.dataset.id}`);
    dlg.close();
    toast('Member deleted. Bring them back from the Deleted tab within 30 days.');
    await refresh();
    go('#/members');
  },
  async 'pay-full'(el) {
    const m = byId(S.members, el.dataset.id), sum = G.due(m);
    await api('POST', `/api/members/${m.id}/pay`, { amount: sum, mode: el.dataset.mode });
    toast(`${G.money(sum)} received from ${m.name}`);
    await load();
  },
  'pay-part'(el) {
    const m = byId(S.members, el.dataset.id);
    openDialog(dialogForm(`Payment from ${m.name}`, 'pay-save', m.id, `<div class="grid">${field(`Amount (pending ${G.money(G.due(m))})`, input('amount', '', `${NUM} required max="${G.due(m)}"`))}
      ${field('Paid by', `<select name="mode">${opts(MODES, 'Cash')}</select>`)}</div>`, 'Save payment'));
  },
  async 'pay-save'(form) {
    await api('POST', `/api/members/${form.dataset.id}/pay`, fd(form));
    dlg.close();
    toast('Payment saved');
    await load();
  },
  renew(el) {
    const m = byId(S.members, el.dataset.id), t = today(), start = m.end >= t ? G.addDays(m.end, 1) : t;
    openDialog(dialogForm(`Renew ${m.name}`, 'renew-save', m.id, `<div class="grid">
      ${monthsField(m.months)}
      ${field('Starts on', `<input type="date" name="start" value="${esc(start)}">`)}
      <div class="row span2">${check('Personal trainer', `name="pt" ${m.pt ? 'checked' : ''}`)}${check('Diet plan', `name="diet" ${m.diet ? 'checked' : ''}`)}</div>
      ${field('Paid now', input('paid', '', NUM))}${field('Paid by', `<select name="mode">${opts(MODES, 'Cash')}</select>`)}</div>
      ${G.due(m) ? `<p class="hint">${G.money(G.due(m))} is still pending from the last period and is added to the new fee.</p>` : ''}`, 'Renew'));
  },
  async 'renew-save'(form) {
    await api('POST', `/api/members/${form.dataset.id}/renew`, memberBody(form));
    dlg.close();
    toast('Membership renewed');
    await load();
  },
});

// ---- old records: a photo of the register, a PDF, an Excel or CSV file, read by the AI and checked by the owner

// The file as the server wants it. A photo is made smaller first: a phone's picture is far larger than reading needs.
async function fileData(file) {
  if (file.type.startsWith('image/')) {
    const img = await createImageBitmap(file).catch(() => { throw new Error('This photo could not be opened. Take it as a JPG or PNG.'); });
    const k = Math.min(1, 2400 / Math.max(img.width, img.height)), c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return { name: file.name, type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.85).split(',')[1] };
  }
  if (file.size > 8e6) throw new Error('This file is larger than 8 MB. Use a smaller one, or photos of its pages.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { name: file.name, type: file.type, data: btoa(text) };
}
// Why a row would be refused, so the owner mends or removes it before saving.
function rowNote(r, seen) {
  if (!r.name) return 'No name';
  if (!/^[6-9]\d{9}$/.test(r.phone)) return 'No mobile number';
  if (S.members.some((m) => m.phone === r.phone)) return 'Already a member';
  return seen.filter((p) => p === r.phone).length > 1 ? 'Number is here twice' : '';
}
function importRows() {
  const rows = imp.rows, seen = rows.map((r) => r.phone), box = (r, name, attrs) => `<input name="${name}" value="${esc(r[name])}" ${attrs} aria-label="${name}">`;
  return `<section class="card"><div class="card-head"><h2>2. Check every row (${rows.length})</h2><span class="hint">Mend what was misread, remove what is not a member. Fee empty means the gym's price. Pending is what the member still owes.</span></div>
    ${table(['Name', 'Mobile', 'Started on', 'Months', 'Fee', 'Pending', ''], rows.map((r) => { const note = rowNote(r, seen); return `<tr class="import-row">
      <td>${box(r, 'name', 'maxlength="80"')}</td><td>${box(r, 'phone', 'maxlength="15" inputmode="numeric"')}</td><td><input type="date" name="start" value="${esc(r.start)}" aria-label="start"></td>
      <td>${box(r, 'months', `${NUM} min="1" max="36"`)}</td><td>${box(r, 'fee', NUM)}</td><td>${box(r, 'due', NUM)}</td>
      <td class="num">${note ? `<span class="low">${note}</span> ` : ''}<button type="button" class="btn ghost icon" data-action="import-drop" aria-label="Remove this row">${icon('x')}</button>
        <input type="hidden" name="gender" value="${esc(r.gender)}"><input type="hidden" name="age" value="${esc(r.age)}"><input type="hidden" name="batch" value="${esc(r.batch)}"><input type="hidden" name="notes" value="${esc(r.notes)}"></td></tr>`; }))}
    <div class="card-body actions"><button class="btn primary" data-action="import-save">Save these members</button><button class="btn secondary" data-action="import-clear">Throw these rows away</button></div></section>`;
}
views.import = () => page('Import old members', '<a class="btn secondary" href="#/members">Back to members</a>', `
  <section class="card"><div class="card-head"><h2>1. Choose a file</h2><span class="hint">A photo of the register, a PDF, an Excel file (.xlsx) or a CSV file. One file, or one page, at a time.</span></div>
    <div class="card-body"><form class="row" data-action="import-read"><input type="file" name="file" required accept="image/*,.pdf,.xlsx,.xls,.csv,.txt" aria-label="File of old members"><button class="btn primary">Read the file</button></form>
      <p class="hint">For a photo: lay the page flat, in good light, with the whole page in the picture. The AI reads it and can misread handwriting, so look through every row before you save.
        ${S.aiEnabled ? '' : '<strong class="low">No AI key is set, so a file cannot be read.</strong>'}</p></div></section>
  ${imp.done ? `<section class="card"><div class="card-body"><strong>${imp.done.added} members added.</strong>${imp.done.skipped.length ? ` ${imp.done.skipped.length} could not be added and are still below:
      <ul>${imp.done.skipped.map((k) => `<li>${esc(k.name || `Row ${k.row}`)}: ${esc(k.why)}</li>`).join('')}</ul>` : ' <a href="#/members">See the members</a>.'}</div></section>` : ''}
  ${imp.rows && imp.rows.length ? importRows() : ''}`);
// The rows as they stand on the screen, with whatever the owner mended.
const typedRows = () => [...document.querySelectorAll('.import-row')].map((tr) => Object.fromEntries([...tr.querySelectorAll('input')].map((i) => [i.name, i.value.trim()])));

Object.assign(actions, {
  async 'import-read'(form) {
    const file = form.file.files[0], button = form.querySelector('button');
    if (imp.rows) imp.rows = typedRows(); // what the owner mended so far stays, and the next file's rows go below it
    button.textContent = 'Reading… this can take a minute';
    try {
      const r = await api('POST', '/api/import/read', await fileData(file));
      imp = { rows: [...(imp.rows || []), ...r.rows], done: null };
      toast(r.rows.length ? `${r.rows.length} rows read. Check them.` : 'No member was found in this file.', !r.rows.length);
    } finally { route(); }
  },
  'import-drop'(el) { el.closest('tr').remove(); },
  'import-clear'() { imp = { rows: null, done: null }; route(); },
  async 'import-save'() {
    const rows = typedRows();
    if (!rows.length) return toast('There is no row to save.', true);
    const done = await api('POST', '/api/import/save', { rows });
    imp = { rows: done.skipped.map((k) => rows[k.row - 1]), done };
    await refresh();
    return route();
  },
});

// ---- payments: every rupee the gym received, newest first, for one month or for all time

function paymentRows() {
  const rows = S.payments.filter((p) => !F.month || p.date.startsWith(F.month)).sort((a, b) => (a.date < b.date) - (a.date > b.date));
  const total = rows.reduce((s, p) => s + p.amount, 0);
  if (!rows.length) return empty('No payment here', F.month ? 'Nothing was received in this month. Clear the month to see all.' : 'Payments show up here as members pay.');
  return `<div class="card-body"><strong>${money(total)}</strong> received in ${rows.length} payment${rows.length > 1 ? 's' : ''}</div>` + table(['Date', 'Member', 'Paid by', '#Amount', ''], rows.map((p) => `<tr>
    <td>${esc(G.fmtDate(p.date))}</td><td>${byId(S.members, p.memberId) ? `<a href="#/members/${esc(p.memberId)}">${esc(p.name)}</a>` : esc(p.name)}</td><td>${esc(p.mode)}</td><td class="num">${money(p.amount)}</td><td class="num">${payDel(p)}</td></tr>`));
}
views.payments = () => {
  const owe = S.members.filter((m) => G.due(m) > 0), owed = owe.reduce((s, m) => s + G.due(m), 0);
  return page('Payments', `<button class="btn secondary" data-action="export-payments" ${off(!S.payments.length, 'There is no payment to download yet')}>Download Excel</button>`, `
    <div class="card"><div class="filters"><label class="field"><span>Month (empty shows all)</span><input type="month" data-action="pay-month" value="${esc(F.month)}"></label></div>
      <div id="list">${paymentRows()}</div></div>
    <p class="hint">${owe.length ? `${money(owed)} is still pending from ${owe.length} member${owe.length > 1 ? 's' : ''}: <a href="#/members" data-action="tab" data-value="due">see who</a>.` : 'No fees are pending.'}</p>`);
};
actions['pay-month'] = (el) => { F.month = el.value; $('#list').innerHTML = paymentRows(); };

// ---- the assistant: it speaks, listens, and registers a member by asking

let talk = [];      // { who: 'ai' | 'me', text, welcome: memberId }
let reg = null;     // the registration in progress: { form, asked, tries, done, fee }
let thinking = false;
let hearing = null; // the speech recognition that is listening now
// The browser's own speech recognition and voice (Chrome, Edge, Android). Without them the owner types and reads.
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;

function stopVoice() {
  if (hearing) hearing.abort();
  if (window.speechSynthesis) speechSynthesis.cancel();
}
// Says the text aloud in Hindi. Resolves when it has been said, or at once where the browser has no voice.
function speak(text) {
  return new Promise((done) => {
    if (!window.speechSynthesis || !text) return done();
    const u = new SpeechSynthesisUtterance(text.replace(/[*_]/g, ''));
    u.lang = 'hi-IN';
    u.onend = u.onerror = done;
    setTimeout(done, 2500 + text.length * 110); // some browsers never report the end
    speechSynthesis.cancel();
    return speechSynthesis.speak(u);
  });
}
// Listens for one answer. Resolves with what was heard, rejects when nothing was.
function listen() {
  return new Promise((resolve, reject) => {
    const rec = hearing = new Speech();
    let text = '', why = 'no-speech';
    Object.assign(rec, { lang: 'hi-IN', interimResults: true });
    rec.onresult = (e) => { text = [...e.results].map((r) => r[0].transcript).join(' '); const box = $('#boloInput'); if (box) box.value = text; };
    rec.onerror = (e) => { why = e.error; };
    rec.onend = () => { hearing = null; renderTalk(); return text.trim() ? resolve(text.trim()) : reject(new Error(why)); };
    rec.start();
    renderTalk();
  });
}
// After the assistant has spoken it listens for the answer by itself, so a registration needs no button between questions.
async function listenNext() {
  if (!Speech || current !== 'bolo') return;
  try { await heard(await listen()); } catch (e) {
    if (e.message === 'not-allowed') toast('Allow the microphone for this site, then press the mic.', true);
  }
}
async function says(text, more) {
  talk.push({ who: 'ai', text, ...more });
  renderTalk();
  await speak(text);
}

async function regTurn(said) {
  thinking = true;
  renderTalk();
  try {
    const r = await api('POST', '/api/register/turn', { form: reg.form, asked: reg.asked, said, tries: reg.tries });
    if (r.setup) { reg = null; thinking = false; return await says(r.say, { settings: true }); } // the gym has no prices yet
    Object.assign(reg, { form: r.form, asked: r.next, tries: r.tries, done: r.done, fee: r.fee });
    thinking = false;
    await says(r.say);
    if (!r.done) listenNext();
  } finally {
    thinking = false;
    renderTalk();
  }
}
// Opens the talk with a greeting, said aloud, and then listens: for 'naya member jodo' or for a question.
function greet() {
  stopVoice();
  reg = null;
  talk = [];
  return says('नमस्ते! मैं आपका जिम साथी असिस्टेंट हूँ। मैं आपकी क्या मदद कर सकता हूँ? नया मेंबर जोड़ना हो या कुछ पूछना हो, बस बोलिए।', { hello: true }).then(listenNext);
}
const ASKS = ['नया मेंबर जोड़ो', 'किसकी फीस बाकी है?', 'किसकी मेंबरशिप खत्म हो रही है?', 'इस महीने कितना पैसा आया?'];
const askChips = () => ASKS.map((q) => `<button class="chip" data-action="bolo-ask">${q}</button>`).join('');

// ---- the invitation to talk, shown to a gym when it signs in, and otherwise once a day

let helloDue = false; // somebody has just signed in
function hello() {
  if (!S || !S.gym || view || dlg.open || S.exportDue || current === 'bolo') return;
  const key = `gs-hello:${S.user.id}`;
  let seen = '';
  try { seen = localStorage.getItem(key) || ''; } catch { /* a private window keeps nothing: the invitation just shows */ }
  if (!helloDue && seen === today()) return;
  helloDue = false;
  try { localStorage.setItem(key, today()); } catch { /* nothing to keep it in */ }
  openDialog(`<div class="dialog-body hello">
      <div class="hello-mic">${icon('mic')}</div>
      <h2>Try the AI assistant</h2>
      <p class="hello-hi">बोल कर काम कीजिए, टाइप नहीं</p>
      <p class="muted">Add a member, see who owes fees, ask how much came in this month. Just say it, in Hindi or English.</p>
      <div class="hello-asks">${ASKS.map((q) => `<span class="chip">${q}</span>`).join('')}</div>
    </div>
    <footer class="dialog-foot hello-foot"><button class="btn secondary" data-action="dialog-close">Not now</button>
      <button class="btn primary" data-action="hello-go">${icon('mic')}Talk to the assistant</button></footer>`);
}
actions['hello-go'] = () => { dlg.close(); go('#/bolo?hi=1'); };

function startReg() {
  reg = { form: {}, asked: null, tries: 0, done: false, fee: 0 };
  return regTurn('');
}
// What the owner said or typed: an answer to the question in progress, or a question of their own.
async function heard(text) {
  text = text.trim();
  if (!text || thinking) return undefined;
  const box = $('#boloInput');
  if (box) box.value = '';
  talk.push({ who: 'me', text });
  if (reg && !reg.done) return regTurn(text);
  thinking = true;
  renderTalk();
  try {
    // The last few turns go along, so 'kab khatam hogi?' after a question about Meena is understood to be about her.
    const r = await api('POST', '/api/chat', { question: text, history: talk.slice(-7, -1).map((t) => ({ who: t.who, text: t.text })) });
    thinking = false;
    if (r.start === 'register') return startReg();
    return says(r.answer);
  } finally {
    thinking = false;
    renderTalk();
  }
}

// The filled form, shown for one look before it is saved.
function regCard() {
  const f = reg.form, start = today(), owed = Math.max(0, reg.fee - (f.paid || 0)), yes = (v) => (v ? 'Yes' : 'No');
  const row = (label, value) => (value || value === 0 ? `<div class="trow"><span class="muted">${label}</span><span>${esc(value)}</span></div>` : '');
  return `<div class="bill-card"><strong>New member</strong>
    ${row('Name', f.name)}${row('Mobile', f.phone)}${row('Gender', f.gender)}${row('Age', f.age)}${row('Weight', f.weight && `${f.weight} kg`)}${row('Height', f.height)}
    ${row('Goal', f.goal)}${row('Health', f.health)}${row('Batch', f.batch)}${row('Personal trainer', yes(f.pt))}${row('Diet plan', yes(f.diet))}
    ${row('Plan', `${planName(f.months)}, ${G.fmtDate(start)} to ${G.fmtDate(G.endOf(start, f.months))}`)}
    <div class="trow total"><span>Fee</span><span>${money(reg.fee)}</span></div>
    ${row('Paid now', G.money(f.paid || 0))}${owed ? `<div class="trow"><span class="low">Pending</span><span class="low">${money(owed)}</span></div>` : ''}
    <div class="row"><button class="btn primary" data-action="reg-save">Save member</button><button class="btn secondary" data-action="reg-edit">Change</button>
      <button class="btn ghost" data-action="reg-cancel">Cancel</button></div></div>`;
}

function renderTalk() {
  const log = $('#talk');
  if (!log) return;
  log.innerHTML = (talk.length ? talk.map((t) => { const m = t.welcome && byId(S.members, t.welcome); return `<div class="msg ${t.who === 'me' ? 'user' : ''}">${esc(t.text)}
      ${m ? `<div class="msg-meta">${waBtn(m, 'welcome', 'Send welcome on WhatsApp', 'primary')}<a class="btn secondary" href="#/members/${esc(m.id)}">Open member</a></div>` : ''}
      ${t.settings ? '<div class="msg-meta"><a class="btn primary" href="#/settings">Fill in the gym prices</a></div>' : ''}${t.hello && talk.length === 1 ? `<div class="msg-meta">${askChips()}</div>` : ''}</div>`; }).join('')
    : `<p class="muted">Press <strong>New member</strong> and answer the questions aloud, or ask about your gym:</p>
       ${['किसकी फीस बाकी है?', 'किसकी मेंबरशिप खत्म हो रही है?', 'इस महीने कितना पैसा आया?'].map((q) => `<button class="chip" data-action="bolo-ask">${q}</button>`).join('')}`)
    + (reg && reg.done ? regCard() : '') + (thinking ? '<div class="msg typing" aria-label="Thinking"><i></i><i></i><i></i></div>' : '');
  log.scrollTop = log.scrollHeight;
  const mic = $('#boloMic');
  if (mic) { mic.hidden = !Speech; if (hearing) mic.setAttribute('aria-pressed', 'true'); else mic.removeAttribute('aria-pressed'); }
  const state = $('#boloState');
  if (state) state.textContent = hearing ? 'Listening… speak now' : reg && !reg.done ? 'Registering a new member' : '';
}

views.bolo = (id, q) => {
  // Reached from a 'New member by voice' button: the questions start at once.
  if (q.get('hi')) setTimeout(() => { history.replaceState(null, '', '#/bolo'); greet().catch((e) => toast(e.message, true)); });
  else if (q.get('new') && !(reg && !reg.done)) setTimeout(() => { history.replaceState(null, '', '#/bolo'); startReg().catch((e) => toast(e.message, true)); });
  return page('Assistant', `<button class="btn primary" data-action="reg-start">${icon('plus')}New member</button>`, `
    <div class="card talk-card"><div id="talk" class="chat-log" aria-live="polite"></div>
      <div class="card-body hint" id="boloState"></div>
      <form class="chat-form" data-action="bolo-send">
        <button type="button" id="boloMic" class="btn secondary icon mic" data-action="bolo-mic" aria-label="Speak" hidden>${icon('mic')}</button>
        <label class="sr-only" for="boloInput">Your answer or question</label>
        <input id="boloInput" name="said" autocomplete="off" maxlength="500" placeholder="${Speech ? 'Speak, or type here' : 'Type your answer or question'}">
        <button class="btn primary icon" aria-label="Send">${icon('send')}</button>
      </form></div>
    <p class="hint">${Speech ? 'The assistant speaks each question and then listens. Press the mic to answer again, or to stop it listening.' : 'This browser cannot listen. Open GymSaathi in Chrome to speak; here you can type.'}
      ${S.aiEnabled ? '' : ' The AI is switched off, so answer one thing at a time.'}</p>`);
};

Object.assign(actions, {
  'reg-start'() { stopVoice(); talk = []; return startReg(); },
  'reg-cancel'() { stopVoice(); reg = null; talk.push({ who: 'ai', text: 'ठीक है, रद्द कर दिया।' }); renderTalk(); },
  'reg-edit'() { openDialog(dialogForm('New member', 'member-save', '', memberForm({ ...reg.form, fee: reg.fee }, true), 'Save member')); },
  async 'reg-save'() {
    const f = reg.form, m = await api('POST', '/api/members', { ...f, fee: reg.fee, mode: 'Cash' });
    reg = null;
    await refresh();
    await says(`${m.name} जी जुड़ गए।${G.due(m) ? ` ${Math.round(G.due(m))} रुपये बाकी हैं, उनका रिमाइंडर रोज़ डैशबोर्ड पर मिलेगा।` : ''} व्हाट्सऐप पर स्वागत संदेश भेज दीजिए।`, { welcome: m.id });
  },
  'bolo-mic'() {
    if (hearing) return hearing.stop();
    if (window.speechSynthesis) speechSynthesis.cancel();
    return listenNext();
  },
  'bolo-send'(form) { stopVoice(); return heard(form.said.value); },
  'bolo-ask'(el) { return heard(el.textContent); },
});

// ---- a backup on this computer, every seven days

// A site cannot put a file on a computer by itself, nor learn the path a download went to. So: when a backup is due a
// box asks for it and will not go away until it is saved. In Chrome and Edge a folder can be chosen once; after that
// each week's file is written there without asking. What is noted on the server is when, which file, the folder's
// name (or 'Downloads folder') and the device.
let backupBusy = false, backupBox = false;
const me = () => (S.user.admin ? 'owner' : S.user.id);
// The browser's own small store on this computer: it remembers the folder that was chosen.
function kept(mode, run) {
  return new Promise((done, fail) => {
    const open = indexedDB.open('gymsaathi', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kept');
    open.onerror = () => fail(open.error);
    open.onsuccess = () => { const tx = open.result.transaction('kept', mode), asked = run(tx.objectStore('kept')); tx.oncomplete = () => done(asked.result); tx.onerror = () => fail(tx.error); };
  });
}
function keptFolder() { return window.showDirectoryPicker ? kept('readonly', (store) => store.get(`folder:${me()}`)).catch(() => undefined) : Promise.resolve(undefined); }
function deviceName() {
  const ua = navigator.userAgent, browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${browser} on ${(navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || 'this device'}`;
}
// The file itself: a gym's own records, or for the owner of the service every gym's.
async function backupFile() {
  if (S.user.admin) {
    loading(1);
    const res = await fetch('/api/admin/backup').catch(() => null).finally(() => loading(-1));
    if (!res || !res.ok) throw new Error('The backup could not be made. Try again.');
    return { name: `gymsaathi-all-gyms-${today()}.json.gz`, blob: await res.blob() };
  }
  return { name: `${S.gym.name.replace(/[^\w]+/g, '-')}-backup-${today()}.json`, blob: new Blob([JSON.stringify(await api('GET', '/api/backup'), null, 1)], { type: 'application/json' }) };
}
// Saves a backup and notes it. Into the chosen folder when there is one and the browser allows it; else, when `ask`
// is set (somebody pressed a button), as an ordinary download. Says where it went, or '' when nothing could be saved
// without asking.
async function saveBackup(ask) {
  const folder = await keptFolder();
  let into = null;
  if (folder && (await folder.queryPermission({ mode: 'readwrite' }) === 'granted' || (ask && await folder.requestPermission({ mode: 'readwrite' }) === 'granted'))) into = folder;
  if (!into && !ask) return '';
  const { name, blob } = await backupFile();
  let place = 'Downloads folder';
  if (into) {
    const writer = await (await into.getFileHandle(name, { create: true })).createWritable();
    await writer.write(blob);
    await writer.close();
    place = `Folder "${into.name}"`;
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  Object.assign(S, await api('POST', '/api/exports', { file: name, place, device: deviceName() }));
  return place;
}
const lastSaved = () => (S.exports.length ? `Last saved ${when(S.exports[0].at)}, in ${S.exports[0].place}, from ${S.exports[0].device || 'a device'}.` : 'No backup has been saved yet.');
const backupButtons = (folder) => `<button class="btn primary" data-action="export-now">${folder ? `Save in the folder "${esc(folder.name)}"` : 'Download backup'}</button>
  ${window.showDirectoryPicker ? `<button class="btn secondary" data-action="export-folder">${folder ? 'Choose another folder' : 'Choose a folder for backups'}</button>` : ''}`;
// Called whenever a page is drawn. Does nothing unless a backup is due.
async function weeklyBackup() {
  if (!S || !S.exportDue || backupBusy || (backupBox && dlg.open)) return;
  backupBusy = true;
  try {
    const place = await saveBackup(false).catch(() => '');
    if (place) return toast(`This week's backup is saved: ${place}`);
    const folder = await keptFolder();
    backupBox = true;
    return openDialog(`<div class="dialog-body"><h2>Save this week's backup on this computer</h2>
      <p class="muted">Every ${S.exportDays} days a copy of ${S.user.admin ? "every gym's data" : "your gym's members, memberships and payments"} is saved on your own computer, so nothing is lost if the internet or this site ever fails. ${esc(lastSaved())}</p>
      ${window.showDirectoryPicker ? '<p class="hint">Choose a folder once and later backups are saved there by themselves.</p>' : ''}</div>
      <footer class="dialog-foot">${backupButtons(folder)}</footer>`);
  } finally { backupBusy = false; }
}
function backupDone(place) {
  backupBox = false;
  if (dlg.open) dlg.close();
  toast(`Backup saved: ${place}`);
  route();
}
// The box stays until the backup is saved: Esc does not close it, and leaving the page brings it back.
dlg.addEventListener('cancel', (e) => { if (backupBox) e.preventDefault(); });
dlg.addEventListener('close', () => { if (!dlg.open) backupBox = false; }); // a close that the box has already come back from does not count
async function working(el, run) {
  const label = el.innerHTML;
  el.textContent = 'Making the backup… please wait';
  try { return await run(); } finally { el.innerHTML = label; }
}
Object.assign(actions, {
  // Every gym's data takes the server some seconds to gather, so the button says that it is at work.
  async 'export-now'(el) { backupDone(await working(el, () => saveBackup(true))); },
  async 'export-folder'(el) {
    const folder = await window.showDirectoryPicker({ id: 'gymsaathi-backups', mode: 'readwrite' }).catch((e) => { if (e.name === 'AbortError') return null; throw e; });
    if (!folder) return;
    await kept('readwrite', (store) => store.put(folder, `folder:${me()}`));
    backupDone(await working(el, () => saveBackup(true)));
  },
});
// The card on Settings (a gym) and on Accounts (the owner of the service).
const backupCard = () => `<section class="card"><div class="card-head"><h2>Backup on this computer</h2><span class="hint">Asked for every ${S.exportDays} days</span></div>
  <div class="card-body"><p class="muted">${esc(lastSaved())}</p><div class="actions"><button class="btn secondary" data-action="export-now" ${off(S.user.admin ? !(accounts || []).length : !S.members.length, 'There is nothing to back up yet')}>Save a backup now</button>
    ${window.showDirectoryPicker ? '<button class="btn secondary" data-action="export-folder">Choose a folder for backups</button>' : ''}</div></div></section>`;

// ---- settings

// The gym's details and prices: on its Settings page, and in the form the owner of the service fills to add a gym,
// where the owner's name and mobile number are needed (`must`).
const gymDetails = (g, must = '') => `
  ${field('Gym name', input('name', g.name, 'required maxlength="80"'))}${field('Owner\'s name', input('owner', g.owner, `${must} maxlength="80"`))}
  ${field('Owner\'s mobile number', input('phone', g.phone, `${must} type="tel" inputmode="numeric" maxlength="30"`))}${field('UPI ID for fees (optional)', input('upi', g.upi, 'maxlength="80"'))}
  ${field('Address', input('address', g.address, 'maxlength="300"'), 'span2')}
  ${field('Timings', input('timings', g.timings, 'maxlength="150" placeholder="सुबह 5 से 10, शाम 4 से 10"'), 'span2')}
  ${field('Amenities', input('amenities', g.amenities, 'maxlength="400" placeholder="कार्डियो, वेट ट्रेनिंग, स्टीम, लॉकर"'), 'span2')}`;
const gymPrices = (g, must = '') => [['price1', '1 month'], ['price3', '3 months'], ['price6', '6 months'], ['price12', '1 year'], ['ptPrice', 'Personal trainer, per month'], ['dietPrice', 'Diet plan, per month']]
  .map(([name, label]) => field(label, input(name, g[name] || '', name === 'price1' ? `${NUM} ${must}` : NUM))).join('');
const PRICE_HINT = 'Leave 3, 6 or 12 months empty to charge the monthly price times the months.';

views.settings = () => {
  const g = S.gym;
  return page('Settings', '', `
    <form data-action="gym-save">
      <section class="card"><div class="card-head"><h2>Your gym</h2><span class="hint">The assistant and the WhatsApp messages use these.</span></div>
        <div class="card-body grid">${gymDetails(g)}</div></section>
      <section class="card"><div class="card-head"><h2>Prices</h2><span class="hint">${PRICE_HINT}</span></div>
        <div class="card-body grid three">${gymPrices(g)}</div></section>
      <div class="form-foot"><button class="btn primary">Save settings</button></div>
    </form>
    ${view ? '' : backupCard()}
    ${view ? '' : `<section class="card"><div class="card-head"><h2>Account</h2><span class="hint">Signed in as ${esc(S.user.email)}</span></div>
      <div class="card-body actions"><button class="btn secondary" data-action="password-edit">Change password</button></div></section>`}`);
};
const passwordField = (label, name, auto) => field(label, `<input name="${name}" type="password" required minlength="8" maxlength="200" autocomplete="${auto}">`, 'span2');

Object.assign(actions, {
  // The owner of the service, editing a gym from the Accounts page, lands back on that page once it is saved.
  async 'gym-save'(form) { await api('PUT', '/api/gym', fd(form)); toast('Settings saved'); return view ? actions['view-close']() : load(); },
  'password-edit'() {
    openDialog(dialogForm('Change password', 'password-save', '', `<div class="grid">${passwordField('Current password', 'current', 'current-password')}
      ${passwordField('New password (at least 8 characters)', 'password', 'new-password')}</div>`, 'Change password'));
  },
  async 'password-save'(form) { await api('POST', '/api/auth/password', fd(form)); dlg.close(); toast('Password changed. Other devices are signed out.'); },
});

// ---- accounts (the owner of the service only): every gym, its time left and its numbers

async function loadAccounts() { accounts = await api('GET', '/api/admin/gyms'); if (current === 'accounts') route(); }
const daysLeft = (a) => (a.validTill ? Math.ceil((Date.parse(a.validTill) - Date.now()) / 864e5) : 99);
// A WhatsApp message to a gym whose time is ending or over, asking for the month's payment.
const askGym = (a) => { const d = daysLeft(a), kind = a.paidMonths ? 'प्लान' : 'फ्री ट्रायल', on = G.fmtDate(G.todayISO(new Date(a.validTill)));
  return G.waLink(a.phone, `नमस्ते 🙏\n${a.gym} का GymSaathi ${kind} ${on} को ${d > 0 ? 'खत्म हो रहा है' : 'खत्म हो चुका है'}।\nसेवा चालू रखने के लिए ${G.money(S.price)} जमा करवा दें।\nधन्यवाद।`); };
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '');
// Where a gym stands: switched off, never signed in, in its free month, paid up, or out of time.
function planPill(a) {
  if (a.disabled) return '<span class="pill overdue">Switched off</span>';
  if (!a.firstLoginAt) return '<span class="pill partial">Not signed in yet</span>';
  if (new Date(a.validTill) <= new Date()) return `<span class="pill overdue">${a.paidMonths ? 'Plan' : 'Free trial'} over</span>`;
  return `<span class="pill ${a.paidMonths ? 'paid' : 'partial'}">${a.paidMonths ? 'Paid' : 'Free trial'}</span>`;
}
views.accounts = () => {
  if (!S.user.admin) return notFound;
  if (!accounts) {
    loadAccounts().catch((err) => toast(err.message, true));
    return page('Accounts', '', `<div class="card">${empty('Loading gyms', 'One moment.')}</div>`);
  }
  const addGym = `<button class="btn primary" data-action="account-new">${icon('plus')}Add gym</button>`;
  const add = `<button class="btn secondary" data-action="export-now" ${off(!accounts.length, 'There is no gym to back up yet')}>Download backup</button>${addGym}`;
  const gone = accounts.filter((a) => a.deletedAt), shown = accounts.filter((a) => !a.deletedAt);
  if (!accounts.length) return page('Accounts', add, `<div class="card">${empty('No gym yet', 'Add a gym and give it its username and password. Its free month starts when it first signs in.', addGym)}</div>`);
  // All gyms added up. A gym's own Members page only ever shows that one gym.
  const all = (key) => shown.reduce((n, g) => n + g[key], 0), card = (label, value, hint) => `<div class="card kpi"><div class="muted">${label}</div><div class="kpi-value">${value}</div><div class="hint">${hint}</div></div>`;
  return page('Accounts', add, `
    <div class="kpis">${card('Gyms', shown.length, `${shown.filter((g) => g.firstLoginAt && !g.disabled && new Date(g.validTill) > new Date()).length} running now`)}${card('Members in all gyms', all('members').toLocaleString('en-IN'), 'open a gym to see its own')}
      ${card('Fees pending in all gyms', money(all('due')), 'owed to the gyms by their members')}${card('Collected by all gyms', money(all('collected')), 'since each gym began')}</div>
    <div class="card">${bulkBar()}${table([PICK_ALL, 'Gym', '#Members', '#Fees pending', '#Collected', 'First sign-in', 'Runs till', ''], shown.map((a) => `<tr>
      ${pickBox(a.id, a.gym)}<td><strong>${esc(a.gym)}</strong><br><span class="muted">Login: <strong>${esc(a.email)}</strong>${a.owner || a.phone ? `<br>${esc([a.owner, a.phone].filter(Boolean).join(' · '))}` : ''}
        <br>${a.savedAt ? `Own backup: ${esc(when(a.savedAt))}, ${esc(a.savedPlace)}${a.savedDevice ? `, ${esc(a.savedDevice)}` : ''}` : 'Own backup: never'}</span></td>
      <td class="num">${a.members}</td><td class="num ${a.due > 0 ? 'low' : ''}">${money(a.due)}</td><td class="num">${money(a.collected)}</td>
      <td>${esc(when(a.firstLoginAt)) || '<span class="muted">Never</span>'}${a.lastLoginAt && a.lastLoginAt !== a.firstLoginAt ? `<br><span class="muted">last ${esc(when(a.lastLoginAt))}</span>` : ''}</td>
      <td>${planPill(a)}${a.validTill ? `<br><span class="muted">${esc(when(a.validTill))}</span>` : ''}</td>
      <td class="num"><div class="actions">
        <button class="btn primary" data-action="view-open" data-id="${esc(a.id)}">Open</button>
        <button class="btn secondary" data-action="view-open" data-id="${esc(a.id)}" data-to="#/settings">Edit details</button>
        ${daysLeft(a) <= 5 && G.lastTen(a.phone).length === 10 ? `<a class="btn secondary" target="_blank" rel="noopener" href="${esc(askGym(a))}">Ask on WhatsApp</a>` : ''}
        <button class="btn secondary" data-action="account-paid" data-id="${esc(a.id)}" data-name="${esc(a.gym)}" data-months="1">Paid: +1 month</button>
        <button class="btn secondary" data-action="account-paid" data-id="${esc(a.id)}" data-name="${esc(a.gym)}" data-months="12">+1 year</button>
        <button class="btn secondary" data-action="account-password" data-id="${esc(a.id)}" data-name="${esc(a.email)}" data-gym="${esc(a.gym)}">Username, password</button>
        <button class="btn secondary" data-action="account-toggle" data-id="${esc(a.id)}" data-off="${a.disabled ? '' : '1'}">${a.disabled ? 'Switch on' : 'Switch off'}</button>
        <button class="btn secondary" data-action="account-backups" data-id="${esc(a.id)}" data-name="${esc(a.gym)}">Backups</button>
        <button class="btn danger" data-action="account-delete" data-id="${esc(a.id)}" data-name="${esc(a.gym)}" data-members="${a.members}">Delete</button></div></td></tr>`))}</div>
    <p class="hint">A gym's free month starts at its first sign-in. When its time is over it is signed out and told to pay; press <strong>Paid</strong> when it has, and it can sign in again.
      <strong>Open</strong> shows a gym's members, fees and payments as the gym sees them. <strong>Edit details</strong> opens its name, owner, address, amenities and prices.
      Every gym is backed up once a day and the last ${S.backupDays} days are kept: <strong>Backups</strong> puts a gym back to one of them. <strong>Download backup</strong> saves everything in one file; keep a copy outside this site.</p>
    ${view ? '' : backupCard()}
    ${gone.length ? `<section class="card"><div class="card-head"><h2>Deleted gyms</h2><span class="hint">Kept for 30 days, then gone for good.</span></div>
      ${table(['Gym', '#Members', 'Deleted on', ''], gone.map((a) => `<tr><td><strong>${esc(a.gym)}</strong><br><span class="muted">Login: ${esc(a.email)}</span></td><td class="num">${a.members}</td>
        <td>${esc(when(a.deletedAt))}</td><td class="num"><button class="btn secondary" data-action="account-restore" data-id="${esc(a.id)}">Bring back</button></td></tr>`))}</section>` : ''}`);
};
Object.assign(actions, {
  'account-new'() {
    openDialog(dialogForm('Add gym', 'account-save', '', `<h3 class="form-part">The gym and its owner</h3><div class="grid">${gymDetails({}, 'required')}</div>
      <h3 class="form-part">Prices</h3><p class="hint">${PRICE_HINT}</p><div class="grid three">${gymPrices({}, 'required')}</div>
      <h3 class="form-part">Login for the gym</h3><div class="grid">${field('Username', input('email', '', 'required maxlength="100" autocapitalize="none" spellcheck="false" autocomplete="off"'), 'span2')}
      ${passwordField('Password (at least 8 characters)', 'password', 'new-password')}</div>`, 'Create gym'));
  },
  async 'account-save'(form) { await api('POST', '/api/admin/gyms', fd(form)); dlg.close(); toast('Gym created. Give it its username and password.'); await loadAccounts(); },
  'account-paid'(el) {
    const months = Number(el.dataset.months);
    openDialog(`<div class="dialog-body"><h2>${esc(el.dataset.name)} has paid?</h2><p class="muted">It gets ${months === 12 ? '1 year' : '1 month'} more. This is kept in its record.</p></div>
      <footer class="dialog-foot"><button class="btn secondary" data-action="dialog-close">Cancel</button>
        <button class="btn primary" data-action="account-paid-yes" data-id="${esc(el.dataset.id)}" data-months="${months}">Yes, add ${months === 12 ? '1 year' : '1 month'}</button></footer>`);
  },
  async 'account-paid-yes'(el) {
    const r = await api('PUT', `/api/admin/gyms/${el.dataset.id}`, { addMonths: Number(el.dataset.months) });
    dlg.close();
    toast(`Runs till ${when(r.validTill)}`);
    await loadAccounts();
  },
  'account-password'(el) {
    openDialog(dialogForm(`Login of ${el.dataset.gym}`, 'account-password-save', el.dataset.id, `<p class="hint">The gym signs in with this username, or with its gym name when no other gym has the same name, and this password.</p><div class="grid">
      ${field('Username', input('email', el.dataset.name, 'required maxlength="100" autocapitalize="none" spellcheck="false" autocomplete="off"'), 'span2')}
      ${field('New password (leave empty to keep the old one)', '<input name="password" type="password" minlength="8" maxlength="200" autocomplete="new-password">', 'span2')}</div>`, 'Save login'));
  },
  async 'account-password-save'(form) { await api('PUT', `/api/admin/gyms/${form.dataset.id}`, fd(form)); dlg.close(); toast('Login saved. That gym is signed out everywhere.'); await loadAccounts(); },
  'account-delete'(el) {
    sure(`Delete ${el.dataset.name}?`, `The gym, its login, its ${el.dataset.members} members and all their memberships and payments leave at once and it is signed out. For 30 days you can bring it back from Deleted gyms on this page; after that it is gone for good. To only stop it signing in, use Switch off.`, 'account-delete-yes', el.dataset.id, 'Delete gym');
  },
  async 'account-delete-yes'(el) { await api('DELETE', `/api/admin/gyms/${el.dataset.id}`); dlg.close(); toast('Gym deleted. It can be brought back for 30 days.'); await loadAccounts(); },
  async 'account-restore'(el) { await api('POST', `/api/admin/gyms/${el.dataset.id}/restore`); toast('The gym is back'); await loadAccounts(); },
  async 'account-backups'(el) {
    const kept = await api('GET', `/api/admin/gyms/${el.dataset.id}/backups`);
    openDialog(`<header class="dialog-head"><h2>Backups of ${esc(el.dataset.name)}</h2><button type="button" class="btn ghost icon" data-action="dialog-close" aria-label="Close">${icon('x')}</button></header>
      <div class="dialog-body"><p class="muted">Putting a gym back replaces its members, memberships and payments with what it had on that day. What it has now is kept as "before restore", so this can be taken back.</p>
      ${kept.length ? table(['Day', '#Members', ''], kept.map((b) => `<tr><td>${b.date === 'before restore' ? 'Before the last restore' : esc(G.fmtDate(b.date))}<br><span class="muted">${esc(when(b.at))}</span></td><td class="num">${b.members}</td>
        <td class="num"><button class="btn secondary" data-action="account-backup-restore" data-id="${esc(el.dataset.id)}" data-date="${esc(b.date)}">Put back</button></td></tr>`))
      : empty('No backup yet', 'The first one is made within a day of the gym being added.')}</div>`);
  },
  async 'account-backup-restore'(el) {
    const r = await api('POST', `/api/admin/gyms/${el.dataset.id}/backups`, { date: el.dataset.date });
    dlg.close();
    toast(`Put back: ${r.members} members`);
    await loadAccounts();
  },
  async 'account-toggle'(el) { await api('PUT', `/api/admin/gyms/${el.dataset.id}`, { disabled: !!el.dataset.off }); toast(el.dataset.off ? 'Gym switched off' : 'Gym switched on'); await loadAccounts(); },
});

// ---- start

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await refresh();
  } catch (err) {
    if (err.status !== 401 && err.status !== 402) {
      main.innerHTML = `<div class="card">${empty('GymSaathi could not load', esc(err.message), '<button class="btn primary" data-action="retry">Try again</button>')}</div>`;
      return;
    }
  }
  route();
});
