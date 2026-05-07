/**
 * announce.js — QueueJoy Announcement Module (Public UI)
 *
 * Runs in the browser inside admin.html.
 * Never uses `window` directly; uses `globalThis` safe access only.
 *
 * Responsibilities:
 * - Render announcement composer UI
 * - Preview message + media
 * - Discover Telegram-connected subscribers from RTDB
 * - Send announcement payload to the backend Netlify function
 * - Show send log and delivery estimates
 *
 * Expected ctx:
 * {
 *   tRef, get, onValue, set, update, genId,
 *   showToast, writeAudit, fileToBase64, formatDate,
 *   slug, tenantId
 * }
 */
(function () {
  'use strict';

  const root = typeof globalThis !== 'undefined'
    ? globalThis
    : (typeof self !== 'undefined' ? self : {});

  const TEMPLATES = [
    { name: '🎉 Promotion', text: "🎉 *Special Promotion!*\n\nWe have an exciting deal for you today! Don't miss out on our limited-time offer.\n\nVisit us now!" },
    { name: '🆕 New Product', text: "🆕 *New Product Alert!*\n\nWe're thrilled to introduce our latest addition. Come check it out!\n\nAvailable now." },
    { name: '📋 Notice', text: '📋 *Important Notice!*\n\nPlease be informed of the following update regarding our services.\n\nThank you for your understanding.' },
    { name: '🚨 Urgent Update', text: '🚨 *Urgent Update!*\n\nThis is an important message that requires your immediate attention.\n\nPlease read carefully.' },
    { name: '👋 Friendly Reminder', text: '👋 *Friendly Reminder!*\n\nJust a quick reminder about our services. We look forward to seeing you!\n\nHave a great day!' },
    { name: '🎄 Holiday Update', text: '🎄 *Holiday Update!*\n\nWishing you a wonderful holiday season! Please note our updated hours during this period.\n\nHappy holidays!' },
    { name: '⏰ Service Delay', text: '⏰ *Service Delay Notice!*\n\nWe apologize for any inconvenience. There is currently a slight delay in our service.\n\nThank you for your patience.' },
    { name: '💰 Special Offer', text: '💰 *Special Offer!*\n\nFor a limited time only — enjoy exclusive savings on our services.\n\nHurry, offer ends soon!' }
  ];

  const FONTS = ['Inter', 'Poppins', 'Roboto', 'DM Sans', 'Georgia', 'Courier New', 'Arial'];
  const MAX_MESSAGE_CHARS = 4000;
  const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
  const MAX_INLINE_MEDIA_BYTES = 10 * 1024 * 1024;

  let ctx = null;
  let container = null;
  let initialized = false;
  let sending = false;
  let previewTimer = null;
  let subscriberCount = 0;
  let annTarget = { type: 'all' };
  let annMediaFile = null;
  let annMediaDataUrl = null;
  let activeChatIds = [];
  let subscribedPaths = [];
  let loadedOnce = false;

  function qel(id) {
    return container ? container.querySelector('#' + id) : document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeText(v, fallback = '') {
    const s = String(v ?? '').trim();
    return s.length ? s : fallback;
  }

  function notify(message, type) {
    try {
      if (ctx && typeof ctx.showToast === 'function') {
        ctx.showToast(message, type || 'success');
        return;
      }
      if (typeof root.showToast === 'function') {
        root.showToast(message, type || 'success');
        return;
      }
    } catch (_) {}
    console.log((type || 'info').toUpperCase() + ': ' + message);
  }

  function parseChatIds(raw) {
    if (!raw || typeof raw !== 'string') return [];
    return [...new Set(
      raw.split(/[\n,\s]+/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(normalizeChatId)
        .filter(Boolean)
    )];
  }

  function normalizeChatId(v) {
    if (v === null || v === undefined) return '';
    const s = String(v).trim();
    if (!s) return '';
    return s;
  }

  function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function extractChatIdsDeep(node) {
    const ids = new Set();

    const walk = (value) => {
      if (value === null || value === undefined) return;

      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }

      if (typeof value !== 'object') return;

      if (Object.prototype.hasOwnProperty.call(value, 'chatId')) {
        const id = normalizeChatId(value.chatId);
        if (id) ids.add(id);
      }
      if (Object.prototype.hasOwnProperty.call(value, 'telegramChatId')) {
        const id = normalizeChatId(value.telegramChatId);
        if (id) ids.add(id);
      }
      if (Object.prototype.hasOwnProperty.call(value, 'id') && (
        typeof value.chatId !== 'undefined' ||
        typeof value.telegramChatId !== 'undefined' ||
        typeof value.connected !== 'undefined' ||
        typeof value.used !== 'undefined'
      )) {
        const id = normalizeChatId(value.id);
        if (id) ids.add(id);
      }

      for (const [k, v] of Object.entries(value)) {
        if (k === 'chatId' || k === 'telegramChatId' || k === 'id') continue;
        if (v && typeof v === 'object') walk(v);
      }
    };

    walk(node);
    return [...ids].filter(Boolean);
  }

  function firstExistingString(...values) {
    for (const v of values) {
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number' && isFinite(v)) return String(v);
    }
    return '';
  }

  function setRecipientCountText(text) {
    const el = qel('annRecipientCount');
    if (el) el.textContent = text;
  }

  function setResultBox(kind, text, html) {
    const el = qel('annResult');
    if (!el) return;
    el.style.display = 'block';
    if (kind === 'success') {
      el.style.background = 'rgba(16,185,129,0.1)';
      el.style.color = 'var(--green)';
    } else if (kind === 'warning') {
      el.style.background = 'rgba(245,158,11,0.1)';
      el.style.color = 'var(--amber)';
    } else {
      el.style.background = 'rgba(239,68,68,0.1)';
      el.style.color = 'var(--red)';
    }
    if (html) el.innerHTML = html;
    else el.textContent = text;
  }

  function renderUI() {
    if (!container) return;

    container.innerHTML = `
      <div class="card ann-fade-in" style="padding:22px;margin-bottom:16px">
        <div class="card-header">📢 Compose Announcement</div>

        <label class="field-label" style="margin-top:0">Quick Templates</label>
        <div id="annTemplates" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
          ${TEMPLATES.map((t, i) => `<button type="button" class="btn btn-secondary btn-sm ann-tpl-btn" data-ann-tpl="${i}">${escapeHtml(t.name)}</button>`).join('')}
        </div>

        <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
          <div>
            <label class="field-label" style="margin-top:0">Font</label>
            <select id="annFont" class="input" style="width:160px;padding:8px 12px;font-size:13px">
              ${FONTS.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('')}
            </select>
          </div>
          <div style="display:flex;gap:4px;margin-top:18px">
            <button type="button" class="btn btn-secondary btn-sm" id="annBoldBtn" style="font-weight:900;font-size:14px" title="Bold">B</button>
          </div>
        </div>

        <label class="field-label">Message</label>
        <textarea id="annComposer" class="input" rows="6" placeholder="Type your announcement here... Use *bold* for emphasis." style="font-size:14px;line-height:1.6"></textarea>

        <label class="field-label">Preview</label>
        <div id="annPreview" style="padding:14px;background:rgba(255,255,255,0.03);border-radius:10px;border:1px solid var(--border);font-size:14px;line-height:1.6;min-height:60px;white-space:pre-wrap;word-break:break-word;color:var(--text);transition:all .2s ease"></div>

        <label class="field-label">Attach Media</label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <label class="file-btn">📎 Choose File<input type="file" id="annMediaInput" accept="image/*,video/*,audio/*" style="position:absolute;left:-9999px"/></label>
          <span id="annMediaName" style="font-size:12px;color:var(--text-muted);transition:opacity .2s"></span>
          <button type="button" id="annMediaClear" class="btn btn-secondary btn-sm" style="display:none">✕ Remove</button>
        </div>
        <p style="margin-top:4px;font-size:11px;color:var(--text-muted)">Images, GIFs, videos, audio. Max 10MB. Media over 5MB may be sent as text only depending on backend limits.</p>
        <div id="annMediaPreview" style="margin-top:8px"></div>

        <label class="field-label">Target Audience</label>
        <div id="annTargetGroup" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <div class="target-opt selected" data-ann-target="all">🌍 Telegram-connected customers</div>
          <div class="target-opt" data-ann-target="list">📋 Specific Chat IDs</div>
        </div>
        <div id="annTargetListWrap" style="display:none;margin-bottom:12px">
          <textarea id="annChatIds" class="input" rows="2" placeholder="Comma or newline separated chat IDs..."></textarea>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;flex-wrap:wrap;gap:10px">
          <span class="badge badge-blue" id="annRecipientCount">Estimated: 0 recipients</span>
          <button type="button" class="btn btn-primary" id="annSendBtn">
            <span id="annSendText">📱 Send Now</span>
            <span id="annSendSpinner" style="display:none"><span class="spinner"></span>Sending...</span>
          </button>
        </div>

        <div id="annResult" style="display:none;margin-top:12px;padding:12px;border-radius:8px;font-weight:600;font-size:13px;transition:all .3s ease"></div>
      </div>

      <div class="card ann-fade-in" style="padding:22px;animation-delay:.1s">
        <div class="card-header">📋 Send Log</div>
        <div id="annSendLog" style="font-size:13px;color:var(--text-muted)">No announcements sent yet.</div>
      </div>
    `;

    bindEvents();
  }

  function bindEvents() {
    const tplContainer = qel('annTemplates');
    if (tplContainer) {
      tplContainer.addEventListener('click', e => {
        const btn = e.target.closest('[data-ann-tpl]');
        if (!btn) return;
        const idx = parseInt(btn.dataset.annTpl, 10);
        const tpl = TEMPLATES[idx];
        const composer = qel('annComposer');
        if (tpl && composer) {
          composer.value = tpl.text;
          updatePreview();
        }
      });
    }

    const boldBtn = qel('annBoldBtn');
    if (boldBtn) {
      boldBtn.addEventListener('click', () => {
        const ta = qel('annComposer');
        if (!ta) return;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const val = ta.value;
        if (start !== end) {
          ta.value = val.slice(0, start) + '*' + val.slice(start, end) + '*' + val.slice(end);
        } else {
          ta.value = val.slice(0, start) + '**' + val.slice(start);
          ta.selectionStart = ta.selectionEnd = start + 1;
        }
        ta.focus();
        updatePreview();
      });
    }

    const composer = qel('annComposer');
    if (composer) composer.addEventListener('input', schedulePreview);

    const fontSel = qel('annFont');
    if (fontSel) fontSel.addEventListener('change', updatePreview);

    const mediaInput = qel('annMediaInput');
    if (mediaInput) mediaInput.addEventListener('change', handleMedia);

    const mediaClear = qel('annMediaClear');
    if (mediaClear) mediaClear.addEventListener('click', clearMedia);

    const targetGroup = qel('annTargetGroup');
    if (targetGroup) {
      targetGroup.querySelectorAll('[data-ann-target]').forEach(opt => {
        opt.addEventListener('click', () => {
          targetGroup.querySelectorAll('[data-ann-target]').forEach(x => x.classList.remove('selected'));
          opt.classList.add('selected');
          annTarget.type = opt.dataset.annTarget;
          const listWrap = qel('annTargetListWrap');
          if (listWrap) listWrap.style.display = annTarget.type === 'list' ? 'block' : 'none';
          updateRecipientCount();
        });
      });
    }

    const sendBtn = qel('annSendBtn');
    if (sendBtn) sendBtn.addEventListener('click', doSend);

    const chatIds = qel('annChatIds');
    if (chatIds) chatIds.addEventListener('input', updateRecipientCount);
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 150);
  }

  function updatePreview() {
    const raw = (qel('annComposer') || {}).value || '';
    const font = (qel('annFont') || {}).value || 'Inter';
    const prev = qel('annPreview');
    if (!prev) return;

    const safe = escapeHtml(raw)
      .replace(/\*([^*]+)\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');

    prev.innerHTML = safe || '<span style="color:var(--text-light)">Preview will appear here...</span>';
    prev.style.fontFamily = font + ', sans-serif';
  }

  function clearObjectUrlsFromPreview() {
    const prev = qel('annMediaPreview');
    if (!prev) return;

    const vids = prev.querySelectorAll('video');
    vids.forEach(v => {
      try { v.pause(); } catch (_) {}
      try { v.removeAttribute('src'); } catch (_) {}
    });

    const audios = prev.querySelectorAll('audio');
    audios.forEach(a => {
      try { a.pause(); } catch (_) {}
      try { a.removeAttribute('src'); } catch (_) {}
    });

    prev.innerHTML = '';
  }

  function clearMedia() {
    annMediaFile = null;
    annMediaDataUrl = null;

    const input = qel('annMediaInput');
    if (input) input.value = '';

    const name = qel('annMediaName');
    if (name) name.textContent = '';

    const clearBtn = qel('annMediaClear');
    if (clearBtn) clearBtn.style.display = 'none';

    clearObjectUrlsFromPreview();
  }

  function handleMedia(e) {
    const f = e.target && e.target.files ? e.target.files[0] : null;
    if (!f) return;

    if (f.size > MAX_INLINE_MEDIA_BYTES) {
      notify('Max 10MB', 'error');
      return;
    }

    annMediaFile = f;

    const nameEl = qel('annMediaName');
    if (nameEl) nameEl.textContent = `${f.name} (${Math.round(f.size / 1024)}KB)`;

    const clearBtn = qel('annMediaClear');
    if (clearBtn) clearBtn.style.display = 'inline';

    const prev = qel('annMediaPreview');
    if (prev) {
      clearObjectUrlsFromPreview();

      if (f.type.startsWith('video/')) {
        const url = URL.createObjectURL(f);
        const placeholder = document.createElement('div');
        placeholder.className = 'media-placeholder';
        placeholder.innerHTML = `
          <div class="mp-meta">
            <span class="mp-icon">🎬</span>
            <div>
              <div style="font-weight:600;font-size:12px;color:var(--text)">${escapeHtml(f.name)}</div>
              <div style="font-size:10px;color:var(--text-light)">${Math.round(f.size / 1024)} KB</div>
            </div>
          </div>
          <button type="button" class="btn btn-secondary btn-sm mp-load-btn">▶ Load Preview</button>
        `;
        const loadBtn = placeholder.querySelector('.mp-load-btn');
        loadBtn.addEventListener('click', () => {
          loadBtn.innerHTML = '<span class="spinner"></span> Loading...';
          loadBtn.disabled = true;
          const v = document.createElement('video');
          v.preload = 'none';
          v.controls = true;
          v.muted = true;
          v.playsInline = true;
          v.style.cssText = 'width:100%;max-width:300px;border-radius:10px';
          v.onloadeddata = () => { placeholder.replaceWith(v); };
          v.onerror = () => { loadBtn.textContent = '⚠️ Failed'; loadBtn.disabled = false; };
          v.src = url;
          v.load();
        });
        prev.appendChild(placeholder);
      } else if (f.type.startsWith('audio/')) {
        const url = URL.createObjectURL(f);
        const a = document.createElement('audio');
        a.src = url;
        a.controls = true;
        a.style.cssText = 'width:100%;max-width:300px';
        prev.appendChild(a);
      } else {
        const url = URL.createObjectURL(f);
        const img = document.createElement('img');
        img.src = url;
        img.loading = 'lazy';
        img.style.cssText = 'max-width:300px;width:100%;border-radius:10px';
        prev.appendChild(img);
      }
    }

    annMediaDataUrl = null;
    const reader = new FileReader();
    reader.onload = () => { annMediaDataUrl = reader.result; };
    reader.readAsDataURL(f);
  }

  function updateRecipientCount() {
    const el = qel('annRecipientCount');
    if (!el) return;

    if (annTarget.type === 'list') {
      const raw = (qel('annChatIds') || {}).value || '';
      const ids = parseChatIds(raw);
      el.textContent = ids.length > 0 ? `Custom list: ${ids.length} ID(s)` : 'Custom list';
      return;
    }

    el.textContent = subscriberCount > 0
      ? `Estimated: ${subscriberCount} recipients`
      : 'Estimated: 0 recipients';
  }

  function getBackendUrl() {
    // Primary Netlify function endpoint
    return '/.netlify/functions/announce';
  }

  async function sendWithRetry(payload) {
    const doFetch = () => fetch(getBackendUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    let res;
    try {
      res = await doFetch();
    } catch (e) {
      await new Promise(r => setTimeout(r, 1000));
      res = await doFetch();
      return res;
    }

    if (res.status === 502 || res.status === 503 || res.status === 504) {
      await new Promise(r => setTimeout(r, 1500));
      res = await doFetch();
    }

    return res;
  }

  async function doSend() {
    if (sending) return;

    const composerEl = qel('annComposer');
    const message = (composerEl ? composerEl.value : '').trim();

    if (!message) {
      notify('Enter a message', 'error');
      return;
    }

    if (message.length > MAX_MESSAGE_CHARS) {
      notify(`Message too long (max ${MAX_MESSAGE_CHARS} chars)`, 'error');
      return;
    }

    const font = (qel('annFont') || {}).value || 'Inter';

    const payload = {
      slug: ctx && ctx.slug ? ctx.slug : '',
      tenantId: ctx && ctx.tenantId ? ctx.tenantId : '',
      message,
      font,
      level: 'info',
      source: 'admin-ui'
    };

    if (annTarget.type === 'list') {
      const raw = (qel('annChatIds') || {}).value || '';
      const ids = parseChatIds(raw);
      if (!ids.length) {
        notify('Enter at least one chat ID', 'error');
        return;
      }
      payload.target = { type: 'list', chatIds: ids };
    } else {
      payload.target = { type: 'all' };
      if (activeChatIds.length) payload.telegramChatIds = activeChatIds;
    }

    if (annMediaFile && annMediaDataUrl) {
      if (annMediaDataUrl.length > MAX_INLINE_MEDIA_BYTES * 1.37) {
        notify('Media too large for inline send. Sending text only.', 'error');
      } else {
        payload.media = annMediaDataUrl;
        payload.mediaType = annMediaFile.type;
        payload.mediaName = annMediaFile.name;
      }
    }

    const btn = qel('annSendBtn');
    const text = qel('annSendText');
    const spin = qel('annSendSpinner');
    const resultDiv = qel('annResult');

    sending = true;
    if (btn) btn.disabled = true;
    if (text) text.style.display = 'none';
    if (spin) spin.style.display = 'inline';

    try {
      const res = await sendWithRetry(payload);
      let body = null;
      try { body = await res.json(); } catch (_) { body = null; }

      if (resultDiv) resultDiv.style.display = 'block';

      if (!res.ok) {
        let errorMsg = 'Unknown error';
        if (body) errorMsg = body.error || body.message || body.details || JSON.stringify(body).slice(0, 240);
        if (res.status === 413 || /too large|payload|size/i.test(String(errorMsg))) {
          errorMsg = 'Payload too large. Remove media or shorten the message.';
        }
        setResultBox('error', `⚠️ Server error (${res.status}): ${errorMsg}`);
        return;
      }

      const successCount = Number(body && body.success ? body.success : 0);
      const failedCount = Number(body && body.failed ? body.failed : 0);

      if (successCount > 0) {
        setResultBox(
          'success',
          '',
          `✅ Sent to ${successCount} recipient(s)${failedCount ? ` · ⚠️ ${failedCount} failed` : ''}`
        );

        if (composerEl) composerEl.value = '';
        clearMedia();
        updatePreview();

        if (ctx && typeof ctx.writeAudit === 'function') {
          try {
            ctx.writeAudit('announcement_sent', {
              success: successCount,
              failed: failedCount,
              mode: annTarget.type
            });
          } catch (_) {}
        }

        loadSendLog();
        return;
      }

      if (successCount === 0 && failedCount > 0) {
        setResultBox('error', `⚠️ All ${failedCount} delivery attempts failed`);
        return;
      }

      setResultBox('error', `⚠️ ${body?.error || body?.message || 'No recipients or unknown response'}`);
    } catch (e) {
      notify('Network error: ' + (e.message || 'Failed to connect'), 'error');
      setResultBox('error', `⚠️ Network error: ${e.message || 'Failed to connect'}`);
    } finally {
      sending = false;
      if (btn) btn.disabled = false;
      if (text) text.style.display = 'inline';
      if (spin) spin.style.display = 'none';
    }
  }

  function getTimestampFromAnnouncementNode(node) {
    if (!node) return 0;
    if (typeof node.ts === 'number') return node.ts;
    if (typeof node.timestamp === 'number') return node.timestamp;
    if (typeof node.createdAt === 'number') return node.createdAt;
    return 0;
  }

  function renderSendLogRows(data) {
    const announcements = Object.entries(data)
      .sort((a, b) => getTimestampFromAnnouncementNode(b[1]) - getTimestampFromAnnouncementNode(a[1]))
      .slice(0, 10);

    if (!announcements.length) {
      return '<p style="color:var(--text-muted)">No send logs yet.</p>';
    }

    return announcements.map(([annId, annNode]) => {
      if (!isObject(annNode)) {
        return `<div class="audit-entry"><div class="audit-time">${escapeHtml(ctx && typeof ctx.formatDate === 'function' ? ctx.formatDate(0) : '')}</div><div>${escapeHtml(annId)}</div></div>`;
      }

      let ok = 0;
      let fail = 0;
      let ts = 0;

      const chatEntries = Object.entries(annNode);
      for (const [, v] of chatEntries) {
        if (!v || typeof v !== 'object') continue;
        ts = Math.max(ts, getTimestampFromAnnouncementNode(v));
        if (String(v.status || '').toLowerCase() === 'ok' || String(v.status || '').toLowerCase() === 'sent') ok += 1;
        else fail += 1;
      }

      const fmt = ctx && typeof ctx.formatDate === 'function'
        ? ctx.formatDate(ts)
        : new Date(ts || Date.now()).toLocaleString();

      return `
        <div class="audit-entry" style="transition:background .15s">
          <div class="audit-time">${escapeHtml(fmt)} — ${escapeHtml(annId)}</div>
          <div style="margin-top:4px">
            <span class="badge badge-green">${ok} sent</span>
            ${fail ? `<span class="badge badge-red">${fail} failed</span>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  function loadSendLog() {
    if (!ctx || !ctx.get || !ctx.tRef) return;

    const logPaths = [
      'integrations/telegram/sentAnnouncements',
      'integrations/telegram/announcementLogs',
      'announcements/sent',
      'announcements/logs'
    ];

    const tryPath = (idx) => {
      if (idx >= logPaths.length) {
        const logDiv = qel('annSendLog');
        if (logDiv) logDiv.innerHTML = '<p style="color:var(--text-muted)">No send logs yet.</p>';
        return;
      }

      ctx.get(ctx.tRef(logPaths[idx]))
        .then(snap => {
          if (!snap || !snap.exists()) {
            tryPath(idx + 1);
            return;
          }

          const data = snap.val();
          const logDiv = qel('annSendLog');
          if (!logDiv) return;

          if (!data || typeof data !== 'object') {
            tryPath(idx + 1);
            return;
          }

          logDiv.innerHTML = renderSendLogRows(data);
        })
        .catch(() => {
          tryPath(idx + 1);
        });
    };

    tryPath(0);
  }

  function collectTelegramChatIds() {
    if (!ctx || !ctx.get || !ctx.tRef) return Promise.resolve([]);

    const paths = [
      'integrations/telegram/tokens',
      'integrations/telegram/connected',
      'integrations/telegram/chatIds',
      'integrations/telegram/subscribers',
      'telegramTokens',
      'telegramConnections',
      'telegram/connected',
      'telegram/chatIds',
      'telegram/subscribers'
    ];

    return Promise.all(paths.map(path => {
      return ctx.get(ctx.tRef(path))
        .then(snap => (snap && snap.exists()) ? snap.val() : null)
        .catch(() => null);
    })).then(values => {
      const ids = new Set();
      values.forEach(v => {
        extractChatIdsDeep(v).forEach(id => ids.add(id));
      });
      return [...ids].filter(Boolean);
    });
  }

  function attachLiveSubscriberWatchers() {
    if (!ctx || !ctx.onValue || !ctx.tRef) return;

    const paths = [
      'integrations/telegram/tokens',
      'integrations/telegram/connected',
      'integrations/telegram/chatIds',
      'integrations/telegram/subscribers',
      'telegramTokens',
      'telegramConnections',
      'telegram/connected',
      'telegram/chatIds',
      'telegram/subscribers'
    ];

    // avoid duplicate subscriptions if init is called more than once unexpectedly
    if (subscribedPaths.length) return;
    subscribedPaths = paths.slice();

    paths.forEach(path => {
      try {
        ctx.onValue(ctx.tRef(path), snap => {
          if (!snap || !snap.exists()) return;
          const ids = extractChatIdsDeep(snap.val());
          if (!ids.length) return;

          const merged = new Set([...activeChatIds, ...ids].map(normalizeChatId).filter(Boolean));
          activeChatIds = [...merged];
          subscriberCount = activeChatIds.length;
          updateRecipientCount();
        });
      } catch (_) {}
    });
  }

  function refreshSubscribers() {
    return collectTelegramChatIds().then(ids => {
      activeChatIds = ids;
      subscriberCount = ids.length;
      updateRecipientCount();
      return ids;
    });
  }

  function loadDefaultRecipients() {
    attachLiveSubscriberWatchers();
    refreshSubscribers().catch(() => {});
  }

  function init(context) {
    if (initialized) return;
    initialized = true;

    ctx = context || {};
    container = document.getElementById('announceContainer');

    if (!container) {
      console.error('announce.js: #announceContainer not found');
      return;
    }

    renderUI();
    updatePreview();
    loadDefaultRecipients();
    loadSendLog();

    if (ctx && typeof ctx.writeAudit === 'function' && !loadedOnce) {
      loadedOnce = true;
      try {
        ctx.writeAudit('announcement_ui_loaded');
      } catch (_) {}
    }
  }

  root.__announceModule = {
    init,
    getSubscriberCount() {
      return subscriberCount;
    },
    refreshSubscribers
  };

  // Auto-init if the container is already present
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        if (document.getElementById('announceContainer') && root.__announceModule && typeof root.__announceModule.init === 'function') {
          root.__announceModule.init(root.__announceCtx || null);
        }
      });
    } else {
      if (document.getElementById('announceContainer') && root.__announceModule && typeof root.__announceModule.init === 'function') {
        // Only auto-init if a context was preloaded
        if (root.__announceCtx) root.__announceModule.init(root.__announceCtx);
      }
    }
  }
})();