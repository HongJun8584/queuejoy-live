// tenant-firebase.js
// Dynamically fetch tenant public config and initialize Firebase app + DB.
// Returns { cfg, app, db, dbApi } on success, or an object indicating unauthorized or error.

export async function initFirebaseForTenant(slug) {
  const url = `/.netlify/functions/get-firebase-config?slug=${encodeURIComponent(slug)}`;
  let res;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (err) {
    throw new Error(`Network error fetching firebase config for "${slug}": ${err.message || err}`);
  }

  if (!res.ok) {
    // try parse JSON body for more info
    let bodyText = await res.text().catch(()=>null);
    let body = null;
    try { body = JSON.parse(bodyText); } catch(e){}
    if (res.status === 403 || (body && body.unauthorized)) {
      return { unauthorized: true, message: body && body.message || 'unauthorized' };
    }
    throw new Error(`Failed to fetch firebase config for "${slug}": ${res.status} ${bodyText || ''}`);
  }

  const cfg = await res.json();

  if (!cfg || cfg.unauthorized) return cfg;

  // Initialize firebase app + database (modular SDK) dynamically
  try {
    const firebaseAppMod = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js');
    const firebaseDbMod = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js');

    const { initializeApp } = firebaseAppMod;
    const { getDatabase, ref, get, child, push, onValue, runTransaction, set } = firebaseDbMod;

    const app = initializeApp(cfg);
    const db = getDatabase(app);

    // Attach to window for convenience/debug
    window.firebaseApp = app;
    window.firebaseDb = db;
    window.firebaseDbApi = { ref, get, child, push, onValue, runTransaction, set };

    return { cfg, app, db, dbApi: window.firebaseDbApi };
  } catch (err) {
    // If dynamic import or init fails, return cfg so bootstrap can decide fallback
    console.warn('tenant-firebase: failed dynamic import or init', err);
    return { cfg, initError: String(err) };
  }
}
