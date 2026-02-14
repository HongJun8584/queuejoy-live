/*
Accepts Telegram update JSON. Ensure function always returns a JSON body.
*/
exports.handler = async function(event) {
  const headers = { 'Content-Type': 'application/json' };
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    // Here you would handle commands, messages etc.
    // For now: log and return ok to Telegram.
    console.log('telegramWebhook got', JSON.stringify(body).slice(0,1000));
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('telegramWebhook error', err && err.stack || err);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: err && err.message }) }; // return 200 so Telegram doesn't retry aggressively
  }
};
