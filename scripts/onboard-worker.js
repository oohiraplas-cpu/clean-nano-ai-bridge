#!/usr/bin/env node
'use strict';
// Runs src/onboardWorker.js against the production /mcp endpoint.
// Env: BASE_URL, KEY (never printed), DISPLAY_NAME, EMAIL, DRY_RUN ("true" by default), ENABLE_NOW ("false" by default), APPROVER.
// The report contains no password and no token.
const { onboardWorker } = require('../src/onboardWorker');
const { call } = require('../src/bridgeClient');

(async () => {
  const dryRun = (process.env.DRY_RUN || 'true') !== 'false';
  const enableNow = process.env.ENABLE_NOW === 'true';
  const report = await onboardWorker({ displayName: process.env.DISPLAY_NAME, email: process.env.EMAIL }, call, { dryRun, enableNow, approver: process.env.APPROVER || 'owner' });
  console.log(JSON.stringify(report, null, 2));
  const okStatuses = new Set(['dry_run_ok', 'completed']);
  process.exit(okStatuses.has(report.status) ? 0 : 1);
})();
