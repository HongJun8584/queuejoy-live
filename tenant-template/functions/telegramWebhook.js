'use strict';

/*
  tenant-aware telegramWebhook.js (revised)
  - No root-scoped queue/counters reads/writes anymore.
  - Fast token map: /telegramTokens/{token} -> { tenantId, ... } (recommended)
  - Fallback scan: iterate /slugs -> check tenants/{tenantId}/telegramTokens/{token}
  - Resolve chat -> tenant by scanning tenants (or use a global index if you add one).
*/

const fetch = globalThis.fetch || require('node-fetch');
const { URL } = require('url');

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) console.warn('telegramWebhook: BOT_TOKEN not set');

function makeHeaders() { return { 'Content-Type': 'application/json' }; }
function safeJsonParse(s){ try { return JSON.parse(s); } catch (e) { return null; } }
function escapeForMarkdown(s=''){ return String(s).replace(/\\/g,'\\\\').replace(/\*/g,'\\*').replace(/_/g,'\\_').replace(/`/g,'\\`').replace(/\[/g,'\\[').replace(/\]/g,'\\]'); }
function normalizeToken(raw){
  if (!raw) return null;
  let t = String(raw).trim();
  try {
    if (t.includes('?')) {
      const u = new URL(t, 'https://example.invalid');
      if (u.searchParams.has('start')) return u.searchParams.get('start');
    }
  } catch (e) {}
  const idx = t.indexOf('start=');
  if (idx !== -1) return t.slice(idx + 6).split('&')[0];
  return t || null;
}
function tryDecodeBase64Json(token) {
  try {
    const normalized = token.replace(/-/g,'+').replace(/_/g,'/');
    const pad = normalized.length % 4 ? '='.repeat(4 - (normalized.length % 4)) : '';
    const b = Buffer.from(normalized + pad, 'base64').toString('utf8');
    return JSON.parse(b);
  } catch (e) { return null; }
}

/* ---------- firebase-admin init ---------- */
function tryInitAdmin() {
  let admin = null;
  try { admin = require('firebase-admin'); } catch (e) { return { ok: false, reason: 'firebase-admin-not-installed', detail: String(e || '') }; }
  if (admin.apps && admin.apps.length > 0) return { ok: true, admin };

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON || null;
  let sa = null;
  if (raw) {
    try { const maybe = Buffer.from(raw, 'base64').toString('utf8'); sa = JSON.parse(maybe); } catch (e) { try { sa = JSON.parse(raw); } catch (e2) { sa = null; } }
  }
  const dbUrl = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || process.env.FIREBASE_RTDB_URL || undefined;
  try {
    if (sa) admin.initializeApp({ credential: admin.credential.cert(sa), ...(dbUrl ? { databaseURL: dbUrl } : {}) });
    else admin.initializeApp({ ...(dbUrl ? { databaseURL: dbUrl } : {}) });
    return { ok: true, admin };
  } catch (err) { return { ok: false, reason: 'init_failed', detail: err && err.message ? err.message : String(err) }; }
}

/* ---------- Telegram helpers ---------- */
async function sendTelegram(chatId, text, extra = {}) {
  if (!BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text, disable_web_page_preview: true, ...extra };
  if (!body.parse_mode) body.parse_mode = 'Markdown';
  try {
    const res = await fetch(url, { method: 'POST', headers: makeHeaders(), body: JSON.stringify(body) });
    const json = await res.json().catch(()=>null);
    if (!res.ok) return { ok: false, error: json || res.status };
    return { ok: true, data: json };
  } catch (e) { console.error('sendTelegram error', e); return { ok: false, error: String(e) }; }
}
async function answerCallback(callbackQueryId, text = '') {
  if (!BOT_TOKEN) return;
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;
  try { await fetch(url, { method: 'POST', headers: makeHeaders(), body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }) }); } catch (e) {}
}

