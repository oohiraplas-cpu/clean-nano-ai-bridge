#!/usr/bin/env node
'use strict';
// Registers existing Entra accounts in CN_社員台帳 (see src/registerExistingAccounts.js).
// Env: BASE_URL, KEY (never printed), TARGET_UPNS (one entry per line / comma / semicolon: "UPN" or "UPN=contact e-mail"),
//      DRY_RUN ("true" by default), RESEND_MAIL ("false" by default).
const { registerExisting } = require('../src/registerExistingAccounts');
const { call } = require('../src/bridgeClient');

(async () => {
  const targets = String(process.env.TARGET_UPNS || '').split(/[\s,;]+/).filter(Boolean);
  const dryRun = (process.env.DRY_RUN || 'true') !== 'false';
  const resendMail = process.env.RESEND_MAIL === 'true';
  const report = await registerExisting(targets, call, { dryRun, resendMail });
  console.log(JSON.stringify(report, null, 2));
  process.exit(['dry_run_ok', 'completed'].includes(report.status) ? 0 : 1);
})();
