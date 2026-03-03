// ─── QualityServer  ──  src/index.js ────────────────────────────────
// Standalone print-job API.  Dashboard POSTs jobs, print client polls.
// Runs as Express locally OR as AWS Lambda via serverless-http.
// ────────────────────────────────────────────────────────────────────

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const { authMiddleware } = require('./middleware/auth');
const printJobRoutes     = require('./routes/printJobs');
const printerRoutes      = require('./routes/printers');
const clientRoutes       = require('./routes/clients');
const { log }            = require('./lib/logger');
const { ensureDataDir }  = require('./lib/store');

// ─── Load .env for local dev only ──────────────────────────────────
const envPath = path.join(__dirname, '..', '.env');
try {
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8')
      .split('\n')
      .filter(l => l.trim() && !l.startsWith('#'))
      .forEach(l => {
        const [key, ...rest] = l.split('=');
        if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
      });
  }
} catch (e) { /* ignore missing .env */ }

const app  = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// ─── CORS ──────────────────────────────────────────────────────────
const defaultOrigins = [
  'https://qualitytirelube.com',
  'https://www.qualitytirelube.com'
];

const envOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [];

const allowedOrigins = [...new Set([...defaultOrigins, ...envOrigins])];

const corsOptions = {
  origin(origin, cb) {
    // Allow no-origin requests (curl, mobile, print client)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    // Allow localhost in dev
    if (process.env.NODE_ENV !== 'production' &&
        (origin.includes('localhost') || origin.includes('127.0.0.1'))) {
      return cb(null, true);
    }
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
};

// Preflight for every route
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

// ─── Body parsing ──────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));   // base64 PDF payloads can be large

// ─── Request logging (lightweight) ─────────────────────────────────
app.use((req, _res, next) => {
  log(`${req.method} ${req.path}`);
  next();
});

// ─── Health check (no auth) ────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ─── API routes ────────────────────────────────────────────────────
app.use('/api/print/jobs',    authMiddleware, printJobRoutes);
app.use('/api/print/printers', authMiddleware, printerRoutes);
app.use('/api/print/clients', authMiddleware, clientRoutes);

// Stats route (convenience — lives at /api/print/stats)
const { getStats } = require('./lib/store');
const statsHandler = async (_req, res) => {
  try {
    res.json(await getStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
app.get('/api/print/stats', authMiddleware, statsHandler);
app.get('/api/print/stats/polling', authMiddleware, statsHandler); // Print Client compat

// ─── Print Client compatibility routes ─────────────────────────────
// The Print Client (Python) uses slightly different paths than our
// canonical routes.  These aliases keep it working without changes.

const { read, write } = require('./lib/store');
const { v4: uuidv4 } = require('uuid');

// POST /api/login — Print Client expects JWT login; we return the API key as a "token"
app.post('/api/login', (_req, res) => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return res.json({ token: 'dev-mode', message: 'No auth required' });
  res.json({ token: apiKey, message: 'Use this value as your Bearer token or X-API-Key' });
});

// POST /api/print/client/register-printers → same logic as POST /api/print/printers
app.post('/api/print/client/register-printers', authMiddleware, async (req, res) => {
  const { clientId, printers } = req.body;
  if (!clientId || !Array.isArray(printers)) {
    return res.status(400).json({ error: 'clientId and printers[] required' });
  }
  const db = await read('printers');
  for (const p of printers) {
    const sysName = p.systemName || p.systemPrinterName || p.name;
    const idx = db.findIndex(x => x.systemName === sysName && x.clientId === clientId);
    const record = {
      id: idx >= 0 ? db[idx].id : uuidv4(),
      clientId,
      name: p.name,
      type: p.type || 'Generic',
      connectionType: p.connectionType || 'network',
      status: p.status || 'online',
      systemName: sysName,
      lastSeen: new Date().toISOString()
    };
    if (idx >= 0) db[idx] = record; else db.push(record);
  }
  await write('printers', db);
  log(`${printers.length} printer(s) registered from client ${clientId} (compat)`);
  res.json({ message: `${printers.length} printer(s) registered` });
});

// PUT /api/print/client/printer-status → same logic as PUT /api/print/printers/status
app.put('/api/print/client/printer-status', authMiddleware, async (req, res) => {
  const { clientId, printerStatuses, statuses } = req.body;
  const statusList = statuses || printerStatuses;
  if (!clientId || !Array.isArray(statusList)) {
    return res.status(400).json({ error: 'clientId and statuses/printerStatuses[] required' });
  }
  const db = await read('printers');
  let updated = 0;
  for (const s of statusList) {
    const sysName = s.systemName || s.name;
    const printer = db.find(p => (p.systemName === sysName || p.name === sysName) && p.clientId === clientId);
    if (printer) {
      printer.status = s.status;
      printer.lastSeen = new Date().toISOString();
      updated++;
    }
  }
  await write('printers', db);
  res.json({ message: `Updated ${updated} printer statuses` });
});

// DELETE /api/print/printers/all → alias for DELETE /api/print/printers
app.delete('/api/print/printers/all', authMiddleware, async (_req, res) => {
  const db = await read('printers');
  await write('printers', []);
  log(`Cleared ${db.length} printers (compat)`);
  res.json({ message: `Cleared ${db.length} printers` });
});

// GET /api/print-client-tokens — Print Client checks for permanent tokens
app.get('/api/print-client-tokens', authMiddleware, (_req, res) => {
  res.json({ tokens: [] });
});

// ─── 404 ───────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Error handler ─────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  log(`ERROR: ${err.message}`, 'error');
  res.status(err.status || 500).json({ error: err.message });
});

// ─── Init data dir ─────────────────────────────────────────────────
try { ensureDataDir(); } catch (e) { log(`ensureDataDir warning: ${e.message}`); }

// ─── Start server ──────────────────────────────────────────────────
app.listen(PORT, () => {
  log(`QualityServer running on port ${PORT}`);
  log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  log(`CORS origins: ${allowedOrigins.join(', ')}`);
  log(`Auth: ${process.env.API_KEY ? 'API key required' : 'OPEN (no API_KEY set)'}`);
});

// Export for testing
module.exports = app;
