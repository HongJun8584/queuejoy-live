'use strict';
const parseJSON = (s) => { try { return JSON.parse(s); } catch(e){ return null; } };

exports.handler = async function(event, context) {
  const query = (event.queryStringParameters) || {};
  const slug = query.slug || null;
  if (!slug) return { statusCode: 400, body: JSON.stringify({ ok:false, error:'missing slug' }) };

  const providedMaster = (event.headers && (event.headers['x-master-key'] || event.headers['X-Master-Key'])) || null;
  const MASTER_API_KEY = process.env.MASTER_API_KEY || '';

  const publicShape = {
    ok: true,
    slug,
    public: {
      displayName: `Demo Tenant - ${slug}`,
      theme: {},
      features: { queue: true }
    }
  };

  const fbBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT || null;
  if (!fbBase64) {
    if (providedMaster && providedMaster === MASTER_API_KEY) {
      return { statusCode: 200, body: JSON.stringify(Object.assign({}, publicShape, { admin: { demo:true, note:'no firebase creds' } })) };
    }
    return { statusCode: 200, body: JSON.stringify(publicShape) };
  }

  try {
    const admin = require('firebase-admin');
    if (!admin.apps || admin.apps.length === 0) {
      let serviceAccount = null;
      try {
        const buff = Buffer.from(fbBase64, 'base64');
        const txt = buff.toString('utf8');
        const parsed = parseJSON(txt);
        if (parsed) serviceAccount = parsed;
        else {
          const rawParsed = parseJSON(fbBase64);
          if (rawParsed) serviceAccount = rawParsed;
        }
      } catch(e) {
        const rawParsed = parseJSON(fbBase64);
        if (rawParsed) serviceAccount = rawParsed;
      }
      if (!serviceAccount) {
        if (providedMaster && providedMaster === MASTER_API_KEY) {
          return { statusCode:200, body:JSON.stringify(Object.assign({}, publicShape, { admin:{ demo:true, note:'invalid firebase creds' } })) };
        }
        return { statusCode:200, body:JSON.stringify(publicShape) };
      }
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL || undefined
      });
    }

    const db = admin.database ? admin.database() : null;
    const firestore = admin.firestore ? admin.firestore() : null;

    if (providedMaster && providedMaster === MASTER_API_KEY) {
      if (db) {
        const ref = db.ref(`/tenants/${slug}`);
        const snap = await ref.once('value');
        const tenant = snap.exists() ? snap.val() : null;
        return { statusCode:200, body:JSON.stringify({ ok:true, slug, tenant, source:'rtdb' }) };
      }
      if (firestore) {
        const doc = await firestore.collection('tenants').doc(slug).get();
        const tenant = doc.exists ? doc.data() : null;
        return { statusCode:200, body:JSON.stringify({ ok:true, slug, tenant, source:'firestore' }) };
      }
      return { statusCode:200, body:JSON.stringify(Object.assign({}, publicShape, { admin:{ note:'firebase initialized but no db' } })) };
    }

    if (db) {
      const ref = db.ref(`/tenants/${slug}/public`);
      const snap = await ref.once('value');
      const pub = snap.exists() ? snap.val() : null;
      if (pub) return { statusCode:200, body:JSON.stringify({ ok:true, slug, public:pub, source:'rtdb' }) };
    }
    if (firestore) {
      const doc = await firestore.collection('tenants').doc(slug).get().catch(()=>null);
      if (doc && doc.exists) {
        const data = doc.data();
        if (data && data.public) return { statusCode:200, body:JSON.stringify({ ok:true, slug, public:data.public, source:'firestore-direct' }) };
      }
    }

    return { statusCode:200, body:JSON.stringify({ ok:true, slug, public:{ displayName:`Tenant ${slug}` }, note:'no public config found' }) };
  } catch (err) {
    if (providedMaster && providedMaster === MASTER_API_KEY) {
      return { statusCode:200, body:JSON.stringify(Object.assign({}, { ok:true, slug, public:{ displayName:`Demo ${slug}` } }, { admin:{ error:String(err) } } )) };
    }
    return { statusCode:200, body:JSON.stringify({ ok:true, slug, public:{ displayName:`Demo ${slug}` }, note:'firebase unavailable' }) };
  }
};
