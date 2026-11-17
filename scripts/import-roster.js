#!/usr/bin/env node
'use strict';
// Imports a roster into CN_社員台帳 (see src/importRoster.js).
// Env: BASE_URL, KEY (never printed), ROSTER_JSON (the rows; a GitHub secret - personal data, never printed),
//      DRY_RUN ("true" by default), CATEGORIES (comma separated, default "一般社員,アルバイト").
const { importRoster, DEFAULT_CATEGORIES } = require('../src/importRoster');
const { call } = require('../src/bridgeClient');

(async () => {
  let rows;
  try { rows = JSON.parse(process.env.ROSTER_JSON || ''); } catch (_) {
    console.log(JSON.stringify({ status: 'invalid_input', reason: 'ROSTER_JSON を JSON として読めません（内容は出力しません）', changed: false }, null, 2));
    process.exit(1);
  }
  const dryRun = (process.env.DRY_RUN || 'true') !== 'false';
  const categories = String(process.env.CATEGORIES || '').split(',').map((s) => s.trim()).filter(Boolean);
  const report = await importRoster(rows, call, { dryRun, categories: categories.length ? categories : DEFAULT_CATEGORIES });
  console.log(JSON.stringify(report, null, 2));
  process.exit(['dry_run_ok', 'completed'].includes(report.status) ? 0 : 1);
})();
