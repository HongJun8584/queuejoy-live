/**
 * announce.js — QueueJoy Announcement Module
 * Handles: composer UI, templates, media attachments, send logic, send logs
 * Loaded by admin.html. Expects window.__ANN_CTX to be set before init.
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

  let ctx = null; // { tRef, get, onValue, set, update, genId, showToast, writeAudit, fileToBase64, formatDate, slug, tenantId }
  let annTarget = { type: 'all' };
  let annMediaFile = null;
  let annMediaDataUrl = null;
  let subscriberCount = 0;

  function el(id) { return document.getElementById(id); }

  function renderUI(container) {
    container.innerHTML = `
      <div class="glass-card" style="padding:22px;margin-bottom:16px">
        <h3 style="font-weight:800;margin-bottom:14px">📢 Compose Announcement</h3>

        <!-- Templates -->
        <label class="field-label" style="margin-top:0">Quick Templates</label>
        <div id="annTemplates" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
          ${TEMPLATES.map((t, i) => `<button class="btn-secondary" data-tpl="${i}" style="font-size:12px;padding:6px 12px">${t.name}</button>`).join('')}
        </div>

        <!-- Font selector -->
        <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
          <div>
            <label class="field-label" style="margin-top:0">Font</label>
            <select id="annFont" class="input-field" style="width:160px;padding:8px 12px;font-size:13px">
              ${FONTS.map(f => `<option value="${f}">${f}</option>`).join('')}
            </select>
          </div>
          <div style="display:flex;gap:4px;margin-top:18px">
            <button class="btn-secondary" id="annBoldBtn" style="padding:6px 10px;font-weight:900;font-size:14px" title="Bold">B</button>
          </div>
        </div>

        <!-- Single composer -->
        <label class="field-label">Message</label>
        <textarea id="annComposer" class="input-field" rows="6" placeholder="Type your announcement here... Use *bold* for emphasis." style="font-size:14px;line-height:1.6"></textarea>

        <!-- Live preview -->
        <label class="field-label">Preview</label>
        <div id="annPreview" style="padding:14px;background:#f9fafb;border-radius:10px;border:1px solid #e5e7eb;font-size:14px;line-height:1.6;min-height:60px;white-space:pre-wrap;word-break:break-word"></div>

        <!-- Media attachment -->
        <label class="field-label">Attach Media</label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <label class="file-upload-btn">📎 Choose File<input type="file" id="annMediaInput" accept="image/*,video/*,audio/*" style="position:absolute;left:-9999px"/></label>
          <span id="annMediaName" style="font-size:12px;color:var(--text-muted)"></span>
          <button id="annMediaClear" class="btn-secondary" style="display:none;padding:4px 10px;font-size:11px">✕ Remove</button>
        </div>
        <p style="margin-top:4px;font-size:11px;color:var(--text-muted)">Images, GIFs, videos, audio. Max 10MB.</p>
        <div id="annMediaPreview" style="margin-top:8px"></div>

        <!-- Target -->
        <label class="field-label">Target Audience</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <div class="target-option selected" data-target="all">🌍 All Subscribers</div>
          <div class="target-option" data-target="list">📋 Specific Chat IDs</div>
        </div>
        <div id="annTargetListWrap" style="display:none;margin-bottom:12px">
          <textarea id="annChatIds" class="input-field" rows="2" placeholder="Comma-separated chat IDs..."></textarea>
        </div>

        <!-- Send -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;flex-wrap:wrap;gap:10px">
          <span class="badge badge-blue" id="annRecipientCount">Estimated: 0 recipients</span>
          <button class="btn-primary" id="annSendBtn">
            <span id="annSendText">📱 Send Now</span>
            <span id="annSendSpinner" style="display:none"><span class="spinner"></span>Sending...</span>
          </button>
        </div>
        <div id="annResult" style="display:none;margin-top:12px;padding:12px;border-radius:8px;font-weight:600;font-size:13px"></div>
      </div>

      <!-- Send Log -->
      <div class="glass-card" style="padding:22px">
        <h3 style="font-weight:800;margin-bottom:14px">📋 Send Log</h3>
        <div id="annSendLog" style="font-size:13px;color:var(--text-muted)">No announcements sent yet.</div>
      </div>
    `;
    bindEvents();
  }

  function bindEvents() {
    // Templates
    el('annTemplates').addEventListener('click', e => {
      const btn = e.target.closest('[data-tpl]');
      if (!btn) return;
      const tpl = TEMPLATES[parseInt(btn.dataset.tpl)];
      if (tpl) { el('annComposer').value = tpl.text; updatePreview(); }
    });

    // Bold
    el('annBoldBtn').addEventListener('click', () => {
      const ta = el('annComposer');
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
    el('annComposer').addEventListener('input', updatePreview);
    el('annFont').addEventListener('change', updatePreview);

    // Media
    el('annMediaInput').addEventListener('change', handleMedia);
    el('annMediaClear').addEventListener('click', clearMedia);

    // Target
    document.querySelectorAll('#view-announcements .target-option, [data-target]').forEach(opt => {
      opt.addEventListener('click', () => {
        document.querySelectorAll('.target-option').forEach(x => x.classList.remove('selected'));
        opt.classList.add('selected');
        annTarget.type = opt.dataset.target;
        el('annTargetListWrap').style.display = annTarget.type === 'list' ? 'block' : 'none';
        updateRecipientCount();
      });
    });

    // Send
    el('annSendBtn').addEventListener('click', doSend);
  }

  function updatePreview() {
    const raw = el('annComposer').value || '';
    const font = el('annFont').value;
    // Convert *bold* to <strong>
    let html = escapeHtml(raw).replace(/\*([^*]+)\*/g, '<strong>$1</strong>');
    html = html.replace(/\n/g, '<br>');
    const prev = el('annPreview');
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
    el('annMediaName').textContent = f.name + ' (' + (f.size / 1024).toFixed(0) + 'KB)';
    el('annMediaClear').style.display = 'inline';

    const prev = el('annMediaPreview');
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
    el('annMediaInput').value = '';
    el('annMediaName').textContent = '';
    el('annMediaClear').style.display = 'none';
    el('annMediaPreview').innerHTML = '';
  }

  function updateRecipientCount() {
    if (annTarget.type === 'list') {
      el('annRecipientCount').textContent = 'Custom list';
    } else {
      el('annRecipientCount').textContent = 'Estimated: ' + subscriberCount + ' recipients';
    }
  }

  async function doSend() {
    const message = el('annComposer').value.trim();
    if (!message) { ctx.showToast('Enter a message', 'error'); return; }

    const font = el('annFont').value;
    const payload = {
      slug: ctx.slug,
      tenantId: ctx.tenantId,
      message,
      font,
      level: 'info',
      target: { ...annTarget }
    };

    if (annTarget.type === 'list') {
      const ids = (el('annChatIds')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!ids.length) { ctx.showToast('Enter chat IDs', 'error'); return; }
      payload.target = { type: 'list', chatIds: ids };
    }

    // CRITICAL: Include media in payload
    if (annMediaFile && annMediaDataUrl) {
      payload.media = annMediaDataUrl;
      payload.mediaType = annMediaFile.type;
      payload.mediaName = annMediaFile.name;
    }

    const btn = el('annSendBtn');
    const text = el('annSendText');
    const spin = el('annSendSpinner');
    const resultDiv = el('annResult');

    btn.disabled = true; text.style.display = 'none'; spin.style.display = 'inline';

    try {
      const res = await fetch('/.netlify/functions/announce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const r = await res.json();

      resultDiv.style.display = 'block';
      if (r && r.success > 0) {
        resultDiv.style.background = '#dcfce7'; resultDiv.style.color = '#065f46';
        resultDiv.innerHTML = `✅ Sent to ${r.success} recipient(s)` + (r.failed ? `<br>⚠️ ${r.failed} failed` : '');
        el('annComposer').value = '';
        clearMedia();
        updatePreview();
        ctx.writeAudit('announcement_sent', { success: r.success, failed: r.failed });
        loadSendLog();
      } else {
        resultDiv.style.background = '#fee2e2'; resultDiv.style.color = '#991b1b';
        resultDiv.textContent = '⚠️ ' + (r?.error || 'Failed to send');
      }
      setTimeout(() => resultDiv.style.display = 'none', 6000);
    } catch (e) {
      ctx.showToast(e.message || 'Error', 'error');
    } finally {
      btn.disabled = false; text.style.display = 'inline'; spin.style.display = 'none';
    }
  }

  function loadSendLog() {
    ctx.get(ctx.tRef('integrations/telegram/sentAnnouncements')).then(snap => {
      const logDiv = el('annSendLog');
      if (!snap.exists()) { logDiv.innerHTML = '<p style="color:var(--text-muted)">No send logs yet.</p>'; return; }
      const data = snap.val();
      const announcements = Object.entries(data).slice(-10).reverse();
      logDiv.innerHTML = announcements.map(([annId, chats]) => {
        const chatEntries = Object.entries(chats || {});
        const ok = chatEntries.filter(([, v]) => v.status === 'ok').length;
        const fail = chatEntries.length - ok;
        const ts = chatEntries[0]?.[1]?.ts;
        return `<div class="audit-entry"><div class="audit-time">${ctx.formatDate(ts)} — ${annId}</div><div style="margin-top:4px"><span class="badge badge-green">${ok} sent</span> ${fail ? `<span class="badge badge-red">${fail} failed</span>` : ''}</div></div>`;
      }).join('');
    }).catch(() => { });
  }

  function initSubscribers() {
    ctx.onValue(ctx.tRef('integrations/telegram/connected'), snap => {
      const obj = snap.exists() ? snap.val() : {};
      subscriberCount = Object.keys(obj || {}).length;
      updateRecipientCount();
    });
    ctx.onValue(ctx.tRef('announcement/chatIds'), snap => {
      if (subscriberCount === 0 && snap.exists()) {
        subscriberCount = Object.keys(snap.val() || {}).length;
        updateRecipientCount();
      }
    });
  }

  // Public API
  window.__announceModule = {
    init(context) {
      ctx = context;
      const container = document.getElementById('announceContainer');
      if (!container) return;
      renderUI(container);
      updatePreview();
      initSubscribers();
      loadSendLog();
    },
    getSubscriberCount() { return subscriberCount; },
    sendQuick(message) { return doSend.call(null, message); }
  };
})();
