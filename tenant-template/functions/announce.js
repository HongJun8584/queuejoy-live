/**
 * announce.js — QueueJoy Announcement Module
 * Handles: composer UI, templates, media attachments, send logic, send logs
 * Loaded by admin.html. Initialized via window.__announceModule.init(ctx).
 *
 * ctx must provide: { tRef, get, onValue, set, update, genId, showToast, writeAudit, fileToBase64, formatDate, slug, tenantId }
 */
(function () {
  'use strict';

  const TEMPLATES = [
    { name: '🎉 Promotion', text: '🎉 *Special Promotion!*\n\nWe have an exciting deal for you today! Don\'t miss out on our limited-time offer.\n\nVisit us now!' },
    { name: '🆕 New Product', text: '🆕 *New Product Alert!*\n\nWe\'re thrilled to introduce our latest addition. Come check it out!\n\nAvailable now.' },
    { name: '📋 Notice', text: '📋 *Important Notice*\n\nPlease be informed of the following update regarding our services.\n\nThank you for your understanding.' },
    { name: '🚨 Urgent Update', text: '🚨 *Urgent Update*\n\nThis is an important message that requires your immediate attention.\n\nPlease read carefully.' },
    { name: '👋 Friendly Reminder', text: '👋 *Friendly Reminder*\n\nJust a quick reminder about our services. We look forward to seeing you!\n\nHave a great day!' },
    { name: '🎄 Holiday Update', text: '🎄 *Holiday Update*\n\nWishing you a wonderful holiday season! Please note our updated hours during this period.\n\nHappy holidays!' },
    { name: '⏰ Service Delay', text: '⏰ *Service Delay Notice*\n\nWe apologize for any inconvenience. There is currently a slight delay in our service.\n\nThank you for your patience.' },
    { name: '💰 Special Offer', text: '💰 *Special Offer!*\n\nFor a limited time only — enjoy exclusive savings on our services.\n\nHurry, offer ends soon!' }
  ];

  const FONTS = ['Inter', 'Poppins', 'Roboto', 'DM Sans', 'Georgia', 'Courier New', 'Arial'];

  let ctx = null;
  let annTarget = { type: 'all' };
  let annMediaFile = null;
  let annMediaDataUrl = null;
  let subscriberCount = 0;
  let container = null; // scoped root
  let initialized = false;

  // Scoped element query — always queries within the module container
  function qel(id) {
    return container ? container.querySelector('#' + id) : document.getElementById(id);
  }

  function renderUI() {
    container.innerHTML = `
      <div class="card fade-in" style="padding:22px;margin-bottom:16px">
        <div class="card-header">📢 Compose Announcement</div>

        <!-- Templates -->
        <label class="field-label" style="margin-top:0">Quick Templates</label>
        <div id="annTemplates" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
          ${TEMPLATES.map((t, i) => `<button class="btn btn-secondary btn-sm" data-ann-tpl="${i}">${t.name}</button>`).join('')}
        </div>

        <!-- Font selector -->
        <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
          <div>
            <label class="field-label" style="margin-top:0">Font</label>
            <select id="annFont" class="input" style="width:160px;padding:8px 12px;font-size:13px">
              ${FONTS.map(f => `<option value="${f}">${f}</option>`).join('')}
            </select>
          </div>
          <div style="display:flex;gap:4px;margin-top:18px">
            <button class="btn btn-secondary btn-sm" id="annBoldBtn" style="font-weight:900;font-size:14px" title="Bold">B</button>
          </div>
        </div>

        <!-- Single composer -->
        <label class="field-label">Message</label>
        <textarea id="annComposer" class="input" rows="6" placeholder="Type your announcement here... Use *bold* for emphasis." style="font-size:14px;line-height:1.6"></textarea>

        <!-- Live preview -->
        <label class="field-label">Preview</label>
        <div id="annPreview" style="padding:14px;background:rgba(255,255,255,0.03);border-radius:10px;border:1px solid var(--border);font-size:14px;line-height:1.6;min-height:60px;white-space:pre-wrap;word-break:break-word;color:var(--text)"></div>

        <!-- Media attachment -->
        <label class="field-label">Attach Media</label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <label class="file-btn">📎 Choose File<input type="file" id="annMediaInput" accept="image/*,video/*,audio/*" style="position:absolute;left:-9999px"/></label>
          <span id="annMediaName" style="font-size:12px;color:var(--text-muted)"></span>
          <button id="annMediaClear" class="btn btn-secondary btn-sm" style="display:none">✕ Remove</button>
        </div>
        <p style="margin-top:4px;font-size:11px;color:var(--text-muted)">Images, GIFs, videos, audio. Max 10MB.</p>
        <div id="annMediaPreview" style="margin-top:8px"></div>

        <!-- Target -->
        <label class="field-label">Target Audience</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <div class="target-opt selected" data-ann-target="all">🌍 All Subscribers</div>
          <div class="target-opt" data-ann-target="list">📋 Specific Chat IDs</div>
        </div>
        <div id="annTargetListWrap" style="display:none;margin-bottom:12px">
          <textarea id="annChatIds" class="input" rows="2" placeholder="Comma-separated chat IDs..."></textarea>
        </div>

        <!-- Send -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;flex-wrap:wrap;gap:10px">
          <span class="badge badge-blue" id="annRecipientCount">Estimated: 0 recipients</span>
          <button class="btn btn-primary" id="annSendBtn">
            <span id="annSendText">📱 Send Now</span>
            <span id="annSendSpinner" style="display:none"><span class="spinner"></span>Sending...</span>
          </button>
        </div>
        <div id="annResult" style="display:none;margin-top:12px;padding:12px;border-radius:8px;font-weight:600;font-size:13px"></div>
      </div>

      <!-- Send Log -->
      <div class="card fade-in" style="padding:22px">
        <div class="card-header">📋 Send Log</div>
        <div id="annSendLog" style="font-size:13px;color:var(--text-muted)">No announcements sent yet.</div>
      </div>
    `;
    bindEvents();
  }

  function bindEvents() {
    // Templates — use scoped data attribute
    const tplContainer = qel('annTemplates');
    if (tplContainer) {
      tplContainer.addEventListener('click', e => {
        const btn = e.target.closest('[data-ann-tpl]');
        if (!btn) return;
        const tpl = TEMPLATES[parseInt(btn.dataset.annTpl)];
        if (tpl) { qel('annComposer').value = tpl.text; updatePreview(); }
      });
    }

    // Bold
    qel('annBoldBtn').addEventListener('click', () => {
      const ta = qel('annComposer');
      const start = ta.selectionStart, end = ta.selectionEnd;
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

    // Live preview
    qel('annComposer').addEventListener('input', updatePreview);
    qel('annFont').addEventListener('change', updatePreview);

    // Media
    qel('annMediaInput').addEventListener('change', handleMedia);
    qel('annMediaClear').addEventListener('click', clearMedia);

    // Target — SCOPED to container only
    container.querySelectorAll('[data-ann-target]').forEach(opt => {
      opt.addEventListener('click', () => {
        container.querySelectorAll('[data-ann-target]').forEach(x => x.classList.remove('selected'));
        opt.classList.add('selected');
        annTarget.type = opt.dataset.annTarget;
        qel('annTargetListWrap').style.display = annTarget.type === 'list' ? 'block' : 'none';
        updateRecipientCount();
      });
    });

    // Send
    qel('annSendBtn').addEventListener('click', doSend);
  }

  function updatePreview() {
    const raw = qel('annComposer').value || '';
    const font = qel('annFont').value;
    let html = escapeHtml(raw).replace(/\*([^*]+)\*/g, '<strong>$1</strong>');
    html = html.replace(/\n/g, '<br>');
    const prev = qel('annPreview');
    prev.innerHTML = html || '<span style="color:var(--text-light)">Preview will appear here...</span>';
    prev.style.fontFamily = font + ', sans-serif';
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function handleMedia(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { ctx.showToast('Max 10MB', 'error'); return; }
    annMediaFile = f;
    qel('annMediaName').textContent = f.name + ' (' + (f.size / 1024).toFixed(0) + 'KB)';
    qel('annMediaClear').style.display = 'inline';

    const prev = qel('annMediaPreview');
    prev.innerHTML = '';
    const url = URL.createObjectURL(f);

    if (f.type.startsWith('video/')) {
      const v = document.createElement('video');
      v.src = url; v.controls = true; v.autoplay = true; v.muted = true; v.loop = true;
      v.style.cssText = 'width:100%;max-width:300px;border-radius:10px';
      prev.appendChild(v);
    } else if (f.type.startsWith('audio/')) {
      const a = document.createElement('audio');
      a.src = url; a.controls = true;
      a.style.cssText = 'width:100%;max-width:300px';
      prev.appendChild(a);
    } else {
      const img = document.createElement('img');
      img.src = url;
      img.style.cssText = 'max-width:300px;width:100%;border-radius:10px';
      prev.appendChild(img);
    }

    // Pre-read as base64 for payload
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
    if (prev) prev.innerHTML = '';
  }

  function updateRecipientCount() {
    const el = qel('annRecipientCount');
    if (!el) return;
    if (annTarget.type === 'list') {
      el.textContent = 'Custom list';
    } else {
      el.textContent = 'Estimated: ' + subscriberCount + ' recipients';
    }
  }

  async function doSend() {
    const composerEl = qel('annComposer');
    const message = (composerEl ? composerEl.value : '').trim();
    if (!message) { ctx.showToast('Enter a message', 'error'); return; }

    const font = qel('annFont').value;

    // Build strict payload
    const payload = {
      slug: ctx.slug,
      tenantId: ctx.tenantId,
      message: message,
      font: font,
      level: 'info'
    };

    // Build explicit target
    if (annTarget.type === 'list') {
      const raw = (qel('annChatIds')?.value || '');
      // Split by comma, newline, or space — trim and deduplicate
      const ids = [...new Set(
        raw.split(/[,\n\s]+/).map(s => s.trim()).filter(Boolean)
      )];
      if (!ids.length) { ctx.showToast('Enter at least one chat ID', 'error'); return; }
      payload.target = { type: 'list', chatIds: ids };
    } else {
      payload.target = { type: 'all' };
    }

    // Include media if attached
    if (annMediaFile && annMediaDataUrl) {
      payload.media = annMediaDataUrl;
      payload.mediaType = annMediaFile.type;
      payload.mediaName = annMediaFile.name;
    }

    const btn = qel('annSendBtn');
    const text = qel('annSendText');
    const spin = qel('annSendSpinner');
    const resultDiv = qel('annResult');

    btn.disabled = true;
    text.style.display = 'none';
    spin.style.display = 'inline';

    try {
      const res = await fetch('/.netlify/functions/announce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      let r;
      try {
        r = await res.json();
      } catch {
        r = null;
      }

      resultDiv.style.display = 'block';

      if (!res.ok) {
        // HTTP error — show it clearly
        resultDiv.style.background = 'rgba(239,68,68,0.1)';
        resultDiv.style.color = 'var(--red)';
        resultDiv.textContent = '⚠️ Server error (' + res.status + '): ' + (r?.error || r?.message || 'Unknown error');
        // Do NOT clear composer on failure
        // Do NOT write audit on failure
      } else if (r && r.success > 0) {
        resultDiv.style.background = 'rgba(16,185,129,0.1)';
        resultDiv.style.color = 'var(--green)';
        resultDiv.innerHTML = `✅ Sent to ${r.success} recipient(s)` + (r.failed ? ` · ⚠️ ${r.failed} failed` : '');
        // Clear composer only on success
        composerEl.value = '';
        clearMedia();
        updatePreview();
        ctx.writeAudit('announcement_sent', { success: r.success, failed: r.failed || 0, mode: annTarget.type });
        loadSendLog();
      } else if (r && r.success === 0 && r.failed > 0) {
        resultDiv.style.background = 'rgba(239,68,68,0.1)';
        resultDiv.style.color = 'var(--red)';
        resultDiv.textContent = '⚠️ All ' + r.failed + ' delivery attempts failed';
      } else {
        resultDiv.style.background = 'rgba(239,68,68,0.1)';
        resultDiv.style.color = 'var(--red)';
        resultDiv.textContent = '⚠️ ' + (r?.error || r?.message || 'No recipients or unknown response');
      }
      setTimeout(() => { if (resultDiv) resultDiv.style.display = 'none'; }, 8000);
    } catch (e) {
      ctx.showToast('Network error: ' + (e.message || 'Failed to connect'), 'error');
    } finally {
      btn.disabled = false;
      text.style.display = 'inline';
      spin.style.display = 'none';
    }
  }

  function loadSendLog() {
    ctx.get(ctx.tRef('integrations/telegram/sentAnnouncements')).then(snap => {
      const logDiv = qel('annSendLog');
      if (!logDiv) return;
      if (!snap.exists()) { logDiv.innerHTML = '<p style="color:var(--text-muted)">No send logs yet.</p>'; return; }
      const data = snap.val();
      if (!data || typeof data !== 'object') { logDiv.innerHTML = '<p style="color:var(--text-muted)">No send logs yet.</p>'; return; }
      const announcements = Object.entries(data).slice(-10).reverse();
      if (!announcements.length) { logDiv.innerHTML = '<p style="color:var(--text-muted)">No send logs yet.</p>'; return; }
      logDiv.innerHTML = announcements.map(([annId, chats]) => {
        const chatEntries = (chats && typeof chats === 'object') ? Object.entries(chats) : [];
        const ok = chatEntries.filter(([, v]) => v && v.status === 'ok').length;
        const fail = chatEntries.length - ok;
        const ts = chatEntries[0]?.[1]?.ts;
        return `<div class="audit-entry"><div class="audit-time">${ctx.formatDate(ts)} — ${annId}</div><div style="margin-top:4px"><span class="badge badge-green">${ok} sent</span> ${fail ? `<span class="badge badge-red">${fail} failed</span>` : ''}</div></div>`;
      }).join('');
    }).catch(() => {
      const logDiv = qel('annSendLog');
      if (logDiv) logDiv.innerHTML = '<p style="color:var(--text-muted)">Could not load send logs.</p>';
    });
  }

  function initSubscribers() {
    // Primary source: announcement/chatIds (explicit subscriber list)
    ctx.onValue(ctx.tRef('announcement/chatIds'), snap => {
      if (snap.exists()) {
        const obj = snap.val();
        if (obj && typeof obj === 'object') {
          subscriberCount = Object.keys(obj).length;
          updateRecipientCount();
          return;
        }
      }
      subscriberCount = 0;
      updateRecipientCount();
    });

    // Fallback source: integrations/telegram/connected
    ctx.onValue(ctx.tRef('integrations/telegram/connected'), snap => {
      if (subscriberCount > 0) return; // primary already populated
      if (snap.exists()) {
        const obj = snap.val();
        if (obj && typeof obj === 'object') {
          subscriberCount = Object.keys(obj).length;
          updateRecipientCount();
          return;
        }
      }
    });

    // Secondary fallback: count unique chatIds from telegram tokens
    ctx.onValue(ctx.tRef('integrations/telegram/tokens'), snap => {
      if (subscriberCount > 0) return; // already populated from above
      if (snap.exists()) {
        const obj = snap.val();
        if (obj && typeof obj === 'object') {
          const uniqueChatIds = new Set();
          Object.values(obj).forEach(tok => {
            if (tok && tok.chatId && tok.used) {
              uniqueChatIds.add(String(tok.chatId));
            }
          });
          if (uniqueChatIds.size > 0) {
            subscriberCount = uniqueChatIds.size;
            updateRecipientCount();
          }
        }
      }
    });
  }

  // Public API
  window.__announceModule = {
    init(context) {
      if (initialized) return; // prevent double init
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
    },
    getSubscriberCount() { return subscriberCount; }
  };
})();