/*
notifyCounter: used by back-office to notify counter or customers.
Expects: { slug, counterId, message, calledFull }
*/
const fetch = global.fetch || require('node-fetch');

exports.handler = async function(event) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const slug = body.slug;
    if (!slug) return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing slug' }) };

    const counterId = body.counterId || 'main';
    const message = body.message || 'notification';
    const calledFull = (typeof body.calledFull !== 'undefined') ? Boolean(body.calledFull) : false;

    // Optionally send via Telegram if configured
    const token = process.env.TELEGRAM_BOT_TOKEN || null;
    const chatId = process.env.CHAT_ID || null;
    let telegramResult = { skipped: true };
    if (token && chatId) {
      try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: `Counter ${counterId}: ${message}` })
        });
        telegramResult = await res.json();
      } catch (e) {
        telegramResult = { error: String(e) };
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, slug, counterId, message, calledFull, telegram: telegramResult }) };
  } catch (err) {
    console.error('notifyCounter error', err && (err.stack || err.message));
    return { statusCode: 500, headers, body: JSON.stringify({ error: err && err.message || 'internal' }) };
  }
};
