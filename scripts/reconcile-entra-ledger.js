#!/usr/bin/env node
'use strict';
// Usage: node scripts/reconcile-entra-ledger.js <entra-users.json> <ledger-items.json>
// Prints match flags and counts only. It never prints ledger field values (no e-mail, no category, no ledger name).
const fs = require('fs');
const { reconcile } = require('../src/entraLedgerReconcile');

const [entraPath, ledgerPath] = process.argv.slice(2);
if (!entraPath || !ledgerPath) { console.error('usage: reconcile-entra-ledger.js <entra-users.json> <ledger-items.json>'); process.exit(2); }

const entra = JSON.parse(fs.readFileSync(entraPath, 'utf8'));
const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
const out = reconcile(entra.users, ledger.items);

console.log(JSON.stringify({ ledgerHasMorePages: Boolean(ledger.hasMore), entraHasMorePages: Boolean(entra.hasMore), summary: out.summary }, null, 2));
for (const r of out.results) {
  console.log(`${r.status.padEnd(18)} ${String(r.displayName).padEnd(10)} ${r.userPrincipalName} | objectId:${r.matchedByObjectId ? 'Y' : 'N'}${r.objectIdKnown ? '' : '(unknown)'} name:${r.matchedByName ? 'Y' : 'N'} email:${r.matchedByEmail ? 'Y' : 'N'} | ledgerEmailFilled:${r.ledgerEmailFilled} ledgerCategorySet:${r.ledgerCategorySet}`);
}
