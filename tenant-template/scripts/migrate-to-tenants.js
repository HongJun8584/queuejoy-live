/**
 * migrate-to-tenants.js
 *
 * Node script — move/copy existing top-level Firebase Realtime Database
 * structure into tenants/<slug>/... so legacy pages continue to work.
 *
 * Usage:
 *   # install deps first
 *   npm install firebase-admin minimist
 *
 *   # run for single slug (recommended)
 *   node migrate-to-tenants.js --slug=my-tenant-slug
 *
 *   # run to preview only (no writes)
 *   node migrate-to-tenants.js --slug=my-tenant-slug --dry
 *
 *   # run to migrate multiple slugs by mapping file (json)
 *   node migrate-to-tenants.js --map=tenants-map.json
 *
 * Requirements:
 * - A Firebase service account JSON (set env var GOOGLE_APPLICATION_CREDENTIALS
 *   to the path) or have default application credentials available.
 *
 * Behavior:
 * - Copies these top-level nodes if they exist:
 *     settings, queue, counters, analytics
 *   into tenants/<slug>/settings, tenants/<slug>/queue, ...
 *
 * - Does NOT delete original data (safer). It optionally writes a marker
 *   tenants/<slug>/_migratedFrom = {ts, sourcePath}
 *
 * - Keeps timestamps and structure intact (shallow copy using values).
 *
 * NOTE: read code, test with --dry before running in prod.
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const minimist = require('minimist');

async function main() {
  const argv = minimist(process.argv.slice(2), {
    string: ['slug', 'map'],
    boolean: ['dry'],
    default: { dry: false }
  });

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('ERROR: Set GOOGLE_APPLICATION_CREDENTIALS to your service-account.json path.');
    process.exit(1);
  }

  const serviceAccount = require(process.env.GOOGLE_APPLICATION_CREDENTIALS);

  // init admin
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: argv.dburl || (serviceAccount.project_id ? `https://${serviceAccount.project_id}-default-rtdb.asia-southeast1.firebasedatabase.app` : null)
    });
  } catch (e) {
    console.error('Firebase admin init failed:', e);
    process.exit(1);
  }

  const db = admin.database();

  // nodes to migrate
  const nodes = ['settings', 'queue', 'counters', 'analytics'];

  if (argv.map) {
    // map mode: read JSON of { "slug": "targetPath" } or array of slugs
    const mapFile = path.resolve(argv.map);
    if (!fs.existsSync(mapFile)) {
      console.error('Map file not found:', mapFile);
      process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    const slugs = Array.isArray(data) ? data : Object.keys(data).length ? Object.keys(data) : null;
    if (!slugs) {
      console.error('Map file must be array of slugs or object mapping slug->...; found:', typeof data);
      process.exit(1);
    }
    for (const slug of slugs) {
      await migrateSlug(db, slug, nodes, argv.dry);
    }
  } else if (argv.slug) {
    await migrateSlug(db, argv.slug, nodes, argv.dry);
  } else {
    console.error('Usage: node migrate-to-tenants.js --slug=my-tenant-slug [--dry]');
    process.exit(1);
  }

  console.log('Migration script finished.');
  process.exit(0);
}

async function migrateSlug(db, slug, nodes, dry) {
  console.log(`\n=== Migrating slug: ${slug}  (dry=${!!dry}) ===`);
  const now = Date.now();

  for (const node of nodes) {
    try {
      const srcRef = db.ref(node);
      const snapshot = await srcRef.once('value');
      if (!snapshot.exists()) {
        console.log(` - node "${node}" not found at root — skipping.`);
        continue;
      }
      const val = snapshot.val();
      const destPath = `tenants/${slug}/${node}`;
      const destRef = db.ref(destPath);

      console.log(` - will copy node "${node}" -> "${destPath}" (keys: ${Object.keys(val || {}).length})`);

      if (!dry) {
        await destRef.set(val);
        console.log(`   ✓ copied ${node}`);
      } else {
        console.log(`   (dry run) skipped actual write for ${destPath}`);
      }
    } catch (e) {
      console.error(`   ✗ failed copying node ${node}:`, e);
    }
  }

  // write migration marker
  const markerRef = db.ref(`tenants/${slug}/_migratedFrom`);
  const marker = { at: now, source: 'root', by: process.env.USER || process.env.USERNAME || 'migrate-to-tenants' };
  if (!dry) {
    try {
      await markerRef.set(marker);
      console.log(' - marker written at tenants/%s/_migratedFrom', slug);
    } catch (e) {
      console.warn(' - failed writing marker:', e);
    }
  } else {
    console.log(' - (dry run) marker not written');
  }
}

main().catch(err => {
  console.error('Migration failed', err);
  process.exit(1);
});
