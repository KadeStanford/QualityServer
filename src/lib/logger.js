// ─── Simple logger ──────────────────────────────────────────────────
function log(msg, level = 'info') {
  const ts = new Date().toISOString();
  const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '→';
  console.log(`[${ts}] ${prefix} ${msg}`);
}

module.exports = { log };
