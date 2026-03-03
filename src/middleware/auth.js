// ─── API Key auth middleware ─────────────────────────────────────────
// If API_KEY env var is set, every request must include:
//   X-API-Key: <key>
// If API_KEY is NOT set (local dev), all requests pass through.
// ────────────────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const apiKey = process.env.API_KEY;

  // No key configured → open access (dev mode)
  if (!apiKey) return next();

  // Accept X-API-Key header
  let provided = req.headers['x-api-key'];

  // Also accept Authorization: Bearer <token> (Print Client compat)
  if (!provided) {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      provided = authHeader.slice(7);
    }
  }

  if (!provided) {
    return res.status(401).json({ error: 'Missing X-API-Key or Authorization header' });
  }

  // Accept the primary API key OR the Print Client's existing JWT token
  const printClientToken = process.env.PRINT_CLIENT_TOKEN;
  const validTokens = [apiKey];
  if (printClientToken) validTokens.push(printClientToken);

  if (!validTokens.includes(provided)) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  next();
}

module.exports = { authMiddleware };
