'use strict';
(() => {
  const token = window.location.pathname.split('/').filter(Boolean).at(-1) || '';
  const $ = (selector) => document.querySelector(selector);
  const panels = ['#lookupPanel', '#registerPanel', '#successPanel'];
  let gym = null;
  let plans = [];
  let extras = { pt: 0, diet: 0 };
  const money = (amount) => `₹${Math.round(Number(amount) || 0).toLocaleString('en-IN')}`;
  const visible = (selector) => { for (const panel of panels) $(panel).hidden = panel !== selector; };
  const notice = (message, good = false) => {
    const el = $('#notice');
    el.textContent = message;
    el.classList.toggle('success', good);
    el.hidden = !message;
  };
  async function request(path = '', body, method = 'GET') {
    const options = { method, headers: {} };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(`/api/public/join/${token}${path}`, options);
    } catch {
      throw new Error('Server se connect nahi ho paya. Internet check karke dobara try karein.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Request complete nahi ho payi. Dobara try karein.');
    return data;
  }
  const setBusy = (button, busy, label) => {
    button.disabled = busy;
    if (busy) { button.dataset.oldLabel = button.textContent; button.textContent = label || 'Please wait…'; }
    else if (button.dataset.oldLabel) { button.textContent = button.dataset.oldLabel; delete button.dataset.oldLabel; }
  };
  const value = (form, key) => String(new FormData(form).get(key) || '').trim();
  const validPhone = (phone) => {
    const digits = phone.replace(/\D/g, '').replace(/^(0|91|0091)(?=\d{10}$)/, '');
    return /^[6-9]\d{9}$/.test(digits) ? digits : '';
  };
  function showSuccess(title, message, fee) {
    visible('#successPanel');
    notice('', true);
    $('#successTitle').textContent = title;
    $('#successMessage').textContent = message;
    const feeLine = $('#feeLine');
    feeLine.hidden = fee == null;
    feeLine.textContent = fee == null ? '' : `Membership fee: ${money(fee)} · Payment not recorded`;
    $('#switchMemberButton').hidden = false;
  }
  function populatePlans() {
    const select = $('#planSelect');
    select.replaceChildren();
    for (const plan of plans) {
      const option = document.createElement('option');
      option.value = String(plan.months);
      option.textContent = `${plan.label} — ${money(plan.fee)}`;
      select.append(option);
    }
    $('#ptWrap').hidden = !extras.pt;
    $('#dietWrap').hidden = !extras.diet;
    $('#ptLabel').textContent = `Personal trainer — ${money(extras.pt)} extra per month`;
    $('#dietLabel').textContent = `Diet plan — ${money(extras.diet)} extra per month`;
    $('#extras').hidden = !extras.pt && !extras.diet;
  }

  $('#lookupForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    notice('');
    const form = event.currentTarget;
    const name = value(form, 'name');
    const phone = validPhone(value(form, 'phone'));
    if (!name) return notice('Apna registered full name enter karein.');
    if (!phone) return notice('Valid 10-digit Indian mobile number enter karein.');
    const button = $('#lookupButton');
    setBusy(button, true);
    try {
      const result = await request('/lookup', { name, phone }, 'POST');
      if (result.status === 'present' || result.status === 'already') {
        showSuccess(result.status === 'present' ? 'Attendance marked' : 'Already checked in', `${result.memberName ? `Hi ${result.memberName}. ` : ''}${result.message || 'Attendance status confirmed for today.'}`, null);
        return;
      }
      if (result.status === 'inactive') {
        showSuccess('Membership not active', `${result.memberName ? `Hi ${result.memberName}. ` : ''}${result.message}`, null);
        return;
      }
      if (result.status === 'mismatch') return notice(result.message || 'Details did not match. Please check your name and mobile number.');
      if (result.status === 'new') {
        if (!gym.canRegister || !plans.length) return notice('New registration abhi available nahi hai. Gym desk se baat karein.');
        const reg = $('#registerForm');
        reg.elements.name.value = name;
        reg.elements.phone.value = phone;
        reg.elements.gender.value = '';
        reg.elements.age.value = '';
        reg.elements.batch.value = '';
        reg.elements.goal.value = '';
        reg.elements.pt.checked = false;
        reg.elements.diet.checked = false;
        populatePlans();
        visible('#registerPanel');
        notice('Is mobile number se member nahi mila. Neeche apni registration complete karein.', true);
      }
    } catch (error) {
      notice(error.message);
    } finally {
      setBusy(button, false);
    }
  });

  $('#registerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    notice('');
    const form = event.currentTarget;
    const name = value(form, 'name');
    const phone = validPhone(value(form, 'phone'));
    const months = Number(value(form, 'months'));
    const ageText = value(form, 'age');
    const age = ageText ? Number(ageText) : '';
    if (!name) return notice('Full name zaroori hai.');
    if (!phone) return notice('Valid 10-digit mobile number enter karein.');
    if (!plans.some((plan) => plan.months === months)) return notice('Membership plan select karein.');
    if (age !== '' && (!Number.isInteger(age) || age < 5 || age > 100)) return notice('Age 5 se 100 ke beech enter karein.');
    if (!form.elements.accept.checked) return notice('Aage badhne ke liye details confirm karein.');
    const button = $('#registerButton');
    setBusy(button, true, 'Saving registration…');
    try {
      const result = await request('/register', {
        name, phone, months, gender: value(form, 'gender'), age,
        batch: value(form, 'batch'), goal: value(form, 'goal'),
        pt: !!form.elements.pt?.checked, diet: !!form.elements.diet?.checked,
        accept: true,
      }, 'POST');
      showSuccess('Registration saved', result.message || 'Please visit the front desk to confirm your membership.', result.fee);
    } catch (error) {
      notice(error.message);
    } finally {
      setBusy(button, false);
    }
  });

  $('#backButton').addEventListener('click', () => {
    visible('#lookupPanel');
    notice('');
  });

  $('#switchMemberButton').addEventListener('click', async () => {
    const button = $('#switchMemberButton');
    setBusy(button, true, 'Switching…');
    try {
      await request('/logout', {}, 'POST');
      visible('#lookupPanel');
      notice('Enter your own registered details. On this device, future scans will recognize the verified member.', true);
    } catch (error) {
      notice(error.message);
    } finally {
      setBusy(button, false);
      button.hidden = true;
    }
  });

  async function start() {
    if (!/^[a-f0-9]{48}$/.test(token)) throw new Error('This QR link is not valid. Please ask gym staff for the correct code.');
    const result = await request();
    gym = result.gym;
    plans = Array.isArray(result.plans) ? result.plans : [];
    extras = result.extras || extras;
    $('#gymName').textContent = gym.name || 'Gym member check-in';
    const details = [gym.timings, gym.amenities].filter(Boolean).join(' · ');
    $('#gymDetails').textContent = details || 'Member check-in and registration';
    if (result.status === 'present' || result.status === 'already') {
      showSuccess(result.status === 'present' ? 'Attendance marked' : 'Already checked in', `${result.memberName ? `Hi ${result.memberName}. ` : ''}${result.message}`, null);
      return;
    }
    if (result.status === 'inactive') {
      showSuccess('Membership not active', `${result.memberName ? `Hi ${result.memberName}. ` : ''}${result.message}`, null);
      return;
    }
    $('#lookupPanel').hidden = false;
    $('#switchMemberButton').hidden = true;
    if (!result.canRegister) notice('Existing members can check in. New registrations ke liye gym desk se baat karein.');
  }
  start().catch((error) => {
    panels.forEach((selector) => $(selector).hidden = true);
    $('#gymName').textContent = 'QR link unavailable';
    $('#gymDetails').textContent = '';
    notice(error.message);
  });
})();
