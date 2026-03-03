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
app.get('/api/print/stats', authMiddleware, async (_req, res) => {
  try {
    res.json(await getStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
