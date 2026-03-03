// ─── Print Job routes ───────────────────────────────────────────────
// POST   /              → Create job (dashboard sends this)
// GET    /              → List all jobs
// GET    /pending       → Poll for pending jobs (print client)
// POST   /:id/claim     → Claim a job (print client)
// POST   /:id/complete  → Mark done
// POST   /:id/fail      → Mark failed (auto-retry up to 3x)
// DELETE /:id           → Delete a single job
// DELETE /clear         → Clear completed/failed jobs
// ────────────────────────────────────────────────────────────────────

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { read, write } = require('../lib/store');
const { log } = require('../lib/logger');

const router = express.Router();

// ─── Forward URL (Inspectionapp at the shop) ────────────────────────
const FORWARD_URL   = process.env.FORWARD_URL || '';   // e.g. https://api.autoflopro.com
const CF_CLIENT_ID  = process.env.CF_ACCESS_CLIENT_ID || '';
const CF_CLIENT_SEC = process.env.CF_ACCESS_CLIENT_SECRET || '';

// ─── Forward a job to the shop's Inspectionapp server ───────────────
// Fire-and-forget — if it fails we still have the local copy.
async function forwardToShopServer(job) {
  if (!FORWARD_URL) return null;
  try {
    const payload = {
      templateName: job.templateName,
      printer:      job.printer,
      copies:       job.copies,
      pdfData:      job.pdfData,
      labelData:    job.labelData,
      paperSize:    job.paperSize,
      locationId:   job.locationId
    };
    const headers = { 'Content-Type': 'application/json' };
    // Cloudflare Access service-token auth (if tunnel is protected)
    if (CF_CLIENT_ID && CF_CLIENT_SEC) {
      headers['CF-Access-Client-Id']     = CF_CLIENT_ID;
      headers['CF-Access-Client-Secret'] = CF_CLIENT_SEC;
    }
    const resp = await fetch(`${FORWARD_URL}/api/print/jobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      log(`Forward failed (${resp.status}): ${await resp.text()}`, 'error');
      return null;
    }
    const data = await resp.json();
    log(`Forwarded job → shop server, remote id: ${data.id}`);
    return data.id;   // the Inspectionapp job id
  } catch (err) {
    log(`Forward error: ${err.message}`, 'error');
    return null;
  }
}

// ─── Sync status of forwarded jobs from shop server ─────────────────
async function syncRemoteStatuses() {
  if (!FORWARD_URL) return;
  try {
    const jobs = await read('jobs');
    // Only sync jobs that were forwarded and aren't terminal
    const pending = jobs.filter(j => j.remoteId && !['completed', 'failed'].includes(j.status));
    if (pending.length === 0) return;

    const fetchHeaders = {};
    if (CF_CLIENT_ID && CF_CLIENT_SEC) {
      fetchHeaders['CF-Access-Client-Id']     = CF_CLIENT_ID;
      fetchHeaders['CF-Access-Client-Secret'] = CF_CLIENT_SEC;
    }

    const resp = await fetch(`${FORWARD_URL}/api/print/jobs`, { headers: fetchHeaders });
    if (!resp.ok) return;
    const remoteJobs = await resp.json();

    const remoteMap = new Map(remoteJobs.map(rj => [rj.id, rj]));
    let changed = false;

    for (const local of pending) {
      const remote = remoteMap.get(local.remoteId);
      if (!remote) continue;
      if (remote.status !== local.status) {
        log(`Sync: job ${local.id} ${local.status} → ${remote.status}`);
        local.status      = remote.status;
        local.claimedBy   = remote.claimedBy   || local.claimedBy;
        local.claimedAt   = remote.claimedAt   || local.claimedAt;
        local.completedAt = remote.completedAt || local.completedAt;
        local.failedAt    = remote.failedAt    || local.failedAt;
        local.errorMessage = remote.errorMessage || local.errorMessage;
        if (remote.status === 'completed') local.pdfData = null; // free memory
        changed = true;
      }
    }

    if (changed) await write('jobs', jobs);
  } catch (err) {
    log(`Sync error: ${err.message}`, 'error');
  }
}

// Run sync every 30 seconds
if (FORWARD_URL) {
  setInterval(syncRemoteStatuses, 30_000);
  log(`Job forwarding enabled → ${FORWARD_URL}`);
}

// ─── Create job ─────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { templateName, formName, printer, printerName, printerId, copies, pdfData, labelData, paperSize, locationId } = req.body;

  if (!pdfData) {
    return res.status(400).json({ error: 'pdfData (base64 PDF) is required' });
  }

  const resolvedName = templateName || formName || 'Unnamed';
  const job = {
    id: uuidv4(),
    templateName: resolvedName,
    formName: resolvedName,        // alias for Print Client compat
    printer: printer || printerName || null,
    printerId: printerId || null,
    copies: copies || 1,
    pdfData,
    labelData: labelData || {},
    paperSize: paperSize || 'Brother-QL800',
    locationId: locationId || null,
    status: 'pending',
    createdAt: new Date().toISOString(),
    claimedBy: null,
    claimedAt: null,
    completedAt: null,
    failedAt: null,
    errorMessage: null,
    retryCount: 0,
    remoteId: null                 // filled if forwarded to shop server
  };

  const jobs = await read('jobs');
  jobs.push(job);
  await write('jobs', jobs);

  // Forward to shop server (fire-and-forget — don't block the response)
  forwardToShopServer(job).then(async (remoteId) => {
    if (remoteId) {
      job.remoteId = remoteId;
      const freshJobs = await read('jobs');
      const target = freshJobs.find(j => j.id === job.id);
      if (target) {
        target.remoteId = remoteId;
        await write('jobs', freshJobs);
      }
    }
  }).catch(() => {});

  log(`Print job created: ${job.id} — ${job.templateName} → ${job.printer || 'any'}`);
  res.status(201).json({ id: job.id, status: 'pending', message: 'Print job queued' });
});

// ─── List all jobs (summary, no pdfData) ────────────────────────────

router.get('/', async (req, res) => {
  const { status, limit } = req.query;
  let jobs = await read('jobs');

  if (status) jobs = jobs.filter(j => j.status === status);

  // Newest first
  jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (limit) jobs = jobs.slice(0, parseInt(limit, 10));

  // Strip bulky pdfData from list view
  const summary = jobs.map(({ pdfData, ...rest }) => rest);
  res.json(summary);
});

// ─── Poll pending jobs (print client calls this) ───────────────────

router.get('/pending', async (req, res) => {
  const { limit, locationId } = req.query;
  let jobs = (await read('jobs')).filter(j => j.status === 'pending');

  // Filter by locationId if the print client provides one
  if (locationId) {
    jobs = jobs.filter(j => !j.locationId || j.locationId === locationId);
  }

  // Oldest first so they print in order
  jobs.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const max = parseInt(limit, 10) || 10;
  jobs = jobs.slice(0, max);

  // Ensure formName alias exists (Print Client compat)
  jobs = jobs.map(j => ({
    ...j,
    formName: j.formName || j.templateName || 'Unnamed'
  }));

  res.json(jobs);
});

// ─── Claim a job ────────────────────────────────────────────────────

router.post('/:id/claim', async (req, res) => {
  const { id } = req.params;
  const { clientId } = req.body;
  const jobs = await read('jobs');
  const job = jobs.find(j => j.id === id);

  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'pending') {
    return res.status(409).json({ error: `Job already ${job.status}`, status: job.status });
  }

  job.status = 'printing';
  job.claimedBy = clientId || 'unknown';
  job.claimedAt = new Date().toISOString();
  await write('jobs', jobs);

  log(`Job ${id} claimed by ${clientId || 'unknown'}`);
  res.json({ message: 'Job claimed', job });
});

// ─── Complete a job ─────────────────────────────────────────────────

router.post('/:id/complete', async (req, res) => {
  const { id } = req.params;
  const { clientId, printDetails } = req.body;
  const jobs = await read('jobs');
  const job = jobs.find(j => j.id === id);

  if (!job) return res.status(404).json({ error: 'Job not found' });

  job.status = 'completed';
  job.completedAt = new Date().toISOString();
  job.printDetails = printDetails || {};
  job.pdfData = null;  // free memory
  await write('jobs', jobs);

  log(`Job ${id} completed by ${clientId || 'unknown'}`);
  res.json({ message: 'Job completed' });
});

// ─── Fail a job (auto-retry up to 3x) ──────────────────────────────

router.post('/:id/fail', async (req, res) => {
  const { id } = req.params;
  const { clientId, errorMessage, shouldRetry } = req.body;
  const jobs = await read('jobs');
  const job = jobs.find(j => j.id === id);

  if (!job) return res.status(404).json({ error: 'Job not found' });

  const willRetry = shouldRetry !== false && (job.retryCount || 0) < 3;

  if (willRetry) {
    job.status = 'pending';
    job.retryCount = (job.retryCount || 0) + 1;
    job.claimedBy = null;
    job.claimedAt = null;
  } else {
    job.status = 'failed';
    job.failedAt = new Date().toISOString();
  }
  job.errorMessage = errorMessage || 'Unknown error';
  await write('jobs', jobs);

  log(`Job ${id} failed${willRetry ? ' — will retry' : ' — permanent'}`);
  res.json({ message: willRetry ? 'Job will be retried' : 'Job failed permanently', willRetry });
});

// ─── Delete a single job ────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  let jobs = await read('jobs');
  const before = jobs.length;
  jobs = jobs.filter(j => j.id !== id);
  await write('jobs', jobs);

  if (jobs.length === before) return res.status(404).json({ error: 'Job not found' });
  res.json({ message: 'Job deleted' });
});

// ─── Clear completed/failed jobs ────────────────────────────────────

router.delete('/clear', async (_req, res) => {
  let jobs = await read('jobs');
  const before = jobs.length;
  jobs = jobs.filter(j => j.status === 'pending' || j.status === 'printing');
  await write('jobs', jobs);

  res.json({ message: `Cleared ${before - jobs.length} jobs` });
});

module.exports = router;
