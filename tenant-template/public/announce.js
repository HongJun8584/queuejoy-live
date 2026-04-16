/* /public/announce.js */
(() => {
  'use strict';

  const DEFAULT_ENDPOINT = '/.netlify/functions/announce';
  const STYLE_ID = 'qj-announce-ui-styles';
  const ROOT_ID = 'qj-announce-root';

  const state = {
    mounted: false,
    bound: false,
    config: {
      tenantId: '',
      slug: '',
      endpoint: DEFAULT_ENDPOINT,
      onStatus: null,
      tRef: null,
      onValue: null,
      get: null,
      set: null,
      update: null,
      writeAudit: null,
    },
    media: null,
    logsUnsub: null,
    sending: false,
    lastLogsKey: '',
  };

  const dom = {};

  function $(id) {
    return document.getElementById(id);
  }

  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeIds(raw) {
    return String(raw || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }

  function setStatus(message, kind = 'info') {
    const el = dom.result || $('announceResult');
    if (el) {
      el.textContent = message || '';
      el.dataset.kind = kind;
      el.style.display = 'block';
    }
    if (typeof state.config.onStatus === 'function') {
      try {
        state.config.onStatus(message, kind);
      } catch {}
    }
  }

  function ensureStyles() {
    if ($(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .qj-ann-wrap{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(280px,.95fr);gap:16px;align-items:start}
      .qj-ann-card{background:var(--card-solid);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-card)}
      .qj-ann-card .qj-ann-head{padding:16px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
      .qj-ann-card .qj-ann-title{font-size:16px;font-weight:800}
      .qj-ann-card .qj-ann-sub{font-size:12px;color:var(--text-muted);margin-top:4px;line-height:1.45}
      .qj-ann-card .qj-ann-body{padding:18px}
      .qj-ann-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
      .qj-ann-full{grid-column:1/-1}
      .qj-ann-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
      .qj-ann-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;border:1px solid var(--border);background:rgba(255,255,255,.03);font-size:12px;color:var(--text-muted);font-weight:600}
      .qj-ann-chip strong{color:var(--text)}
      .qj-ann-help{font-size:12px;line-height:1.55;color:var(--text-muted)}
      .qj-ann-help code{font-size:11px;padding:2px 6px;border-radius:6px;background:rgba(255,255,255,.05);border:1px solid var(--border)}
      .qj-ann-preview{margin-top:10px;border:1px dashed var(--border);border-radius:12px;padding:12px;background:rgba(255,255,255,.02)}
      .qj-ann-preview img,.qj-ann-preview video{max-width:100%;max-height:220px;border-radius:10px;display:block}
      .qj-ann-preview audio{width:100%}
      .qj-ann-status{margin-top:12px;padding:12px 14px;border-radius:12px;border:1px solid var(--border);background:rgba(255,255,255,.03);font-size:13px;display:none;white-space:pre-wrap}
      .qj-ann-status[data-kind="success"]{border-color:rgba(16,185,129,.35);background:rgba(16,185,129,.09);color:var(--green)}
      .qj-ann-status[data-kind="error"]{border-color:rgba(239,68,68,.35);background:rgba(239,68,68,.09);color:var(--red)}
      .qj-ann-status[data-kind="info"]{border-color:rgba(102,126,234,.25);background:rgba(102,126,234,.08);color:var(--primary)}
      .qj-ann-send{min-width:160px;justify-content:center}
      .qj-ann-logs{display:grid;gap:10px}
      .qj-log-item{padding:12px 14px;border:1px solid var(--border);border-radius:12px;background:rgba(255,255,255,.02)}
      .qj-log-top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
      .qj-log-title{font-weight:700;font-size:13px}
      .qj-log-meta{font-size:11px;color:var(--text-muted);margin-top:4px;line-height:1.45}
      .qj-log-badges{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
      .qj-log-badge{font-size:11px;padding:4px 8px;border-radius:999px;font-weight:700}
      .qj-log-badge.ok{background:rgba(16,185,129,.12);color:var(--green)}
      .qj-log-badge.fail{background:rgba(239,68,68,.12);color:var(--red)}
      .qj-log-badge.total{background:rgba(102,126,234,.12);color:var(--primary)}
      .qj-log-empty{padding:20px;border:1px dashed var(--border);border-radius:12px;color:var(--text-muted);text-align:center;font-size:13px;background:rgba(255,255,255,.02)}
      .qj-media-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
      .qj-file-btn{display:inline-flex;align-items:center;gap:8px}
      .qj-file-btn input{display:none}
      .qj-mini{font-size:11px;color:var(--text-light)}
      .qj-loading{display:inline-flex;align-items:center;gap:8px}
      @media (max-width: 1024px){.qj-ann-wrap{grid-template-columns:1fr}.qj-ann-grid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function guessMediaKind(file) {
    if (!file) return 'unknown';
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('video/')) return 'video';
    if (file.type.startsWith('audio/')) return 'audio';
    return 'unknown';
  }

  function formatTime(ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return '—';
    }
  }

  function countLogSummary(node) {
    let success = 0;
    let failed = 0;
    let latestTs = 0;
    let slug = '';
    let tenantId = '';

    if (!node || typeof node !== 'object') {
      return { success, failed, total: 0, latestTs, slug, tenantId };
    }

    for (const v of Object.values(node)) {
      if (!v || typeof v !== 'object') continue;
      if (v.status === 'ok') success++;
      else if (v.status === 'failed') failed++;
      const t = Number(v.ts || 0);
      if (t > latestTs) latestTs = t;
      if (!slug && v.slug) slug = String(v.slug);
      if (!tenantId && v.tenantId) tenantId = String(v.tenantId);
    }

    return { success, failed, total: success + failed, latestTs, slug, tenantId };
  }

  function renderShell() {
    const host =
      $('announceContainer') ||
      $('view-announcements') ||
      document.body;

    if (!host) return;

    if (host.id === 'announceContainer') {
      host.innerHTML = '';
      const root = document.createElement('div');
      root.id = ROOT_ID;
      host.appendChild(root);
      dom.root = root;
    } else if (host.id === 'view-announcements') {
      let root = $(ROOT_ID);
      if (!root) {
        root = document.createElement('div');
        root.id = ROOT_ID;
        host.appendChild(root);
      }
      dom.root = root;
    } else {
      let root = $(ROOT_ID);
      if (!root) {
        root = document.createElement('div');
        root.id = ROOT_ID;
        host.appendChild(root);
      }
      dom.root = root;
    }

    dom.root.innerHTML = `
      <div class="qj-ann-wrap">
        <div class="qj-ann-card">
          <div class="qj-ann-head">
            <div>
              <div class="qj-ann-title">Announcements</div>
              <div class="qj-ann-sub">
                Send Telegram announcements to all connected users or to a custom list of chat IDs.
              </div>
            </div>
            <div class="qj-ann-chip" title="Current tenant">
              <span>Tenant</span>
              <strong id="announceTenantChip">—</strong>
            </div>
          </div>

          <div class="qj-ann-body">
            <div class="qj-ann-grid">
              <div class="qj-ann-full">
                <label class="field-label" style="margin-top:0">Message</label>
                <textarea class="input" id="announceMessage" rows="5" placeholder="Type your announcement here..."></textarea>
                <div class="qj-ann-help" style="margin-top:8px">
                  Tip: press <code>Ctrl</code> + <code>Enter</code> to send.
                </div>
              </div>

              <div>
                <label class="field-label">Level</label>
                <select class="input" id="announceLevel">
                  <option value="info">Info</option>
                  <option value="warning">Warning</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>

              <div>
                <label class="field-label">Target</label>
                <select class="input" id="announceTarget">
                  <option value="all">All connected users</option>
                  <option value="list">Custom chat IDs</option>
                </select>
              </div>

              <div class="qj-ann-full" id="announceChatIdsWrap" style="display:none">
                <label class="field-label">Custom Chat IDs</label>
                <textarea class="input" id="announceChatIds" rows="3" placeholder="123456789, -1001234567890"></textarea>
                <div class="qj-ann-help" style="margin-top:8px">
                  Separate IDs with commas. Used only when Target is set to Custom chat IDs.
                </div>
              </div>

              <div class="qj-ann-full">
                <label class="field-label">Media (optional)</label>
                <div class="qj-ann-media-row">
                  <label class="file-btn qj-file-btn btn btn-secondary btn-sm" style="padding:8px 12px">
                    📎 Upload Media
                    <input type="file" id="announceMedia" accept="image/*,video/*,audio/*"/>
                  </label>
                  <button class="btn btn-secondary btn-sm" id="announceClearMediaBtn" type="button">Clear Media</button>
                  <span class="qj-mini" id="announceMediaName">No file selected</span>
                </div>
                <div class="qj-ann-preview" id="announceMediaPreview" style="display:none"></div>
                <div class="qj-ann-help" style="margin-top:8px">
                  Images, videos, and audio are sent through the backend. Other files are ignored safely.
                </div>
              </div>

              <div class="qj-ann-full qj-ann-row" style="margin-top:4px">
                <button class="btn btn-primary qj-ann-send" id="announceSendBtn" type="button">
                  <span id="announceSendText">Send Announcement</span>
                  <span id="announceSendSpin" style="display:none" class="qj-loading"><span class="spinner"></span>Sending…</span>
                </button>
                <div class="qj-ann-chip" title="Delivery mode">
                  <span>Endpoint</span>
                  <strong id="announceEndpointChip">—</strong>
                </div>
              </div>

              <div class="qj-ann-full">
                <div class="qj-ann-status" id="announceResult" data-kind="info">Ready.</div>
              </div>
            </div>
          </div>
        </div>

        <div class="qj-ann-card">
          <div class="qj-ann-head">
            <div>
              <div class="qj-ann-title">Recent delivery logs</div>
              <div class="qj-ann-sub">
                Latest results from Firebase announcement logs.
              </div>
            </div>
            <button class="btn btn-secondary btn-sm" id="announceRefreshLogsBtn" type="button">Refresh</button>
          </div>
          <div class="qj-ann-body">
            <div class="qj-ann-logs" id="announceLogs">
              <div class="qj-log-empty">No logs yet.</div>
            </div>
          </div>
        </div>
      </div>
    `;

    dom.tenantChip = $('announceTenantChip');
    dom.endpointChip = $('announceEndpointChip');
    dom.message = $('announceMessage');
    dom.level = $('announceLevel');
    dom.target = $('announceTarget');
    dom.chatIdsWrap = $('announceChatIdsWrap');
    dom.chatIds = $('announceChatIds');
    dom.media = $('announceMedia');
    dom.mediaName = $('announceMediaName');
    dom.mediaPreview = $('announceMediaPreview');
    dom.clearMediaBtn = $('announceClearMediaBtn');
    dom.sendBtn = $('announceSendBtn');
    dom.sendText = $('announceSendText');
    dom.sendSpin = $('announceSendSpin');
    dom.result = $('announceResult');
    dom.logs = $('announceLogs');
    dom.refreshLogsBtn = $('announceRefreshLogsBtn');
  }

  function renderMediaPreview() {
    if (!dom.mediaPreview) return;

    const media = state.media;
    if (!media) {
      dom.mediaPreview.style.display = 'none';
      dom.mediaPreview.innerHTML = '';
      if (dom.mediaName) dom.mediaName.textContent = 'No file selected';
      return;
    }

    dom.mediaPreview.style.display = 'block';
    dom.mediaName.textContent = media.name ? `${media.name} (${media.type})` : media.type;

    if (media.kind === 'image') {
      dom.mediaPreview.innerHTML = `<img src="${esc(media.data)}" alt="preview">`;
      return;
    }

    if (media.kind === 'video') {
      dom.mediaPreview.innerHTML = `<video controls playsinline src="${esc(media.data)}"></video>`;
      return;
    }

    if (media.kind === 'audio') {
      dom.mediaPreview.innerHTML = `<audio controls src="${esc(media.data)}"></audio>`;
      return;
    }

    dom.mediaPreview.innerHTML = `<div class="qj-log-empty">Selected file type is not supported for inline preview.</div>`;
  }

  function setSending(isSending) {
    state.sending = isSending;
    if (!dom.sendBtn) return;
    dom.sendBtn.disabled = isSending;
    if (dom.sendText) dom.sendText.style.display = isSending ? 'none' : 'inline';
    if (dom.sendSpin) dom.sendSpin.style.display = isSending ? 'inline-flex' : 'none';
  }

  function updateTargetVisibility() {
    if (!dom.chatIdsWrap || !dom.target) return;
    dom.chatIdsWrap.style.display = dom.target.value === 'list' ? 'block' : 'none';
  }

  function buildPayload() {
    const message = String(dom.message?.value || '').trim();
    const level = String(dom.level?.value || 'info').trim() || 'info';
    const targetType = dom.target?.value === 'list' ? 'list' : 'all';
    const chatIds = targetType === 'list' ? normalizeIds(dom.chatIds?.value) : [];

    const payload = {
      tenantId: state.config.tenantId,
      slug: state.config.slug,
      message,
      level,
      target: targetType === 'list'
        ? { type: 'list', chatIds }
        : { type: 'all' },
    };

    if (state.media?.data && state.media?.kind && state.media.kind !== 'unknown') {
      payload.media = state.media.data;
      payload.mediaType = state.media.type;
      payload.mediaName = state.media.name || '';
    }

    return payload;
  }

  async function postAnnouncement(payload) {
    const endpoint = state.config.endpoint || DEFAULT_ENDPOINT;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.errorMessage || data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  async function sendAnnouncement() {
    if (state.sending) return;

    const message = String(dom.message?.value || '').trim();
    if (!message) {
      setStatus('Message is required.', 'error');
      dom.message?.focus();
      return;
    }

    const targetType = dom.target?.value === 'list' ? 'list' : 'all';
    const chatIds = targetType === 'list' ? normalizeIds(dom.chatIds?.value) : [];

    if (targetType === 'list' && chatIds.length === 0) {
      setStatus('Enter at least one chat ID for the custom target.', 'error');
      dom.chatIds?.focus();
      return;
    }

    const payload = buildPayload();
    setSending(true);
    setStatus('Sending announcement…', 'info');

    try {
      const data = await postAnnouncement(payload);
      const success = Number(data.success || 0);
      const failed = Number(data.failed || 0);
      const total = Array.isArray(data.chatIds) ? data.chatIds.length : success + failed;

      setStatus(
        `Sent successfully.\nRecipients: ${total}\nDelivered: ${success}\nFailed: ${failed}`,
        failed ? 'error' : 'success'
      );

      if (typeof state.config.writeAudit === 'function') {
        try {
          await state.config.writeAudit('announcement_sent', {
            target: targetType,
            recipients: total,
            success,
            failed,
            hasMedia: Boolean(state.media),
          });
        } catch {}
      }

      if (targetType !== 'list') {
        dom.chatIds && (dom.chatIds.value = '');
      }
      dom.message && (dom.message.value = '');
      dom.media && (dom.media.value = '');
      state.media = null;
      renderMediaPreview();
      updateLogs(); // refresh if possible
      return data;
    } catch (err) {
      setStatus(err.message || 'Announcement failed.', 'error');
      throw err;
    } finally {
      setSending(false);
    }
  }

  function bindUI() {
    if (state.bound) return;

    dom.target?.addEventListener('change', updateTargetVisibility);
    dom.sendBtn?.addEventListener('click', sendAnnouncement);

    dom.message?.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        sendAnnouncement();
      }
    });

    dom.media?.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) {
        state.media = null;
        renderMediaPreview();
        return;
      }

      const kind = guessMediaKind(file);
      if (kind === 'unknown') {
        state.media = null;
        renderMediaPreview();
        setStatus('Unsupported file type. Use image, video, or audio.', 'error');
        return;
      }

      try {
        const data = await fileToDataUrl(file);
        state.media = {
          kind,
          data,
          type: file.type,
          name: file.name,
          size: file.size,
        };
        renderMediaPreview();
        setStatus(`Media loaded: ${file.name}`, 'info');
      } catch (err) {
        state.media = null;
        renderMediaPreview();
        setStatus('Failed to read media file.', 'error');
      }
    });

    dom.clearMediaBtn?.addEventListener('click', () => {
      state.media = null;
      if (dom.media) dom.media.value = '';
      renderMediaPreview();
      setStatus('Media cleared.', 'info');
    });

    dom.refreshLogsBtn?.addEventListener('click', () => {
      updateLogs(true);
    });

    state.bound = true;
  }

  function renderLogs(entries) {
    if (!dom.logs) return;

    if (!entries || entries.length === 0) {
      dom.logs.innerHTML = `<div class="qj-log-empty">No logs yet.</div>`;
      return;
    }

    dom.logs.innerHTML = entries.map((row) => {
      const ok = Number(row.success || 0);
      const fail = Number(row.failed || 0);
      const total = Number(row.total || ok + fail);
      const title = row.slug || row.tenantId || 'Announcement';
      return `
        <div class="qj-log-item">
          <div class="qj-log-top">
            <div>
              <div class="qj-log-title">${esc(title)}</div>
              <div class="qj-log-meta">
                ${esc(formatTime(row.latestTs))}<br>
                Log ID: ${esc(row.logId)}
              </div>
            </div>
            <div class="qj-ann-chip"><strong>${total}</strong> deliveries</div>
          </div>
          <div class="qj-log-badges">
            <span class="qj-log-badge total">Total ${total}</span>
            <span class="qj-log-badge ok">OK ${ok}</span>
            <span class="qj-log-badge fail">Failed ${fail}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  async function updateLogs(force = false) {
    if (!state.config.onValue || typeof state.config.tRef !== 'function') {
      if (force) setStatus('Live logs unavailable in this environment.', 'info');
      return;
    }

    try {
      const ref = state.config.tRef('public/announcementLogs');
      state.config.onValue(ref, (snap) => {
        try {
          if (!snap || !snap.exists()) {
            renderLogs([]);
            return;
          }

          const raw = snap.val() || {};
          const entries = Object.entries(raw)
            .map(([logId, node]) => {
              const summary = countLogSummary(node);
              return { logId, ...summary };
            })
            .sort((a, b) => (b.latestTs || 0) - (a.latestTs || 0))
            .slice(0, 10);

          renderLogs(entries);
        } catch {
          renderLogs([]);
        }
      });
    } catch {
      renderLogs([]);
    }
  }

  function setHeaderValues() {
    if (dom.tenantChip) {
      dom.tenantChip.textContent = state.config.slug || state.config.tenantId || '—';
    }
    if (dom.endpointChip) {
      dom.endpointChip.textContent = state.config.endpoint || DEFAULT_ENDPOINT;
    }
  }

  function init(config = {}) {
    ensureStyles();

    state.config = {
      tenantId: String(config.tenantId || '').trim(),
      slug: String(config.slug || '').trim(),
      endpoint: String(config.endpoint || DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT,
      onStatus: typeof config.onStatus === 'function' ? config.onStatus : null,
      tRef: typeof config.tRef === 'function' ? config.tRef : null,
      onValue: typeof config.onValue === 'function' ? config.onValue : null,
      get: typeof config.get === 'function' ? config.get : null,
      set: typeof config.set === 'function' ? config.set : null,
      update: typeof config.update === 'function' ? config.update : null,
      writeAudit: typeof config.writeAudit === 'function' ? config.writeAudit : null,
    };

    renderShell();
    bindUI();
    setHeaderValues();
    updateTargetVisibility();
    renderMediaPreview();
    updateLogs();

    state.mounted = true;
    if (dom.result && !dom.result.textContent) {
      dom.result.textContent = 'Ready.';
      dom.result.dataset.kind = 'info';
      dom.result.style.display = 'block';
    }

    return {
      sendAnnouncement,
      postAnnouncement,
      setStatus,
    };
  }

  window.__announceModule = {
    init,
    sendAnnouncement,
    postAnnouncement,
  };

  document.addEventListener('DOMContentLoaded', () => {
    if (!state.mounted) {
      const rootExists = $('announceContainer') || $('view-announcements');
      if (rootExists) {
        try {
          init(state.config);
        } catch {}
      }
    }
  });
})();