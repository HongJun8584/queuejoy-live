// tenant-template/functions/telegramWebhook.js
// Tenant-aware adaptation of your working webhook.
// Minimal changes: scope RTDB calls to tenants/{slug}/... when tenant slug present,
// otherwise fall back to existing global paths. Keep original behaviour intact.

const fetch = globalThis.fetch || require('node-fetch');

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || '').replace(/\/$/, '');

    if (!BOT_TOKEN) {
      console.error('Missing BOT_TOKEN env var');
      return { statusCode: 500, body: 'Server misconfigured' };
    }

    // ---- Helpers ----
    const fetchJson = async (url, opts = {}) => {
      try {
        const res = await fetch(url, opts);
        const txt = await res.text().catch(() => null);
        if (!res.ok) {
          console.warn('fetchJson non-ok', res.status, url, txt);
          return null;
        }
        try { return JSON.parse(txt); } catch (e) { return txt; }
      } catch (e) {
        console.error('fetchJson error', e, url);
        return null;
      }
    };

    const patchJson = async (url, body) => {
      try {
        const res = await fetch(url, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!res.ok) { console.warn('patchJson failed', res.status, url); return null; }
        return await res.json();
      } catch (e) { console.error('patchJson error', e, url); return null; }
    };

    const putJson = async (url, body) => {
      try {
        const res = await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!res.ok) { console.warn('putJson failed', res.status, url); return null; }
        return await res.json();
      } catch (e) { console.error('putJson error', e, url); return null; }
    };

    const sendTelegram = async (chatId, text, extra = {}) => {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
      try {
        const body = {
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
          ...extra
        };
        if (!body.parse_mode) body.parse_mode = 'Markdown';
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          console.warn('Telegram sendMessage failed', data);
          return { ok: false, error: data };
        }
        return { ok: true, data };
      } catch (e) {
        console.error('sendTelegram err', e);
        return { ok: false, error: e.message };
      }
    };

    const answerCallback = async (callbackQueryId, text = '') => {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false })
        });
      } catch (e) { /* ignore */ }
    };

    // basic Markdown escape (for Markdown, not MarkdownV2)
    const escapeForMarkdown = (s = '') => {
      return String(s)
        .replace(/\\/g, '\\\\')
        .replace(/\*/g, '\\*')
        .replace(/_/g, '\\_')
        .replace(/`/g, '\\`')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]');
    };

    // ---- Token helpers ----
    const normalizeToken = (raw) => {
      if (!raw) return null;
      let t = String(raw).trim();
      try {
        if (t.includes('?')) {
          const u = new URL(t, 'https://example.invalid');
          if (u.searchParams.has('start')) return u.searchParams.get('start');
        }
      } catch (e) {}
      const startIdx = t.indexOf('start=');
      if (startIdx !== -1) return t.slice(startIdx + 6).split('&')[0];
      return t || null;
    };

    const tryDecodeBase64Json = (token) => {
      try {
        const normalized = token.replace(/-/g, '+').replace(/_/g, '/');
        const pad = normalized.length % 4 ? '='.repeat(4 - (normalized.length % 4)) : '';
        const b = Buffer.from(normalized + pad, 'base64').toString('utf8');
        return JSON.parse(b);
      } catch (e) {
        return null;
      }
    };

    // ---- Tenant helpers ----
    // Determine tenant slug from header / query / or token content
    const pickTenantFromEventOrToken = (eventObj, tokenCandidate) => {
      // header
      if (eventObj.headers) {
        const low = {};
        for (const k of Object.keys(eventObj.headers || {})) low[k.toLowerCase()] = eventObj.headers[k];
        if (low['x-tenant']) return String(low['x-tenant']).trim();
      }
      // query param
      if (eventObj.queryStringParameters && eventObj.queryStringParameters.slug) return String(eventObj.queryStringParameters.slug).trim();
      // token encoded JSON may contain tenant/slug
      if (tokenCandidate) {
        try {
          // token in 'slug:token' format?
          if (/^[a-z0-9\-]+:/.test(tokenCandidate)) {
            const parts = tokenCandidate.split(':');
            if (parts[0]) return parts[0].trim();
          }
          const parsed = tryDecodeBase64Json(tokenCandidate);
          if (parsed && typeof parsed === 'object') {
            if (parsed.tenant) return String(parsed.tenant).trim();
            if (parsed.slug) return String(parsed.slug).trim();
          }
        } catch (e) {}
      }
      return '';
    };

    const tenantPrefixPath = (slug) => {
      if (!slug) return '';
      return `tenants/${String(slug).toString().trim()}`;
    };

    const dbJsonUrlFor = (relative, tenantSlug) => {
      // relative expected like 'queue.json' or 'queue/<key>.json' or with query params 'queue.json?orderBy="chatId"&equalTo=...'
      const prefix = tenantSlug ? `${tenantPrefixPath(tenantSlug)}/` : '';
      // ensure single slashes
      const base = FIREBASE_DB_URL.replace(/\/$/, '');
      return `${base}/${prefix}${relative}`.replace(/([^:]\/)\/+/g, '$1'); // collapse double slashes (but keep https://)
    };

    // ---- Firebase helpers (tenant-aware) ----
    // Safe RTDB query for chatId, try tenant scope first, then fallback to global
    const findQueueByChatId = async (chatId, tenantSlug = '') => {
      if (!FIREBASE_DB_URL) return null;
      try {
        // tenant-scoped query
        if (tenantSlug) {
          const qUrl = dbJsonUrlFor(`queue.json?orderBy="chatId"&equalTo=${encodeURIComponent(JSON.stringify(chatId))}`, tenantSlug);
          const q = await fetchJson(qUrl);
          if (q && Object.keys(q).length) {
            const key = Object.keys(q)[0];
            return { key, entry: q[key], tenant: tenantSlug };
          }
        }
        // global query fallback
        const qUrlGlobal = `${FIREBASE_DB_URL}/queue.json?orderBy="chatId"&equalTo=${encodeURIComponent(JSON.stringify(chatId))}`;
        const qg = await fetchJson(qUrlGlobal);
        if (qg && Object.keys(qg).length) {
          const key = Object.keys(qg)[0];
          return { key, entry: qg[key], tenant: '' };
        }
        // fallback: fetch all and scan (tenant first)
        if (tenantSlug) {
          const allT = await fetchJson(dbJsonUrlFor('queue.json', tenantSlug));
          if (allT) {
            for (const k of Object.keys(allT)) {
              const e = allT[k];
              if (!e) continue;
              if (e.chatId === chatId || String(e.chatId) === String(chatId)) {
                return { key: k, entry: e, tenant: tenantSlug };
              }
            }
          }
        }
        const allG = await fetchJson(`${FIREBASE_DB_URL}/queue.json`);
        if (allG) {
          for (const k of Object.keys(allG)) {
            const e = allG[k];
            if (!e) continue;
            if (e.chatId === chatId || String(e.chatId) === String(chatId)) {
              return { key: k, entry: e, tenant: '' };
            }
          }
        }
        return null;
      } catch (e) {
        console.error('findQueueByChatId', e);
        return null;
      }
    };

    const resolveCounterName = async (counterId, tenantSlug = '') => {
      if (!counterId || !FIREBASE_DB_URL) return 'Unassigned';
      try {
        // tenant first
        if (tenantSlug) {
          const c = await fetchJson(dbJsonUrlFor(`counters/${encodeURIComponent(counterId)}.json`, tenantSlug));
          if (c && c.name) return c.name;
        }
        const cG = await fetchJson(`${FIREBASE_DB_URL}/counters/${encodeURIComponent(counterId)}.json`);
        return cG?.name || counterId || 'Unassigned';
      } catch (e) {
        return counterId || 'Unassigned';
      }
    };

    // Attach chat to queue using heuristics, tenant-aware: try tenant-scoped token lookup first
    const attachChatToQueue = async (candidateToken, userChatId, tenantHint = '') => {
      if (!FIREBASE_DB_URL || !candidateToken) return { ok: false, reason: 'no-firebase-or-empty-token' };
      const normalized = normalizeToken(candidateToken);
      if (!normalized) return { ok: false, reason: 'empty-token' };

      // try tenantHint first (if present)
      const tryTokenRecord = async (slug) => {
        const tokenPath = dbJsonUrlFor(`telegramTokens/${encodeURIComponent(normalized)}.json`, slug);
        const rec = await fetchJson(tokenPath);
        return rec;
      };

      try {
        // attempt tenant-scoped token record if tenantHint provided
        if (tenantHint) {
          try {
            const recT = await tryTokenRecord(tenantHint);
            if (recT) {
              if (recT.expiresAt && Date.now() > Date.parse(recT.expiresAt)) {
                return { ok: false, reason: 'token-expired' };
              }
              if (recT.queueKey) {
                const qKey = String(recT.queueKey);
                const patchUrl = dbJsonUrlFor(`queue/${encodeURIComponent(qKey)}.json`, tenantHint);
                const patched = await patchJson(patchUrl, { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
                if (patched) {
                  // mark token used (best-effort)
                  try { await patchJson(dbJsonUrlFor(`telegramTokens/${encodeURIComponent(normalized)}.json`, tenantHint), { used: true, usedAt: new Date().toISOString(), chatId: userChatId, linkedQueueKey: qKey }); } catch (e) {}
                  return { ok: true, queueKey: qKey, via: 'telegramTokens', tenant: tenantHint };
                }
                return { ok: false, reason: 'patch-failed' };
              }
            }
          } catch (e) { /* ignore, fallback later */ }
        }

        // global token check (original behavior)
        try {
          const recG = await fetchJson(`${FIREBASE_DB_URL}/telegramTokens/${encodeURIComponent(normalized)}.json`);
          if (recG) {
            if (recG.expiresAt && Date.now() > Date.parse(recG.expiresAt)) {
              return { ok: false, reason: 'token-expired' };
            }
            if (recG.queueKey) {
              const qKey = String(recG.queueKey);
              const patched = await patchJson(`${FIREBASE_DB_URL}/queue/${encodeURIComponent(qKey)}.json`, { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
              if (patched) {
                try { await patchJson(`${FIREBASE_DB_URL}/telegramTokens/${encodeURIComponent(normalized)}.json`, { used: true, usedAt: new Date().toISOString(), chatId: userChatId, linkedQueueKey: qKey }); } catch (e) {}
                return { ok: true, queueKey: qKey, via: 'telegramTokens', tenant: '' };
              }
              return { ok: false, reason: 'patch-failed' };
            }
          }
        } catch (e) { /* ignore and continue heuristics */ }

      } catch (e) {
        console.warn('checkTelegramTokenRecord error', e);
      }

      // token looks like -queueKey (direct queue key style), attempt tenant-scoped patch first if tenantHint present
      if (/^-[A-Za-z0-9_]+$/.test(normalized)) {
        // try tenant-scoped patch
        if (tenantHint) {
          const urlT = dbJsonUrlFor(`queue/${encodeURIComponent(normalized)}.json`, tenantHint);
          const patch = await patchJson(urlT, { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
          if (patch) return { ok: true, queueKey: normalized, tenant: tenantHint };
        }
        // fallback to global
        const urlG = `${FIREBASE_DB_URL}/queue/${encodeURIComponent(normalized)}.json`;
        const patchG = await patchJson(urlG, { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
        return patchG ? { ok: true, queueKey: normalized, tenant: '' } : { ok: false, reason: 'patch-failed' };
      }

      // decode base64 JSON and look for queueKey/queueId/id/ticket/number. If found, prefer tenant-scoped target if available.
      const parsed = tryDecodeBase64Json(normalized);
      if (parsed && typeof parsed === 'object') {
        const keys = ['queueKey', 'queueId', 'id', 'ticket', 'number'];
        for (const k of keys) {
          if (parsed[k]) {
            const val = String(parsed[k]);
            // try tenant-scoped patch by queue key first
            if (k === 'queueKey' && /^-/.test(val)) {
              if (tenantHint) {
                const patch = await patchJson(dbJsonUrlFor(`queue/${encodeURIComponent(val)}.json`, tenantHint), { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
                if (patch) return { ok: true, queueKey: val, tenant: tenantHint };
              }
              const patchG = await patchJson(`${FIREBASE_DB_URL}/queue/${encodeURIComponent(val)}.json`, { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
              return patchG ? { ok: true, queueKey: val, tenant: '' } : { ok: false, reason: 'patch-failed' };
            } else {
              // search by queueId (tenant first)
              if (tenantHint) {
                const urlT = dbJsonUrlFor(`queue.json?orderBy="queueId"&equalTo=${encodeURIComponent(JSON.stringify(val))}`, tenantHint);
                const resT = await fetchJson(urlT);
                if (resT && Object.keys(resT).length) {
                  const firstKey = Object.keys(resT)[0];
                  const patch = await patchJson(dbJsonUrlFor(`queue/${encodeURIComponent(firstKey)}.json`, tenantHint), { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
                  return patch ? { ok: true, queueKey: firstKey, tenant: tenantHint } : { ok: false, reason: 'patch-failed' };
                }
              }
              // fallback global
              const urlG = `${FIREBASE_DB_URL}/queue.json?orderBy="queueId"&equalTo=${encodeURIComponent(JSON.stringify(val))}`;
              const resG = await fetchJson(urlG);
              if (resG && Object.keys(resG).length) {
                const firstKey = Object.keys(resG)[0];
                const patch = await patchJson(`${FIREBASE_DB_URL}/queue/${encodeURIComponent(firstKey)}.json`, { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
                return patch ? { ok: true, queueKey: firstKey, tenant: '' } : { ok: false, reason: 'patch-failed' };
              }
            }
            break;
          }
        }
      }

      // try matching by plain queueId pattern (tenant first, then global)
      if (/^[A-Za-z0-9\-_]{2,30}$/.test(normalized)) {
        const val = String(normalized);
        if (tenantHint) {
          const urlT = dbJsonUrlFor(`queue.json?orderBy="queueId"&equalTo=${encodeURIComponent(JSON.stringify(val))}`, tenantHint);
          const resT = await fetchJson(urlT);
          if (resT && Object.keys(resT).length) {
            const firstKey = Object.keys(resT)[0];
            const patch = await patchJson(dbJsonUrlFor(`queue/${encodeURIComponent(firstKey)}.json`, tenantHint), { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
            return patch ? { ok: true, queueKey: firstKey, tenant: tenantHint } : { ok: false, reason: 'patch-failed' };
          }
        }
        const urlG = `${FIREBASE_DB_URL}/queue.json?orderBy="queueId"&equalTo=${encodeURIComponent(JSON.stringify(val))}`;
        const resG = await fetchJson(urlG);
        if (resG && Object.keys(resG).length) {
          const firstKey = Object.keys(resG)[0];
          const patch = await patchJson(`${FIREBASE_DB_URL}/queue/${encodeURIComponent(firstKey)}.json`, { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
          return patch ? { ok: true, queueKey: firstKey, tenant: '' } : { ok: false, reason: 'patch-failed' };
        }
      }

      return { ok: false, reason: 'no-match' };
    };

    // ---- Parse incoming update ----
    let update = {};
    try { update = JSON.parse(event.body || '{}'); } catch (e) { console.error('invalid json body'); return { statusCode: 400, body: 'Invalid JSON' }; }

    // handle callback_query
    if (update.callback_query) {
      const cb = update.callback_query;
      const data = cb.data;
      const from = cb.from;
      const chatId = cb.message?.chat?.id || from?.id;
      await answerCallback(cb.id);

      // pick tenant hint from header / callback data if token-like present
      // (we will derive tenant again when needed)
      if (data === 'help') {
        const helpText = [
          '*Need a Hand?*',
          '',
          'Check your number and counter with /status anytime.',
          '',
          'Telegram will notify you when it\'s your number — no need to keep the browser and telegram open.',
          '',
          'Relax and do your thing — we\'ll handle the queue.'
        ].join('\n');
        await sendTelegram(chatId, helpText);
        return { statusCode: 200, body: 'OK' };
      }

      if (data === 'status') {
        // try tenant-aware lookup using x-tenant header if set; otherwise global fallback
        const tenantHint = pickTenantFromEventOrToken(event, null) || '';
        const found = await findQueueByChatId(chatId, tenantHint);
        if (found) {
          const q = found.entry;
          const queueId = q.queueId || q.number || q.ticket || 'Unknown';
          const counterName = await resolveCounterName(q.counterId, found.tenant || tenantHint);
          const reply = [
            '✅ Connected to QueueJoy!',
            `🧾 Your number: *${escapeForMarkdown(queueId)}*`,
            `🪑 Counter: *${escapeForMarkdown(counterName)}*`,
            '',
            'We will notify you via this Telegram chat when your number is called. You can close this chat or app — notifications will arrive automatically.'
          ].join('\n');
          await sendTelegram(chatId, reply);
        } else {
          await sendTelegram(chatId, 'No queue linked to this chat. Connect via the status page or paste your token here.');
        }
        return { statusCode: 200, body: 'OK' };
      }

      return { statusCode: 200, body: 'OK' };
    }

    // message handling
    const msg = update.message || update.edited_message || null;
    const from = msg?.from || null;
    const userChatId = msg?.chat?.id ?? from?.id ?? null;

    if (!userChatId) {
      console.log('No chat id in update — ignoring.');
      return { statusCode: 200, body: 'No chat id' };
    }

    const messageText = (msg?.text || msg?.caption || '').trim();

    // /help
    if (messageText === '/help' || messageText === '/help@QueueJoyBot') {
      const helpText = [
        '*Need a Hand?*',
        '',
        'Check your number and counter with /status anytime.',
        '',
        'Telegram will notify you when it\'s your number — no need to keep the browser and telegram open.',
        '',
        'Relax and do your thing — we\'ll handle the queue.'
      ].join('\n');
      await sendTelegram(userChatId, helpText, {
        reply_markup: {
          inline_keyboard: [
            [ { text: '📊 Status', callback_data: 'status' }, { text: '📲 Open Status Page', url: `${process.env.SITE_BASE || 'https://queuejoy.netlify.app'}/status.html` } ]
          ]
        }
      });
      return { statusCode: 200, body: 'OK' };
    }

    // /status
    if (messageText === '/status' || messageText === '/status@QueueJoyBot') {
      const tenantHint = pickTenantFromEventOrToken(event, null) || '';
      const found = await findQueueByChatId(userChatId, tenantHint);
      if (found) {
        const q = found.entry;
        const queueId = q.queueId || q.number || q.ticket || 'Unknown';
        const counterName = await resolveCounterName(q.counterId, found.tenant || tenantHint);
        const reply = [
          '✅ Connected to QueueJoy!',
          `🧾 Your number: *${escapeForMarkdown(queueId)}*`,
          `🪑 Counter: *${escapeForMarkdown(counterName)}*`,
          '',
          'We will notify you via this Telegram chat when your number is called. You can close this chat or app — notifications will arrive automatically.'
        ].join('\n');
        await sendTelegram(userChatId, reply, {
          reply_markup: {
            inline_keyboard: [ [ { text: '📄 Help', callback_data: 'help' } ] ]
          }
        });
      } else {
        await sendTelegram(userChatId, 'No queue linked to this chat. Connect via the status page or paste your token here.');
      }
      return { statusCode: 200, body: 'OK' };
    }

    // parse /start <token> or token text
    let token = null;
    const startMatch = messageText.match(/^\/start(?:@[\w_]+)?(?:\s+(.+))?$/i);
    if (startMatch) {
      token = (startMatch[1] || '').trim() || null;
      // if just /start with no token, show helpful message
      if (!token) {
        const text = 'To connect your Telegram chat to your queue, open the status page from the kiosk and tap *Connect via Telegram*, or paste the token here (example: `/start -OaVK...`).';
        await sendTelegram(userChatId, text);
        return { statusCode: 200, body: 'OK' };
      }
    } else if (messageText && messageText.length < 200) {
      // maybe user pasted the token directly
      token = messageText;
    }

    if (token) {
      // attempt to detect tenant from header/query or token itself
      const tenantHint = pickTenantFromEventOrToken(event, token) || '';
      const attachResult = await attachChatToQueue(token, userChatId, tenantHint);
      if (attachResult && attachResult.ok) {
        // add to announcement list (idempotent) under tenant or global
        try {
          if (FIREBASE_DB_URL) {
            if (attachResult.tenant) {
              await putJson(dbJsonUrlFor(`announcement/chatIds/${encodeURIComponent(userChatId)}.json`, attachResult.tenant), true);
            } else {
              await putJson(`${FIREBASE_DB_URL}/announcement/chatIds/${encodeURIComponent(userChatId)}.json`, true);
            }
            console.log('Added chatId to announcements:', userChatId, 'tenant:', attachResult.tenant || '(global)');
          }
        } catch (e) { console.warn('announce put failed', e); }

        // fetch queue entry (tenant-scoped if attachResult.tenant)
        const q = await fetchJson(attachResult.tenant ? dbJsonUrlFor(`queue/${encodeURIComponent(attachResult.queueKey)}.json`, attachResult.tenant) : `${FIREBASE_DB_URL}/queue/${encodeURIComponent(attachResult.queueKey)}.json`);
        const queueId = q?.queueId || q?.number || q?.ticket || 'Unknown';
        const counterName = await resolveCounterName(q?.counterId, attachResult.tenant);
        const siteBase = process.env.SITE_BASE ? process.env.SITE_BASE.replace(/\/$/, '') : 'https://queuejoy.netlify.app';
        const statusUrl = attachResult.tenant ? `${siteBase}/${attachResult.tenant}/status.html?queueId=${encodeURIComponent(attachResult.queueKey)}` : `${siteBase}/status.html?queueId=${encodeURIComponent(attachResult.queueKey)}`;

        const reply = [
          '✅ Connected to QueueJoy!',
          `🧾 Your number: *${escapeForMarkdown(queueId)}*`,
          `🪑 Counter: *${escapeForMarkdown(counterName)}*`,
          '',
          'We will notify you via this Telegram chat when your number is called. You can close this chat or app — notifications will arrive automatically.'
        ].join('\n');

        await sendTelegram(userChatId, reply, {
          reply_markup: {
            inline_keyboard: [
              [ { text: '📲 Open Queue Status', url: statusUrl } ],
              [ { text: '📄 Help', callback_data: 'help' } ]
            ]
          }
        });

        return { statusCode: 200, body: 'OK' };
      } else {
        console.log('attach failed', attachResult);
        await sendTelegram(userChatId, 'Could not connect with that token. Please check the token or open your status page and use *Connect via Telegram*.');
        return { statusCode: 200, body: 'OK' };
      }
    }

    // fallback: if chat already linked, show summary (tenant-aware)
    const tenantHint = pickTenantFromEventOrToken(event, null) || '';
    const found = await findQueueByChatId(userChatId, tenantHint);
    if (found) {
      const q = found.entry;
      const queueId = q.queueId || q.number || q.ticket || 'Unknown';
      const counterName = await resolveCounterName(q.counterId, found.tenant || tenantHint);
      const reply = [
        'ℹ️ Queue status for this Telegram chat:',
        `🧾 Number: *${escapeForMarkdown(queueId)}*`,
        `🪑 Counter: *${escapeForMarkdown(counterName)}*`,
        '',
        'We will send you a message when it is your turn.'
      ].join('\n');
      await sendTelegram(userChatId, reply, {
        reply_markup: { inline_keyboard: [ [ { text: '📄 Help', callback_data: 'help' } ] ] }
      });
      return { statusCode: 200, body: 'OK' };
    }

    // final fallback: show connect instructions
    const connectInstructions = [
      '👋 Hi — I could not find a Queue entry for this Telegram chat.',
      '',
      'To connect: open the QueueJoy status page you were given and tap *Connect via Telegram*. That runs `/start <token>` automatically and connects this chat.',
      '',
      'If you prefer, paste the token here and I will try to connect you.',
      '',
      'Example token format: `/start -OaVK...` or the token link on your status page.'
    ].join('\n');

    await sendTelegram(userChatId, connectInstructions);
    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('Handler error', err);
    return { statusCode: 500, body: 'Internal Server Error' };
  }
};
