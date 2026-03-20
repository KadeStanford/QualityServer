// ─── Firebase RTDB wake-up signal (zero-dependency) ──────────────────
// Writes to `printers/pendingSignal` in Firebase Realtime Database
// using a plain HTTPS PUT to the REST API — no SDK or credentials needed
// when the RTDB rules allow public writes on the signal node.
//
// If the write fails for any reason, it's silently ignored — the
// fallback poll in the Print Client still picks up jobs.
// ────────────────────────────────────────────────────────────────────

const https = require('https');
const { log } = require('./logger');

const RTDB_URL = 'https://qualityexpress-c19f2-default-rtdb.firebaseio.com';

function initFirebase() {
  log('RTDB signal: using REST API (no SDK needed)');
}

function sendPendingSignal(jobId) {
  const data = JSON.stringify({ jobId: jobId || null, t: new Date().toISOString() });
  const url = new URL(`${RTDB_URL}/printers/pendingSignal.json`);

  const req = https.request(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  }, (res) => {
    res.resume();
    if (res.statusCode >= 400) {
      log(`RTDB signal: HTTP ${res.statusCode} (non-blocking)`, 'warn');
    }
  });

  req.on('error', (err) => {
    log(`RTDB signal failed (non-blocking): ${err.message}`, 'warn');
  });

  req.write(data);
  req.end();
}

module.exports = { initFirebase, sendPendingSignal };
