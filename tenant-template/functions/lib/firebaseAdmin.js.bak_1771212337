/*
  firebaseAdmin.js - initialize firebase-admin with FIREBASE_SERVICE_ACCOUNT_BASE64 env var.
  Expects FIREBASE_SERVICE_ACCOUNT_BASE64 to be a base64 encoded JSON service account.
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('firebase-admin');

if (admin.apps && admin.apps.length > 0) {
  module.exports = admin;
  return;
}

const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || null;
if (!b64) {
  console.error('FIREBASE_SERVICE_ACCOUNT_BASE64 not set in env. Firebase admin will not be initialized.');
  module.exports = admin;
  return;
}

try {
  const tmpfile = path.join(os.tmpdir(), `fb-sa-${Date.now()}.json`);
  const buf = Buffer.from(b64, 'base64');
  fs.writeFileSync(tmpfile, buf);
  const serviceAccount = require(tmpfile);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  module.exports = admin;
} catch (err) {
  console.error('Failed to init firebase admin:', err);
  module.exports = admin;
}
