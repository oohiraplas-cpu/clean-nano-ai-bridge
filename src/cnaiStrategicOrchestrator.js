'use strict';

// Deterministic execution planner. It does not invoke tools or grant permission.
function planExecution(goal, tasks, completed = []) {
  if (typeof goal !== 'string' || !goal.trim() || !Array.isArray(tasks))
    throw new Error('valid goal and tasks required');
  const ids = new Set();
  for (const task of tasks) {
    if (!task || typeof task.id !== 'string' || !task.id.trim() || ids.has(task.id))
      throw new Error('invalid or duplicate task id');
    ids.add(task.id);
  }
  for (const task of tasks)
    if (!Array.isArray(task.dependsOn || []) ||
      (task.dependsOn || []).some(id => !ids.has(id) || id === task.id))
      throw new Error('invalid dependency');
  const finished = new Set(completed);
  const remaining = new Map(tasks.filter(t => !finished.has(t.id)).map(t => [t.id, t]));
  const waves = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter(t =>
      (t.dependsOn || []).every(id => finished.has(id)));
    if (!ready.length) throw new Error('dependency cycle or missing verified prerequisite');
    // Parallel execution is permitted only for independently verified read-only work.
    const readOnly = ready.filter(t => t.readOnly === true && t.preflightVerified === true);
    const batch = readOnly.length ? readOnly : [ready[0]];
    waves.push(batch.map(t => t.id));
    for (const t of batch) { remaining.delete(t.id); finished.add(t.id); }
  }
  return { goal, waves, totalTasks: tasks.length, requiresExecutor: true };
}

function evaluateCompletion(requiredEvidence, observedEvidence) {
  if (!Array.isArray(requiredEvidence) || !observedEvidence ||
      typeof observedEvidence !== 'object' || Array.isArray(observedEvidence))
    throw new Error('invalid completion evidence');
  const missing = requiredEvidence.filter(k =>
    typeof k !== 'string' || typeof observedEvidence[k] !== 'string' ||
    !observedEvidence[k].trim());
  return { status: missing.length ? 'PARTIAL' : 'DONE', missing };
}

module.exports = { planExecution, evaluateCompletion };
