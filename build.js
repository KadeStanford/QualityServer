#!/usr/bin/env node
// ─── Amplify WEB_COMPUTE build script ──────────────────────────────
// Amplify WEB_COMPUTE expects the entrypoint to be a Node.js HTTP
// server (not a Lambda handler). Our Express app in src/index.js
// already calls app.listen() when require.main === module.
// We make the entrypoint start the Express app directly.
// ────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE    = '.amplify-hosting';
const COMPUTE = path.join(BASE, 'compute', 'default');
const STATIC  = path.join(BASE, 'static');

// ─── Clean previous build ──────────────────────────────────────────
if (fs.existsSync(BASE)) fs.rmSync(BASE, { recursive: true });

// ─── Create directories ────────────────────────────────────────────
fs.mkdirSync(COMPUTE, { recursive: true });
fs.mkdirSync(STATIC,  { recursive: true });

// ─── Copy application code ─────────────────────────────────────────
copyDir('src', path.join(COMPUTE, 'src'));
fs.copyFileSync('package.json',      path.join(COMPUTE, 'package.json'));
fs.copyFileSync('package-lock.json', path.join(COMPUTE, 'package-lock.json'));

// ─── Install production deps inside compute dir ────────────────────
console.log('Installing production dependencies…');
execSync('npm ci --omit=dev', { cwd: path.resolve(COMPUTE), stdio: 'inherit' });

// ─── Create entrypoint that starts the Express server ──────────────
// Amplify WEB_COMPUTE injects env vars during BUILD but not into
// the compute runtime.  We bake the relevant ones into the entrypoint.
const envVars = ['NODE_ENV', 'API_KEY', 'ALLOWED_ORIGINS', 'DYNAMODB_TABLE', 'DYNAMO_ACCESS_KEY', 'DYNAMO_SECRET_KEY', 'DYNAMO_REGION', 'FORWARD_URL', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET'];
const envLines = envVars
  .filter(k => process.env[k])
  .map(k => `process.env[${JSON.stringify(k)}] = ${JSON.stringify(process.env[k])};`)
  .join('\n');

const entrypoint = `
// Amplify WEB_COMPUTE entrypoint — starts our Express server
// Env vars baked in at build time (Amplify doesn't inject them at runtime)
${envLines}

require('./src/index');
`.trimStart();

fs.writeFileSync(path.join(COMPUTE, 'index.js'), entrypoint);

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

// ─── Helper ────────────────────────────────────────────────────────
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
