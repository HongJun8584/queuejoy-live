/**
 * announce.js — QueueJoy Announcement Module (Public UI)
 *
 * Runs in the browser inside admin.html.
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
 *   tRef, get, onValue, set, update, push, genId,
 *   showToast, writeAudit, fileToDataUrl, formatDate,
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
  const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
  const MAX_INLINE_MEDIA_BYTES = 5 * 1024 * 1024;

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
  let unsubscribeFns = [];

  function qel(id) {
    return container ? container.querySelector('#' + id) : document.getElementById(id);
  }

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeText(v, fallback) {
    fallback = fallback || '';
    const s = String(v == null ? '' : v).trim();
    return s.length ? s : fallback;
  }

  function normalizeChatId(v) {
    if (v === null || v === undefined) return '';
    return String(v).trim();
  }

  function parseChatIds(raw) {
    if (!raw || typeof raw !== 'string') return [];
    const ids = raw
      .split(/[\n,\s]+/)
      .map(function (s) { return normalizeChatId(s); })
      .filter(Boolean);
    return Array.from(new Set(ids));
  }

  function looksLikeChatIdKey(k) {
    return typeof k === 'string' && /^-?\d+$/.test(k.trim());
  }

  function extractChatIdsFromNode(node) {
    const ids = new Set();

    function walk(value) {
      if (!value) return;
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (typeof value !== 'object') return;

      if (typeof value.chatId !== 'undefined') {
        const cid = normalizeChatId(value.chatId);
        if (cid) ids.add(cid);
      }
      if (typeof value.telegramChatId !== 'undefined') {
        const tid = normalizeChatId(value.telegramChatId);
        if (tid) ids.add(tid);
      }
      if (typeof value.id !== 'undefined' && (typeof value.id === 'string' || typeof value.id === 'number')) {
        const idv = normalizeChatId(value.id);
        if (idv && /^-?\d+$/.test(idv)) ids.add(idv);
      }

      const keys = Object.keys(value);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k === 'chatId' || k === 'telegramChatId' || k === 'id') continue;
        if (typeof value[k] === 'object' && value[k] !== null) walk(value[k]);
      }
    }

    walk(node);
    return Array.from(ids).filter(Boolean);
  }

  function extractConnectedChatIds(node) {
    const ids = new Set();
    if (!node || typeof node !== 'object') return [];

    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (looksLikeChatIdKey(k)) {
        ids.add(normalizeChatId(k));
      }
      const v = node[k];
      if (v && typeof v === 'object') {
        if (v.chatId) ids.add(normalizeChatId(v.chatId));
        if (v.telegramChatId) ids.add(normalizeChatId(v.telegramChatId));
      }
    }
    return Array.from(ids).filter(Boolean);
  }

  function setRecipientCountText(text) {
    const el = qel('annRecipientCount');
    if (el) el.textContent = text;
  }

  function setResultVisible(show) {
    const resultDiv = qel('annResult');
    if (!resultDiv) return;
    resultDiv.style.display = show ? 'block' : 'none';
  }

  function renderUI() {
    if (!container) return;

    container.innerHTML =
      '<div class="card ann-fade-in" style="padding:22px;margin-bottom:16px">' +
        '<div class="card-header">📢 Compose Announcement</div>' +

        '<label class="field-label" style="margin-top:0">Quick Templates</label>' +
        '<div id="annTemplates" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">' +
          TEMPLATES.map(function (t, i) {
            return '<button type="button" class="btn btn-secondary btn-sm ann-tpl-btn" data-ann-tpl="' + i + '">' + escapeHtml(t.name) + '</button>';
          }).join('') +
        '</div>' +

        '<div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;flex-wrap:wrap">' +
          '<div>' +
            '<label class="field-label" style="margin-top:0">Font</label>' +
            '<select id="annFont" class="input" style="width:160px;padding:8px 12px;font-size:13px">' +
              FONTS.map(function (f) {
                return '<option value="' + escapeHtml(f) + '">' + escapeHtml(f) + '</option>';
              }).join('') +
            '</select>' +
          '</div>' +
          '<div style="display:flex;gap:4px;margin-top:18px">' +
            '<button type="button" class="btn btn-secondary btn-sm" id="annBoldBtn" style="font-weight:900;font-size:14px" title="Bold">B</button>' +
          '</div>' +
        '</div>' +

        '<label class="field-label">Message</label>' +
        '<textarea id="annComposer" class="input" rows="6" placeholder="Type your announcement here... Use *bold* for emphasis." style="font-size:14px;line-height:1.6"></textarea>' +
        '<div style="display:flex;justify-content:flex-end;margin-top:4px"><span id="annCharCount" style="font-size:11px;color:var(--text-light)">0 / ' + MAX_MESSAGE_CHARS + '</span></div>' +

        '<label class="field-label">Preview</label>' +
        '<div id="annPreview" style="padding:14px;background:rgba(255,255,255,0.03);border-radius:10px;border:1px solid var(--border);font-size:14px;line-height:1.6;min-height:60px;white-space:pre-wrap;word-break:break-word;color:var(--text);transition:all .2s ease"></div>' +

        '<label class="field-label">Attach Media</label>' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
          '<label class="file-btn">📎 Choose File<input type="file" id="annMediaInput" accept="image/*,video/*,audio/*" style="position:absolute;left:-9999px"/></label>' +
          '<span id="annMediaName" style="font-size:12px;color:var(--text-muted);transition:opacity .2s"></span>' +
          '<button type="button" id="annMediaClear" class="btn btn-secondary btn-sm" style="display:none">✕ Remove</button>' +
        '</div>' +
        '<p style="margin-top:4px;font-size:11px;color:var(--text-muted)">Images, GIFs, videos, audio. Max 10MB. Media over 5MB will be sent as text only.</p>' +
        '<div id="annMediaPreview" style="margin-top:8px"></div>' +

        '<label class="field-label">Target Audience</label>' +
        '<div id="annTargetGroup" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">' +
          '<div class="target-opt selected" data-ann-target="all">🌍 All Telegram Subscribers</div>' +
          '<div class="target-opt" data-ann-target="list">📋 Specific Chat IDs</div>' +
        '</div>' +

        '<div id="annTargetListWrap" style="display:none;margin-bottom:12px">' +
          '<textarea id="annChatIds" class="input" rows="2" placeholder="Comma or newline separated chat IDs..."></textarea>' +
        '</div>' +

        '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;flex-wrap:wrap;gap:10px">' +
          '<span class="badge badge-blue" id="annRecipientCount">Estimated: 0 recipients</span>' +
          '<button type="button" class="btn btn-primary" id="annSendBtn">' +
            '<span id="annSendText">📱 Send Now</span>' +
            '<span id="annSendSpinner" style="display:none"><span class="spinner"></span>Sending...</span>' +
          '</button>' +
        '</div>' +

        '<div id="annResult" style="display:none;margin-top:12px;padding:12px;border-radius:8px;font-weight:600;font-size:13px;transition:all .3s ease"></div>' +
      '</div>' +

      '<div class="card ann-fade-in" style="padding:22px;animation-delay:.1s">' +
        '<div class="card-header">📋 Send Log</div>' +
        '<div id="annSendLog" style="font-size:13px;color:var(--text-muted)">No announcements sent yet.</div>' +
      '</div>';

    bindEvents();
  }

  function bindEvents() {
    const tplContainer = qel('annTemplates');
    if (tplContainer && !tplContainer.dataset.bound) {
      tplContainer.dataset.bound = '1';
      tplContainer.addEventListener('click', function (e) {
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
    if (boldBtn && !boldBtn.dataset.bound) {
      boldBtn.dataset.bound = '1';
      boldBtn.addEventListener('click', function () {
        const ta = qel('annComposer');
        if (!ta) return;
        const start = ta.selectionStart || 0;
        const end = ta.selectionEnd || 0;
        const val = ta.value || '';

        if (start !== end) {
          ta.value = val.slice(0, start) + '*' + val.slice(start, end) + '*' + val.slice(end);
          ta.selectionStart = start;
          ta.selectionEnd = end + 2;
        } else {
          ta.value = val.slice(0, start) + '**' + val.slice(start);
          ta.selectionStart = ta.selectionEnd = start + 1;
        }

        ta.focus();
        updatePreview();
      });
    }

    const composer = qel('annComposer');
    if (composer && !composer.dataset.bound) {
      composer.dataset.bound = '1';
      composer.addEventListener('input', schedulePreview);
    }

    const fontSel = qel('annFont');
    if (fontSel && !fontSel.dataset.bound) {
      fontSel.dataset.bound = '1';
      fontSel.addEventListener('change', updatePreview);
    }

    const mediaInput = qel('annMediaInput');
    if (mediaInput && !mediaInput.dataset.bound) {
      mediaInput.dataset.bound = '1';
      mediaInput.addEventListener('change', handleMedia);
    }

    const mediaClear = qel('annMediaClear');
    if (mediaClear && !mediaClear.dataset.bound) {
      mediaClear.dataset.bound = '1';
      mediaClear.addEventListener('click', clearMedia);
    }

    const targetGroup = qel('annTargetGroup');
    if (targetGroup && !targetGroup.dataset.bound) {
      targetGroup.dataset.bound = '1';
      targetGroup.querySelectorAll('[data-ann-target]').forEach(function (opt) {
        opt.addEventListener('click', function () {
          targetGroup.querySelectorAll('[data-ann-target]').forEach(function (x) { x.classList.remove('selected'); });
          opt.classList.add('selected');
          annTarget.type = opt.dataset.annTarget;
          const listWrap = qel('annTargetListWrap');
          if (listWrap) listWrap.style.display = annTarget.type === 'list' ? 'block' : 'none';
          updateRecipientCount();
        });
      });
    }

    const chatIds = qel('annChatIds');
    if (chatIds && !chatIds.dataset.bound) {
      chatIds.dataset.bound = '1';
      chatIds.addEventListener('input', updateRecipientCount);
    }

    const sendBtn = qel('annSendBtn');
    if (sendBtn && !sendBtn.dataset.bound) {
      sendBtn.dataset.bound = '1';
      sendBtn.addEventListener('click', doSend);
    }
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 120);
  }

  function updatePreview() {
    const raw = (qel('annComposer') || {}).value || '';
    const font = (qel('annFont') || {}).value || 'Inter';
    const prev = qel('annPreview');
    const charEl = qel('annCharCount');
    if (charEl) charEl.textContent = raw.length + ' / ' + MAX_MESSAGE_CHARS;
    if (!prev) return;

    const safe = escapeHtml(raw)
      .replace(/\*([^*]+)\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');

    prev.innerHTML = safe || '<span style="color:var(--text-light)">Preview will appear here...</span>';
    prev.style.fontFamily = font + ', sans-serif';
  }

  function setMediaPreviewNode(node) {
    const prev = qel('annMediaPreview');
    if (!prev) return;
    prev.innerHTML = '';
    if (node) prev.appendChild(node);
  }

  function cleanupPreviewMedia() {
    const prev = qel('annMediaPreview');
    if (!prev) return;
    const oldVid = prev.querySelector('video');
    if (oldVid) {
      try { oldVid.pause(); } catch (e) {}
      try { oldVid.removeAttribute('src'); oldVid.load(); } catch (e2) {}
    }
    const oldAudio = prev.querySelector('audio');
    if (oldAudio) {
      try { oldAudio.pause(); } catch (e3) {}
      try { oldAudio.removeAttribute('src'); } catch (e4) {}
    }
    prev.innerHTML = '';
  }

  function handleMedia(e) {
    const input = e.target;
    const f = input.files && input.files[0];
    if (!f) return;

    if (f.size > MAX_MEDIA_BYTES) {
      if (ctx && ctx.showToast) ctx.showToast('Max 10MB', 'error');
      input.value = '';
      return;
    }

    if (annMediaFile && annMediaFile.name === f.name && annMediaFile.size === f.size && annMediaFile.type === f.type) {
      return;
    }

    annMediaFile = f;
    const nameEl = qel('annMediaName');
    if (nameEl) nameEl.textContent = f.name + ' (' + formatBytes(f.size) + ')';

    const clearBtn = qel('annMediaClear');
    if (clearBtn) clearBtn.style.display = 'inline-flex';

    cleanupPreviewMedia();

    try {
      if (f.type.startsWith('video/')) {
        const url = URL.createObjectURL(f);
        const placeholder = document.createElement('div');
        placeholder.className = 'media-placeholder';
        placeholder.innerHTML =
          '<div class="mp-meta"><span class="mp-icon">🎬</span><div><div style="font-weight:600;font-size:12px;color:var(--text)">' + escapeHtml(f.name) + '</div><div style="font-size:10px;color:var(--text-light)">' + formatBytes(f.size) + '</div></div></div>' +
          '<button type="button" class="btn btn-secondary btn-sm mp-load-btn">▶ Load Preview</button>';

        const loadBtn = placeholder.querySelector('.mp-load-btn');
        loadBtn.addEventListener('click', function () {
          loadBtn.innerHTML = '<span class="spinner"></span> Loading...';
          loadBtn.disabled = true;

          const v = document.createElement('video');
          v.preload = 'metadata';
          v.controls = true;
          v.muted = true;
          v.playsInline = true;
          v.style.cssText = 'width:100%;max-width:300px;border-radius:10px';
          v.onloadeddata = function () { placeholder.replaceWith(v); };
          v.onerror = function () {
            loadBtn.textContent = '⚠️ Failed';
            loadBtn.disabled = false;
          };
          v.src = url;
          v.load();
        });

        setMediaPreviewNode(placeholder);
      } else if (f.type.startsWith('audio/')) {
        const aUrl = URL.createObjectURL(f);
        const a = document.createElement('audio');
        a.src = aUrl;
        a.controls = true;
        a.style.cssText = 'width:100%;max-width:300px';
        setMediaPreviewNode(a);
      } else {
        const iUrl = URL.createObjectURL(f);
        const img = document.createElement('img');
        img.src = iUrl;
        img.loading = 'lazy';
        img.className = 'preview-media';
        img.style.cssText = 'max-width:300px;width:100%;border-radius:10px';
        setMediaPreviewNode(img);
      }
    } catch (mediaErr) {
      console.error('Media preview error:', mediaErr);
      cleanupPreviewMedia();
      const fallback = document.createElement('div');
      fallback.style.cssText = 'color:var(--text-muted);font-size:12px';
      fallback.textContent = 'Could not preview media';
      setMediaPreviewNode(fallback);
    }

    annMediaDataUrl = null;
    const reader = new FileReader();
    reader.onload = function () {
      annMediaDataUrl = reader.result;
    };
    reader.onerror = function () {
      console.error('Failed to read media file');
      if (ctx && ctx.showToast) ctx.showToast('Could not read media file', 'error');
    };
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

    cleanupPreviewMedia();
  }

  function updateRecipientCount() {
    const el = qel('annRecipientCount');
    if (!el) return;

    if (annTarget.type === 'list') {
      const raw = (qel('annChatIds') || {}).value || '';
      const ids = parseChatIds(raw);
      el.textContent = ids.length > 0 ? 'Custom list: ' + ids.length + ' ID(s)' : 'Custom list: 0 IDs';
      return;
    }

    el.textContent = subscriberCount > 0
      ? 'Estimated: ' + subscriberCount + ' recipients'
      : 'Estimated: 0 recipients (no Telegram subscribers found)';
  }

  function setSendLoading(isLoading) {
    const btn = qel('annSendBtn');
    const text = qel('annSendText');
    const spin = qel('annSendSpinner');

    if (btn) btn.disabled = isLoading;
    if (text) text.style.display = isLoading ? 'none' : 'inline';
    if (spin) spin.style.display = isLoading ? 'inline' : 'none';
  }

  function showResult(msg, isError) {
    const resultDiv = qel('annResult');
    if (!resultDiv) return;
    resultDiv.style.display = 'block';
    if (isError) {
      resultDiv.style.background = 'rgba(239,68,68,0.1)';
      resultDiv.style.color = 'var(--red)';
      resultDiv.style.border = '1px solid rgba(239,68,68,0.2)';
    } else {
      resultDiv.style.background = 'rgba(16,185,129,0.1)';
      resultDiv.style.color = 'var(--green)';
      resultDiv.style.border = '1px solid rgba(16,185,129,0.2)';
    }
    resultDiv.textContent = msg;
  }

  function buildPayload() {
    const composerEl = qel('annComposer');
    const message = (composerEl ? composerEl.value : '').trim();
    if (!message) {
      throw new Error('Enter a message');
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      throw new Error('Message too long (max ' + MAX_MESSAGE_CHARS + ' chars)');
    }

    const font = (qel('annFont') || {}).value || 'Inter';

    const payload = {
      slug: ctx ? ctx.slug : '',
      tenantId: ctx ? ctx.tenantId : '',
      message: message,
      font: font,
      level: 'info',
      source: 'admin-ui',
      createdAt: Date.now()
    };

    if (annTarget.type === 'list') {
      const raw = (qel('annChatIds') || {}).value || '';
      const ids = parseChatIds(raw);
      if (!ids.length) {
        throw new Error('Enter at least one chat ID');
      }
      payload.target = { type: 'list', chatIds: ids };
    } else {
      payload.target = { type: 'all' };
      if (activeChatIds.length) {
        payload.telegramChatIds = activeChatIds.map(String);
      }
      if (activeChatIds.length === 0) {
        throw new Error('No Telegram-connected customers found. Cannot send.');
      }
    }

    if (annMediaFile && annMediaDataUrl) {
      const inlineOk = annMediaFile.size <= MAX_INLINE_MEDIA_BYTES;
      if (inlineOk) {
        payload.media = annMediaDataUrl;
        payload.mediaType = annMediaFile.type || 'application/octet-stream';
        payload.mediaName = annMediaFile.name || 'attachment';
        payload.mediaSize = annMediaFile.size || 0;
      } else if (ctx && ctx.showToast) {
        ctx.showToast('Media too large for inline send. Sending text only.', 'error');
      }
    }

    return payload;
  }

  function parseMaybeJson(text) {
    if (!text) return null;
    const trimmed = String(text).trim();
    if (!trimmed) return null;
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;
    try {
      return JSON.parse(trimmed);
    } catch (e) {
      return null;
    }
  }

  function safeResponseErrorMessage(bodyText, response) {
    const bodyJson = parseMaybeJson(bodyText);
    if (bodyJson) {
      return bodyJson.error || bodyJson.message || bodyJson.details || JSON.stringify(bodyJson).slice(0, 240);
    }

    const text = String(bodyText || '').trim();
    if (!text) return 'Empty server response';

    if (/<!doctype html>|<html[\s>]|<head[\s>]|<body[\s>]/i.test(text)) {
      return 'Server returned HTML instead of JSON. Check the Netlify function path or a redirect/error page.';
    }

    return text.slice(0, 240);
  }

  function sendWithRetry(payload) {
    function doFetch() {
      return fetch('/.netlify/functions/announce', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload),
        credentials: 'same-origin'
      });
    }

    return doFetch().then(function (res) {
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        return new Promise(function (resolve) { setTimeout(resolve, 1200); }).then(doFetch);
      }
      return res;
    }).catch(function (err) {
      return new Promise(function (resolve) { setTimeout(resolve, 900); }).then(doFetch).catch(function () {
        throw err;
      });
    });
  }

  function doSend() {
    if (sending) return;

    let payload;
    try {
      payload = buildPayload();
    } catch (err) {
      if (ctx && ctx.showToast) ctx.showToast(err.message || 'Invalid announcement', 'error');
      showResult('⚠️ ' + (err.message || 'Invalid announcement'), true);
      return;
    }

    sending = true;
    setSendLoading(true);
    setResultVisible(false);

    sendWithRetry(payload).then(function (res) {
      return res.text().then(function (bodyText) {
        const contentType = res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '';
        const body = /json/i.test(contentType) ? parseMaybeJson(bodyText) : (parseMaybeJson(bodyText) || null);

        if (!res.ok) {
          let errorMsg = safeResponseErrorMessage(bodyText, res);
          if (res.status === 413 || /too large|payload|size/i.test(String(errorMsg))) {
            errorMsg = 'Payload too large. Remove media or shorten the message.';
          }
          showResult('⚠️ Server error (' + res.status + '): ' + errorMsg, true);
          if (ctx && ctx.showToast) ctx.showToast('Send failed: ' + errorMsg, 'error');
          return;
        }

        if (body && typeof body === 'object') {
          const success = Number(body.success || 0);
          const failed = Number(body.failed || 0);

          if (success > 0) {
            let msg = '✅ Sent to ' + success + ' recipient(s)';
            if (failed) msg += ' · ⚠️ ' + failed + ' failed';
            showResult(msg, false);
            if (ctx && ctx.showToast) ctx.showToast('Announcement sent', 'success');
            const composerEl = qel('annComposer');
            if (composerEl) composerEl.value = '';
            clearMedia();
            updatePreview();
            if (ctx && ctx.writeAudit) {
              ctx.writeAudit('announcement_sent', {
                success: success,
                failed: failed || 0,
                mode: annTarget.type,
                targetCount: annTarget.type === 'list' ? parseChatIds((qel('annChatIds') || {}).value || '').length : activeChatIds.length
              });
            }
            loadSendLog();
            return;
          }

          if (success === 0 && failed > 0) {
            const msg = '⚠️ All ' + failed + ' delivery attempts failed';
            showResult(msg, true);
            if (ctx && ctx.showToast) ctx.showToast(msg, 'error');
            return;
          }

          const fallbackMsg = body.error || body.message || 'No recipients or unknown response';
          showResult('⚠️ ' + fallbackMsg, true);
          if (ctx && ctx.showToast) ctx.showToast(fallbackMsg, 'error');
          return;
        }

        if (bodyText && /html/i.test(contentType)) {
          const msg = 'Server returned HTML instead of JSON. Check /.netlify/functions/announce.';
          showResult('⚠️ ' + msg, true);
          if (ctx && ctx.showToast) ctx.showToast(msg, 'error');
          return;
        }

        const raw = String(bodyText || '').trim();
        if (!raw) {
          const msg = 'Empty response from server';
          showResult('⚠️ ' + msg, true);
          if (ctx && ctx.showToast) ctx.showToast(msg, 'error');
          return;
        }

        const msg = raw.length > 240 ? raw.slice(0, 240) : raw;
        showResult('⚠️ ' + msg, true);
        if (ctx && ctx.showToast) ctx.showToast(msg, 'error');
      });
    }).catch(function (e) {
      const message = e && e.message ? e.message : 'Failed to connect';
      if (ctx && ctx.showToast) ctx.showToast('Network error: ' + message, 'error');
      showResult('⚠️ Network error: ' + message, true);
    }).finally(function () {
      sending = false;
      setSendLoading(false);
    });
  }

  function getFirstTs(chats) {
    if (!chats || typeof chats !== 'object') return 0;
    const vals = Object.values(chats);
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] && typeof vals[i].ts === 'number') return vals[i].ts;
      if (vals[i] && typeof vals[i].createdAt === 'number') return vals[i].createdAt;
      if (vals[i] && typeof vals[i].updatedAt === 'number') return vals[i].updatedAt;
    }
    return 0;
  }

  function renderSendLogRows(data) {
    const announcements = Object.entries(data)
      .sort(function (a, b) { return getFirstTs(b[1]) - getFirstTs(a[1]); })
      .slice(0, 10);

    if (!announcements.length) return '<p style="color:var(--text-muted)">No send logs yet.</p>';

    return announcements.map(function (entry) {
      const annId = entry[0];
      const chats = entry[1];
      const chatEntries = (chats && typeof chats === 'object') ? Object.entries(chats) : [];
      const ok = chatEntries.filter(function (ce) { return ce[1] && (ce[1].status === 'ok' || ce[1].ok === true); }).length;
      const fail = chatEntries.length - ok;
      const ts = chatEntries[0] && chatEntries[0][1] ? (chatEntries[0][1].ts || chatEntries[0][1].createdAt || chatEntries[0][1].updatedAt || null) : null;
      const dateStr = ctx && ctx.formatDate ? ctx.formatDate(ts) : (ts ? new Date(ts).toLocaleString() : '—');

      return '<div class="audit-entry" style="transition:background .15s">' +
        '<div class="audit-time">' + escapeHtml(dateStr) + ' — ' + escapeHtml(annId) + '</div>' +
        '<div style="margin-top:4px">' +
          '<span class="badge badge-green">' + ok + ' sent</span> ' +
          (fail ? '<span class="badge badge-red">' + fail + ' failed</span>' : '') +
        '</div>' +
      '</div>';
    }).join('');
  }

  function loadSendLog() {
    if (!ctx || !ctx.get || !ctx.tRef) return;

    ctx.get(ctx.tRef('integrations/telegram/sentAnnouncements')).then(function (snap) {
      const logDiv = qel('annSendLog');
      if (!logDiv) return;

      if (!snap || !snap.exists()) {
        logDiv.innerHTML = '<p style="color:var(--text-muted)">No send logs yet.</p>';
        return;
      }

      const data = snap.val();
      if (!data || typeof data !== 'object') {
        logDiv.innerHTML = '<p style="color:var(--text-muted)">No send logs yet.</p>';
        return;
      }

      logDiv.innerHTML = renderSendLogRows(data);
    }).catch(function () {
      const logDiv = qel('annSendLog');
      if (logDiv) logDiv.innerHTML = '<p style="color:var(--text-muted)">Could not load send logs.</p>';
    });
  }

  function collectTelegramChatIds() {
    const ids = new Set();
    const paths = [
      'telegramConnected',
      'telegramTokens',
      'integrations/telegram/tokens',
      'integrations/telegram/connected',
      'integrations/telegram/chatIds',
      'integrations/telegram/subscribers',
      'telegram/subscribers'
    ];

    if (!ctx || !ctx.get || !ctx.tRef) return Promise.resolve([]);

    return Promise.all(paths.map(function (path) {
      return ctx.get(ctx.tRef(path)).then(function (snap) {
        if (!snap || !snap.exists()) return null;
        return { path: path, data: snap.val() };
      }).catch(function () {
        return null;
      });
    })).then(function (results) {
      results.forEach(function (r) {
        if (!r || !r.data) return;

        if (r.path === 'telegramConnected' || r.path === 'integrations/telegram/connected') {
          extractConnectedChatIds(r.data).forEach(function (id) { ids.add(id); });
        }
        extractChatIdsFromNode(r.data).forEach(function (id) { ids.add(id); });
      });

      return Array.from(ids).filter(Boolean);
    });
  }

  function bindToLivePath(path, handler) {
    if (!ctx || !ctx.onValue || !ctx.tRef) return;
    const refObj = ctx.tRef(path);
    try {
      const unsub = ctx.onValue(refObj, handler);
      if (typeof unsub === 'function') {
        unsubscribeFns.push(unsub);
      }
    } catch (err) {
      console.error('Failed to watch path ' + path + ':', err);
    }
  }

  function initSubscribers() {
    const watchedPaths = [
      'telegramConnected',
      'telegramTokens',
      'integrations/telegram/tokens',
      'integrations/telegram/connected',
      'integrations/telegram/chatIds',
      'integrations/telegram/subscribers',
      'telegram/subscribers'
    ];

    function mergeIds(newIds) {
      if (!newIds || !newIds.length) return;
      const combined = new Set(activeChatIds);
      newIds.forEach(function (id) { combined.add(normalizeChatId(id)); });
      activeChatIds = Array.from(combined).filter(Boolean);
      subscriberCount = activeChatIds.length;
      updateRecipientCount();
    }

    watchedPaths.forEach(function (path) {
      bindToLivePath(path, function (snap) {
        try {
          if (!snap || !snap.exists()) return;
          const data = snap.val();
          let ids = [];
          if (path === 'telegramConnected' || path === 'integrations/telegram/connected') {
            ids = ids.concat(extractConnectedChatIds(data));
          }
          ids = ids.concat(extractChatIdsFromNode(data));
          mergeIds(ids);
        } catch (err) {
          console.error('Subscriber listener error (' + path + '):', err);
        }
      });
    });

    collectTelegramChatIds().then(function (ids) {
      if (ids && ids.length) {
        activeChatIds = Array.from(new Set(ids.map(normalizeChatId))).filter(Boolean);
        subscriberCount = activeChatIds.length;
        updateRecipientCount();
      }
    }).catch(function (err) {
      console.error('collectTelegramChatIds error:', err);
    });
  }

  function refreshSubscribers() {
    return collectTelegramChatIds().then(function (ids) {
      activeChatIds = Array.from(new Set((ids || []).map(normalizeChatId))).filter(Boolean);
      subscriberCount = activeChatIds.length;
      updateRecipientCount();
      return activeChatIds;
    });
  }

  function destroy() {
    unsubscribeFns.forEach(function (fn) {
      try { fn(); } catch (e) {}
    });
    unsubscribeFns = [];
    clearTimeout(previewTimer);
  }

  window.__announceModule = {
    init: function (context) {
      if (initialized) return;
      initialized = true;
      ctx = context || {};
      container = document.getElementById('announceContainer');

      if (!container) {
        console.error('announce.js: #announceContainer not found');
        return;
      }

      try {
        renderUI();
        updatePreview();
        initSubscribers();
        loadSendLog();
        if (ctx && ctx.writeAudit) {
          ctx.writeAudit('announcement_ui_loaded');
        }
      } catch (initErr) {
        console.error('announce.js init error:', initErr);
        container.innerHTML = '<div class="card" style="padding:20px;color:var(--red)">⚠️ Announcement module failed to initialize: ' + escapeHtml(initErr && initErr.message ? initErr.message : 'Unknown error') + '</div>';
      }
    },
    getSubscriberCount: function () {
      return subscriberCount;
    },
    refreshSubscribers: function () {
      return refreshSubscribers();
    },
    destroy: function () {
      destroy();
    }
  };
})();