const { analyzeStructure, assertNoSecrets, stop } = require('./powerAppsStructureService');
const { sourceRecovery } = require('./powerFxDependencies');

class PowerAppsImpactService {
  constructor(structureService) { this.structureService = structureService; }
  evaluate(loaded, changes) {
    const { bundle, structure: before } = loaded;
    assertNoSecrets(changes, this.structureService.secrets);
    const updated = new Map(bundle.files.map(f => [f.relativePath, { ...f }]));
    for (const change of changes) {
      if (!updated.has(change.relativePath)) stop('target_not_found', 404);
      if (change.delete === true) {
        if (/^(?:app\.pa\.yaml|canvasmanifest\.json)$/i.test(change.relativePath.split('/').pop())) stop('critical_file_deletion');
        updated.delete(change.relativePath);
      } else updated.set(change.relativePath, { relativePath: change.relativePath, content: change.content });
    }
    const files = [...updated.values()];
    const after = analyzeStructure(files, this.structureService.secrets);
    const changedPaths = new Set(changes.map(c => c.relativePath));
    const afterNames = new Set(after.entities.map(e => e.name.toLowerCase()));
    const removed = before.entities.filter(e => !afterNames.has(e.name.toLowerCase()));
    const symbolKey = s => `${s.kind === 'context_variable' ? String(s.screen).toLowerCase() : 'global'}:${s.name.toLowerCase()}`;
    const afterSymbols = new Set(after.symbolDefinitions.map(symbolKey));
    const removedSymbols = before.symbolDefinitions.filter(s => !afterSymbols.has(symbolKey(s)));
    // Losing a proven source definition must not be reclassified as an external binding or row field.
    for (const e of removed) {
      for (const ref of after.possible) if (ref.target?.toLowerCase() === e.name.toLowerCase()) after.issues.push({ ...ref, reason: 'dangling_entity' });
    }
    for (const s of removedSymbols) {
      for (const ref of after.dependencies) {
        const screen = after.entities.find(e => e.name === ref.owner)?.screen;
        if (ref.target?.toLowerCase() === s.name.toLowerCase() && (s.kind !== 'context_variable' || screen?.toLowerCase() === s.screen?.toLowerCase()) && ref.resolution !== 'confirmed') after.issues.push({ ...ref, reason: 'removed_symbol_definition', definition: s.evidence });
      }
    }
    const touched = new Set([...before.entities, ...after.entities].filter(e => changedPaths.has(e.file)).map(e => e.name));
    for (const s of [...before.symbolDefinitions, ...after.symbolDefinitions]) if (changedPaths.has(s.evidence.file)) touched.add(s.name);
    const confirmed = [
      ...[...touched].sort().map(target => ({ kind: 'changed_definition', target })),
      ...[...before.confirmed.map(r => ({ ...r, phase: 'before' })), ...after.confirmed.map(r => ({ ...r, phase: 'after' }))].filter(r => touched.has(r.target)).map(r => ({ ...r, kind: 'direct_dependency' }))
    ];
    // Indirect, dynamic and external dependencies cannot be proven by this static subset.
    const possible = [...before.possible.map(r => ({ ...r, phase: 'before' })), ...after.possible.map(r => ({ ...r, phase: 'after' }))].map(r => ({ ...r, kind: 'unverified_dependency' }));
    const issues = [...before.issues.map(r => ({ ...r, phase: 'before' })), ...after.issues.map(r => ({ ...r, phase: 'after' }))];
    return { files, report: {
      status: issues.length ? 'blocked' : 'incomplete', scope: 'static_change_impact', branch: bundle.branch, commitSha: bundle.commitSha,
      changedFiles: [...changedPaths].sort(), removedEntities: removed, removedSymbols,
      confirmed, possible, issues, before: before.summary, after: after.summary,
      recovery: sourceRecovery({ issues, dependencies: [...before.dependencies, ...after.dependencies] }),
      limitations: before.limitations
    }, afterStructure: after };
  }
  async analyze(params) {
    const loaded = await this.structureService.load(params.branch);
    return this.evaluate(loaded, params.changes).report;
  }
}
module.exports = { PowerAppsImpactService };
