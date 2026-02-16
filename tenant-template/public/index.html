<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Queue Joy - Digital Queue System</title>

  <!-- Tailwind CDN (dev) -->
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">

  <style>
    :root { --card-radius: 1rem; }
    body { font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial; }
    .fade-in { animation: fadeIn 0.45s cubic-bezier(.2,.9,.2,1); }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(12px) } to { opacity: 1; transform: translateY(0) } }
    .db-image { max-height: 180px; object-fit: cover; }
  </style>

  <!-- NOTE:
    This page is a tenant-aware SPA (B2):
      - Netlify redirects all paths to this index.html (SPA fallback)
      - bootstrap.js (module) detects tenant slug, calls serverless function to get public config,
        initializes firebase client (if configured) and renders tenant UI.
      - If serverless / config is missing/unauthorized, demo fallback will run.
  -->
</head>

<body class="min-h-screen bg-gradient-to-br from-slate-50 via-purple-50 to-rose-50 flex flex-col items-center p-6 pb-20">

  <!-- DEBUG marker for automated tests (kept hidden) -->
  <div id="tenant-debug" data-path="" style="display:none"></div>

  <!-- Application root: bootstrap.js will update fields inside this root -->
  <div id="app-root" class="w-full max-w-3xl">
    <!-- Keep the UI static markup as the DOM that JS will populate/modify.
         This also provides graceful HTML-first fallback when JS is disabled. -->
    <header class="w-full mb-6">
      <div class="bg-white rounded-2xl shadow-md p-4 flex items-center gap-4">
        <img id="siteLogo" src="" alt="Site logo" class="w-12 h-12 rounded-full hidden object-cover border" />
        <div class="flex-1 text-left">
          <h1 id="siteTitle" class="text-lg font-bold text-gray-800">Queue Joy</h1>
          <p id="smallTopText" class="text-xs text-gray-500">Digital Queue System</p>
        </div>
        <div class="text-right text-xs text-gray-400">Powered by Queue Joy</div>
      </div>
    </header>

    <main class="flex flex-col items-center gap-8">
      <section class="w-full max-w-md bg-white rounded-2xl shadow-xl p-6 space-y-6 text-center fade-in relative">
        <div class="mx-auto">
          <img id="centerLogo" class="w-20 h-20 rounded-full object-cover hidden mx-auto shadow-sm border" alt="center logo"/>
          <div id="centerIcon" class="w-20 h-20 bg-gradient-to-r from-purple-600 to-indigo-500 rounded-full flex items-center justify-center mx-auto">
            <svg class="w-9 h-9 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"></path>
            </svg>
          </div>
        </div>

        <div class="space-y-2">
          <h2 id="mainHeading" class="text-2xl font-bold text-gray-800">Get your queue number</h2>
          <p id="introText" class="text-gray-600">Real-time queueing system. Mobile-friendly. No app needed.</p>
        </div>

        <button id="getNumberBtn" class="w-full py-4 bg-gradient-to-r from-purple-600 to-purple-400 text-white font-semibold rounded-2xl shadow-lg hover:scale-105 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed">
          <span id="btnText">🎫 Get your queue number</span>
          <span id="btnSpinner" class="hidden inline-flex items-center ml-2">
            <svg class="animate-spin h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
            </svg>
            Getting your number...
          </span>
        </button>

        <div id="errorMessage" class="hidden p-3 bg-red-50 border border-red-200 rounded-lg"><p class="text-red-600 text-sm"></p></div>
        <div id="successMessage" class="hidden p-3 bg-green-50 border border-green-200 rounded-lg"><p class="text-green-600 text-sm"></p></div>
      </section>

      <aside class="w-full max-w-md bg-white rounded-xl shadow-lg p-3">
        <p class="text-xs text-gray-500 text-center mb-2">Advertisement</p>
        <a id="adLink" href="#" class="block relative">
          <div id="adContainer" class="w-full rounded-lg shadow-md overflow-hidden"></div>
        </a>
        <div id="noAd" class="text-center text-gray-400 text-sm py-6">No advertisement available</div>
        <div id="adText" class="text-xs text-gray-600 text-center mt-2 hidden"></div>
      </aside>
    </main>
  </div>

  <!-- Demo fallback (callable) - kept small & safe -->
  <script>
    // Demo fallback will be called only when bootstrap fails/unauthorized.
    // It exposes minimal tenantRef/runTx helpers using localStorage and then populates UI similarly.
    window.__QJ_DEMO_FALLBACK = function demoFallback() {
      // detect slug (path first, then query debug_tenant)
      function getSlugFromPath() {
        try {
          const qp = new URL(location.href).searchParams;
          if (qp.get('debug_tenant')) return qp.get('debug_tenant');
        } catch(e){}
        const parts = (location.pathname||'/').split('/').filter(Boolean);
        return parts.length ? parts[0] : 'demo';
      }
      const TENANT = getSlugFromPath();
      window.__TENANT__ = TENANT;

      // simple localStorage namespacing
      const NS = `qj_demo__${TENANT}__`;
      function lsKey(k){ return NS + k; }
      function lsGet(k){ try { return JSON.parse(localStorage.getItem(lsKey(k))); } catch(e){ return null } }
      function lsSet(k,v){ localStorage.setItem(lsKey(k), JSON.stringify(v)); }

      // expose tenantRef-like API (very small subset)
      window.tenantRef = function(path) {
        path = (path||'').replace(/^\/+/, '');
        return {
          async get() { return lsGet(path) || null; },
          async set(v) { lsSet(path, v); return true; },
          async push(v) {
            const list = lsGet(path) || {};
            const key = 'id_' + Date.now();
            list[key] = v;
            lsSet(path, list);
            return { key, val: v };
          },
          async update(obj) {
            const cur = lsGet(path) || {};
            Object.assign(cur, obj);
            lsSet(path, cur);
            return true;
          },
          async onceValue() { return { exists: ()=> !!lsGet(path), val: ()=> lsGet(path) } }
        }
      };

      window.runTxWithRetries = async function(path, updater) {
        const cur = lsGet(path) || 0;
        const next = updater(cur);
        lsSet(path, next);
        return { committed:true, snapshot:{ val: ()=> next } };
      };

      // write a basic demo settings object if missing
      if (!lsGet('settings')) {
        lsSet('settings', {
          name: 'Demo Cafe',
          titleinmiddle: 'Get your demo queue number',
          ctaText: 'Get a demo ticket',
          adText: '',
          logo: '',
          adImage: ''
        });
      }

      // Quick "populate UI" using same DOM IDs as production watcher expects.
      const updateFromSettings = () => {
        const s = lsGet('settings') || {};
        const pick = v => (typeof v === 'string' && v.trim()) ? v.trim() : (typeof v === 'number' || typeof v === 'boolean') ? v : null;
        const siteTitleEl = document.getElementById('siteTitle');
        const mainHeading = document.getElementById('mainHeading');
        const introText = document.getElementById('introText');
        const btnText = document.getElementById('btnText');
        if (siteTitleEl) siteTitleEl.textContent = pick(s.name) || 'Queue Joy (demo)';
        if (mainHeading) mainHeading.textContent = pick(s.titleinmiddle) || 'Get your demo queue number';
        if (introText) introText.textContent = pick(s.introText) || 'Demo fallback is active.';
        if (btnText) btnText.textContent = '🎫 ' + (pick(s.ctaText) || 'Get your queue number');
        // set tenant-debug
        const dbg = document.getElementById('tenant-debug');
        if (dbg) { dbg.dataset.path = location.pathname; dbg.dataset.tenant = TENANT; dbg.style.display = 'none'; }
      };

      updateFromSettings();

      // show debug in console
      console.info('Demo fallback enabled for tenant:', TENANT);
    };
  </script>

  <!-- Load tenant runtime (module) -->
  <script type="module" src="/js/bootstrap.js"></script>

  <!-- Safety: if bootstrap didn't set a tenant (e.g. module load error), run demo fallback after short timeout -->
  <script>
    setTimeout(()=> {
      try {
        const dbg = document.getElementById('tenant-debug');
        if (dbg) dbg.dataset.checkedAt = new Date().toISOString();
        // If no tenant was set by bootstrap, run demo fallback
        if (!window.__TENANT__) {
          console.warn('bootstrap did not set window.__TENANT__; running demo fallback');
          if (typeof window.__QJ_DEMO_FALLBACK === 'function') window.__QJ_DEMO_FALLBACK();
        }
      } catch(e){ console.warn('fallback check failed', e); }
    }, 350);
  </script>
</body>
</html>
