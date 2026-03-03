#!/usr/bin/env node
// ─── Amplify WEB_COMPUTE build script ──────────────────────────────
// Creates the .amplify-hosting/ directory that Amplify expects:
//   .amplify-hosting/
//     deploy-manifest.json
//     compute/default/   ← Lambda handler + app code + node_modules
//     static/            ← empty (pure API, no static files)
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

// ─── Create Lambda entry point ─────────────────────────────────────
const handler = `
const serverless = require('serverless-http');
const app = require('./src/index');

module.exports.handler = serverless(app);
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

console.log('✔ Build complete → .amplify-hosting/');

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
