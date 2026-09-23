'use strict';
// The checked-in dist directory is a ready-to-load copy of these source files.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'src');
const dist = path.join(root, 'dist');
const runtimeFiles = Object.freeze([
  'manifest.json', 'background.js', 'download-core.js', 'media-plan.js',
  'download-engine.js', 'mp4.js', 'dash-parser.js', 'media-resolver.js', 'metadata-network.js',
  'content.js', 'content.css', 'offscreen.html', 'offscreen.js',
  'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png',
]);

function validateRuntime(directory) {
  for (const relative of runtimeFiles) {
    const file = path.join(directory, relative);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new Error(`Missing runtime file: ${relative}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (!/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) throw new Error('Invalid extension version');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.version !== pkg.version) throw new Error('Version mismatch: package.json and manifest.json');
  for (const [file, pattern] of [
    ['content.js', /const UI_VERSION = '([^']+)'/],
    ['background.js', /const RUNTIME_VERSION = '([^']+)'/],
  ]) {
    const match = fs.readFileSync(path.join(directory, file), 'utf8').match(pattern);
    if (match?.[1] !== manifest.version) throw new Error(`Version mismatch: ${file} must match manifest ${manifest.version}`);
  }
  const entries = [manifest.background?.service_worker, ...Object.values(manifest.icons || {}),
    ...(manifest.content_scripts || []).flatMap(script => [...(script.js || []), ...(script.css || [])])];
  for (const entry of entries) if (!runtimeFiles.includes(entry)) throw new Error(`Manifest references an unpackaged file: ${entry}`);
  return manifest;
}

function removeBuildDirectory(directory) {
  const resolved = path.resolve(directory);
  // Recursive cleanup is restricted to this build's named staging directories.
  if (path.dirname(resolved) !== root || !/^\.dist-(?:build|backup)-/.test(path.basename(resolved))) {
    throw new Error(`Refusing cleanup outside build staging: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function build() {
  const manifest = validateRuntime(source);
  const staging = fs.mkdtempSync(path.join(root, '.dist-build-'));
  let previous;
  try {
    for (const relative of runtimeFiles) {
      const destination = path.join(staging, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(source, relative), destination);
    }
    validateRuntime(staging);
    if (fs.existsSync(dist)) {
      if (!fs.lstatSync(dist).isDirectory() || fs.lstatSync(dist).isSymbolicLink()) throw new Error('dist must be a normal directory');
      previous = path.join(root, '.dist-backup-' + randomUUID());
      // Both paths resolve directly inside this repository before moving a tree.
      if (path.dirname(path.resolve(dist)) !== root || path.dirname(path.resolve(previous)) !== root) throw new Error('Invalid dist path');
      fs.renameSync(dist, previous);
    }
    try { fs.renameSync(staging, dist); }
    catch (error) { if (previous) fs.renameSync(previous, dist); previous = null; throw error; }
    if (previous) removeBuildDirectory(previous);
  } finally {
    if (fs.existsSync(staging)) removeBuildDirectory(staging);
  }
  return { version: manifest.version, files: runtimeFiles.length, directory: dist };
}

module.exports = { build, validateRuntime, runtimeFiles, root, source, dist };
if (require.main === module) {
  try { const result = build(); console.log(`Built v${result.version}: ${result.files} runtime files in ${result.directory}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
