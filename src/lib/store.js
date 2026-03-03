// ─── Data store — auto-selects backend ──────────────────────────────
// If DYNAMODB_TABLE env var is set → DynamoDB (Lambda / Amplify).
// Otherwise → JSON files in data/ (local dev).
// ────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

const USE_DYNAMO = !!process.env.DYNAMODB_TABLE;

// ═══════════════════════════════════════════════════════════════════
//  DynamoDB backend  (one row per collection, data stored as list)
// ═══════════════════════════════════════════════════════════════════

let _docClient = null;

function dynamo() {
  if (!_docClient) {
    const { DynamoDBClient }         = require('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

    // Amplify WEB_COMPUTE doesn't inject IAM role credentials into the
    // runtime.  Use explicit credentials via DYNAMO_* env vars instead.
    const clientOpts = { region: process.env.DYNAMO_REGION || process.env.AWS_REGION || 'us-east-1' };
    if (process.env.DYNAMO_ACCESS_KEY && process.env.DYNAMO_SECRET_KEY) {
      clientOpts.credentials = {
        accessKeyId:     process.env.DYNAMO_ACCESS_KEY,
        secretAccessKey: process.env.DYNAMO_SECRET_KEY
      };
    }
    _docClient = DynamoDBDocumentClient.from(new DynamoDBClient(clientOpts));
  }
  return _docClient;
}

function table() { return process.env.DYNAMODB_TABLE; }

// ═══════════════════════════════════════════════════════════════════
//  JSON-file backend  (local dev, or Lambda /tmp fallback)
// ═══════════════════════════════════════════════════════════════════

// Lambda filesystem is read-only except /tmp — use that when in Lambda
const IS_LAMBDA = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const DATA_DIR = IS_LAMBDA
  ? path.join('/tmp', 'data')
  : path.join(__dirname, '..', '..', 'data');
const FILES = {
  jobs:     path.join(DATA_DIR, 'print-jobs.json'),
  printers: path.join(DATA_DIR, 'printers.json'),
  clients:  path.join(DATA_DIR, 'clients.json')
};

// ─── Init (only touches disk when using file backend) ──────────────

function ensureDataDir() {
  if (USE_DYNAMO) return;                        // DynamoDB: nothing to init
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const [, filePath] of Object.entries(FILES)) {
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '[]');
  }
}

// ─── Read ──────────────────────────────────────────────────────────

async function read(collection) {
  if (USE_DYNAMO) {
    const { GetCommand } = require('@aws-sdk/lib-dynamodb');
    try {
      const res = await dynamo().send(new GetCommand({
        TableName: table(),
        Key: { pk: collection }
      }));
      return res.Item ? res.Item.data : [];
    } catch (err) {
      console.error(`DynamoDB read(${collection}):`, err.message);
      return [];
    }
  }

  // File fallback
  try { return JSON.parse(fs.readFileSync(FILES[collection], 'utf8')); }
  catch { return []; }
}

// ─── Write ─────────────────────────────────────────────────────────

async function write(collection, data) {
  if (USE_DYNAMO) {
    const { PutCommand } = require('@aws-sdk/lib-dynamodb');
    try {
      await dynamo().send(new PutCommand({
        TableName: table(),
        Item: { pk: collection, data }
      }));
      return;
    } catch (err) {
      console.error(`DynamoDB write(${collection}):`, err.message);
      // Fall through to file backend as emergency fallback
    }
  }

  ensureDataDir();
  fs.writeFileSync(FILES[collection], JSON.stringify(data, null, 2));
}

// ─── Stats ─────────────────────────────────────────────────────────

async function getStats() {
  const jobs     = await read('jobs');
  const printers = await read('printers');
  const clients  = await read('clients');

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