/* ---------- Token resolution (tenant-aware) ---------- */
async function resolveTokenToTenant(adminDb, token) {
  // Fast path: check global map /telegramTokens/{token}
  try {
    const gSnap = await adminDb.ref(`telegramTokens/${token}`).get().catch(()=>null);
    if (gSnap && gSnap.exists && gSnap.exists()) {
      const val = gSnap.val();
      if (val && (val.tenantId || val.tenant)) return { tenantId: val.tenantId || val.tenant, tokenRecord: val, source: 'global' };
      return { tenantId: null, tokenRecord: val, source: 'global' };
    }
  } catch (e) { console.warn('resolveTokenToTenant: global check failed', e); }

  // Fallback: scan slugs -> tenants/<tenantId>/telegramTokens/{token}
  try {
    const slugsSnap = await adminDb.ref('slugs').get().catch(()=>null);
    if (!slugsSnap || !slugsSnap.exists || !slugsSnap.exists()) return null;
    const slugs = slugsSnap.val();
    for (const slugKey of Object.keys(slugs)) {
      const mapping = slugs[slugKey];
      const tenantId = (typeof mapping === 'string') ? mapping : (mapping && mapping.tenantId ? mapping.tenantId : null);
      if (!tenantId) continue;
      const tokenSnap = await adminDb.ref(`tenants/${tenantId}/telegramTokens/${token}`).get().catch(()=>null);
      if (tokenSnap && tokenSnap.exists && tokenSnap.exists()) return { tenantId, tokenRecord: tokenSnap.val(), source: `tenant:${tenantId}` };
    }
  } catch (e) { console.warn('resolveTokenToTenant: tenant scan failed', e); }

  return null;
}

/* ---------- Chat -> tenant/queue resolution ---------- */
/*
  Attempts to find the tenant and the queue entry linked to a given Telegram chatId.
  Fast path: (optional) if you later maintain a global index like /telegramChatIndex/{chatId} -> tenantId + queueKey,
             check that first. Otherwise, scans slugs -> tenants/{tenantId}/queue orderByChild('chatId').equalTo(chatId).
*/
async function resolveChatToTenantAndEntry(adminDb, chatId) {
  if (!adminDb || !chatId) return null;

  // optional fast-path: global index (uncomment if you maintain this index)
  try {
    const idxSnap = await adminDb.ref(`telegramChatIndex/${chatId}`).get().catch(()=>null);
    if (idxSnap && idxSnap.exists && idxSnap.exists()) {
      const rec = idxSnap.val(); // expect { tenantId, queueKey }
      if (rec && rec.tenantId && rec.queueKey) {
        const qeSnap = await adminDb.ref(`tenants/${rec.tenantId}/queue/${rec.queueKey}`).get().catch(()=>null);
        if (qeSnap && qeSnap.exists && qeSnap.exists()) return { tenantId: rec.tenantId, queueKey: rec.queueKey, entry: qeSnap.val(), source: 'index' };
      }
    }
  } catch (e) { /* ignore */ }

  // fallback: scan all slugs and search tenant queue collections
  try {
    const slugsSnap = await adminDb.ref('slugs').get().catch(()=>null);
    if (!slugsSnap || !slugsSnap.exists || !slugsSnap.exists()) return null;
    const slugs = slugsSnap.val();
    for (const slugKey of Object.keys(slugs)) {
      const mapping = slugs[slugKey];
      const tenantId = (typeof mapping === 'string') ? mapping : (mapping && mapping.tenantId ? mapping.tenantId : null);
      if (!tenantId) continue;
      // query tenants/<tenantId>/queue where chatId == chatId
      try {
        const qSnap = await adminDb.ref(`tenants/${tenantId}/queue`).orderByChild('chatId').equalTo(chatId).get().catch(()=>null);
        if (qSnap && qSnap.exists && qSnap.exists()) {
          const val = qSnap.val();
          const firstKey = Object.keys(val)[0];
          return { tenantId, queueKey: firstKey, entry: val[firstKey], source: `tenantScan:${tenantId}` };
        }
      } catch (e) { /* continue to next tenant */ }
    }
  } catch (e) { console.warn('resolveChatToTenantAndEntry: scan failed', e); }

  return null;
}

