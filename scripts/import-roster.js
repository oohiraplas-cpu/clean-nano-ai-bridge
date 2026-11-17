#!/usr/bin/env node
'use strict';
// Imports a roster into CN_社員台帳 (see src/importRoster.js).
// Env: BASE_URL, KEY (never printed), DRY_RUN ("true" by default), CATEGORIES (comma separated, default "一般社員,アルバイト").
// The rows are personal data and are never printed. They come from ONE of:
//   ROSTER_JSON                        the rows as JSON (a GitHub secret), or
//   ROSTER_ENC_FILE + ROSTER_PRIVATE_KEY   an encrypted envelope (src/rosterCrypto.js) and the private key from Azure.
const fs = require('node:fs');
const { importRoster, DEFAULT_CATEGORIES } = require('../src/importRoster');
const { decryptRoster } = require('../src/rosterCrypto');
const { call } = require('../src/bridgeClient');

const fail = (reason) => {
  console.log(JSON.stringify({ status: 'invalid_input', reason, changed: false }, null, 2));
  process.exit(1);
};

function loadRows() {
  let text = process.env.ROSTER_JSON || '';
  if (!text && process.env.ROSTER_ENC_FILE) {
    if (!process.env.ROSTER_PRIVATE_KEY) fail('暗号化された名簿はありますが、復号の鍵が Azure にありません（内容は出力しません）');
    try { text = decryptRoster(JSON.parse(fs.readFileSync(process.env.ROSTER_ENC_FILE, 'utf8')), process.env.ROSTER_PRIVATE_KEY); } catch (_) {
      fail('暗号化された名簿を復号できません（内容は出力しません）');
    }
  }
  if (!text) fail('名簿がありません。ROSTER_JSON か、暗号化された名簿と鍵が必要です');
  try { return JSON.parse(text); } catch (_) { return fail('名簿を JSON として読めません（内容は出力しません）'); }
}

(async () => {
  const rows = loadRows();
  const dryRun = (process.env.DRY_RUN || 'true') !== 'false';
  const categories = String(process.env.CATEGORIES || '').split(',').map((s) => s.trim()).filter(Boolean);
  const report = await importRoster(rows, call, { dryRun, categories: categories.length ? categories : DEFAULT_CATEGORIES });
  console.log(JSON.stringify(report, null, 2));
  process.exit(['dry_run_ok', 'completed'].includes(report.status) ? 0 : 1);
})();
