// bootstrap.js
import { initFirebaseForTenant } from './tenant-firebase.js';
import { getTenantFromLocation } from './tenant.js'; // your tenant slug extractor

// small helper to set the debug marker for smoke tests
function setDebug(path, tenant) {
  const dbg = document.getElementById('tenant-debug');
  if (!dbg) return;
  if (path !== undefined) dbg.dataset.path = path;
  if (tenant !== undefined) dbg.dataset.tenant = tenant;
  dbg.style.display = 'none';
}

// lightweight rendering helper used for placeholder & errors
function renderPre(root, html) {
  const r = document.getElementById('app-root');
  if (!r) return;
  r.innerHTML = html;
}

// runTransaction with retries + jitter/backoff
async function runTxWithRetries(runTransactionFn, ref, updater, maxRetries = 6) {
  // runTransactionFn is the firebase runTransaction function from dbApi
  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await runTransactionFn(ref, current => {
        return updater(current);
      });
      // modular SDK: result has committed & snapshot
      if (result && result.committed) return result;
      lastErr = new Error(`Transaction not committed (attempt ${attempt})`);
    } catch (err) {
      lastErr = err;
      console.warn('[tx] attempt', attempt, 'failed', err);
    }
    const backoff = 100 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 120);
    await new Promise(r => setTimeout(r, backoff));
  }
  throw lastErr || new Error('Transaction failed after retries');
}

// tenantRef wrapper using dbApi.ref, prefixing tenants/<slug> when slug present
function makeTenantRef(dbApi, slug) {
  return function tenantRef(path = '') {
    path = String(path || '').replace(/^\/+/, '');
    if (!slug) {
      // top-level path
      return dbApi.ref(dbApi.db || null, path || '/');
    }
    if (!path) return dbApi.ref(dbApi.db, `tenants/${slug}`);
    return dbApi.ref(dbApi.db, `tenants/${slug}/${path}`);
  };
}

// fetchActiveCounters using dbApi.get
async function fetchActiveCounters(dbApi, tenantRef) {
  const snap = await dbApi.get(tenantRef('counters'));
  if (!snap || !snap.exists()) return [];
  const raw = [];
  snap.forEach(s => {
    const val = s.val() || {};
    const activeRaw = val.active;
    const active =
      activeRaw === undefined ||
      activeRaw === null ||
      activeRaw === true ||
      activeRaw === 'true' ||
      activeRaw === 1 ||
      activeRaw === '1' ||
      String(activeRaw).toLowerCase() === 'yes' ||
      String(activeRaw).toLowerCase() === 'y';

    raw.push({ id: s.key, ...val, _active: !!active });
  });

  const activeList = raw.filter(c => c && c._active);
  activeList.sort((a,b) => {
    const ao = (a.order !== undefined && a.order !== '' && a.order !== null) ? Number(a.order) : Number.POSITIVE_INFINITY;
    const bo = (b.order !== undefined && b.order !== '' && b.order !== null) ? Number(b.order) : Number.POSITIVE_INFINITY;
    if (ao !== bo) return ao - bo;
    if (!isNaN(Number(a.id)) && !isNaN(Number(b.id))) return Number(a.id) - Number(b.id);
    return String(a.id).localeCompare(String(b.id), undefined, { numeric: true, sensitivity: 'base' });
  });

  return activeList;
}

// UI helpers
function $(id){ return document.getElementById(id); }
function showError(msg) {
  const el = $('errorMessage'); if (!el) return;
  el.querySelector('p').textContent = msg;
  el.classList.remove('hidden');
  $('successMessage')?.classList.add('hidden');
  setTimeout(()=>el.classList.add('hidden'), 6000);
}
function showSuccess(msg) {
  const el = $('successMessage'); if (!el) return;
  el.querySelector('p').textContent = msg;
  el.classList.remove('hidden');
  $('errorMessage')?.classList.add('hidden');
  setTimeout(()=>el.classList.add('hidden'), 6000);
}
function setLoading(flag) {
  const btn = $('getNumberBtn'); if (!btn) return;
  btn.disabled = flag;
  $('btnText')?.classList.toggle('hidden', flag);
  $('btnSpinner')?.classList.toggle('hidden', !flag);
  btn.setAttribute('aria-busy', String(flag));
}

