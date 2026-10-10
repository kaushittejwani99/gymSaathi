// Sends a WhatsApp message by itself, through Meta's own WhatsApp Cloud API. Without WHATSAPP_TOKEN and
// WHATSAPP_PHONE_ID nothing is sent from here and the reminders stay a tap on the dashboard.
// A business may only start a chat with a template that Meta has approved, so a message is a template's name and
// the values for its blanks. The templates are in core.js; README.md says how to register them.
'use strict';

const enabled = () => !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);

// `phone` is the 10 digits of an Indian mobile number.
async function send(phone, template, params) {
  const res = await fetch(`https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || 'v22.0'}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: `91${phone}`, type: 'template',
      template: { name: template, language: { code: 'hi' }, components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || `WhatsApp answered ${res.status}`);
}

module.exports = { enabled, send };
