#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const semver = require('semver');

const SDK = 'elven-opentelemetry-instrumentation-js';
const LOGS = 'elven-logs-interceptor';
const ROOT = path.resolve(__dirname, '..');
const ALLOWLIST = ['package.json', 'tsconfig.json', 'src', 'tests', 'scripts', 'README.md', 'USAGE.md', 'MEMORY_TUNING.md', 'LICENSE', 'candidate-state.json', 'docs'];

function copySource(source, target) {
  const info = fs.lstatSync(source);
  assert(!info.isSymbolicLink(), `Source symlink is not allowed: ${source}`);
  if (info.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source)) {
      assert(!name.startsWith('.env'), 'Environment files are never copied');
      copySource(path.join(source, name), path.join(target, name));
    }
  } else {
    assert(info.isFile() && info.size <= 2 * 1024 * 1024, `Unsupported source: ${source}`);
    fs.copyFileSync(source, target);
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(command, args, cwd, environment) {
  return execFileSync(command, args, {
    cwd, env: environment, encoding: 'utf8', timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function main() {
  const args = process.argv.slice(2);
  assert([4, 8].includes(args.length) && args[0] === '--sdk-archive' && args[2] === '--sdk-sha256'
    && (args.length === 4 || (args[4] === '--logs-archive' && args[6] === '--logs-sha256')),
    'Usage: npm run validate:candidate -- --sdk-archive /absolute/sdk.tgz --sdk-sha256 <64 hex> [--logs-archive /absolute/logs.tgz --logs-sha256 <64 hex>]');
  const archive = args[1];
  assert(path.isAbsolute(archive), 'SDK archive path must be absolute');
  const info = fs.lstatSync(archive);
  assert(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 50 * 1024 * 1024,
    'SDK archive must be a regular file of at most 50 MiB');
  assert(/^[a-f0-9]{64}$/.test(args[3]) && sha256(archive) === args[3], 'SDK archive SHA256 mismatch');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const statePath = path.join(ROOT, 'candidate-state.json');
  const publicDependencies = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8')).publicDependencies || manifest.dependencies
    : manifest.dependencies;
  const sdkManifest = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
  }));
  assert.equal(sdkManifest.name, SDK);
  assert(semver.satisfies(sdkManifest.version, publicDependencies[SDK]), 'SDK candidate does not satisfy the public dependency range');
  const archives = [{ name: SDK, source: archive, hash: args[3], version: sdkManifest.version, filename: 'instrumentation-sdk.tgz' }];
  if (args.length === 8) {
    const logsArchive = args[5];
    assert(path.isAbsolute(logsArchive), 'Logs archive path must be absolute');
    const logsInfo = fs.lstatSync(logsArchive);
    assert(logsInfo.isFile() && !logsInfo.isSymbolicLink() && logsInfo.size > 0 && logsInfo.size <= 50 * 1024 * 1024, 'Invalid logs archive');
    assert(/^[a-f0-9]{64}$/.test(args[7]) && sha256(logsArchive) === args[7], 'Logs archive SHA256 mismatch');
    const logsManifest = JSON.parse(execFileSync('tar', ['-xOf', logsArchive, 'package/package.json'], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    }));
    assert.equal(logsManifest.name, LOGS);
    assert(semver.satisfies(logsManifest.version, publicDependencies[LOGS]), 'Logs candidate does not satisfy the public dependency range');
    archives.push({ name: LOGS, source: logsArchive, hash: args[7], version: logsManifest.version, filename: 'logs-interceptor.tgz' });
  }
  assert(archives.every(item => !semver.prerelease(item.version)), 'Candidate archive versions must be stable');

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'elven-unified-candidate-'));
  const candidate = path.join(stage, 'candidate');
  fs.mkdirSync(candidate);
  for (const entry of ALLOWLIST) {
    if (fs.existsSync(path.join(ROOT, entry))) copySource(path.join(ROOT, entry), path.join(candidate, entry));
  }
  fs.mkdirSync(path.join(candidate, 'vendor'));
  const stagedManifest = structuredClone(manifest);
  stagedManifest.private = true;
  for (const item of archives) {
    item.staged = path.join(candidate, 'vendor', item.filename);
    fs.copyFileSync(item.source, item.staged);
    assert.equal(sha256(item.staged), item.hash, 'Archive changed while staging');
    fs.chmodSync(item.staged, 0o400);
    stagedManifest.dependencies[item.name] = `file:vendor/${item.filename}`;
  }
  fs.writeFileSync(path.join(candidate, 'candidate-state.json'), JSON.stringify({
    publicLockStatus: 'candidate-local-only', publicDependencies,
    archiveHashes: Object.fromEntries(archives.map(item => [item.name, item.hash])),
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(candidate, 'package.json'), JSON.stringify(stagedManifest, null, 2) + '\n');
  fs.writeFileSync(path.join(stage, 'npm-user.npmrc'), 'registry=https://registry.npmjs.org/\n');
  fs.writeFileSync(path.join(stage, 'npm-global.npmrc'), '');
  const environment = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot', 'WINDIR']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  Object.assign(environment, {
    NPM_CONFIG_USERCONFIG: path.join(stage, 'npm-user.npmrc'),
    NPM_CONFIG_GLOBALCONFIG: path.join(stage, 'npm-global.npmrc'),
    NPM_CONFIG_CACHE: path.join(stage, 'npm-cache'),
    NPM_CONFIG_IGNORE_SCRIPTS: 'true', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false',
  });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const checks = [];
  const report = {
    evidenceLevel: 'local-candidate-integration', promotionEligible: false, stage,
    nodeVersion: process.version, platform: process.platform, architecture: process.arch,
    sourceManifestSHA256: sha256(path.join(ROOT, 'package.json')),
    candidateArchives: archives.map(({ name, version, hash }) => ({ name, version, sha256: hash })), checks,
  };
  console.log(`Candidate staging: ${stage}`);
  try {
    for (const [name, commandArgs] of [
      ['install-checksummed-sdk-archive', ['install', '--ignore-scripts', '--no-audit', '--no-fund']],
      ['replay-generated-candidate-lock', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']],
      ['production-dependency-audit', ['audit', '--omit=dev']],
      ['typecheck', ['run', 'typecheck']],
      ['tests-and-build', ['test']],
      ['pack-dry-run', ['run', 'package:check']],
    ]) {
      const output = run(npm, commandArgs, candidate, environment);
      fs.writeFileSync(path.join(stage, `${name}.log`), output);
      checks.push({ name, status: 'passed' });
      console.log(`${name}: passed`);
    }
    const lock = JSON.parse(fs.readFileSync(path.join(candidate, 'package-lock.json'), 'utf8'));
    for (const item of archives) {
      assert.equal(lock.packages[`node_modules/${item.name}`].version, item.version);
      assert.equal(lock.packages[`node_modules/${item.name}`].resolved, `file:vendor/${item.filename}`);
      assert(lock.packages[`node_modules/${item.name}`].integrity.startsWith('sha512-'));
    }
    report.candidateLockSHA256 = sha256(path.join(candidate, 'package-lock.json'));

    const packRoot = path.join(stage, 'package');
    fs.mkdirSync(packRoot);
    for (const entry of ['package.json', 'README.md', 'USAGE.md', 'MEMORY_TUNING.md', 'LICENSE']) {
      copySource(path.join(ROOT, entry), path.join(packRoot, entry));
    }
    copySource(path.join(candidate, 'dist'), path.join(packRoot, 'dist'));
    const packed = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json'], packRoot, environment))[0];
    const packedPaths = packed.files.map((file) => file.path);
    for (const required of ['LICENSE', 'dist/index.js', 'dist/index.d.ts', 'dist/register.js', 'dist/register.d.ts']) {
      assert(packedPaths.includes(required), `Missing package file ${required}`);
    }
    assert(!packedPaths.some((file) => /(^|\/)(\.env|vendor|node_modules|tests|scripts)(\/|$|\.)/.test(file)));
    const wrapperArchive = path.join(packRoot, packed.filename);
    const consumer = path.join(stage, 'consumer');
    fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({
      name: 'elven-unified-candidate-smoke', version: '0.0.0', private: true,
      dependencies: { ...Object.fromEntries(archives.map(item => [item.name, `file:${item.staged}`])), [manifest.name]: `file:${wrapperArchive}` },
    }, null, 2) + '\n');
    run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund'], consumer, environment);
    const smoke = `const assert=require('node:assert/strict'); const p=require('${manifest.name}/package.json'); assert.equal(p.version,'${manifest.version}'); const u=require('${manifest.name}'); assert.equal(typeof u.init,'function'); assert.equal(typeof u.shutdown,'function'); assert(require.resolve('${manifest.name}/register')); assert.equal(p.dependencies['${SDK}'],'${manifest.dependencies[SDK]}'); (async()=>{ const h=await u.init({serviceName:'packed-wrapper-smoke',enableLogging:false,enableTracing:false,enableMetrics:false,telemetry:{autoShutdown:false,instrumentations:false},failOpen:false}); assert.equal(typeof h.tracer.withSpan,'function'); assert.equal(typeof u.tracer.withSpan,'function'); assert.equal(h.getStatus().healthy,true); await h.shutdown(); assert.equal(h.isStarted(),false); })().catch(e=>{console.error(e);process.exitCode=1;});`;
    run(process.execPath, ['-e', smoke], consumer, environment);
    checks.push({ name: 'packed-cjs-initialize-shutdown', status: 'passed' });
    const esmSmoke = `import assert from 'node:assert/strict'; import wrapper from '${manifest.name}'; assert.equal(typeof wrapper.init,'function'); assert.equal(typeof wrapper.shutdown,'function'); assert(import.meta.resolve('${manifest.name}/register'));`;
    run(process.execPath, ['--input-type=module', '-e', esmSmoke], consumer, environment);
    checks.push({ name: 'packed-esm-import', status: 'passed' });
    const preloadSmoke = `const assert=require('node:assert/strict'); assert(!Object.keys(require.cache).some(p=>p.includes('node_modules/${SDK}/'))); const u=require('${manifest.name}'); assert.equal(u.getStatus().state,'idle'); assert.equal(u.isInitialized(),false);`;
    run(process.execPath, ['--require', `${manifest.name}/register`, '-e', preloadSmoke], consumer, {
      ...environment, OTEL_SERVICE_NAME: 'packed-wrapper-preload', ENABLE_LOGGING: 'false', ENABLE_TRACING: 'false', ENABLE_METRICS: 'false',
    });
    checks.push({ name: 'packed-register-preload', status: 'passed' });
    checks.push({ name: 'install-packed-wrapper-with-real-sdk-candidate', status: 'passed' });
    report.wrapperArchive = wrapperArchive;
    report.wrapperArchiveSHA256 = sha256(wrapperArchive);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    fs.writeFileSync(path.join(stage, 'failure.log'), String(error.stdout || '') + String(error.stderr || '') + '\n' + error.stack);
    throw error;
  } finally {
    fs.writeFileSync(path.join(stage, 'candidate-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`Candidate report: ${path.join(stage, 'candidate-report.json')}`);
  }
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
