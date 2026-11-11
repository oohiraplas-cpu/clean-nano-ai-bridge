const test = require('node:test');
const assert = require('node:assert');
const {
  TRANSACTION_STATE,
  Transaction,
  TransactionManager
} = require('../src/transactionControl');

test('Transaction Control', async (t) => {
  await t.test('creates transaction with initial state', () => {
    const tx = new Transaction({
      operationType: 'save',
      operationId: 'op-123'
    });

    assert.strictEqual(tx.state, TRANSACTION_STATE.INITIAL);
    assert.ok(tx.transactionId);
    assert.ok(tx.startedAt);
    assert.strictEqual(tx.operationType, 'save');
  });

  await t.test('PLAN step records plan and transitions state', async () => {
    const tx = new Transaction();

    await tx.plan(async ({ operationType }) => {
      return { operationType, targets: ['app1', 'app2'] };
    });

    assert.strictEqual(tx.state, TRANSACTION_STATE.PLANNED);
    assert.ok(tx.results.plan);
    assert.ok(tx.results.planHash);
    assert.strictEqual(tx.steps.length, 1);
    assert.strictEqual(tx.steps[0].name, 'PLAN');
    assert.strictEqual(tx.steps[0].success, true);
  });

  await t.test('PLAN step records error on failure', async () => {
    const tx = new Transaction();

    try {
      await tx.plan(async () => {
        throw new Error('Plan failed');
      });
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error.message.includes('Plan failed'));
      assert.strictEqual(tx.steps[0].success, false);
      assert.ok(tx.steps[0].error);
    }
  });

  await t.test('PRECHECK step validates prerequisites', async () => {
    const tx = new Transaction();

    await tx.plan(async () => ({ targets: [] }));

    await tx.precheck(async ({ plan }) => {
      return { valid: true, targets: plan.targets };
    });

    assert.strictEqual(tx.state, TRANSACTION_STATE.PRECHECKED);
    assert.ok(tx.results.precheckResults);
    assert.ok(tx.results.precheckHash);
  });

  await t.test('PRECHECK step fails when precheck.valid is false', async () => {
    const tx = new Transaction();

    await tx.plan(async () => ({}));

    try {
      await tx.precheck(async () => {
        return { valid: false, reason: 'Test failed' };
      });
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error.message.includes('Precheck failed'));
    }
  });

  await t.test('LOCK step acquires lock', async () => {
    const tx = new Transaction({
      context: { target: { appId: 'app1' } }
    });

    const mockLockManager = {
      acquireLock: async ({ resource }) => ({
        acquired: true,
        lockId: `lock:${resource}`,
        resource
      })
    };

    await tx.lock(mockLockManager);

    assert.strictEqual(tx.state, TRANSACTION_STATE.LOCKED);
    assert.ok(tx.results.lockId);
  });

  await t.test('LOCK step fails when lock cannot be acquired', async () => {
    const tx = new Transaction({
      context: { target: { appId: 'app1' } }
    });

    const mockLockManager = {
      acquireLock: async () => ({
        acquired: false,
        reason: 'Resource locked'
      })
    };

    try {
      await tx.lock(mockLockManager);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error.message.includes('Lock acquisition failed'));
    }
  });

  await t.test('EXECUTE step performs operation', async () => {
    const tx = new Transaction();

    await tx.plan(async () => ({ action: 'save', file: 'test.json' }));

    await tx.execute(async ({ plan }) => {
      return { status: 'success', file: plan.file, sha: 'a'.repeat(40) };
    });

    assert.strictEqual(tx.state, TRANSACTION_STATE.EXECUTED);
    assert.ok(tx.results.executionResult);
    assert.strictEqual(tx.results.executionResult.status, 'success');
  });

  await t.test('VERIFY step verifies execution', async () => {
    const tx = new Transaction();

    await tx.plan(async () => ({}));
    await tx.execute(async () => ({ sha: 'a'.repeat(40) }));

    await tx.verify(async ({ result }) => {
      return { valid: true, sha: result.sha, verified: true };
    });

    assert.strictEqual(tx.state, TRANSACTION_STATE.VERIFIED);
    assert.ok(tx.results.verification);
    assert.strictEqual(tx.results.verification.verified, true);
  });

  await t.test('VERIFY step fails when verification invalid', async () => {
    const tx = new Transaction();

    await tx.plan(async () => ({}));
    await tx.execute(async () => ({}));

    try {
      await tx.verify(async () => {
        return { valid: false, reason: 'Verification failed' };
      });
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error.message.includes('Verification failed'));
    }
  });

  await t.test('COMMIT step commits transaction', async () => {
    const tx = new Transaction();

    await tx.plan(async () => ({}));
    await tx.execute(async () => ({ status: 'done' }));
    await tx.verify(async () => ({ valid: true }));

    await tx.commit(async ({ result }) => {
      return { committed: true, result };
    });

    assert.strictEqual(tx.state, TRANSACTION_STATE.COMMITTED);
    assert.ok(tx.results.commitResult);
  });

  await t.test('AUDIT step records in ledger', async () => {
    const tx = new Transaction({
      operationId: 'op-1'
    });

    await tx.plan(async () => ({}));

    await tx.audit(async ({ entry }) => {
      return { reference: `audit:${entry.transactionId}` };
    });

    assert.strictEqual(tx.state, TRANSACTION_STATE.AUDITED);
    assert.ok(tx.results.auditReference);
  });

  await t.test('isSuccessful returns true when audited', async () => {
    const tx = new Transaction();

    await tx.plan(async () => ({}));
    await tx.audit(async () => ({ reference: 'audit:ref' }));

    assert.strictEqual(tx.isSuccessful(), true);
  });

  await t.test('isSuccessful returns false when not audited', () => {
    const tx = new Transaction();

    assert.strictEqual(tx.isSuccessful(), false);
  });

  await t.test('isInProgress returns true for intermediate states', () => {
    const tx = new Transaction();

    assert.strictEqual(tx.isInProgress(), true);

    tx.state = TRANSACTION_STATE.PLANNED;
    assert.strictEqual(tx.isInProgress(), true);

    tx.state = TRANSACTION_STATE.COMMITTED;
    assert.strictEqual(tx.isInProgress(), false);
  });

  await t.test('isFailed returns true for failed/rolled_back states', () => {
    const tx = new Transaction();

    assert.strictEqual(tx.isFailed(), false);

    tx.state = TRANSACTION_STATE.FAILED;
    assert.strictEqual(tx.isFailed(), true);

    tx.state = TRANSACTION_STATE.ROLLED_BACK;
    assert.strictEqual(tx.isFailed(), true);
  });

  await t.test('toJSON serializes transaction', () => {
    const tx = new Transaction({
      operationType: 'save'
    });

    const json = tx.toJSON();

    assert.ok(json.transactionId);
    assert.strictEqual(json.operationType, 'save');
    assert.strictEqual(json.state, TRANSACTION_STATE.INITIAL);
    assert.strictEqual(json.successful, false);
  });

  await t.test('TransactionManager creates and retrieves transactions', () => {
    const manager = new TransactionManager();

    const tx = manager.createTransaction({
      operationType: 'save'
    });

    assert.ok(tx.transactionId);

    const retrieved = manager.getTransaction(tx.transactionId);
    assert.strictEqual(retrieved, tx);
  });

  await t.test('TransactionManager lists transactions', () => {
    const manager = new TransactionManager();

    manager.createTransaction({ operationType: 'save' });
    manager.createTransaction({ operationType: 'delete' });

    const all = manager.listTransactions();
    assert.strictEqual(all.length, 2);

    const saves = manager.listTransactions({ operationType: 'save' });
    assert.strictEqual(saves.length, 1);
  });

  await t.test('TransactionManager gets statistics', async () => {
    const manager = new TransactionManager();

    const tx1 = manager.createTransaction();
    const tx2 = manager.createTransaction();

    // Mark one as successful
    tx1.state = TRANSACTION_STATE.AUDITED;
    tx1.completedAt = new Date();

    const stats = manager.getStatistics();

    assert.strictEqual(stats.total, 2);
    assert.strictEqual(stats.successful, 1);
    assert.strictEqual(stats.inProgress, 1);
  });

  await t.test('TransactionManager cleans up old transactions', async () => {
    const manager = new TransactionManager();

    const tx = manager.createTransaction();
    tx.completedAt = new Date(Date.now() - 5000000); // 5000 seconds ago

    const cleaned = manager.cleanup(1000); // 1 second TTL

    assert.strictEqual(cleaned, 1);
    assert.strictEqual(manager.listTransactions().length, 0);
  });

  await t.test('records steps for full transaction flow', async () => {
    const tx = new Transaction();

    await tx.plan(async () => ({ step: 'plan' }));
    await tx.precheck(async () => ({ valid: true }));

    assert.strictEqual(tx.steps.length, 2);
    assert.strictEqual(tx.steps[0].name, 'PLAN');
    assert.strictEqual(tx.steps[1].name, 'PRECHECK');
  });

  await t.test('calculates duration on completion', async () => {
    const tx = new Transaction();

    const startDuration = tx.duration;

    await new Promise(resolve => setTimeout(resolve, 50));

    tx._finalize();

    assert.ok(tx.duration > startDuration);
    assert.ok(tx.completedAt);
  });
});
