'use strict';

const fs = require('node:fs');
const path = require('node:path');
const semver = require('semver');

function verify(root = path.resolve(__dirname, '..')) {
  const statePath = path.join(root, 'candidate-state.json');
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state.publicLockStatus !== 'verified-public-registry') {
      throw new Error('Publication blocked: candidate dependencies are not verified public artifacts');
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lockPath = path.join(root, 'package-lock.json');
  if (!fs.existsSync(lockPath)) throw new Error('Publication blocked: package-lock.json is required');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (lock.name !== manifest.name || lock.version !== manifest.version) {
    throw new Error('Publication blocked: manifest and lock identity differ');
  }
  for (const [name, range] of Object.entries(manifest.dependencies || {})) {
    const resolved = lock.packages?.[`node_modules/${name}`];
    if (!semver.validRange(range) || /(?:file:|link:|workspace:|git|https?:|-(?:rc|alpha|beta|dev|next))/i.test(range)
      || !resolved || !semver.satisfies(resolved.version, range) || semver.prerelease(resolved.version)) {
      throw new Error(`Publication blocked: ${name} is not a compatible stable registry dependency`);
    }
  }
  for (const [name, entry] of Object.entries(lock.packages || {})) {
    if (!name) continue;
    if (entry.link || !entry.resolved || !entry.integrity
      || new URL(entry.resolved).origin !== 'https://registry.npmjs.org') {
      throw new Error(`Publication blocked: ${name} lacks public registry provenance`);
    }
  }
  return { status: 'verified-public-registry', name: manifest.name, version: manifest.version };
}

module.exports = { verify };
if (require.main === module) {
  try { console.log(JSON.stringify(verify())); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
