// ─── JSON file store ────────────────────────────────────────────────
// Dead-simple persistence: one JSON file per collection in data/.
// Good enough for a label print queue — no database needed.
// ────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

const FILES = {
  jobs:     path.join(DATA_DIR, 'print-jobs.json'),
  printers: path.join(DATA_DIR, 'printers.json'),
  clients:  path.join(DATA_DIR, 'clients.json')
};

// ─── Init ───────────────────────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const [, filePath] of Object.entries(FILES)) {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '[]');
    }
  }
}

// ─── Read / Write ───────────────────────────────────────────────────

function read(collection) {
  try {
    return JSON.parse(fs.readFileSync(FILES[collection], 'utf8'));
  } catch {
    return [];
  }
}

function write(collection, data) {
  fs.writeFileSync(FILES[collection], JSON.stringify(data, null, 2));
}

// ─── Stats ──────────────────────────────────────────────────────────

async function getStats() {
  const jobs     = read('jobs');
  const printers = read('printers');
  const clients  = read('clients');

  const pending   = jobs.filter(j => j.status === 'pending').length;
  const printing  = jobs.filter(j => j.status === 'printing').length;
  const completed = jobs.filter(j => j.status === 'completed').length;
  const failed    = jobs.filter(j => j.status === 'failed').length;

  return {
    status: 'ok',
    queue: { pending, printing, completed, failed, total: jobs.length },
    printers: printers.length,
    clients: clients.length,
    timestamp: new Date().toISOString()
  };
}

module.exports = { ensureDataDir, read, write, getStats };
