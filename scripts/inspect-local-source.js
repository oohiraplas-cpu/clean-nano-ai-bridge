// Read only committed local source; no Power Apps, SharePoint, Graph or write API calls.
const { performance } = require('node:perf_hooks');
const { PowerAppsStructureService } = require('../src/powerAppsStructureService');
const { PowerAppsImpactService } = require('../src/powerAppsImpactService');
const { localSource } = require('./local-source');
async function main() {
  const bundle = localSource();
  const { branch, commitSha, files } = bundle;
  const structure = new PowerAppsStructureService({ canonicalBranch: branch, sourceProvider: async () => bundle });
  const impact = new PowerAppsImpactService(structure);
  const measurements = [];
  let result;
  for (let i = 0; i < 6; i++) {
    const start = performance.now(); result = await structure.inspect({ branch });
    if (i > 0) measurements.push(performance.now() - start); // warm-up excluded
  }
  const start = performance.now();
  const proposal = await impact.analyze({ branch, changes: [{ ...files.find(f => f.relativePath === 'Home.pa.yaml') }] });
  const impactMs = performance.now() - start;
  const historyNavigation = result.possible.filter(p => p.reason === 'history_navigation').length;
  console.log(JSON.stringify({ branch, commitSha, scope: 'committed_local_source', status: result.status,
    summary: result.summary, historyNavigation, navigationInvocations: result.summary.transitionEdges + historyNavigation,
    confirmed: result.confirmed.length, possible: result.possible.length, issues: result.issues,
    classification: result.classification, recovery: result.recovery,
    impactStatus: proposal.status, performance: {
      iterations: measurements.length, inspectMinMs: Math.min(...measurements), inspectMaxMs: Math.max(...measurements),
      inspectMeanMs: measurements.reduce((a, b) => a + b, 0) / measurements.length,
      impactMs, heapUsedBytes: process.memoryUsage().heapUsed
    }, limitations: result.limitations }, null, 2));
  if (result.issues.length || proposal.issues.length) throw new Error('Committed source contains blocking static findings');
  // Incomplete runtime/data binding is reported, never silently relabeled as passed.
}
main().catch(() => { console.error('Local source analysis failed; see safe report above.'); process.exitCode = 1; });
