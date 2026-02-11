// functions/announce.js
// Tenant-aware Netlify Function to broadcast an announcement via Telegram.
// Behavior:
//  - Accepts POST body containing either:
//      { message, media, mediaType, chatIds, telegramBotToken }
//    OR
//      { tenant }  -- will read chatIds and botToken from Firebase RTDB at tenants/{tenant}/announcement
//  - If both tenant and explicit chatIds/botToken provided, explicit values take precedence.
//  - Supports text-only and single-media announcements (image/video/audio/animation/document).
//
// Required env when using tenant lookups:
//  - FIREBASE_DATABASE_URL  (Realtime DB URL, e.g. https://...firebaseio.com)
//  - FIREBASE_SERVICE_ACCOUNT (JSON string of service account)  OR a path-based service account if your platform provides it.
//
// CORS-friendly and returns JSON result summary.

const globalFetch = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

let adminInitialized = false;
let admin = null;

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

function safeParseJSON(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

async function initFirebaseAdminOnce() {
  if (adminInitialized) return admin;
  try {
    // Lazy require to avoid cold-start overhead if not needed
    admin = require('firebase-admin');

    // Allow providing service account as JSON string in env var
    const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT || null;
    const databaseURL = process.env.FIREBASE_DATABASE_URL || null;

    if (!serviceAccountRaw || !databaseURL) {
      // Do not throw here: function can still operate if caller provides botToken/chatIds directly
      console.warn('Firebase admin not initialized: missing FIREBASE_SERVICE_ACCOUNT or FIREBASE_DATABASE_URL');
      adminInitialized = false;
      return null;
    }

    const serviceAccount = (typeof serviceAccountRaw === 'string')
      ? safeParseJSON(serviceAccountRaw) || JSON.parse(serviceAccountRaw)
      : serviceAccountRaw;

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL
    });

    adminInitialized = true;
    return admin;
  } catch (err) {
    console.warn('initFirebaseAdminOnce failed', err);
    adminInitialized = false;
    return null;
  }
}

function normalizeChatIds(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'object') return Object.keys(raw);
  if (typeof raw === 'string') {
    // comma separated
    if (raw.includes(',')) return raw.split(',').map(s => s.trim()).filter(Boolean);
    return [raw];
  }
  return [];
}

async function sendMessageText(apiBase, chatId, text) {
  const res = await globalFetch(apiBase + "sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text || "Announcement",
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });
  return res.json();
}

async function sendMedia(apiBase, chatId, mediaBase64, mediaType, message) {
  // mediaBase64 expected to be either "data:<type>;base64,AA..." or raw base64 string
  let payloadBase64 = mediaBase64 || "";
  const dataPrefixMatch = payloadBase64.match(/^data:([^;]+);base64,(.*)$/s);
  if (dataPrefixMatch) {
    mediaType = mediaType || dataPrefixMatch[1];
    payloadBase64 = dataPrefixMatch[2];
  }

  const fileBuffer = Buffer.from(payloadBase64, "base64");

  // pick telegram method + field
  let method = "sendDocument";
  let field = "document";
  if (mediaType) {
    if (mediaType.startsWith("image/")) { method = "sendPhoto"; field = "photo"; }
    else if (mediaType.startsWith("video/")) { method = "sendVideo"; field = "video"; }
    else if (mediaType.startsWith("audio/")) { method = "sendAudio"; field = "audio"; }
    else if (mediaType.includes("gif")) { method = "sendAnimation"; field = "animation"; }
  }

  const extMap = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg'
  };
  const ext = extMap[mediaType] || 'bin';
  const filename = `announcement.${ext}`;

  // Node 18+ has global FormData & Blob, use them. Fallback to form-data if necessary.
  let form;
  try {
    form = new FormData();
    // Create a Blob from buffer
    const blob = (typeof Blob !== 'undefined') ? new Blob([fileBuffer], { type: mediaType || 'application/octet-stream' }) : null;
    if (blob) {
      form.append(field, blob, filename);
    } else {
      // fallback: convert buffer to ReadableStream (works in Node 18) or use Buffer directly
      form.append(field, fileBuffer, filename);
    }
    if (message) form.append("caption", message);
    form.append("chat_id", String(chatId));
  } catch (e) {
    // If FormData/Blob not available, try using node-fetch's form-data package (best-effort)
    const FormDataPkg = require('form-data');
    form = new FormDataPkg();
    form.append(field, fileBuffer, { filename, contentType: mediaType || 'application/octet-stream' });
    if (message) form.append("caption", message);
    form.append("chat_id", String(chatId));
  }

  const res = await globalFetch(apiBase + method, {
    method: "POST",
    body: form
    // Note: do not set Content-Type header; fetch will add correct multipart boundary
  });
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Use POST only." }) };
  }

  try {
    const rawBody = event.body || "{}";
    const body = (typeof rawBody === "string") ? safeParseJSON(rawBody) || {} : rawBody;

    // Possible inputs:
    //  - message, media, mediaType, chatIds (array/string), telegramBotToken
    //  - tenant (slug) -> function will attempt to read tenants/{tenant}/announcement/{botToken,chatIds} from RTDB
    const tenant = body.tenant || body.slug || null;
    let chatIds = normalizeChatIds(body.chatIds);
    let botToken = body.telegramBotToken || body.botToken || body.token || null;
    const message = (body.message || "").trim();
    const mediaBase64 = body.media || "";
    const mediaType = body.mediaType || "";

    // If tenant provided and missing chatIds or botToken, try reading from Firebase
    if ((tenant && (!chatIds.length || !botToken))) {
      const fbAdmin = await initFirebaseAdminOnce();
      if (fbAdmin && adminInitialized) {
        try {
          const dbRef = admin.database().ref(`tenants/${tenant}/announcement`);
          const snap = await dbRef.get();
          if (snap && snap.exists && snap.exists()) {
            const ann = snap.val();
            if (!chatIds.length && ann.chatIds) chatIds = normalizeChatIds(ann.chatIds);
            if (!botToken && (ann.botToken || ann.telegramBotToken)) botToken = ann.botToken || ann.telegramBotToken;
          } else {
            console.warn(`No announcement node for tenant ${tenant}`);
          }
        } catch (err) {
          console.warn('Firebase read for tenant announcement failed', err);
        }
      } else {
        console.warn('Firebase admin not initialized; tenant lookup skipped');
      }
    }

    if (!botToken) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing Telegram bot token (provide telegramBotToken or configure tenants/{slug}/announcement/botToken in Firebase)" }) };
    }

    if (!chatIds.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "No chatIds provided (body.chatIds or tenants/{slug}/announcement/chatIds required)" }) };
    }

    const apiBase = `https://api.telegram.org/bot${botToken}/`;

    const results = { success: 0, failed: 0, errors: [] };

    for (const idRaw of chatIds) {
      const chatId = String(idRaw);
      try {
        let r;
        if (!mediaBase64) {
          r = await sendMessageText(apiBase, chatId, message);
        } else {
          r = await sendMedia(apiBase, chatId, mediaBase64, mediaType, message);
        }
        if (r && (r.ok === true || r.result)) {
          results.success++;
        } else {
          results.failed++;
          const errMsg = (r && (r.description || r.error || JSON.stringify(r))) || 'Unknown error';
          results.errors.push({ chatId, error: errMsg });
        }
      } catch (err) {
        results.failed++;
        results.errors.push({ chatId, error: err.message || String(err) });
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify(results) };
  } catch (err) {
    console.error('announce handler error', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Internal error' }) };
  }
};
