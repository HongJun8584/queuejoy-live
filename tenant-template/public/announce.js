/* /tenant-template/public/announce.js
 * QueueJoy Announcements — browser-safe.
 * Exposes window.__announceModule = { init(ctx) }
 *
 * ctx (provided by admin.html setupAnnouncementsUI):
 *   { tRef, get, onValue, set, update, genId, showToast, writeAudit,
 *     fileToBase64, formatDate, slug, tenantId }
 *
 * Features:
 *  - Plain-text message (no programmer prefixes)
 *  - Templates: Promotion / Reminder / Open / Closed / Custom
 *  - Lazy video preview (placeholder + click-to-load, preload="none")
 *  - Optional media (image/video/audio) sent through the Netlify function
 *  - Delivery summary: sent / failed / total
 *  - Recent delivery logs from public/announcementLogs (read-only)
 */
(function () {
  'use strict';

  var DEFAULT_ENDPOINT = '/.netlify/functions/announce';
  var STYLE_ID = 'qj-announce-ui-styles';
  var ROOT_ID = 'qj-announce-root';

  var state = {
    mounted: false,
    bound: false,
    sending: false,
    media: null,             // { kind, dataUrl, type, name, size }  -- preview/upload only
    logsUnsub: null,
    ctx: null,
  };
  var dom = {};

  // ---------- Templates (admin can pick a starter, then edit freely) ----------
  var TEMPLATES = [
    { id: 'custom',    label: '✏️  Custom (blank)', text: '' },
    { id: 'promo',     label: '🎉 Promotion',
      text: '🎉 Today only!\n\nGet 20% off your next order.\nShow this message at the counter to claim.\n\nThanks for queueing with us!' },
    { id: 'reminder',  label: '🔔 Reminder',
      text: '🔔 Friendly reminder:\nYour queue is almost ready. Please return to the counter when your number is called. Thank you!' },
    { id: 'open',      label: '🟢 We’re Open',
      text: '🟢 We are now OPEN!\nGrab your queue number and join us — we’d love to serve you today.' },
    { id: 'closed',    label: '🔴 We’re Closed',
      text: '🔴 We are now CLOSED for the day.\nThank you for visiting. See you again tomorrow!' },
    { id: 'delay',     label: '⏳ Slight Delay',
      text: '⏳ Heads up:\nWe are running a few minutes behind right now. We appreciate your patience and will call your number shortly.' },
    { id: 'thanks',    label: '🙏 Thank You',
      text: '🙏 Thank you for queueing with us today!\nWe hope you had a great experience. See you again soon.' }
  ];

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(v) {
    if (v == null) return '';
    return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                     .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function normalizeIds(raw) {
    return String(raw || '').split(',').map(function(s){ return s.trim(); }).filter(Boolean);
  }
  function formatBytes(b) {
    if (!b && b !== 0) return '';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
    return (b/1048576).toFixed(1) + ' MB';
  }
  function setStatus(msg, kind) {
    var el = dom.result; if (!el) return;
    el.textContent = msg || '';
    el.dataset.kind = kind || 'info';
    el.style.display = msg ? 'block' : 'none';
  }
  function fileToDataUrl(file) {
    return new Promise(function(res, rej) {
      var r = new FileReader();
      r.onload = function(){ res(String(r.result || '')); };
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }
  function guessMediaKind(file) {
    if (!file) return 'unknown';
    var t = (file.type || '').toLowerCase();
    if (t === 'image/gif') return 'gif';
    if (t.indexOf('image/') === 0) return 'image';
    if (t.indexOf('video/') === 0) return 'video';
    if (t.indexOf('audio/') === 0) return 'audio';
    return 'unknown';
  }

  // ---------- styles ----------
  function ensureStyles() {
    if ($(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '.qj-ann-wrap{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(280px,.95fr);gap:16px;align-items:start}',
      '.qj-ann-card{background:var(--card-solid);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-card)}',
      '.qj-ann-head{padding:16px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:flex-start;gap:12px}',
      '.qj-ann-title{font-size:16px;font-weight:800;color:var(--text)}',
      '.qj-ann-sub{font-size:12px;color:var(--text-muted);margin-top:4px;line-height:1.45}',
      '.qj-ann-body{padding:18px}',
      '.qj-ann-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
      '.qj-ann-full{grid-column:1/-1}',
      '.qj-ann-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}',
      '.qj-ann-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;border:1px solid var(--border);background:rgba(255,255,255,.03);font-size:12px;color:var(--text-muted);font-weight:600}',
      '.qj-ann-chip strong{color:var(--text)}',
      '.qj-ann-help{font-size:12px;line-height:1.55;color:var(--text-muted)}',
      '.qj-ann-help code{font-size:11px;padding:2px 6px;border-radius:6px;background:rgba(255,255,255,.05);border:1px solid var(--border)}',
      '.qj-ann-preview{margin-top:10px;border:1px dashed var(--border);border-radius:12px;padding:12px;background:rgba(255,255,255,.02)}',
      '.qj-ann-preview img{max-width:100%;max-height:220px;border-radius:10px;display:block}',
      '.qj-ann-preview audio{width:100%}',
      '.qj-ann-vph{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:rgba(0,0,0,.04)}',
      '.qj-ann-status{margin-top:12px;padding:12px 14px;border-radius:12px;border:1px solid var(--border);background:rgba(255,255,255,.03);font-size:13px;display:none;white-space:pre-wrap;color:var(--text)}',
      '.qj-ann-status[data-kind="success"]{border-color:rgba(16,185,129,.35);background:rgba(16,185,129,.09);color:#10b981}',
      '.qj-ann-status[data-kind="error"]{border-color:rgba(239,68,68,.35);background:rgba(239,68,68,.09);color:#ef4444}',
      '.qj-ann-status[data-kind="info"]{border-color:rgba(102,126,234,.25);background:rgba(102,126,234,.08);color:#667eea}',
      '.qj-ann-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px}',
      '.qj-sum-card{padding:10px 12px;border:1px solid var(--border);border-radius:10px;text-align:center;background:rgba(255,255,255,.02)}',
      '.qj-sum-card .v{font-size:20px;font-weight:800;color:var(--text)}',
      '.qj-sum-card .l{font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.6px;margin-top:2px}',
      '.qj-sum-card.ok .v{color:#10b981}.qj-sum-card.fail .v{color:#ef4444}.qj-sum-card.tot .v{color:#667eea}',
      '.qj-ann-send{min-width:170px;justify-content:center}',
      '.qj-log-item{padding:12px 14px;border:1px solid var(--border);border-radius:12px;background:rgba(255,255,255,.02);margin-bottom:10px}',
      '.qj-log-top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}',
      '.qj-log-title{font-weight:700;font-size:13px;color:var(--text)}',
      '.qj-log-meta{font-size:11px;color:var(--text-muted);margin-top:4px;line-height:1.45}',
      '.qj-log-badges{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}',
      '.qj-log-badge{font-size:11px;padding:4px 8px;border-radius:999px;font-weight:700}',
      '.qj-log-badge.ok{background:rgba(16,185,129,.12);color:#10b981}',
      '.qj-log-badge.fail{background:rgba(239,68,68,.12);color:#ef4444}',
      '.qj-log-badge.total{background:rgba(102,126,234,.12);color:#667eea}',
      '.qj-log-empty{padding:20px;border:1px dashed var(--border);border-radius:12px;color:var(--text-muted);text-align:center;font-size:13px;background:rgba(255,255,255,.02)}',
      '.qj-mini{font-size:11px;color:var(--text-light)}',
      '.qj-loading{display:inline-flex;align-items:center;gap:8px}',
      '@media (max-width:1024px){.qj-ann-wrap{grid-template-columns:1fr}.qj-ann-grid{grid-template-columns:1fr}}'
    ].join('');
    document.head.appendChild(st);
  }

  // ---------- shell ----------
  function renderShell() {
    var host = $('announceContainer') || $('view-announcements') || document.body;
    var root = $(ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      if (host.id === 'announceContainer') { host.innerHTML = ''; }
      host.appendChild(root);
    }
    dom.root = root;

    var tplOpts = TEMPLATES.map(function(t){
      return '<option value="' + esc(t.id) + '">' + esc(t.label) + '</option>';
    }).join('');

    root.innerHTML = ''
      + '<div class="qj-ann-wrap">'
      +   '<div class="qj-ann-card">'
      +     '<div class="qj-ann-head">'
      +       '<div>'
      +         '<div class="qj-ann-title">📣 Send Announcement</div>'
      +         '<div class="qj-ann-sub">Send a Telegram message to all connected customers, or to specific chat IDs.</div>'
      +       '</div>'
      +       '<div class="qj-ann-chip" title="Tenant"><span>Tenant</span><strong id="announceTenantChip">—</strong></div>'
      +     '</div>'
      +     '<div class="qj-ann-body">'
      +       '<div class="qj-ann-grid">'

      +         '<div>'
      +           '<label class="field-label" style="margin-top:0">Template</label>'
      +           '<select class="input" id="announceTemplate">' + tplOpts + '</select>'
      +           '<div class="qj-ann-help" style="margin-top:6px">Pick a starter, then edit the text below.</div>'
      +         '</div>'

      +         '<div>'
      +           '<label class="field-label" style="margin-top:0">Target</label>'
      +           '<select class="input" id="announceTarget">'
      +             '<option value="all">All connected users</option>'
      +             '<option value="list">Custom chat IDs</option>'
      +           '</select>'
      +         '</div>'

      +         '<div class="qj-ann-full">'
      +           '<label class="field-label">Message</label>'
      +           '<textarea class="input" id="announceMessage" rows="6" placeholder="Type your announcement here..."></textarea>'
      +           '<div class="qj-ann-help" style="margin-top:6px">Plain text. Customers see exactly what you type. Tip: <code>Ctrl</code>+<code>Enter</code> to send.</div>'
      +         '</div>'

      +         '<div class="qj-ann-full" id="announceChatIdsWrap" style="display:none">'
      +           '<label class="field-label">Custom Chat IDs</label>'
      +           '<textarea class="input" id="announceChatIds" rows="3" placeholder="123456789, -1001234567890"></textarea>'
      +           '<div class="qj-ann-help" style="margin-top:6px">Separate IDs with commas. Used only when Target is set to “Custom chat IDs”.</div>'
      +         '</div>'

      +         '<div class="qj-ann-full">'
      +           '<label class="field-label">Media (optional)</label>'
      +           '<div class="qj-ann-row">'
      +             '<label class="file-btn btn btn-secondary btn-sm" style="padding:8px 12px">📎 Upload Media'
      +               '<input type="file" id="announceMedia" accept="image/*,video/*,audio/*" style="display:none"/>'
      +             '</label>'
      +             '<button class="btn btn-secondary btn-sm" id="announceClearMediaBtn" type="button">Clear</button>'
      +             '<span class="qj-mini" id="announceMediaName">No file selected</span>'
      +           '</div>'
      +           '<div class="qj-ann-preview" id="announceMediaPreview" style="display:none"></div>'
      +           '<div class="qj-ann-help" style="margin-top:6px">Images, GIFs, videos and audio are sent through the backend. Large videos may take longer to upload.</div>'
      +         '</div>'

      +         '<div class="qj-ann-full qj-ann-row" style="margin-top:4px">'
      +           '<button class="btn btn-primary qj-ann-send" id="announceSendBtn" type="button">'
      +             '<span id="announceSendText">📨 Send Announcement</span>'
      +             '<span id="announceSendSpin" style="display:none" class="qj-loading"><span class="spinner"></span>Sending…</span>'
      +           '</button>'
      +           '<div class="qj-ann-chip" title="Endpoint"><span>Endpoint</span><strong id="announceEndpointChip">—</strong></div>'
      +         '</div>'

      +         '<div class="qj-ann-full">'
      +           '<div class="qj-ann-status" id="announceResult" data-kind="info">Ready.</div>'
      +           '<div class="qj-ann-summary" id="announceSummary" style="display:none">'
      +             '<div class="qj-sum-card tot"><div class="v" id="annSumTotal">0</div><div class="l">Recipients</div></div>'
      +             '<div class="qj-sum-card ok"><div class="v" id="annSumOk">0</div><div class="l">Delivered</div></div>'
      +             '<div class="qj-sum-card fail"><div class="v" id="annSumFail">0</div><div class="l">Failed</div></div>'
      +           '</div>'
      +         '</div>'

      +       '</div>'
      +     '</div>'
      +   '</div>'

      +   '<div class="qj-ann-card">'
      +     '<div class="qj-ann-head">'
      +       '<div>'
      +         '<div class="qj-ann-title">📜 Recent delivery logs</div>'
      +         '<div class="qj-ann-sub">Latest results from <code>public/announcementLogs</code>.</div>'
      +       '</div>'
      +       '<button class="btn btn-secondary btn-sm" id="announceRefreshLogsBtn" type="button">Refresh</button>'
      +     '</div>'
      +     '<div class="qj-ann-body">'
      +       '<div id="announceLogs"><div class="qj-log-empty">No logs yet.</div></div>'
      +     '</div>'
      +   '</div>'
      + '</div>';

    dom.tenantChip   = $('announceTenantChip');
    dom.endpointChip = $('announceEndpointChip');
    dom.template     = $('announceTemplate');
    dom.message      = $('announceMessage');
    dom.target       = $('announceTarget');
    dom.chatIdsWrap  = $('announceChatIdsWrap');
    dom.chatIds      = $('announceChatIds');
    dom.media        = $('announceMedia');
    dom.mediaName    = $('announceMediaName');
    dom.mediaPreview = $('announceMediaPreview');
    dom.clearMediaBtn= $('announceClearMediaBtn');
    dom.sendBtn      = $('announceSendBtn');
    dom.sendText     = $('announceSendText');
    dom.sendSpin     = $('announceSendSpin');
    dom.result       = $('announceResult');
    dom.summary      = $('announceSummary');
    dom.sumTotal     = $('annSumTotal');
    dom.sumOk        = $('annSumOk');
    dom.sumFail      = $('annSumFail');
    dom.logs         = $('announceLogs');
    dom.refreshLogs  = $('announceRefreshLogsBtn');
  }

  // ---------- media preview (lazy video) ----------
  function renderMediaPreview() {
    var box = dom.mediaPreview; if (!box) return;
    box.innerHTML = '';
    var m = state.media;
    if (!m) {
      box.style.display = 'none';
      if (dom.mediaName) dom.mediaName.textContent = 'No file selected';
      return;
    }
    box.style.display = 'block';
    if (dom.mediaName) dom.mediaName.textContent = (m.name || '') + ' (' + m.type + (m.size ? ', ' + formatBytes(m.size) : '') + ')';

    if (m.kind === 'image' || m.kind === 'gif') {
      var img = document.createElement('img');
      img.alt = 'preview';
      img.loading = 'lazy';
      img.src = m.dataUrl;
      box.appendChild(img);
      return;
    }
    if (m.kind === 'audio') {
      var au = document.createElement('audio');
      au.controls = true;
      au.preload = 'none';
      au.src = m.dataUrl;
      box.appendChild(au);
      return;
    }
    if (m.kind === 'video') {
      // Lazy: show a placeholder; user clicks to load the <video>.
      var ph = document.createElement('div');
      ph.className = 'qj-ann-vph';
      ph.innerHTML = '<div><div style="font-weight:700;font-size:13px;color:var(--text)">🎬 ' + esc(m.name || 'Video') + '</div>'
                   + '<div class="qj-mini">' + esc(m.type) + (m.size ? ' · ' + formatBytes(m.size) : '') + '</div></div>'
                   + '<button class="btn btn-secondary btn-sm" type="button">▶ Load Preview</button>';
      var btn = ph.querySelector('button');
      btn.addEventListener('click', function () {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Loading…';
        var v = document.createElement('video');
        v.controls = true;
        v.playsInline = true;
        v.muted = true;
        v.preload = 'metadata';
        v.style.maxWidth = '100%';
        v.style.maxHeight = '240px';
        v.style.borderRadius = '10px';
        v.style.display = 'block';
        v.onloadeddata = function () { ph.replaceWith(v); };
        v.onerror = function () { btn.disabled = false; btn.textContent = '⚠️ Failed — retry'; };
        v.src = m.dataUrl;
        v.load();
      });
      box.appendChild(ph);
      return;
    }
    box.innerHTML = '<div class="qj-log-empty">Selected file type is not supported for inline preview.</div>';
  }

  // ---------- send ----------
  function setSending(on) {
    state.sending = !!on;
    if (!dom.sendBtn) return;
    dom.sendBtn.disabled = on;
    if (dom.sendText) dom.sendText.style.display = on ? 'none' : 'inline';
    if (dom.sendSpin) dom.sendSpin.style.display = on ? 'inline-flex' : 'none';
  }
  function showSummary(total, ok, fail) {
    if (!dom.summary) return;
    dom.summary.style.display = 'grid';
    dom.sumTotal.textContent = String(total || 0);
    dom.sumOk.textContent    = String(ok || 0);
    dom.sumFail.textContent  = String(fail || 0);
  }
  function hideSummary() { if (dom.summary) dom.summary.style.display = 'none'; }

  function buildPayload(ctx) {
    var message  = String((dom.message && dom.message.value) || '').trim();
    var targetT  = (dom.target && dom.target.value === 'list') ? 'list' : 'all';
    var chatIds  = targetT === 'list' ? normalizeIds(dom.chatIds && dom.chatIds.value) : [];
    var payload = {
      tenantId: ctx.tenantId || '',
      slug: ctx.slug || '',
      message: message,
      target: targetT === 'list' ? { type: 'list', chatIds: chatIds } : { type: 'all' }
    };
    if (state.media && state.media.dataUrl) {
      payload.media = state.media.dataUrl;
      payload.mediaType = state.media.type;
      payload.mediaName = state.media.name || '';
    }
    return payload;
  }

  async function postAnnouncement(payload) {
    var endpoint = DEFAULT_ENDPOINT;
    var res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    var data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      var err = new Error(data.errorMessage || data.error || ('HTTP ' + res.status));
      err.status = res.status; err.payload = data;
      throw err;
    }
    return data;
  }

  async function sendAnnouncement(ctx) {
    if (state.sending) return;
    hideSummary();

    var msg = String((dom.message && dom.message.value) || '').trim();
    if (!msg) { setStatus('Please type a message before sending.', 'error'); dom.message && dom.message.focus(); return; }

    var targetT = (dom.target && dom.target.value === 'list') ? 'list' : 'all';
    if (targetT === 'list') {
      var ids = normalizeIds(dom.chatIds && dom.chatIds.value);
      if (!ids.length) { setStatus('Add at least one chat ID for the custom target.', 'error'); dom.chatIds && dom.chatIds.focus(); return; }
    }

    var payload = buildPayload(ctx);
    setSending(true);
    setStatus('Sending announcement…', 'info');

    try {
      var data = await postAnnouncement(payload);
      var ok    = Number(data.success || 0);
      var fail  = Number(data.failed  || 0);
      var total = Number(data.total || (Array.isArray(data.chatIds) ? data.chatIds.length : ok + fail));
      showSummary(total, ok, fail);
      setStatus(
        fail > 0
          ? ('Sent with some failures.\nDelivered: ' + ok + '  •  Failed: ' + fail + '  •  Recipients: ' + total)
          : ('✅ Sent to ' + ok + ' recipient' + (ok === 1 ? '' : 's') + '.'),
        fail > 0 ? 'error' : 'success'
      );

      if (typeof ctx.writeAudit === 'function') {
        try { ctx.writeAudit('announcement_sent', { recipients: total, success: ok, failed: fail, hasMedia: !!state.media, target: targetT }); } catch(_){}
      }

      // After success: clear message + media so admin can compose the next one cleanly.
      if (dom.message) dom.message.value = '';
      if (dom.media) dom.media.value = '';
      state.media = null;
      renderMediaPreview();

      // Refresh logs panel if we can
      bindLogs(ctx);
    } catch (err) {
      hideSummary();
      setStatus('❌ ' + (err && err.message ? err.message : 'Announcement failed.'), 'error');
    } finally {
      setSending(false);
    }
  }

  // ---------- logs ----------
  function summarizeLogNode(node) {
    var ok=0, fail=0, latest=0;
    if (!node || typeof node !== 'object') return { ok:ok, fail:fail, total:0, latest:latest };
    Object.values(node).forEach(function(v){
      if (!v || typeof v !== 'object') return;
      if (v.status === 'ok') ok++;
      else if (v.status === 'failed') fail++;
      var t = Number(v.ts || 0); if (t > latest) latest = t;
    });
    return { ok:ok, fail:fail, total: ok+fail, latest:latest };
  }

  function renderLogs(rows) {
    if (!dom.logs) return;
    if (!rows || !rows.length) { dom.logs.innerHTML = '<div class="qj-log-empty">No logs yet.</div>'; return; }
    dom.logs.innerHTML = rows.map(function(r) {
      var when = r.latest ? new Date(r.latest).toLocaleString() : '—';
      return '<div class="qj-log-item">'
           +   '<div class="qj-log-top">'
           +     '<div><div class="qj-log-title">' + esc(r.id) + '</div>'
           +     '<div class="qj-log-meta">' + esc(when) + '</div></div>'
           +   '</div>'
           +   '<div class="qj-log-badges">'
           +     '<span class="qj-log-badge total">Total ' + r.total + '</span>'
           +     '<span class="qj-log-badge ok">Delivered ' + r.ok + '</span>'
           +     '<span class="qj-log-badge fail">Failed ' + r.fail + '</span>'
           +   '</div>'
           + '</div>';
    }).join('');
  }

  function bindLogs(ctx) {
    if (typeof ctx.onValue !== 'function' || typeof ctx.tRef !== 'function') return;
    if (state.logsUnsub) { try { state.logsUnsub(); } catch(_){} state.logsUnsub = null; }
    try {
      var unsub = ctx.onValue(ctx.tRef('public/announcementLogs'), function(snap) {
        var val = snap && snap.exists && snap.exists() ? snap.val() : null;
        if (!val) { renderLogs([]); return; }
        var rows = Object.entries(val).map(function(e){
          var sum = summarizeLogNode(e[1]);
          return { id: e[0], ok: sum.ok, fail: sum.fail, total: sum.total, latest: sum.latest };
        }).sort(function(a,b){ return (b.latest||0) - (a.latest||0); }).slice(0, 20);
        renderLogs(rows);
      });
      // Firebase v9 onValue returns an unsubscribe function
      if (typeof unsub === 'function') state.logsUnsub = unsub;
    } catch (_) {}
  }

  // ---------- bindings ----------
  function bind(ctx) {
    if (state.bound) return;

    if (dom.target) dom.target.addEventListener('change', function(){
      dom.chatIdsWrap.style.display = dom.target.value === 'list' ? 'block' : 'none';
    });

    if (dom.template) dom.template.addEventListener('change', function(){
      var t = TEMPLATES.find(function(x){ return x.id === dom.template.value; });
      if (!t || !dom.message) return;
      // Only auto-fill if message is empty OR matches another template (avoid clobbering user text).
      var current = String(dom.message.value || '').trim();
      var isOtherTemplate = TEMPLATES.some(function(x){ return x.text && x.text.trim() === current; });
      if (!current || isOtherTemplate) dom.message.value = t.text || '';
      if (current && !isOtherTemplate && t.text) {
        // Don't overwrite custom typing — but offer.
        if (window.confirm('Replace your current message with the template?')) dom.message.value = t.text;
      }
      dom.message.focus();
    });

    if (dom.message) dom.message.addEventListener('keydown', function(e){
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendAnnouncement(ctx); }
    });

    if (dom.sendBtn) dom.sendBtn.addEventListener('click', function(){ sendAnnouncement(ctx); });

    if (dom.media) dom.media.addEventListener('change', async function(e){
      var f = e.target.files && e.target.files[0];
      if (!f) { state.media = null; renderMediaPreview(); return; }
      var kind = guessMediaKind(f);
      if (kind === 'unknown') { state.media = null; renderMediaPreview(); setStatus('Unsupported file type. Use image, GIF, video, or audio.', 'error'); return; }
      try {
        var data = await fileToDataUrl(f);
        state.media = { kind: kind, dataUrl: data, type: f.type, name: f.name, size: f.size };
        renderMediaPreview();
        setStatus('Media loaded: ' + f.name, 'info');
      } catch (_) {
        state.media = null; renderMediaPreview(); setStatus('Failed to read media file.', 'error');
      }
    });

    if (dom.clearMediaBtn) dom.clearMediaBtn.addEventListener('click', function(){
      state.media = null;
      if (dom.media) dom.media.value = '';
      renderMediaPreview();
      setStatus('Media cleared.', 'info');
    });

    if (dom.refreshLogs) dom.refreshLogs.addEventListener('click', function(){ bindLogs(ctx); });

    state.bound = true;
  }

  // ---------- public ----------
  function init(ctx) {
    if (!ctx || typeof ctx !== 'object') return;
    state.ctx = ctx;
    ensureStyles();
    if (!state.mounted) { renderShell(); state.mounted = true; }
    if (dom.tenantChip)   dom.tenantChip.textContent   = ctx.slug || ctx.tenantId || '—';
    if (dom.endpointChip) dom.endpointChip.textContent = DEFAULT_ENDPOINT;
    bind(ctx);
    bindLogs(ctx);
    setStatus('Ready.', 'info');
  }

  window.__announceModule = { init: init };
})();
