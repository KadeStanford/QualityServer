#!/usr/bin/env node
// ─── Amplify WEB_COMPUTE build script ──────────────────────────────
// Phase 1: MINIMAL — raw Lambda handler, zero dependencies
// Once this returns 200 from Amplify we add Express back.
// ────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

const BASE    = '.amplify-hosting';
const COMPUTE = path.join(BASE, 'compute', 'default');
const STATIC  = path.join(BASE, 'static');

// ─── Clean previous build ──────────────────────────────────────────
if (fs.existsSync(BASE)) fs.rmSync(BASE, { recursive: true });

// ─── Create directories ────────────────────────────────────────────
fs.mkdirSync(COMPUTE, { recursive: true });
fs.mkdirSync(STATIC,  { recursive: true });

// ─── Ultra-minimal Lambda handler — zero requires ──────────────────
const handler = `
exports.handler = async (event, context) => {
  // Log the full event so we can see what Amplify sends
  console.log('EVENT:', JSON.stringify(event, null, 2));
  console.log('CONTEXT:', JSON.stringify({
    functionName: context.functionName,
    functionVersion: context.functionVersion,
    memoryLimitInMB: context.memoryLimitInMB
  }));

  const body = JSON.stringify({
    message: 'QualityServer is alive',
    event_keys: Object.keys(event),
    timestamp: new Date().toISOString()
  });

  // Try multiple response formats to see which Amplify accepts
  return {
    statusCode: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-cache'
    },
    isBase64Encoded: false,
    body: body
  };
};
`.trimStart();

fs.writeFileSync(path.join(COMPUTE, 'index.js'), handler);

// ─── Deploy manifest ──────────────────────────────────────────────
const manifest = {
  version: 1,
  routes: [
    { path: '/*', target: { kind: 'Compute', src: 'default' } }
  ],
  computeResources: [
    { name: 'default', runtime: 'nodejs20.x', entrypoint: 'index.js' }
  ],
  framework: { name: 'express', version: '4.21.0' }
};

fs.writeFileSync(
  path.join(BASE, 'deploy-manifest.json'),
  JSON.stringify(manifest, null, 2)
);

console.log('Build complete → .amplify-hosting/');
console.log('Handler:', path.join(COMPUTE, 'index.js'));
console.log('Manifest:', path.join(BASE, 'deploy-manifest.json'));
