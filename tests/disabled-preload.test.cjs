'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const path = require('node:path');

for (const controls of [{ UO_ENABLED: 'false' }, { ELVEN_OBSERVABILITY_ENABLED: 'false' },
  { OTEL_SDK_DISABLED: 'true' }, { ENABLE_LOGGING: 'false', ENABLE_METRICS: 'false', ENABLE_TRACING: 'false' }]) {
  test(`disabled preload does not import providers: ${JSON.stringify(controls)}`, () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith('OTEL_') && !key.startsWith('UO_') && !key.startsWith('ELVEN_') && !key.startsWith('ENABLE_')));
    const result = spawnSync(process.execPath, ['-e', `
      require('./dist/register.js');
      setImmediate(() => {
        const loaded = Object.keys(require.cache);
        if (loaded.some(name => /node_modules|dist[\\/]index.js/.test(name))) process.exitCode = 1;
        console.log(JSON.stringify({ providersLoaded: loaded.some(name => name.includes('node_modules')),
          signalListeners: process.listenerCount('SIGTERM') + process.listenerCount('SIGINT') }));
      });
    `], { cwd: path.resolve(__dirname, '..'), env: { ...env, ...controls }, encoding: 'utf8', timeout: 3000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { providersLoaded: false, signalListeners: 0 });
  });
}
