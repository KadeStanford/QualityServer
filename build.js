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
const http = require('http');

const server = http.createServer((req, res) => {
  console.log('Request:', req.method, req.url);
  
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    message: 'QualityServer is alive',
    path: req.url,
    method: req.method,
    timestamp: new Date().toISOString()
  }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('QualityServer listening on port ' + PORT);
});
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
