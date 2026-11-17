#!/usr/bin/env node
'use strict';
// Usage: node scripts/encrypt-roster.js <public-key.pem> <roster.json> <out.enc.json>
// Encrypts a roster with the PUBLIC key (see src/rosterCrypto.js). Prints only the output path and the row count.
const fs = require('node:fs');
const { encryptRoster } = require('../src/rosterCrypto');

const [pubPath, inPath, outPath] = process.argv.slice(2);
if (!pubPath || !inPath || !outPath) { console.error('usage: encrypt-roster.js <public-key.pem> <roster.json> <out.enc.json>'); process.exit(2); }
const text = fs.readFileSync(inPath, 'utf8');
const rows = JSON.parse(text);
if (!Array.isArray(rows)) { console.error('roster must be a JSON array'); process.exit(2); }
fs.writeFileSync(outPath, JSON.stringify(encryptRoster(text, fs.readFileSync(pubPath, 'utf8'))));
console.log(`encrypted ${rows.length} rows -> ${outPath}`);
