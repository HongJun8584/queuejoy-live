/*
announce: sends a short message to tenant's configured announce bot or global TELEGRAM_BOT_TOKEN.
Request body: { slug, message, level }
*/
const fetch = global.fetch || require('node-fetch');

async function sendTelegram(token, chatId, text) {
  if (!token || !chatId) return { skipped:true, reason: 'missing token/chatId' };
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
  });
  const j = await res.json();
  return j;
}

exports.handler = async function(event) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const slug = body.slug;
    const message = body.message || body.text || '';
    const level = body.level || 'info';

    // prefer tenant-specific token stored in Firebase (if you keep it), otherwise fallback to env
    const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || null;
    const chatId = body.chatId || process.env.CHAT_ID || null;
    if (!token || !chatId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing Telegram bot token (provide TELEGRAM_BOT_TOKEN env or tenant config)' }) };
    }
    const result = await sendTelegram(token, chatId, `Announcement (${level}): ${message}`);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, result }) };
  } catch (err) {
    console.error('announce error', err && err.stack || err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err && err.message || 'internal error' }) };
  }
};
