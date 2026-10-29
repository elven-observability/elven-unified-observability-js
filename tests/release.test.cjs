'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { assertContext, verifyRemote, verifyArchive, assertReleasePolicy } = require('../scripts/release-guard.cjs');
const pkg = require('../package.json');

const repo = 'elven-observability/elven-unified-observability-js';
const env = {
  GITHUB_REPOSITORY: repo, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
  RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_WORKFLOW_REF: `${repo}/.github/workflows/release.yml@refs/heads/main`,
  EXPECTED_SHA: 'a'.repeat(40), GITHUB_SHA: 'a'.repeat(40), EXPECTED_VERSION: pkg.version,
  GITHUB_WORKFLOW_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '17', GITHUB_RUN_ATTEMPT: '1',
  CONFIRM: `publish ${pkg.name}@${pkg.version}`,
};

test('known behavioral findings keep publication closed independently of registry audits', () => {
  assert.throws(() => assertReleasePolicy(require('../release-policy.json')), /Publication is on hold/);
  assert.throws(() => execFileSync(process.execPath, ['scripts/release-guard.cjs'], {
    cwd: path.join(__dirname, '..'), env: {PATH: process.env.PATH}, stdio: 'pipe', timeout: 5000,
  }), error => error.status === 1 && error.stdout.length === 0
    && /Publication is on hold/.test(error.stderr.toString()));
  assert.doesNotThrow(() => assertReleasePolicy({schema: 1, publication: 'approved', openFindings: []}));
  for (const policy of [null, {}, {schema: 1, publication: 'hold', openFindings: []},
    {schema: 1, publication: 'approved', openFindings: ['unresolved']},
    {schema: 1, publication: 'approved', openFindings: null}]) {
    assert.throws(() => assertReleasePolicy(policy), /Publication is on hold/);
  }
});

