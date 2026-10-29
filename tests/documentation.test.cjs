'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

test('shipped manual guide uses actual facades and does not end spans twice', () => {
  const source = fs.readFileSync(path.join(__dirname, '../USAGE.md'), 'utf8');
  assert.doesNotMatch(source, /tracer\.startActiveSpan\(|metrics\.getMeter\(/);
  assert.match(source, /tracer\.withSpan\(/);
  assert.match(source, /metrics\.getCounter\(/);
  assert.match(source, /const app = await import\("\.\/app"\)/);
  assert.doesNotMatch(source, /^\s+span\.end\(\);/m);
});

test('shipped memory guide disables providers rather than only their exporters', () => {
  const source = fs.readFileSync(path.join(__dirname, '../MEMORY_TUNING.md'), 'utf8');
  assert.match(source, /ENABLE_TRACING=false/);
  assert.match(source, /ENABLE_METRICS=false/);
  assert.match(source, /UO_ENABLED=false/);
  assert.doesNotMatch(source, /^OTEL_(TRACES|METRICS)_EXPORTER=none$/m);
  assert.match(source, /not proof/);
});