// core: getQueueNumber (round-robin + lastIssued + push)
async function getQueueNumber(dbApi, tenantRef) {
  setLoading(true);
  try {
    const activeCounters = await fetchActiveCounters(dbApi, tenantRef);
    if (!activeCounters || activeCounters.length === 0) {
      showError('No active counters available right now.');
      return;
    }

    // round-robin using settings/lastCounterIndex
    const rrRef = tenantRef('settings/lastCounterIndex');

    const rrResult = await runTxWithRetries(dbApi.runTransaction, rrRef, cur => {
      const ncur = Number(cur) || 0;
      return ncur + 1;
    }, 8);

    if (!rrResult || rrResult.committed !== true) {
      throw new Error('Round-robin transaction failed to commit.');
    }

    const rrVal = rrResult.snapshot && rrResult.snapshot.val ? rrResult.snapshot.val() : rrResult.snapshot;
    const globalCounter = Number(rrVal);
    if (!Number.isFinite(globalCounter)) throw new Error('Invalid round-robin counter value returned.');

    const n = activeCounters.length;
    const index = ((globalCounter - 1) % n + n) % n;
    let chosen = activeCounters[index] || activeCounters[0];

    // increment per-counter lastIssued
    const lastIssuedRef = tenantRef(`counters/${chosen.id}/lastIssued`);
    const lastIssuedTx = await runTxWithRetries(dbApi.runTransaction, lastIssuedRef, cur => (Number(cur) || 0) + 1, 8);
    if (!lastIssuedTx || lastIssuedTx.committed !== true) {
      throw new Error('Failed to increment counter issued number.');
    }

    const nextNumber = lastIssuedTx.snapshot && lastIssuedTx.snapshot.val ? lastIssuedTx.snapshot.val() : lastIssuedTx.snapshot;
    if (!Number.isFinite(Number(nextNumber))) throw new Error('Invalid nextNumber from counter transaction.');

    const prefix = (chosen.prefix && String(chosen.prefix)) || 'Q';
    const queueId = `${prefix}${String(nextNumber).padStart(3,'0')}`;

    // push queue entry
    const newNodeRef = dbApi.push(tenantRef('queue'));
    await dbApi.set(newNodeRef, {
      counterId: chosen.id,
      queueId,
      timestamp: Date.now(),
      status: 'waiting'
    });

    try { sessionStorage.setItem('lastQueueId', newNodeRef.key); } catch(e){}

    showSuccess(`You're number ${queueId}`);
    setTimeout(()=> {
      window.location.href = `status.html?queueId=${encodeURIComponent(newNodeRef.key)}`;
    }, 700);

  } catch (err) {
    console.error('getQueueNumber error', err);
    showError(err && err.message ? err.message : 'Failed to get queue number. Try again.');
  } finally {
    setLoading(false);
  }
}