/* ---------- Attach chat to queue (tenant-scoped) ---------- */
async function attachChatToQueueAdmin(adminDb, tenantId, tokenRecord, userChatId) {
  if (!tenantId || !userChatId) return { ok:false, reason:'missing' };

  // 1) If tokenRecord.queueKey set, attach directly
  if (tokenRecord && tokenRecord.queueKey) {
    const qKey = String(tokenRecord.queueKey);
    const queueRef = adminDb.ref(`tenants/${tenantId}/queue/${qKey}`);
    await queueRef.update({ chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
    return { ok:true, queueKey: qKey, via: 'token.queueKey' };
  }

  // 2) If tokenRecord.queueId provided, query tenants/<tenantId>/queue by queueId
  try {
    const qSnap = await adminDb.ref(`tenants/${tenantId}/queue`).orderByChild('queueId').equalTo(tokenRecord?.queueId || tokenRecord?.id || null).get().catch(()=>null);
    if (qSnap && qSnap.exists && qSnap.exists()) {
      const val = qSnap.val();
      const firstKey = Object.keys(val)[0];
      await adminDb.ref(`tenants/${tenantId}/queue/${firstKey}`).update({ chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
      return { ok:true, queueKey: firstKey, via: 'tenant.queueId' };
    }
  } catch (e) { /* ignore */ }

  // 3) Try decode payload
  try {
    const parsed = typeof tokenRecord === 'string' ? tryDecodeBase64Json(tokenRecord) : (tokenRecord && tokenRecord.rawPayload ? tryDecodeBase64Json(tokenRecord.rawPayload) : null);
    if (parsed && parsed.queueKey) {
      const qKey = String(parsed.queueKey);
      await adminDb.ref(`tenants/${tenantId}/queue/${qKey}`).update({ chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
      return { ok:true, queueKey: qKey, via: 'decoded.queueKey' };
    }
  } catch (e) {}

  return { ok:false, reason:'no-match' };
}

/* ---------- Main handler ---------- */
exports.handler = async function (event) {
  try {
    if (!event || event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const init = tryInitAdmin();
    const adminOk = init.ok && init.admin;
    const adminDb = adminOk ? init.admin.database() : null;
    const FIREBASE_DB_URL = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || process.env.FIREBASE_RTDB_URL || '';

    // parse inbound Telegram update
    let update = {};
    try { update = JSON.parse(event.body || '{}'); } catch (e) { console.error('invalid json body'); return { statusCode: 400, body: 'Invalid JSON' }; }

    // -> handle callback_query
    if (update.callback_query) {
      const cb = update.callback_query;
      const data = cb.data;
      const from = cb.from;
      const chatId = cb.message?.chat?.id || from?.id;
      await answerCallback(cb.id);
      if (data === 'help') {
        await sendTelegram(chatId, '*Need a Hand?*\n\nCheck your number and counter with /status anytime.');
        return { statusCode: 200, body: 'OK' };
      }
      if (data === 'status') {
        // tenant-aware: resolve chat -> tenant+entry
        if (!adminDb && !FIREBASE_DB_URL) {
          await sendTelegram(chatId, 'Server misconfigured: no Firebase access. Ask support.');
          return { statusCode: 200, body: 'OK' };
        }
        let resolved = null;
        if (adminDb) resolved = await resolveChatToTenantAndEntry(adminDb, chatId);
        else {
          // fallback REST: scanning slugs isn't practical via REST here; return helpful message
          await sendTelegram(chatId, 'Status lookup currently unavailable. Please open your status page.');
          return { statusCode: 200, body: 'OK' };
        }

        if (resolved && resolved.tenantId && resolved.queueKey) {
          const tenantId = resolved.tenantId;
          const ent = resolved.entry;
          const queueId = ent.queueId || ent.number || ent.ticket || 'Unknown';
          const counterNameSnap = await adminDb.ref(`tenants/${tenantId}/counters/${ent.counterId}`).get().catch(()=>null);
          const counterName = (counterNameSnap && counterNameSnap.exists && counterNameSnap.val ? counterNameSnap.val().name : 'Unassigned') || 'Unassigned';
          const reply = `✅ Connected to QueueJoy!\n🧾 Your number: *${escapeForMarkdown(queueId)}*\n🪑 Counter: *${escapeForMarkdown(counterName)}*`;
          await sendTelegram(chatId, reply);
        } else {
          await sendTelegram(chatId, 'No queue linked to this chat. Connect via status page or paste your token here.');
        }
        return { statusCode: 200, body: 'OK' };
      }
      return { statusCode: 200, body: 'OK' };
    }

    // -> handle messages
    const msg = update.message || update.edited_message || null;
    const from = msg?.from || null;
    const userChatId = msg?.chat?.id ?? from?.id ?? null;
    if (!userChatId) { console.log('No chat id in update — ignoring.'); return { statusCode: 200, body: 'No chat id' }; }
    const messageText = (msg?.text || msg?.caption || '').trim();

    // help command
    if (messageText === '/help' || messageText === '/help@QueueJoyBot') {
      await sendTelegram(userChatId, '*Need a Hand?*\n\nCheck your number and counter with /status anytime.', { reply_markup: { inline_keyboard: [[{ text:'📊 Status', callback_data:'status' }]] } });
      return { statusCode: 200, body: 'OK' };
    }

    // status command -> tenant-aware resolution
    if (messageText === '/status' || messageText === '/status@QueueJoyBot') {
      if (!adminDb && !FIREBASE_DB_URL) {
        await sendTelegram(userChatId, 'Server misconfigured: no Firebase access. Ask support.');
        return { statusCode: 200, body: 'OK' };
      }
      let resolved = null;
      if (adminDb) resolved = await resolveChatToTenantAndEntry(adminDb, userChatId);
      else {
        await sendTelegram(userChatId, 'Status lookup currently unavailable. Please open your status page.');
        return { statusCode: 200, body: 'OK' };
      }

      if (resolved && resolved.tenantId && resolved.queueKey) {
        const tenantId = resolved.tenantId;
        const ent = resolved.entry;
        const queueId = ent.queueId || ent.number || ent.ticket || 'Unknown';
        const counterNameSnap = await adminDb.ref(`tenants/${tenantId}/counters/${ent.counterId}`).get().catch(()=>null);
        const counterName = (counterNameSnap && counterNameSnap.exists && counterNameSnap.val ? counterNameSnap.val().name : 'Unassigned') || 'Unassigned';
        const reply = `✅ Connected to QueueJoy!\n🧾 Your number: *${escapeForMarkdown(queueId)}*\n🪑 Counter: *${escapeForMarkdown(counterName)}*`;
        await sendTelegram(userChatId, reply);
      } else {
        await sendTelegram(userChatId, 'No queue linked to this chat. Connect via status page or paste your token here.');
      }
      return { statusCode: 200, body: 'OK' };
    }

    // parse /start <token> or raw token
    let token = null;
    const startMatch = messageText.match(/^\/start(?:@[\w_]+)?(?:\s+(.+))?$/i);
    if (startMatch) {
      token = (startMatch[1] || '').trim() || null;
      if (!token) {
        const text = 'To connect: open the status page from the kiosk and tap *Connect via Telegram*, or paste the token here (example: `/start -OaVK...`).';
        await sendTelegram(userChatId, text);
        return { statusCode: 200, body: 'OK' };
      }
    } else if (messageText && messageText.length < 200) {
      token = messageText;
    }

    if (token) {
      const normalized = normalizeToken(token);
      if (!normalized) {
        await sendTelegram(userChatId, 'Invalid token format. Please paste the token link or the token string.');
        return { statusCode: 200, body: 'OK' };
      }

      // resolve token -> tenant (+ tokenRecord)
      let resolved = null;
      if (adminDb) resolved = await resolveTokenToTenant(adminDb, normalized);
      else {
        if (!FIREBASE_DB_URL) {
          await sendTelegram(userChatId, 'Server misconfigured: no Firebase access. Ask support.');
          return { statusCode: 200, body: 'OK' };
        }
        const tokenPath = `${FIREBASE_DB_URL}/telegramTokens/${encodeURIComponent(normalized)}.json`;
        const tokenRec = await fetch(tokenPath).then(r=>r.json()).catch(()=>null);
        if (tokenRec) resolved = { tenantId: tokenRec.tenantId || tokenRec.tenant || null, tokenRecord: tokenRec, source:'global-rest' };
      }

      if (!resolved || !resolved.tenantId) {
        await sendTelegram(userChatId, 'Could not resolve token to a tenant. Make sure you used the *Connect via Telegram* button on your status page or paste the full token link.');
        return { statusCode: 200, body: 'OK' };
      }

      const tenantId = resolved.tenantId;
      const tokenRecord = resolved.tokenRecord || {};

      if (adminDb) {
        const attach = await attachChatToQueueAdmin(adminDb, tenantId, tokenRecord, userChatId);
        if (attach && attach.ok) {
          // mark token used tenant-scoped
          try { await adminDb.ref(`tenants/${tenantId}/telegramTokens/${normalized}`).update({ used: true, usedAt: new Date().toISOString(), chatId: userChatId, linkedQueueKey: attach.queueKey || null }); } catch (e) { console.warn('mark token used failed', e); }

          // tenant-scoped connected list
          try { await adminDb.ref(`tenants/${tenantId}/telegramConnected/${userChatId}`).set({ connectedAt: new Date().toISOString(), queueKey: attach.queueKey || null }); } catch (e) {}

          // tenant-scoped announcement list (best effort)
          try { await adminDb.ref(`tenants/${tenantId}/announcement/chatIds/${userChatId}`).set(true); } catch (e) {}

          // reply with queue details
          const qSnap = await adminDb.ref(`tenants/${tenantId}/queue/${attach.queueKey}`).get().catch(()=>null);
          const q = qSnap && qSnap.exists && qSnap.val ? qSnap.val() : null;
          const queueId = q?.queueId || q?.number || q?.ticket || 'Unknown';
          const counterNameSnap = await adminDb.ref(`tenants/${tenantId}/counters/${q?.counterId}`).get().catch(()=>null);
          const counterName = (counterNameSnap && counterNameSnap.exists && counterNameSnap.val ? counterNameSnap.val().name : q?.counterId || 'Unassigned') || 'Unassigned';

          const reply = [
            '✅ Connected to QueueJoy!',
            `🧾 Your number: *${escapeForMarkdown(queueId)}*`,
            `🪑 Counter: *${escapeForMarkdown(counterName)}*`,
            '',
            'We will notify you via this Telegram chat when your number is called.'
          ].join('\n');

          // NOTE: use your actual frontend base URL from env if necessary
          const statusUrl = (process.env.SITE_BASE || 'https://queuejoy.netlify.app') + `/status.html?queueId=${encodeURIComponent(attach.queueKey)}`;

          await sendTelegram(userChatId, reply, {
            reply_markup: {
              inline_keyboard: [
                [{ text: '📲 Open Queue Status', url: statusUrl }],
                [{ text: '📄 Help', callback_data: 'help' }]
              ]
            }
          });

          return { statusCode: 200, body: 'OK' };
        } else {
          console.log('attach failed', attach);
          await sendTelegram(userChatId, 'Could not connect with that token. Please open your status page and tap Connect via Telegram or paste the full token link.');
          return { statusCode: 200, body: 'OK' };
        }
      } else {
        await sendTelegram(userChatId, 'Server cannot complete connection right now. Try again later.');
        return { statusCode: 200, body: 'OK' };
      }
    }

    // If no token provided, try to show linked queue (tenant-aware)
    if (adminDb) {
      const resolved = await resolveChatToTenantAndEntry(adminDb, userChatId);
      if (resolved && resolved.tenantId && resolved.queueKey) {
        const ent = resolved.entry;
        const tenantId = resolved.tenantId;
        const queueId = ent.queueId || ent.number || ent.ticket || 'Unknown';
        const counterNameSnap = await adminDb.ref(`tenants/${tenantId}/counters/${ent.counterId}`).get().catch(()=>null);
        const counterName = (counterNameSnap && counterNameSnap.exists && counterNameSnap.val ? counterNameSnap.val().name : 'Unassigned') || 'Unassigned';
        const reply = `ℹ️ Queue status for this Telegram chat:\n🧾 Number: *${escapeForMarkdown(queueId)}*\n🪑 Counter: *${escapeForMarkdown(counterName)}*`;
        await sendTelegram(userChatId, reply);
        return { statusCode: 200, body: 'OK' };
      }
    }

    // default connect instructions
    const connectInstructions = [
      '👋 Hi — I could not find a Queue entry for this Telegram chat.',
      '',
      'To connect: open the QueueJoy status page you were given and tap *Connect via Telegram*. That runs `/start <token>` automatically and connects this chat.',
      '',
      'If you prefer, paste the token here and I will try to connect you.',
    ].join('\n');

    await sendTelegram(userChatId, connectInstructions);
    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('Handler error', err && (err.stack || err));
    return { statusCode: 500, body: 'Internal Server Error' };
  }
};