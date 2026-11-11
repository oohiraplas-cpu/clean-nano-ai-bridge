const test = require('node:test');
const assert = require('node:assert');
const {
  MemoryStoreAdapter,
  createStoreAdapter
} = require('../src/stateContextStoreAdapter');

test('State Context Store Adapter', async (t) => {
  await t.test('MemoryStoreAdapter - set and get', async () => {
    const store = new MemoryStoreAdapter();
    const correlationId = '12345678-1234-1234-1234-123456789abc';
    const context = { appId: 'app1', data: 'test' };

    await store.set(correlationId, context);
    const retrieved = await store.get(correlationId);

    assert.deepStrictEqual(retrieved, context);
  });

  await t.test('MemoryStoreAdapter - get returns null for missing key', async () => {
    const store = new MemoryStoreAdapter();

    const result = await store.get('nonexistent-id');

    assert.strictEqual(result, null);
  });

  await t.test('MemoryStoreAdapter - delete', async () => {
    const store = new MemoryStoreAdapter();
    const correlationId = '12345678-1234-1234-1234-123456789abc';

    await store.set(correlationId, { data: 'test' });
    const deleted = await store.delete(correlationId);
    const result = await store.get(correlationId);

    assert.strictEqual(deleted, true);
    assert.strictEqual(result, null);
  });

  await t.test('MemoryStoreAdapter - delete returns false for missing key', async () => {
    const store = new MemoryStoreAdapter();

    const result = await store.delete('nonexistent-id');

    assert.strictEqual(result, false);
  });

  await t.test('MemoryStoreAdapter - TTL expiration', async (t) => {
    const store = new MemoryStoreAdapter();
    const correlationId = '12345678-1234-1234-1234-123456789abc';
    const context = { data: 'test' };

    // Set with 100ms TTL
    await store.set(correlationId, context, 100);

    // Should be available immediately
    const immediate = await store.get(correlationId);
    assert.ok(immediate);

    // Wait for expiration
    await new Promise(resolve => setTimeout(resolve, 150));

    // Should now be expired
    const expired = await store.get(correlationId);
    assert.strictEqual(expired, null);
  });

  await t.test('MemoryStoreAdapter - list returns all non-expired', async () => {
    const store = new MemoryStoreAdapter();

    await store.set('id-1', { data: 'test1' }, 10000);
    await store.set('id-2', { data: 'test2' }, 10000);

    const list = await store.list();

    assert.strictEqual(list.length, 2);
    assert.ok(list.some(item => item.correlationId === 'id-1'));
    assert.ok(list.some(item => item.correlationId === 'id-2'));
  });

  await t.test('MemoryStoreAdapter - list excludes expired', async () => {
    const store = new MemoryStoreAdapter();

    await store.set('id-1', { data: 'test1' }, 10000);
    await store.set('id-2', { data: 'test2' }, 50); // Will expire soon

    // Wait for id-2 to expire
    await new Promise(resolve => setTimeout(resolve, 100));

    const list = await store.list();

    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].correlationId, 'id-1');
  });

  await t.test('MemoryStoreAdapter - clear', async () => {
    const store = new MemoryStoreAdapter();

    await store.set('id-1', { data: 'test1' });
    await store.set('id-2', { data: 'test2' });

    const cleared = await store.clear();

    assert.strictEqual(cleared, 2);
    const list = await store.list();
    assert.strictEqual(list.length, 0);
  });

  await t.test('MemoryStoreAdapter - stats', async () => {
    const store = new MemoryStoreAdapter();

    await store.set('id-1', { data: 'test1' });
    await store.set('id-2', { data: 'test2' });

    const stats = await store.stats();

    assert.strictEqual(stats.backend, 'memory');
    assert.strictEqual(stats.validEntries, 2);
    assert.ok(stats.totalSizeBytes > 0);
    assert.ok(stats.avgSizeBytes > 0);
  });

  await t.test('MemoryStoreAdapter - cleanup removes expired', async () => {
    const store = new MemoryStoreAdapter();

    await store.set('id-1', { data: 'test1' }, 50);
    await store.set('id-2', { data: 'test2' }, 10000);

    // Wait for id-1 to expire
    await new Promise(resolve => setTimeout(resolve, 100));

    const cleaned = await store.cleanup();

    assert.strictEqual(cleaned, 1);
    const list = await store.list();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].correlationId, 'id-2');
  });

  await t.test('MemoryStoreAdapter - rejects invalid correlationId', async () => {
    const store = new MemoryStoreAdapter();

    try {
      await store.set('', { data: 'test' });
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error.message.includes('correlationId'));
    }
  });

  await t.test('MemoryStoreAdapter - rejects invalid context', async () => {
    const store = new MemoryStoreAdapter();

    try {
      await store.set('valid-id', null);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error.message.includes('context'));
    }
  });

  await t.test('MemoryStoreAdapter - rejects invalid TTL', async () => {
    const store = new MemoryStoreAdapter();

    try {
      await store.set('id', { data: 'test' }, -100);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error.message.includes('ttlMs'));
    }
  });

  await t.test('MemoryStoreAdapter - rejects when at capacity', async () => {
    const store = new MemoryStoreAdapter({ maxEntries: 2 });

    await store.set('id-1', { data: 'test1' });
    await store.set('id-2', { data: 'test2' });

    try {
      await store.set('id-3', { data: 'test3' });
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error.message.includes('capacity'));
    }
  });

  await t.test('MemoryStoreAdapter - allows update when at capacity', async () => {
    const store = new MemoryStoreAdapter({ maxEntries: 2 });

    await store.set('id-1', { data: 'test1' });
    await store.set('id-2', { data: 'test2' });

    // Should allow updating existing entry
    await store.set('id-1', { data: 'test1-updated' });

    const retrieved = await store.get('id-1');
    assert.strictEqual(retrieved.data, 'test1-updated');
  });

  await t.test('MemoryStoreAdapter - startCleanup runs interval', async (t) => {
    const store = new MemoryStoreAdapter();

    await store.set('id-1', { data: 'test1' }, 50);

    store.startCleanup(30); // Cleanup every 30ms

    // Wait for cleanup to run
    await new Promise(resolve => setTimeout(resolve, 100));

    store.stopCleanup();

    // The expired entry should have been cleaned
    const list = await store.list();
    assert.strictEqual(list.length, 0);
  });

  await t.test('MemoryStoreAdapter - deep copies context on set', async () => {
    const store = new MemoryStoreAdapter();
    const context = { nested: { value: 'original' } };

    await store.set('id-1', context);

    // Modify original
    context.nested.value = 'modified';

    // Retrieved should be unchanged
    const retrieved = await store.get('id-1');
    assert.strictEqual(retrieved.nested.value, 'original');
  });

  await t.test('MemoryStoreAdapter - deep copies context on get', async () => {
    const store = new MemoryStoreAdapter();
    const context = { nested: { value: 'original' } };

    await store.set('id-1', context);

    const retrieved1 = await store.get('id-1');
    retrieved1.nested.value = 'modified';

    const retrieved2 = await store.get('id-1');
    assert.strictEqual(retrieved2.nested.value, 'original');
  });

  await t.test('createStoreAdapter creates memory adapter by default', () => {
    const adapter = createStoreAdapter();

    assert.ok(adapter instanceof MemoryStoreAdapter);
  });

  await t.test('createStoreAdapter creates memory adapter with explicit backend', () => {
    const adapter = createStoreAdapter({ backend: 'memory' });

    assert.ok(adapter instanceof MemoryStoreAdapter);
  });

  await t.test('createStoreAdapter passes options to adapter', () => {
    const adapter = createStoreAdapter({
      backend: 'memory',
      options: { maxEntries: 5000 }
    });

    assert.strictEqual(adapter.maxEntries, 5000);
  });

  await t.test('createStoreAdapter rejects unknown backend', () => {
    try {
      createStoreAdapter({ backend: 'unknown' });
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error.message.includes('Unknown store backend'));
    }
  });
});
