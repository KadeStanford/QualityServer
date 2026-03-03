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

// ─── Create job ─────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { templateName, printer, printerName, printerId, copies, pdfData, labelData, paperSize } = req.body;

  if (!pdfData) {
    return res.status(400).json({ error: 'pdfData (base64 PDF) is required' });
  }

  const job = {
    id: uuidv4(),
    templateName: templateName || 'Unnamed',
    printer: printer || printerName || null,
    printerId: printerId || null,
    copies: copies || 1,
    pdfData,
    labelData: labelData || {},
    paperSize: paperSize || 'Brother-QL800',
    status: 'pending',
    createdAt: new Date().toISOString(),
    claimedBy: null,
    claimedAt: null,
    completedAt: null,
    failedAt: null,
    errorMessage: null,
    retryCount: 0
  };

  const jobs = await read('jobs');
  jobs.push(job);
  await write('jobs', jobs);

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
  const { limit } = req.query;
  let jobs = (await read('jobs')).filter(j => j.status === 'pending');

  // Oldest first so they print in order
  jobs.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (limit) jobs = jobs.slice(0, parseInt(limit, 10));

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
