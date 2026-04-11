#!/usr/bin/env node
'use strict';

// Thin entry point. Real logic lives in src/cli/index.js so it can be
// required without touching argv (e.g. from tests).
require('../src/cli/index').run(process.argv).catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  process.stderr.write(`\x1b[31merror:\x1b[0m ${msg}\n`);
  process.exit(err && typeof err.exitCode === 'number' ? err.exitCode : 1);
});
