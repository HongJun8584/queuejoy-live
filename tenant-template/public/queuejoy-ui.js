(() => {
  const DEFAULT_FAVICON = '/queuejoy-favicon.svg';

  function safeIconUrl(value) {
    const raw = String(value || '').trim();
    if (raw.length <= 120000 && /^data:image\/(png|jpeg|webp|x-icon|vnd\.microsoft\.icon);base64,/i.test(raw)) return raw;
    try {
      const url = new URL(raw, window.location.href);
      if (url.protocol === 'https:' || (url.protocol === 'http:' && url.origin === window.location.origin)) return url.href;
    } catch (_) {}
    return '';
  }

  function linkFor(rel, id) {
    let link = document.getElementById(id);
    if (!link) {
      const selector = rel === 'icon' ? 'link[rel~="icon"]' : `link[rel="${rel}"]`;
      link = document.querySelector(selector);
      if (link) link.id = id;
    }
    if (!link) {
      link = document.createElement('link');
      link.id = id;
      link.rel = rel;
      document.head.appendChild(link);
    }
    return link;
  }

  function setTenantFavicon(value) {
    const source = safeIconUrl(value) || DEFAULT_FAVICON;
    const icon = linkFor('icon', 'qj-tenant-favicon');
    icon.href = source;
    icon.removeAttribute('type');
    if (source.endsWith('.svg')) icon.type = 'image/svg+xml';
    else if (source.startsWith('data:image/webp')) icon.type = 'image/webp';
    else if (source.startsWith('data:image/png')) icon.type = 'image/png';
    else if (source.startsWith('data:image/jpeg')) icon.type = 'image/jpeg';

    const touch = linkFor('apple-touch-icon', 'qj-tenant-touch-icon');
    touch.href = source;
    return source;
  }

  function applyTenantConfig(config) {
    const cfg = config && typeof config === 'object' ? config : {};
    setTenantFavicon(cfg.faviconUrl);
    return cfg;
  }

  window.QueueJoyUI = Object.assign(window.QueueJoyUI || {}, {
    defaultFavicon: DEFAULT_FAVICON,
    setTenantFavicon,
    applyTenantConfig
  });
  setTenantFavicon('');
})();
