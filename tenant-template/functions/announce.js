/**
 * announce.js — QueueJoy Announcement Module (Public UI)
 *
 * Runs in the browser inside admin.html.
 * Does NOT use window in any server function context.
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

  const TEMPLATES = [
    { name: '🎉 Promotion', text: '🎉 *Special Promotion!*\n\nWe have an exciting deal for you today! Don\'t miss out on our limited-time offer.\n\nVisit us now!' },
    { name: '🆕 New Product', text: '🆕 *New Product Alert!*\n\nWe\'re thrilled to introduce our latest addition. Come check it out!\n\nAvailable now.' },
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

  function parseChatIds(raw) {
    if (!raw || typeof raw !== 'string') return [];
    return [...new Set(raw.split(/[\n,\s]+/).map(s => s.trim()).filter(Boolean))];
  }

  function normalizeChatId(v) {
    if (v === null || v === undefined) return '';
    return String(v).trim();
  }

  function isLikelyChatIdRecord(obj) {
    return obj && typeof obj === 'object' && (
      typeof obj.chatId === 'string' || typeof obj.chatId === 'number' ||
      typeof obj.telegramChatId === 'string' || typeof obj.telegramChatId === 'number' ||
      typeof obj.used === 'boolean' ||
      typeof obj.connected === 'boolean'
    );
  }

  function extractChatIdsFromNode(node) {
    const ids = new Set();
    const walk = (value) => {
      if (!value) return;
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (typeof value !== 'object') return;

      if (typeof value.chatId !== 'undefined') ids.add(normalizeChatId(value.chatId));
      if (typeof value.telegramChatId !== 'undefined') ids.add(normalizeChatId(value.telegramChatId));
      if (typeof value.id !== 'undefined' && isLikelyChatIdRecord(value)) ids.add(normalizeChatId(value.id));

      for (const [k, v] of Object.entries(value)) {
        if (k === 'chatId' || k === 'telegramChatId' || k === 'id') continue;
        if (typeof v === 'object') walk(v);
      }
    };
    walk(node);
    return [...ids].filter(Boolean);
  }

  function setRecipientCountText(text) {
    const el = qel('annRecipientCount');
    if (el) el.textContent = text;
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
        <p style="margin-top:4px;font-size:11px;color:var(--text-muted)">Images, GIFs, videos, audio. Max 10MB. Media over 5MB will be sent as text only.</p>
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

  function handleMedia(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) {
      ctx.showToast('Max 10MB', 'error');
      return;
    }

    if (annMediaFile && annMediaFile.name === f.name && annMediaFile.size === f.size) return;

    annMediaFile = f;
    const nameEl = qel('annMediaName');
    if (nameEl) nameEl.textContent = `${f.name} (${(f.size / 1024).toFixed(0)}KB)`;
    const clearBtn = qel('annMediaClear');
    if (clearBtn) clearBtn.style.display = 'inline';

    const prev = qel('annMediaPreview');
    if (prev) {
      const oldVid = prev.querySelector('video');
      if (oldVid) { oldVid.pause(); oldVid.removeAttribute('src'); oldVid.load(); }
      const oldAudio = prev.querySelector('audio');
      if (oldAudio) { oldAudio.pause(); oldAudio.removeAttribute('src'); }
      prev.innerHTML = '';

      if (f.type.startsWith('video/')) {
        const url = URL.createObjectURL(f);
        const placeholder = document.createElement('div');
        placeholder.className = 'media-placeholder';
        placeholder.innerHTML = `
          <div class="mp-meta"><span class="mp-icon">🎬</span><div><div style="font-weight:600;font-size:12px;color:var(--text)">${escapeHtml(f.name)}</div><div style="font-size:10px;color:var(--text-light)">${(f.size / 1024).toFixed(0)} KB</div></div></div>
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

  function clearMedia() {
    annMediaFile = null;
    annMediaDataUrl = null;
    const input = qel('annMediaInput');
    if (input) input.value = '';
    const name = qel('annMediaName');
    if (name) name.textContent = '';
    const clearBtn = qel('annMediaClear');
    if (clearBtn) clearBtn.style.display = 'none';
    const prev = qel('annMediaPreview');
    if (prev) {
      const oldVid = prev.querySelector('video');
      if (oldVid) { oldVid.pause(); oldVid.removeAttribute('src'); }
      prev.innerHTML = '';
    }
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

  async function doSend() {
    if (sending) return;

    const composerEl = qel('annComposer');
    const message = (composerEl ? composerEl.value : '').trim();
    if (!message) { ctx.showToast('Enter a message', 'error'); return; }
    if (message.length > MAX_MESSAGE_CHARS) { ctx.showToast(`Message too long (max ${MAX_MESSAGE_CHARS} chars)`, 'error'); return; }

    const font = (qel('annFont') || {}).value || 'Inter';
    const payload = {
      slug: ctx.slug,
      tenantId: ctx.tenantId,
      message,
      font,
      level: 'info',
      source: 'admin-ui'
    };

    if (annTarget.type === 'list') {
      const raw = (qel('annChatIds') || {}).value || '';
      const ids = parseChatIds(raw);
      if (!ids.length) { ctx.showToast('Enter at least one chat ID', 'error'); return; }
      payload.target = { type: 'list', chatIds: ids };
    } else {
      payload.target = { type: 'all' };
      if (activeChatIds.length) payload.telegramChatIds = activeChatIds;
      if (subscriberCount === 0) ctx.showToast('No Telegram-connected customers found', 'error');
    }

    if (annMediaFile && annMediaDataUrl) {
      const base64Size = annMediaDataUrl.length;
      if (base64Size > MAX_MEDIA_BYTES * 1.37) {
        ctx.showToast('Media too large for inline send. Sending text only.', 'error');
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
      try { body = await res.json(); } catch { body = null; }

      if (resultDiv) resultDiv.style.display = 'block';

      if (!res.ok) {
        let errorMsg = 'Unknown error';
        if (body) errorMsg = body.error || body.message || body.details || JSON.stringify(body).slice(0, 240);
        if (res.status === 413 || /too large|payload|size/i.test(String(errorMsg))) {
          errorMsg = 'Payload too large. Remove media or shorten the message.';
        }
        if (resultDiv) {
          resultDiv.style.background = 'rgba(239,68,68,0.1)';
          resultDiv.style.color = 'var(--red)';
          resultDiv.textContent = `⚠️ Server error (${res.status}): ${errorMsg}`;
        }
        return;
      }

      if (body && body.success > 0) {
        if (resultDiv) {
          resultDiv.style.background = 'rgba(16,185,129,0.1)';
          resultDiv.style.color = 'var(--green)';
          resultDiv.innerHTML = `✅ Sent to ${body.success} recipient(s)${body.failed ? ` · ⚠️ ${body.failed} failed` : ''}`;
        }
        if (composerEl) composerEl.value = '';
        clearMedia();
        updatePreview();
        ctx.writeAudit('announcement_sent', { success: body.success, failed: body.failed || 0, mode: annTarget.type });
        loadSendLog();
        return;
      }

      if (body && body.success === 0 && body.failed > 0) {
        if (resultDiv) {
          resultDiv.style.background = 'rgba(239,68,68,0.1)';
          resultDiv.style.color = 'var(--red)';
          resultDiv.textContent = `⚠️ All ${body.failed} delivery attempts failed`;
        }
        return;
      }

      if (resultDiv) {
        resultDiv.style.background = 'rgba(239,68,68,0.1)';
        resultDiv.style.color = 'var(--red)';
        resultDiv.textContent = `⚠️ ${body?.error || body?.message || 'No recipients or unknown response'}`;
      }
    } catch (e) {
      ctx.showToast('Network error: ' + (e.message || 'Failed to connect'), 'error');
    } finally {
      sending = false;
      if (btn) btn.disabled = false;
      if (text) text.style.display = 'inline';
      if (spin) spin.style.display = 'none';
    }
  }

  async function sendWithRetry(payload) {
    const doFetch = () => fetch('/.netlify/functions/announce', {
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

    if (res.status === 502 || res.status === 503) {
      await new Promise(r => setTimeout(r, 1500));
      res = await doFetch();
    }

    return res;
  }

  function getFirstTs(chats) {
    if (!chats || typeof chats !== 'object') return 0;
    const vals = Object.values(chats);
    for (const v of vals) {
      if (v && v.ts) return v.ts;
    }
    return 0;
  }

  function renderSendLogRows(data) {
    const announcements = Object.entries(data)
      .sort((a, b) => getFirstTs(b[1]) - getFirstTs(a[1]))
      .slice(0, 10);

    if (!announcements.length) return '<p style="color:var(--text-muted)">No send logs yet.</p>';

    return announcements.map(([annId, chats]) => {
      const chatEntries = (chats && typeof chats === 'object') ? Object.entries(chats) : [];
      const ok = chatEntries.filter(([, v]) => v && v.status === 'ok').length;
      const fail = chatEntries.length - ok;
      const ts = chatEntries[0]?.[1]?.ts;
      return `<div class="audit-entry" style="transition:background .15s"><div class="audit-time">${escapeHtml(ctx.formatDate(ts))} — ${escapeHtml(annId)}</div><div style="margin-top:4px"><span class="badge badge-green">${ok} sent</span> ${fail ? `<span class="badge badge-red">${fail} failed</span>` : ''}</div></div>`;
    }).join('');
  }

  function loadSendLog() {
    if (!ctx || !ctx.get) return;
    ctx.get(ctx.tRef('integrations/telegram/sentAnnouncements')).then(snap => {
      const logDiv = qel('annSendLog');
      if (!logDiv) return;
      if (!snap.exists()) { logDiv.innerHTML = '<p style="color:var(--text-muted)">No send logs yet.</p>'; return; }
      const data = snap.val();
      if (!data || typeof data !== 'object') { logDiv.innerHTML = '<p style="color:var(--text-muted)">No send logs yet.</p>'; return; }
      logDiv.innerHTML = renderSendLogRows(data);
    }).catch(() => {
      const logDiv = qel('annSendLog');
      if (logDiv) logDiv.innerHTML = '<p style="color:var(--text-muted)">Could not load send logs.</p>';
    });
  }

  function collectTelegramChatIds() {
    const ids = new Set();
    const paths = [
      'integrations/telegram/tokens',
      'integrations/telegram/connected',
      'integrations/telegram/chatIds',
      'telegramTokens',
      'telegram/tokens'
    ];

    return Promise.all(paths.map(path => {
      if (!ctx || !ctx.get) return Promise.resolve(null);
      return ctx.get(ctx.tRef(path)).then(snap => {
        if (!snap.exists()) return null;
        return snap.val();
      }).catch(() => null);
    })).then(values => {
      values.forEach(v => {
        if (!v) return;
        extractChatIdsFromNode(v).forEach(id => ids.add(id));
      });
      return [...ids].filter(Boolean);
    });
  }

  function initSubscribers() {
    const watchedPaths = [
      'integrations/telegram/tokens',
      'integrations/telegram/connected',
      'integrations/telegram/chatIds',
      'telegramTokens'
    ];

    let seen = false;
    const setFromNode = (node) => {
      const ids = extractChatIdsFromNode(node).map(normalizeChatId).filter(Boolean);
      if (ids.length) {
        activeChatIds = [...new Set([...activeChatIds, ...ids])];
        subscriberCount = activeChatIds.length;
        updateRecipientCount();
        seen = true;
      }
    };

    watchedPaths.forEach(path => {
      ctx.onValue(ctx.tRef(path), snap => {
        if (!snap.exists()) return;
        setFromNode(snap.val());
      });
    });

    if (!seen) {
      collectTelegramChatIds().then(ids => {
        if (ids.length) {
          activeChatIds = ids;
          subscriberCount = ids.length;
          updateRecipientCount();
        }
      }).catch(() => {});
    }
  }

  function bindChatIdCounter() {
    const chatInput = qel('annChatIds');
    if (chatInput) chatInput.addEventListener('input', updateRecipientCount);
  }

  window.__announceModule = {
    init(context) {
      if (initialized) return;
      initialized = true;
      ctx = context;
      container = document.getElementById('announceContainer');
      if (!container) {
        console.error('announce.js: #announceContainer not found');
        return;
      }
      renderUI();
      updatePreview();
      initSubscribers();
      loadSendLog();
      bindChatIdCounter();
      if (ctx && ctx.writeAudit) ctx.writeAudit('announcement_ui_loaded');
    },
    getSubscriberCount() {
      return subscriberCount;
    },
    refreshSubscribers() {
      return collectTelegramChatIds().then(ids => {
        activeChatIds = ids;
        subscriberCount = ids.length;
        updateRecipientCount();
        return ids;
      });
    }
  };
})();
