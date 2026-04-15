/* /public/announce.js */
(() => {
  'use strict';

  const DEFAULT_ENDPOINT = '/.netlify/functions/announce';

  const state = {
    mounted: false,
    bound: false,
    config: {
      tenantId: '',
      slug: '',
      endpoint: DEFAULT_ENDPOINT,
      onStatus: null
    }
  };

  function $(id) {
    return document.getElementById(id);
  }

  function safeText(el, text) {
    if (!el) return;
    el.textContent = text == null ? '' : String(text);
  }

  function normalizeChatIds(raw) {
    return String(raw || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }

  function setStatus(message, kind = 'info') {
    const el = $('announceResult');
    if (el) {
      el.textContent = message || '';
      el.dataset.kind = kind;
    }
    if (typeof state.config.onStatus === 'function') {
      try {
        state.config.onStatus(message, kind);
      } catch {}
    }
  }

  async function postAnnouncement(payload) {
    const endpoint = state.config.endpoint || DEFAULT_ENDPOINT;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
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

  async function sendFromUI() {
    const messageEl = $('announceMessage');
    const targetEl = $('announceTarget');
    const chatIdsEl = $('announceChatIds');

    const message = String(messageEl?.value || '').trim();
    if (!message) {
      setStatus('Message is required.', 'error');
      return;
    }

    const targetType = targetEl?.value === 'list' ? 'list' : 'all';
    const chatIds = targetType === 'list' ? normalizeChatIds(chatIdsEl?.value) : [];

    if (targetType === 'list' && chatIds.length === 0) {
      setStatus('Enter at least one chat ID for custom target.', 'error');
      return;
    }

    const payload = {
      tenantId: state.config.tenantId,
      slug: state.config.slug,
      message,
      level: 'info',
      target: targetType === 'list'
        ? { type: 'list', chatIds }
        : { type: 'all' }
    };

    setStatus('Sending…', 'info');

    try {
      const data = await postAnnouncement(payload);
      const success = Number(data.success || 0);
      const failed = Number(data.failed || 0);
      setStatus(`Sent: ${success}, Failed: ${failed}`, failed ? 'error' : 'success');
      return data;
    } catch (err) {
      setStatus(err.message || 'Announcement failed.', 'error');
      throw err;
    }
  }

  function bindUI() {
    if (state.bound) return;
    const btn = $('announceSendBtn');
    const messageEl = $('announceMessage');

    if (btn) {
      btn.addEventListener('click', sendFromUI);
    }

    if (messageEl) {
      messageEl.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          sendFromUI();
        }
      });
    }

    state.bound = true;
  }

  function init(config = {}) {
    state.config = {
      tenantId: String(config.tenantId || '').trim(),
      slug: String(config.slug || '').trim(),
      endpoint: String(config.endpoint || DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT,
      onStatus: typeof config.onStatus === 'function' ? config.onStatus : null
    };

    bindUI();
    state.mounted = true;

    const resultEl = $('announceResult');
    if (resultEl && !resultEl.textContent) {
      safeText(resultEl, 'Ready.');
    }

    return {
      sendAnnouncement: sendFromUI,
      postAnnouncement
    };
  }

  window.__announceModule = {
    init,
    sendAnnouncement: sendFromUI,
    postAnnouncement
  };

  document.addEventListener('DOMContentLoaded', () => {
    bindUI();
  });
})();