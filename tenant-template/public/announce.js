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
    var s = String(v == null ? '' : v).trim();
    return s.length ? s : fallback;
  }

  function parseChatIds(raw) {
    if (!raw || typeof raw !== 'string') return [];
    return [].concat(Array.from(new Set(raw.split(/[\n,\s]+/).map(function(s){ return s.trim(); }).filter(Boolean))));
  }

  function normalizeChatId(v) {
    if (v === null || v === undefined) return '';
    return String(v).trim();
  }

  function extractChatIdsFromNode(node) {
    var ids = new Set();
    function walk(value) {
      if (!value) return;
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (typeof value !== 'object') return;
      if (typeof value.chatId !== 'undefined') {
        var cid = normalizeChatId(value.chatId);
        if (cid) ids.add(cid);
      }
      if (typeof value.telegramChatId !== 'undefined') {
        var tid = normalizeChatId(value.telegramChatId);
        if (tid) ids.add(tid);
      }
      var keys = Object.keys(value);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k === 'chatId' || k === 'telegramChatId') continue;
        if (typeof value[k] === 'object' && value[k] !== null) walk(value[k]);
      }
    }
    walk(node);
    return Array.from(ids).filter(Boolean);
  }

  /**
   * Also extract chat IDs from keys of telegramConnected
   * where the key itself IS the chatId
   */
  function extractConnectedChatIds(node) {
    var ids = [];
    if (!node || typeof node !== 'object') return ids;
    var keys = Object.keys(node);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      // If key looks numeric, it's a chatId used as key
      if (/^\d+$/.test(k)) {
        ids.push(k);
      }
      // Also check nested chatId
      if (node[k] && typeof node[k] === 'object' && node[k].chatId) {
        ids.push(normalizeChatId(node[k].chatId));
      }
    }
    return ids.filter(Boolean);
  }

  function setRecipientCountText(text) {
    var el = qel('annRecipientCount');
    if (el) el.textContent = text;
  }

  function renderUI() {
    if (!container) return;

    container.innerHTML =
      '<div class="card ann-fade-in" style="padding:22px;margin-bottom:16px">' +
        '<div class="card-header">📢 Compose Announcement</div>' +
        '<label class="field-label" style="margin-top:0">Quick Templates</label>' +
        '<div id="annTemplates" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">' +
          TEMPLATES.map(function(t, i) { return '<button type="button" class="btn btn-secondary btn-sm ann-tpl-btn" data-ann-tpl="' + i + '">' + escapeHtml(t.name) + '</button>'; }).join('') +
        '</div>' +
        '<div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;flex-wrap:wrap">' +
          '<div>' +
            '<label class="field-label" style="margin-top:0">Font</label>' +
            '<select id="annFont" class="input" style="width:160px;padding:8px 12px;font-size:13px">' +
              FONTS.map(function(f) { return '<option value="' + escapeHtml(f) + '">' + escapeHtml(f) + '</option>'; }).join('') +
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
    var tplContainer = qel('annTemplates');
    if (tplContainer) {
      tplContainer.addEventListener('click', function(e) {
        var btn = e.target.closest('[data-ann-tpl]');
        if (!btn) return;
        var idx = parseInt(btn.dataset.annTpl, 10);
        var tpl = TEMPLATES[idx];
        var composer = qel('annComposer');
        if (tpl && composer) {
          composer.value = tpl.text;
          updatePreview();
        }
      });
    }

    var boldBtn = qel('annBoldBtn');
    if (boldBtn) {
      boldBtn.addEventListener('click', function() {
        var ta = qel('annComposer');
        if (!ta) return;
        var start = ta.selectionStart;
        var end = ta.selectionEnd;
        var val = ta.value;
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

    var composer = qel('annComposer');
    if (composer) composer.addEventListener('input', schedulePreview);
    var fontSel = qel('annFont');
    if (fontSel) fontSel.addEventListener('change', updatePreview);

    var mediaInput = qel('annMediaInput');
    if (mediaInput) mediaInput.addEventListener('change', handleMedia);
    var mediaClear = qel('annMediaClear');
    if (mediaClear) mediaClear.addEventListener('click', clearMedia);

    var targetGroup = qel('annTargetGroup');
    if (targetGroup) {
      targetGroup.querySelectorAll('[data-ann-target]').forEach(function(opt) {
        opt.addEventListener('click', function() {
          targetGroup.querySelectorAll('[data-ann-target]').forEach(function(x) { x.classList.remove('selected'); });
          opt.classList.add('selected');
          annTarget.type = opt.dataset.annTarget;
          var listWrap = qel('annTargetListWrap');
          if (listWrap) listWrap.style.display = annTarget.type === 'list' ? 'block' : 'none';
          updateRecipientCount();
        });
      });
    }

    var sendBtn = qel('annSendBtn');
    if (sendBtn) sendBtn.addEventListener('click', doSend);
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 150);
  }

  function updatePreview() {
    var raw = (qel('annComposer') || {}).value || '';
    var font = (qel('annFont') || {}).value || 'Inter';
    var prev = qel('annPreview');
    var charEl = qel('annCharCount');
    if (charEl) charEl.textContent = raw.length + ' / ' + MAX_MESSAGE_CHARS;
    if (!prev) return;

    var safe = escapeHtml(raw)
      .replace(/\*([^*]+)\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');

    prev.innerHTML = safe || '<span style="color:var(--text-light)">Preview will appear here...</span>';
    prev.style.fontFamily = font + ', sans-serif';
  }

  function handleMedia(e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) {
      if (ctx && ctx.showToast) ctx.showToast('Max 10MB', 'error');
      return;
    }

    if (annMediaFile && annMediaFile.name === f.name && annMediaFile.size === f.size) return;

    annMediaFile = f;
    var nameEl = qel('annMediaName');
    if (nameEl) nameEl.textContent = f.name + ' (' + (f.size / 1024).toFixed(0) + 'KB)';
    var clearBtn = qel('annMediaClear');
    if (clearBtn) clearBtn.style.display = 'inline';

    var prev = qel('annMediaPreview');
    if (prev) {
      var oldVid = prev.querySelector('video');
      if (oldVid) { oldVid.pause(); try { oldVid.removeAttribute('src'); oldVid.load(); } catch(ex){} }
      var oldAudio = prev.querySelector('audio');
      if (oldAudio) { oldAudio.pause(); try { oldAudio.removeAttribute('src'); } catch(ex){} }
      prev.innerHTML = '';

      try {
        if (f.type.startsWith('video/')) {
          var url = URL.createObjectURL(f);
          var placeholder = document.createElement('div');
          placeholder.className = 'media-placeholder';
          placeholder.innerHTML =
            '<div class="mp-meta"><span class="mp-icon">🎬</span><div><div style="font-weight:600;font-size:12px;color:var(--text)">' + escapeHtml(f.name) + '</div><div style="font-size:10px;color:var(--text-light)">' + (f.size / 1024).toFixed(0) + ' KB</div></div></div>' +
            '<button type="button" class="btn btn-secondary btn-sm mp-load-btn">▶ Load Preview</button>';
          var loadBtn = placeholder.querySelector('.mp-load-btn');
          loadBtn.addEventListener('click', function() {
            loadBtn.innerHTML = '<span class="spinner"></span> Loading...';
            loadBtn.disabled = true;
            var v = document.createElement('video');
            v.preload = 'none';
            v.controls = true;
            v.muted = true;
            v.playsInline = true;
            v.style.cssText = 'width:100%;max-width:300px;border-radius:10px';
            v.onloadeddata = function() { placeholder.replaceWith(v); };
            v.onerror = function() { loadBtn.textContent = '⚠️ Failed'; loadBtn.disabled = false; };
            v.src = url;
            v.load();
          });
          prev.appendChild(placeholder);
        } else if (f.type.startsWith('audio/')) {
          var aUrl = URL.createObjectURL(f);
          var a = document.createElement('audio');
          a.src = aUrl;
          a.controls = true;
          a.style.cssText = 'width:100%;max-width:300px';
          prev.appendChild(a);
        } else {
          var iUrl = URL.createObjectURL(f);
          var img = document.createElement('img');
          img.src = iUrl;
          img.loading = 'lazy';
          img.style.cssText = 'max-width:300px;width:100%;border-radius:10px';
          prev.appendChild(img);
        }
      } catch (mediaErr) {
        console.error('Media preview error:', mediaErr);
        prev.innerHTML = '<div style="color:var(--text-muted);font-size:12px">Could not preview media</div>';
      }
    }

    annMediaDataUrl = null;
    var reader = new FileReader();
    reader.onload = function() { annMediaDataUrl = reader.result; };
    reader.onerror = function() { console.error('Failed to read media file'); };
    reader.readAsDataURL(f);
  }

  function clearMedia() {
    annMediaFile = null;
    annMediaDataUrl = null;
    var input = qel('annMediaInput');
    if (input) input.value = '';
    var name = qel('annMediaName');
    if (name) name.textContent = '';
    var clearBtn = qel('annMediaClear');
    if (clearBtn) clearBtn.style.display = 'none';
    var prev = qel('annMediaPreview');
    if (prev) {
      var oldVid = prev.querySelector('video');
      if (oldVid) { oldVid.pause(); try { oldVid.removeAttribute('src'); } catch(ex){} }
      prev.innerHTML = '';
    }
  }

  function updateRecipientCount() {
    var el = qel('annRecipientCount');
    if (!el) return;

    if (annTarget.type === 'list') {
      var raw = (qel('annChatIds') || {}).value || '';
      var ids = parseChatIds(raw);
      el.textContent = ids.length > 0 ? 'Custom list: ' + ids.length + ' ID(s)' : 'Custom list: 0 IDs';
      return;
    }

    el.textContent = subscriberCount > 0
      ? 'Estimated: ' + subscriberCount + ' recipients'
      : 'Estimated: 0 recipients (no Telegram subscribers found)';
  }

  function doSend() {
    if (sending) return;

    var composerEl = qel('annComposer');
    var message = (composerEl ? composerEl.value : '').trim();
    if (!message) {
      if (ctx && ctx.showToast) ctx.showToast('Enter a message', 'error');
      return;
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      if (ctx && ctx.showToast) ctx.showToast('Message too long (max ' + MAX_MESSAGE_CHARS + ' chars)', 'error');
      return;
    }

    var font = (qel('annFont') || {}).value || 'Inter';
    var payload = {
      slug: ctx ? ctx.slug : '',
      tenantId: ctx ? ctx.tenantId : '',
      message: message,
      font: font,
      level: 'info',
      source: 'admin-ui'
    };

    if (annTarget.type === 'list') {
      var raw = (qel('annChatIds') || {}).value || '';
      var ids = parseChatIds(raw);
      if (!ids.length) {
        if (ctx && ctx.showToast) ctx.showToast('Enter at least one chat ID', 'error');
        return;
      }
      payload.target = { type: 'list', chatIds: ids };
    } else {
      payload.target = { type: 'all' };
      if (activeChatIds.length) {
        payload.telegramChatIds = activeChatIds.map(String);
      }
      if (activeChatIds.length === 0) {
        if (ctx && ctx.showToast) ctx.showToast('No Telegram-connected customers found. Cannot send.', 'error');
        showResult('⚠️ No recipients found. Connect customers via Telegram first.', true);
        return;
      }
    }

    if (annMediaFile && annMediaDataUrl) {
      var base64Size = annMediaDataUrl.length;
      if (base64Size > MAX_MEDIA_BYTES * 1.37) {
        if (ctx && ctx.showToast) ctx.showToast('Media too large for inline send. Sending text only.', 'error');
      } else {
        payload.media = annMediaDataUrl;
        payload.mediaType = annMediaFile.type;
        payload.mediaName = annMediaFile.name;
      }
    }

    var btn = qel('annSendBtn');
    var text = qel('annSendText');
    var spin = qel('annSendSpinner');

    sending = true;
    if (btn) btn.disabled = true;
    if (text) text.style.display = 'none';
    if (spin) spin.style.display = 'inline';

    sendWithRetry(payload).then(function(res) {
      var bodyPromise;
      try { bodyPromise = res.json(); } catch(e) { bodyPromise = Promise.resolve(null); }
      return bodyPromise.then(function(body) {
        if (!res.ok) {
          var errorMsg = 'Unknown error';
          if (body) {
            errorMsg = body.error || body.message || body.details || JSON.stringify(body).slice(0, 240);
          }
          if (res.status === 413 || /too large|payload|size/i.test(String(errorMsg))) {
            errorMsg = 'Payload too large. Remove media or shorten the message.';
          }
          showResult('⚠️ Server error (' + res.status + '): ' + errorMsg, true);
          return;
        }

        if (body && body.success > 0) {
          var msg = '✅ Sent to ' + body.success + ' recipient(s)';
          if (body.failed) msg += ' · ⚠️ ' + body.failed + ' failed';
          showResult(msg, false);
          if (composerEl) composerEl.value = '';
          clearMedia();
          updatePreview();
          if (ctx && ctx.writeAudit) ctx.writeAudit('announcement_sent', { success: body.success, failed: body.failed || 0, mode: annTarget.type });
          loadSendLog();
          return;
        }

        if (body && body.success === 0 && body.failed > 0) {
          showResult('⚠️ All ' + body.failed + ' delivery attempts failed', true);
          return;
        }

        var fallbackMsg = (body && (body.error || body.message)) || 'No recipients or unknown response';
        showResult('⚠️ ' + fallbackMsg, true);
      });
    }).catch(function(e) {
      if (ctx && ctx.showToast) ctx.showToast('Network error: ' + (e.message || 'Failed to connect'), 'error');
      showResult('⚠️ Network error: ' + (e.message || 'Failed to connect'), true);
    }).finally(function() {
      sending = false;
      if (btn) btn.disabled = false;
      if (text) text.style.display = 'inline';
      if (spin) spin.style.display = 'none';
    });
  }

  function showResult(msg, isError) {
    var resultDiv = qel('annResult');
    if (!resultDiv) return;
    resultDiv.style.display = 'block';
    if (isError) {
      resultDiv.style.background = 'rgba(239,68,68,0.1)';
      resultDiv.style.color = 'var(--red)';
    } else {
      resultDiv.style.background = 'rgba(16,185,129,0.1)';
      resultDiv.style.color = 'var(--green)';
    }
    resultDiv.textContent = msg;
  }

  function sendWithRetry(payload) {
    function doFetch() {
      return fetch('/.netlify/functions/announce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    return doFetch().then(function(res) {
      if (res.status === 502 || res.status === 503) {
        return new Promise(function(r) { setTimeout(r, 1500); }).then(doFetch);
      }
      return res;
    }).catch(function() {
      // Retry once on network error
      return new Promise(function(r) { setTimeout(r, 1000); }).then(doFetch);
    });
  }

  function getFirstTs(chats) {
    if (!chats || typeof chats !== 'object') return 0;
    var vals = Object.values(chats);
    for (var i = 0; i < vals.length; i++) {
      if (vals[i] && vals[i].ts) return vals[i].ts;
    }
    return 0;
  }

  function renderSendLogRows(data) {
    var announcements = Object.entries(data)
      .sort(function(a, b) { return getFirstTs(b[1]) - getFirstTs(a[1]); })
      .slice(0, 10);

    if (!announcements.length) return '<p style="color:var(--text-muted)">No send logs yet.</p>';

    return announcements.map(function(entry) {
      var annId = entry[0];
      var chats = entry[1];
      var chatEntries = (chats && typeof chats === 'object') ? Object.entries(chats) : [];
      var ok = chatEntries.filter(function(ce) { return ce[1] && ce[1].status === 'ok'; }).length;
      var fail = chatEntries.length - ok;
      var ts = chatEntries[0] && chatEntries[0][1] ? chatEntries[0][1].ts : null;
      var dateStr = ctx && ctx.formatDate ? ctx.formatDate(ts) : (ts ? new Date(ts).toLocaleString() : '—');
      return '<div class="audit-entry" style="transition:background .15s"><div class="audit-time">' + escapeHtml(dateStr) + ' — ' + escapeHtml(annId) + '</div><div style="margin-top:4px"><span class="badge badge-green">' + ok + ' sent</span> ' + (fail ? '<span class="badge badge-red">' + fail + ' failed</span>' : '') + '</div></div>';
    }).join('');
  }

  function loadSendLog() {
    if (!ctx || !ctx.get) return;
    ctx.get(ctx.tRef('integrations/telegram/sentAnnouncements')).then(function(snap) {
      var logDiv = qel('annSendLog');
      if (!logDiv) return;
      if (!snap.exists()) { logDiv.innerHTML = '<p style="color:var(--text-muted)">No send logs yet.</p>'; return; }
      var data = snap.val();
      if (!data || typeof data !== 'object') { logDiv.innerHTML = '<p style="color:var(--text-muted)">No send logs yet.</p>'; return; }
      logDiv.innerHTML = renderSendLogRows(data);
    }).catch(function() {
      var logDiv = qel('annSendLog');
      if (logDiv) logDiv.innerHTML = '<p style="color:var(--text-muted)">Could not load send logs.</p>';
    });
  }

  /**
   * Collect Telegram chat IDs from all known Firebase paths
   * under the current tenant scope
   */
  function collectTelegramChatIds() {
    var ids = new Set();
    var paths = [
      'telegramConnected',
      'telegramTokens',
      'integrations/telegram/tokens',
      'integrations/telegram/connected',
      'integrations/telegram/chatIds'
    ];

    return Promise.all(paths.map(function(path) {
      if (!ctx || !ctx.get) return Promise.resolve(null);
      return ctx.get(ctx.tRef(path)).then(function(snap) {
        if (!snap.exists()) return null;
        return { path: path, data: snap.val() };
      }).catch(function() { return null; });
    })).then(function(results) {
      results.forEach(function(r) {
        if (!r || !r.data) return;
        // For telegramConnected, keys ARE the chatIds
        if (r.path === 'telegramConnected') {
          extractConnectedChatIds(r.data).forEach(function(id) { ids.add(id); });
        }
        // Always do deep extraction too
        extractChatIdsFromNode(r.data).forEach(function(id) { ids.add(id); });
      });
      var result = Array.from(ids).filter(Boolean);
      return result;
    });
  }

  function initSubscribers() {
    // Watch real-time for changes
    var watchedPaths = [
      'telegramConnected',
      'telegramTokens',
      'integrations/telegram/tokens',
      'integrations/telegram/connected'
    ];

    function mergeIds(newIds) {
      if (!newIds || !newIds.length) return;
      var combined = new Set(activeChatIds);
      newIds.forEach(function(id) { combined.add(id); });
      activeChatIds = Array.from(combined).filter(Boolean);
      subscriberCount = activeChatIds.length;
      updateRecipientCount();
    }

    watchedPaths.forEach(function(path) {
      try {
        ctx.onValue(ctx.tRef(path), function(snap) {
          try {
            if (!snap.exists()) return;
            var data = snap.val();
            var ids = [];
            if (path === 'telegramConnected') {
              ids = extractConnectedChatIds(data);
            }
            ids = ids.concat(extractChatIdsFromNode(data));
            mergeIds(ids);
          } catch (err) {
            console.error('Subscriber listener error (' + path + '):', err);
          }
        });
      } catch (err) {
        console.error('Failed to watch path ' + path + ':', err);
      }
    });

    // Also do a one-time full collection
    collectTelegramChatIds().then(function(ids) {
      if (ids.length) mergeIds(ids);
    }).catch(function(err) {
      console.error('collectTelegramChatIds error:', err);
    });
  }

  function bindChatIdCounter() {
    var chatInput = qel('annChatIds');
    if (chatInput) chatInput.addEventListener('input', updateRecipientCount);
  }

  // Expose module globally
  window.__announceModule = {
    init: function(context) {
      if (initialized) return;
      initialized = true;
      ctx = context;
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
        bindChatIdCounter();
        if (ctx && ctx.writeAudit) ctx.writeAudit('announcement_ui_loaded');
      } catch (initErr) {
        console.error('announce.js init error:', initErr);
        container.innerHTML = '<div class="card" style="padding:20px;color:var(--red)">⚠️ Announcement module failed to initialize: ' + escapeHtml(initErr.message) + '</div>';
      }
    },
    getSubscriberCount: function() {
      return subscriberCount;
    },
    refreshSubscribers: function() {
      return collectTelegramChatIds().then(function(ids) {
        activeChatIds = ids;
        subscriberCount = ids.length;
        updateRecipientCount();
        return ids;
      });
    }
  };
})();
