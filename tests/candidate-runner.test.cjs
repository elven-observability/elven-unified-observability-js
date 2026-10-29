const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const runner = path.resolve(__dirname, '../scripts/validate-candidate.cjs');

function run(args) {
  return spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8', timeout: 10_000 });
}

test('candidate runner rejects missing arguments without creating a stage', () => {
  const result = run([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
  assert.doesNotMatch(result.stdout, /Candidate staging/);
});

test('candidate runner rejects relative paths and mismatched archive hashes', () => {
  const relative = run(['--sdk-archive', 'relative.tgz', '--sdk-sha256', '0'.repeat(64)]);
  assert.equal(relative.status, 1);
  assert.match(relative.stderr, /must be absolute/);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'elven-unified-runner-test-'));
  try {
    const archive = path.join(temporary, 'fake.tgz');
    fs.writeFileSync(archive, 'synthetic-invalid-archive');
    const result = run(['--sdk-archive', archive, '--sdk-sha256', '0'.repeat(64)]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SHA256 mismatch/);
    assert.doesNotMatch(result.stdout, /Candidate staging/);
  } finally {
    fs.rmSync(temporary, { recursive: true });
  }
});

test('source candidate cannot pass the public publication gate', () => {
  const { verify } = require('../scripts/verify-public-lock.cjs');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'elven-unified-gate-test-'));
  try {
    fs.writeFileSync(path.join(temporary, 'package.json'), '{}');
    fs.writeFileSync(path.join(temporary, 'candidate-state.json'), JSON.stringify({
      publicLockStatus: 'blocked-until-instrumentation-version-is-published',
    }));
    assert.throws(() => verify(temporary), /Publication blocked/);
  } finally {
    fs.rmSync(temporary, { recursive: true });
  }
});
