// ─── Print Client routes ────────────────────────────────────────────
// POST /register — register / heartbeat a print client
// GET  /         — list all clients
// ────────────────────────────────────────────────────────────────────

const express = require('express');
const { read, write } = require('../lib/store');
const { log } = require('../lib/logger');

const router = express.Router();

// ─── Register or heartbeat ──────────────────────────────────────────

router.post('/register', (req, res) => {
  const { clientId, name, description } = req.body;

  if (!clientId) return res.status(400).json({ error: 'clientId is required' });

  const clients = read('clients');
  const idx = clients.findIndex(c => c.clientId === clientId);

  const record = {
    clientId,
    name: name || `Client-${clientId.substring(0, 8)}`,
    description: description || '',
    lastSeen: new Date().toISOString(),
    registeredAt: idx >= 0 ? clients[idx].registeredAt : new Date().toISOString()
  };

  if (idx >= 0) clients[idx] = { ...clients[idx], ...record };
  else clients.push(record);

  write('clients', clients);
  log(`Print client registered: ${record.name}`);
  res.json({ message: 'Client registered', client: record });
});

// ─── List clients ───────────────────────────────────────────────────

router.get('/', (_req, res) => {
  res.json(read('clients'));
});

module.exports = router;
