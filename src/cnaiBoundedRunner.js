'use strict';

const { runIteration } = require('./cnaiIterationRunner');

// Finite synchronous orchestration per invocation: no timers, no background
// promises and no implicit authorization. The caller owns scheduling.
async function runBounded({ worker, id, authority, adapters, classifyError, maxSteps = 1 }) {
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 9)
    throw new Error('maxSteps must be 1..9');
  const results = [];
  for (let i = 0; i < maxSteps; i++) {
    const result = await runIteration({
      worker, id, authority, adapters, classifyError
    });
    results.push(result);
    if (result.status !== 'READY') break;
  }
  return { status: results.at(-1).status, iterations: results.length, results };
}

module.exports = { runBounded };
