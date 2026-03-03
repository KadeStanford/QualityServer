// ─── Printer routes ─────────────────────────────────────────────────
// GET    /           → List all registered printers
// POST   /           → Register printers (print client sends its list)
// PUT    /status     → Bulk-update printer statuses
// DELETE /           → Clear all printers
// ────────────────────────────────────────────────────────────────────

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { read, write } = require('../lib/store');
const { log } = require('../lib/logger');

const router = express.Router();

// ─── List printers ──────────────────────────────────────────────────

router.get('/', async (_req, res) => {
  res.json(await read('printers'));
});

// ─── Register printers (from print client) ──────────────────────────

router.post('/', async (req, res) => {
  const { clientId, printers } = req.body;

  if (!clientId || !Array.isArray(printers)) {
    return res.status(400).json({ error: 'clientId and printers[] required' });
  }

  const db = await read('printers');

  for (const p of printers) {
    const idx = db.findIndex(
      x => x.systemName === (p.systemName || p.name) && x.clientId === clientId
    );

    const record = {
      id: idx >= 0 ? db[idx].id : uuidv4(),
      clientId,
      name: p.name,
      type: p.type || 'Generic',
      connectionType: p.connectionType || 'network',
      status: p.status || 'online',
      systemName: p.systemName || p.name,
      lastSeen: new Date().toISOString()
    };

    if (idx >= 0) db[idx] = record;
    else db.push(record);
  }

  await write('printers', db);
  log(`${printers.length} printer(s) registered from client ${clientId}`);
  res.json({ message: `${printers.length} printer(s) registered` });
});

// ─── Bulk-update statuses ───────────────────────────────────────────

router.put('/status', async (req, res) => {
  const { clientId, statuses, printerStatuses } = req.body;
  const statusList = statuses || printerStatuses;

  if (!clientId || !Array.isArray(statusList)) {
    return res.status(400).json({ error: 'clientId and statuses[] required' });
  }

  const db = await read('printers');
  let updated = 0;

  for (const s of statusList) {
    const printer = db.find(p => (p.systemName === (s.systemName || s.name) || p.name === s.name) && p.clientId === clientId);
    if (printer) {
      printer.status = s.status;
      printer.lastSeen = new Date().toISOString();
      updated++;
    }
  }

  await write('printers', db);
  res.json({ message: `Updated ${updated} printer statuses` });
});

// ─── Clear all printers ─────────────────────────────────────────────

router.delete('/', async (_req, res) => {
  const db = await read('printers');
  await write('printers', []);
  log(`Cleared ${db.length} printers`);
  res.json({ message: `Cleared ${db.length} printers` });
});

module.exports = router;