test('manual release requires exact matching stable public source and cloud runner', () => {
  assert.equal(assertContext(env, pkg), repo);
  for (const change of [
    { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/heads/other' }, { RUNNER_ENVIRONMENT: 'self-hosted' },
    { EXPECTED_SHA: 'b'.repeat(40) }, { EXPECTED_SHA: 'not-a-sha' }, { CONFIRM: 'publish' },
    { EXPECTED_VERSION: '0.0.0' }, { GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_WORKFLOW_REF: 'wrong' },
    { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_WORKFLOW_SHA: 'b'.repeat(40) },
    { GITHUB_RUN_ID: '' }, { GITHUB_RUN_ID: 'invalid' }, { GITHUB_RUN_ID: 17 },
  ]) assert.throws(() => assertContext({ ...env, ...change }, pkg));
  for (const change of [
    { name: 'other-package' }, { version: '1.2.0-rc.1' }, { repository: { url: 'wrong' } },
    { publishConfig: { ...pkg.publishConfig, provenance: false } },
    { publishConfig: { ...pkg.publishConfig, registry: 'https://other.example.test/' } },
    { publishConfig: { ...pkg.publishConfig, access: 'restricted' } },
  ]) assert.throws(() => assertContext(env, { ...pkg, ...change }));
});

test('archive receipt rejects another run, rerun, workflow commit or tampered bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elven-unified-release-test-'));
  const cwd = process.cwd();
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, env);
    process.chdir(dir);
    fs.mkdirSync('package');
    fs.mkdirSync('release');
    fs.writeFileSync('package/package.json', JSON.stringify(pkg));
    execFileSync('tar', ['-czf', 'release/package.tgz', 'package']);
    const receipt = {name: pkg.name, version: pkg.version, sha: env.EXPECTED_SHA,
      run_id: env.GITHUB_RUN_ID, run_attempt: '1', workflow_sha: env.GITHUB_WORKFLOW_SHA,
      sha256: createHash('sha256').update(fs.readFileSync('release/package.tgz')).digest('hex')};
    const write = value => fs.writeFileSync('release/receipt.json', JSON.stringify(value));
    write(receipt);
    assert.doesNotThrow(() => verifyArchive(pkg));
    for (const change of [{run_id: '18'}, {run_attempt: '2'}, {workflow_sha: 'b'.repeat(40)},
      {sha: 'b'.repeat(40)}, {sha256: '0'.repeat(64)}, {name: 'wrong'}, {version: '0.0.0'}]) {
      write({...receipt, ...change});
      assert.throws(() => verifyArchive(pkg), /Archive receipt mismatch/);
    }
    write(receipt);
    fs.appendFileSync('release/package.tgz', 'tampered');
    assert.throws(() => verifyArchive(pkg), /Archive receipt mismatch/);
  } finally {
    process.chdir(cwd);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('release publishes only the validated archive and keeps the token in the publish step', () => {
  const yaml = fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8');
  assert.match(yaml, /workflow_dispatch:/);
  assert.doesNotMatch(yaml, /\n  (push|pull_request|release|schedule|workflow_run):/);
  assert.equal((yaml.match(/NODE_AUTH_TOKEN:/g) || []).length, 1);
  assert.match(yaml, /npm publish \.\/release\/package\.tgz --ignore-scripts --provenance --access public/);
  assert.doesNotMatch(yaml, /npm publish release\/package\.tgz|provenance[=: ]+false|self-hosted/);
  assert.match(yaml, /node scripts\/release-guard\.cjs archive/);
  assert.match(yaml, /npm audit --omit=dev/);
});

test('remote release checks reject moved main, failed CI, private source and registry uncertainty', async () => {
  const originalFetch = global.fetch;
  const api = `https://api.github.com/repos/${repo}`;
  const run = { id: 17, head_sha: env.EXPECTED_SHA, conclusion: 'success', event: 'push' };
  const base = () => new Map([
    [api, { body: { private: false, full_name: repo, default_branch: 'main' } }],
    [`${api}/git/ref/heads/main`, { body: { object: { sha: env.EXPECTED_SHA } } }],
    [`${api}/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&per_page=100`, { body: { workflow_runs: [run] } }],
    [`${api}/actions/runs/17/jobs?per_page=100`, { body: { jobs: ['22.x', '24.x', '26.x'].map(node => ({ name: `test (${node})`, conclusion: 'success' })) } }],
    [`https://registry.npmjs.org/${pkg.name}/${pkg.version}`, { status: 404 }],
  ]);
  function use(routes) {
    global.fetch = async (url, options) => {
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      if (url.startsWith('https://registry.npmjs.org/')) assert.deepEqual(options.headers, undefined);
      const route = routes.get(url);
      assert.ok(route, `Unexpected release check URL: ${url}`);
      return new Response(JSON.stringify(route.body || {}), { status: route.status || 200 });
    };
  }
  try {
    use(base());
    await verifyRemote(env, pkg);
    for (const [url, route, expected] of [
      [api, { body: { private: true, full_name: repo, default_branch: 'main' } }, /Public matching/],
      [`${api}/git/ref/heads/main`, { body: { object: { sha: 'b'.repeat(40) } } }, /main moved/],
      [`${api}/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&per_page=100`, { body: { workflow_runs: [{ ...run, conclusion: 'failure' }] } }, /Successful main-push/],
      [`${api}/actions/runs/17/jobs?per_page=100`, { body: { jobs: [] } }, /Missing successful/],
      [`https://registry.npmjs.org/${pkg.name}/${pkg.version}`, { status: 200 }, /already published/],
      [`https://registry.npmjs.org/${pkg.name}/${pkg.version}`, { status: 503 }, /availability UNKNOWN/],
    ]) {
      const routes = base();
      routes.set(url, route);
      use(routes);
      await assert.rejects(verifyRemote(env, pkg), expected);
    }
  } finally {
    global.fetch = originalFetch;
  }
});