(async function main(){
  console.info('bootstrap: PATHNAME', window.location.pathname);
  const slug = getTenantFromLocation();
  console.info('bootstrap: PARSED TENANT SLUG ->', slug);

  setDebug(window.location.pathname, slug);

  if (!slug) {
    document.documentElement.classList.add('no-tenant');
    renderPre('app-root', `<div style="padding:24px;font-family:system-ui"><h2>Tenant not found</h2><p>Please include a tenant slug in the URL (e.g. <code>/acme-coffee/</code>).</p></div>`);
    return;
  }

  window.__TENANT__ = slug;

  // init tenant firebase
  let init;
  try {
    init = await initFirebaseForTenant(slug);
  } catch (err) {
    console.error('bootstrap: initFirebaseForTenant network/error', err);
    // fallback demo
    if (typeof window.__QJ_DEMO_FALLBACK === 'function') {
      console.warn('bootstrap: demo fallback due to init error');
      window.__QJ_DEMO_FALLBACK();
      return;
    } else {
      renderPre('app-root', `<pre style="color:red;padding:24px">${String(err && (err.stack || err))}</pre>`);
      return;
    }
  }

  // if function indicated unauthorized, fallback to demo
  if (init && init.unauthorized) {
    console.warn('bootstrap: get-firebase-config returned unauthorized', init);
    if (typeof window.__QJ_DEMO_FALLBACK === 'function') {
      window.__QJ_DEMO_FALLBACK();
      return;
    }
  }

  // if init contains dbApi, we have DB access and can wire real runtime
  if (init && init.dbApi && init.dbApi.ref) {
    const dbApi = init.dbApi; // { ref, get, child, push, onValue, runTransaction, set }
    // dbApi needs database instance reference when calling ref; ensure dbApi.ref accepts (db, path) - our tenant-firebase used ref(db, path)
    // We'll create a small adapter object that forwards correctly
    const adapter = {
      db: init.db,
      ref: (db, path) => dbApi.ref(adapter.db, path),
      get: (snapRef) => dbApi.get(snapRef),
      child: (r, p) => dbApi.child(r, p),
      push: (r) => dbApi.push(r),
      onValue: (r, cb) => dbApi.onValue(r, cb),
      runTransaction: (r, updater) => dbApi.runTransaction(r, updater),
      set: (r, v) => dbApi.set(r, v)
    };

    // tenantRef factory for this tenant
    const tenantRef = (p='') => {
      p = String(p || '').replace(/^\/+/, '');
      if (!p) return adapter.ref(adapter.db, `tenants/${slug}`);
      return adapter.ref(adapter.db, `tenants/${slug}/${p}`);
    };

    // Hook up settings watcher to populate UI (mirrors earlier long page)
    try {
      // subscribe to settings with onValue for live updates
      adapter.onValue(tenantRef('settings'), snap => {
        const s = snap && snap.exists ? snap.val() : (snap || {});
        const pick = v => (typeof v === 'string' && v.trim()) ? v.trim() : (typeof v === 'number' || typeof v === 'boolean') ? v : null;

        // header logo
        if (s.logo) { $('siteLogo').src = s.logo; $('siteLogo').classList.remove('hidden'); } else { $('siteLogo').src=''; $('siteLogo').classList.add('hidden'); }

        const topTitle = pick(s.mainTitle) || pick(s.name) || 'Queue Joy';
        $('siteTitle').textContent = topTitle;
        document.title = topTitle + ' - Digital Queue System';

        if ($('smallTopText')) $('smallTopText').textContent = pick(s.smallTextOnTop) || pick(s.smallTopText) || 'Digital Queue System';
        if (s.logoUrl) { $('centerLogo').src = s.logoUrl; $('centerLogo').classList.remove('hidden'); $('centerIcon').classList.add('hidden'); }
        else if (s.logo) { $('centerLogo').src = s.logo; $('centerLogo').classList.remove('hidden'); $('centerIcon').classList.add('hidden'); }
        else { $('centerLogo').src=''; $('centerLogo').classList.add('hidden'); $('centerIcon').classList.remove('hidden'); }

        $('mainHeading').textContent = pick(s.titleinmiddle) || pick(s.ctaTitle) || 'Get your queue number';
        $('introText').textContent = pick(s.introText) || pick(s.smallTopText) || 'Real-time queueing system. Mobile-friendly. No app needed.';
        $('btnText').textContent = '🎫 ' + (pick(s.ctaText) || 'Get your queue number');

        // ads handling (safe)
        const adContainer = $('adContainer');
        adContainer.innerHTML = '';
        if (s.adImage) {
          const url = String(s.adImage).trim();
          const isVideo = /\.(mp4|webm|ogg)(\?.*)?$/i.test(url) || url.startsWith('data:video/');
          if (isVideo) {
            const v = document.createElement('video');
            v.setAttribute('playsinline',''); v.setAttribute('autoplay',''); v.setAttribute('loop',''); v.setAttribute('muted',''); v.className = 'w-full object-cover db-image';
            v.src = url; adContainer.appendChild(v);
            v.play().catch(()=>v.setAttribute('controls',''));
          } else {
            const img = document.createElement('img'); img.src = url; img.alt = 'Ad'; img.className = 'w-full object-cover db-image';
            adContainer.appendChild(img);
          }
          adContainer.classList.remove('hidden'); $('noAd').classList.add('hidden');
        } else {
          adContainer.innerHTML=''; adContainer.classList.add('hidden'); $('noAd').classList.remove('hidden');
        }

        $('adText').textContent = pick(s.adText) || '';
        $('adText').classList.toggle('hidden', !$('adText').textContent);

        // sanitize adLink (only allow same-origin)
        try {
          const raw = (s.adLink || '').toString();
          const u = new URL(raw, location.href);
          if (u.origin === location.origin) {
            $('adLink').href = u.href; $('adLink').removeAttribute('target'); $('adLink').setAttribute('rel','noopener');
          } else {
            $('adLink').href = '#';
          }
        } catch(e) { $('adLink').href = '#'; }
      }, err => console.warn('settings read failed', err));
    } catch (e) {
      console.warn('Failed to attach settings watcher', e);
    }

    // wire getNumber button to real getQueueNumber using adapter and tenantRef
    const getNumberBtn = $('getNumberBtn');
    if (getNumberBtn) {
      getNumberBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        // call core function with adapter + tenantRef
        getQueueNumber(adapter, tenantRef);
      });
    }

    // auto-redirect if lastQueueId waiting
    (async function autoRedirect() {
      try {
        const last = sessionStorage.getItem('lastQueueId');
        if (!last) return;
        const snap = await adapter.get(adapter.child(tenantRef(''), `queue/${last}`));
        if (snap && snap.exists && snap.val && snap.val().status === 'waiting') {
          window.location.href = `status.html?queueId=${encodeURIComponent(last)}`;
        }
      } catch(e){ console.warn('autoRedirect failed', e); }
    })();

    // DONE: live runtime attached
    console.info('bootstrap: tenant runtime attached for', slug);
    return;
  }

  // otherwise, no DB access — fallback to demo (or render placeholder)
  console.warn('bootstrap: no dbApi available; falling back to demo or placeholder', init);
  if (typeof window.__QJ_DEMO_FALLBACK === 'function') {
    window.__QJ_DEMO_FALLBACK();
    return;
  } else {
    renderPre('app-root', `<div style="padding:16px;font-family:system-ui"><h1>Tenant: ${slug}</h1><pre>${JSON.stringify(init,null,2)}</pre></div>`);
  }
})();
