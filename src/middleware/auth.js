// ─── API Key auth middleware ─────────────────────────────────────────
// If API_KEY env var is set, every request must include:
//   X-API-Key: <key>
// If API_KEY is NOT set (local dev), all requests pass through.
// ────────────────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const apiKey = process.env.API_KEY;

  // No key configured → open access (dev mode)
  if (!apiKey) return next();

  const provided = req.headers['x-api-key'];
  if (!provided) {
    return res.status(401).json({ error: 'Missing X-API-Key header' });
  }
  if (provided !== apiKey) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  next();
}

module.exports = { authMiddleware };
