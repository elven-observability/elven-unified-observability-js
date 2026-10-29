'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const repository = 'elven-observability/elven-unified-observability-js';
const packageName = 'elven-unified-observability-js';

function assertReleasePolicy(policy) {
  if (policy?.schema !== 1 || policy.publication !== 'approved'
    || !Array.isArray(policy.openFindings) || policy.openFindings.length !== 0) {
    throw new Error('Publication is on hold: resolve and independently review the source release policy');
  }
}

function assertContext(env, pkg) {
  if (pkg.name !== packageName || env.GITHUB_REPOSITORY !== repository) {
    throw new Error('Unexpected publishing repository/package');
  }
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Manual main-only release required');
  }
  if (env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('GitHub-hosted runner required for provenance');
  if (env.GITHUB_WORKFLOW_REF !== `${repository}/.github/workflows/release.yml@refs/heads/main`) {
    throw new Error('Unexpected release workflow');
  }
  if (!/^[a-f0-9]{40}$/.test(env.EXPECTED_SHA || '') || env.EXPECTED_SHA !== env.GITHUB_SHA) {
    throw new Error('Exact source SHA confirmation required');
  }
  if (env.GITHUB_RUN_ATTEMPT !== '1' || env.GITHUB_WORKFLOW_SHA !== env.EXPECTED_SHA
    || typeof env.GITHUB_RUN_ID !== 'string' || !/^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID)) {
    throw new Error('First attempt of the exact workflow commit and run required');
  }
  if (env.EXPECTED_VERSION !== pkg.version || !/^\d+\.\d+\.\d+$/.test(pkg.version)
    || env.CONFIRM !== `publish ${pkg.name}@${pkg.version}`) {
    throw new Error('Exact stable package/version confirmation required');
  }
  if (pkg.repository?.url !== `git+https://github.com/${repository}.git`) {
    throw new Error('Provenance repository metadata mismatch');
  }
  if (pkg.publishConfig?.access !== 'public' || pkg.publishConfig?.provenance !== true
    || pkg.publishConfig?.registry !== 'https://registry.npmjs.org/') {
    throw new Error('Mandatory public registry/provenance configuration missing');
  }
  return repository;
}

async function get(url, token) {
  const response = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } : {},
    signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Release preflight HTTP ${response.status}`);
  return response.json();
}

async function verifyRemote(env, pkg) {
  assertContext(env, pkg);
  const api = `https://api.github.com/repos/${repository}`;
  const metadata = await get(api, env.GH_TOKEN);
  if (metadata.private !== false || metadata.full_name !== repository || metadata.default_branch !== 'main') {
    throw new Error('Public matching repository/main required');
  }
  const head = await get(`${api}/git/ref/heads/main`, env.GH_TOKEN);
  if (head.object.sha !== env.EXPECTED_SHA) throw new Error('main moved: revalidate and confirm its new SHA');
  const runs = await get(`${api}/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&per_page=100`, env.GH_TOKEN);
  const run = runs.workflow_runs.find(item => item.head_sha === env.EXPECTED_SHA
    && item.conclusion === 'success' && item.event === 'push');
  if (!run) throw new Error('Successful main-push CI for this exact SHA required');
  const jobs = await get(`${api}/actions/runs/${run.id}/jobs?per_page=100`, env.GH_TOKEN);
  for (const node of ['22.x', '24.x', '26.x']) {
    if (!jobs.jobs.some(job => job.name === `test (${node})` && job.conclusion === 'success')) {
      throw new Error(`Missing successful Node CI job: ${node}`);
    }
  }
  const response = await fetch(`https://registry.npmjs.org/${pkg.name}/${pkg.version}`, {
    signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  if (response.status !== 404) {
    throw new Error(response.ok ? 'Version already published; no replacement allowed'
      : `Registry availability UNKNOWN: HTTP ${response.status}`);
  }
}

function pack(pkg) {
  const archives = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json'], { encoding: 'utf8' }));
  if (archives.length !== 1) throw new Error('Expected one package archive');
  fs.mkdirSync('release', { recursive: true });
  fs.renameSync(archives[0].filename, 'release/package.tgz');
  fs.writeFileSync('release/receipt.json', JSON.stringify({
    name: pkg.name, version: pkg.version, sha: process.env.EXPECTED_SHA,
    run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT,
    workflow_sha: process.env.GITHUB_WORKFLOW_SHA,
    sha256: createHash('sha256').update(fs.readFileSync('release/package.tgz')).digest('hex'),
  }, null, 2));
}

function verifyArchive(pkg) {
  const receipt = JSON.parse(fs.readFileSync('release/receipt.json', 'utf8'));
  const hash = createHash('sha256').update(fs.readFileSync('release/package.tgz')).digest('hex');
  if (hash !== receipt.sha256 || receipt.sha !== process.env.EXPECTED_SHA
    || receipt.name !== pkg.name || receipt.version !== pkg.version
    || receipt.run_id !== process.env.GITHUB_RUN_ID || receipt.run_attempt !== '1'
    || receipt.workflow_sha !== process.env.GITHUB_WORKFLOW_SHA) {
    throw new Error('Archive receipt mismatch');
  }
  const packed = JSON.parse(execFileSync('tar', ['-xOf', 'release/package.tgz', 'package/package.json'], { encoding: 'utf8' }));
  assertContext(process.env, packed);
}

if (require.main === module) {
  const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  (async () => {
    assertReleasePolicy(JSON.parse(fs.readFileSync(path.join(__dirname, '../release-policy.json'), 'utf8')));
    await verifyRemote(process.env, pkg);
    if (process.argv[2] === 'pack') {
      require('./verify-public-lock.cjs').verify();
      pack(pkg);
    }
    if (process.argv[2] === 'archive') verifyArchive(pkg);
    console.log('Release preflight passed; no publication performed by this script');
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { assertContext, verifyRemote, verifyArchive, assertReleasePolicy };
