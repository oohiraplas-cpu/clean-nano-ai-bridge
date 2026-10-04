const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { containsLikelySecret } = require('../src/secretMasking');
// Tests construct synthetic secrets to exercise detection. Never print matched values.
const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean);
let scanned = 0, failed = 0;
for (const file of paths) {
  if (file.startsWith('test/') || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
  const text = fs.readFileSync(file, 'utf8'); scanned++;
  if (containsLikelySecret(text) || /(?:client[_-]?secret|api[_-]?key|access[_-]?token)[ \t]*=[ \t]*["']?[A-Za-z0-9_+/.=-]{20,}/i.test(text)) { failed++; console.error(`Secret-like value detected in ${file}`); }
}
console.log(`Secret scan: ${scanned} production/source/documentation files; ${failed} findings. Synthetic security test fixtures excluded; detection tested by npm test.`);
if (failed) process.exitCode = 1;
