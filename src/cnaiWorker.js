'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { initialState, currentStep, advance, resume } = require('./cnaiAutoPipeline');
const { planRecovery, recoveryVerified } = require('./cnaiRecoveryEngine');

// Local atomic checkpoint persistence. This is not a distributed lock; callers
// must serialize writes and use a shared durable store before scaling workers.
class CnaiCheckpointStore {
  constructor(directory) {
    if (!directory || typeof directory !== 'string') throw new Error('checkpoint directory required');
    this.directory = directory;
  }
  file(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id))
      throw new Error('invalid checkpoint id');
    return path.join(this.directory, id + '.json');
  }
  async read(id) {
    try { return JSON.parse(await fs.readFile(this.file(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async create(id) {
    const file = this.file(id);
    await fs.mkdir(this.directory, { recursive: true });
    const handle = await fs.open(file, 'wx');
    const state = initialState(id);
    try { await handle.writeFile(JSON.stringify(state) + '\n'); }
    finally { await handle.close(); }
    return state;
  }
  async save(state) {
    const file = this.file(state.id);
    await fs.mkdir(this.directory, { recursive: true });
    const tmp = file + '.' + process.pid + '.' + require('node:crypto').randomUUID() + '.tmp';
    try {
      await fs.writeFile(tmp, JSON.stringify(state) + '\n', { flag: 'wx' });
      await fs.rename(tmp, file);
    } finally {
      await fs.rm(tmp, { force: true });
    }
    return state;
  }
}

class CnaiWorker {
  constructor(store) { this.store = store; }
  async status(id) { return this.store.read(id); }
  async start(id) { return this.store.create(id); }
  async verifyAndAdvance(id, proof, options) {
    const current = await this.store.read(id);
    if (!current) throw new Error('checkpoint not found');
    const next = advance(current, proof, options);
    await this.store.save(next);
    return { state: next, nextStep: currentStep(next) };
  }
  async recordFailure(id, failure) {
    const current = await this.store.read(id);
    if (!current) throw new Error('checkpoint not found');
    const next = planRecovery(current, failure);
    await this.store.save(next);
    return next;
  }
  async completeRecovery(id, evidenceId) {
    const current = await this.store.read(id);
    if (!current) throw new Error('checkpoint not found');
    const next = recoveryVerified(current, evidenceId);
    await this.store.save(next);
    return next;
  }
  async resume(id, options) {
    const current = await this.store.read(id);
    if (!current) throw new Error('checkpoint not found');
    const next = resume(current, options);
    await this.store.save(next);
    return next;
  }
}
module.exports = { CnaiCheckpointStore, CnaiWorker };
