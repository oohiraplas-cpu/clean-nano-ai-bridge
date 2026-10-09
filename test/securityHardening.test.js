const test = require('node:test');
const assert = require('node:assert');
const {
  InputSanitizer,
  RateLimiter,
  PayloadValidator,
  SSRFProtection,
  SecurityAuditLog
} = require('../src/securityHardening');

test('Security Hardening', async (t) => {
  await t.test('InputSanitizer', async (t) => {
    const sanitizer = new InputSanitizer();

    await t.test('detects SQL injection patterns', () => {
      const result = sanitizer.sanitize("'; DROP TABLE users; --", 'sql');
      assert.strictEqual(result.issues.length > 0, true);
      assert.ok(result.issues.some(i => i.includes('SQL injection')));
    });

    await t.test('detects command injection patterns', () => {
      const result = sanitizer.sanitize('test; rm -rf /', 'command');
      assert.strictEqual(result.issues.length > 0, true);
    });

    await t.test('detects XSS patterns', () => {
      const result = sanitizer.sanitize('<script>alert("xss")</script>', 'html');
      assert.strictEqual(result.issues.length > 0, true);
    });

    await t.test('sanitizes normal strings', () => {
      const result = sanitizer.sanitize('  hello world  ', 'general');
      assert.strictEqual(result.sanitized, 'hello world');
      assert.strictEqual(result.issues.length, 0);
    });

    await t.test('removes null bytes', () => {
      const result = sanitizer.sanitize('hello\0world', 'general');
      assert.strictEqual(result.sanitized, 'helloworld');
    });

    await t.test('validates object recursively', () => {
      const obj = {
        name: '  John  ',
        age: 30,
        nested: {
          value: "'; DROP TABLE; --"
        }
      };

      const result = sanitizer.validateObject(obj, 'sql');
      assert.strictEqual(result.valid, false);
      assert.ok(result.issues);
    });

    await t.test('handles deep nesting limits', () => {
      let obj = {};
      let current = obj;
      for (let i = 0; i < 15; i++) {
        current.next = {};
        current = current.next;
      }

      const result = sanitizer.validateObject(obj);
      assert.strictEqual(result.valid, false);
    });
  });

  await t.test('RateLimiter', async (t) => {
    await t.test('creates limiter with default config', () => {
      const limiter = new RateLimiter();
      assert.ok(limiter);
      assert.strictEqual(limiter.maxRequests, 100);
    });

    await t.test('allows requests within limit', () => {
      const limiter = new RateLimiter({ maxRequests: 5, windowMs: 1000 });

      for (let i = 0; i < 5; i++) {
        const result = limiter.isAllowed('user1');
        assert.strictEqual(result.allowed, true);
      }

      const result = limiter.isAllowed('user1');
      assert.strictEqual(result.allowed, false);
      limiter.destroy();
    });

    await t.test('returns remaining requests', () => {
      const limiter = new RateLimiter({ maxRequests: 3, windowMs: 1000 });

      let result = limiter.isAllowed('user1');
      assert.strictEqual(result.remaining, 2);

      result = limiter.isAllowed('user1');
      assert.strictEqual(result.remaining, 1);

      result = limiter.isAllowed('user1');
      assert.strictEqual(result.remaining, 0);

      limiter.destroy();
    });

    await t.test('resets after window expires', async () => {
      const limiter = new RateLimiter({ maxRequests: 1, windowMs: 100 });

      const result1 = limiter.isAllowed('user1');
      assert.strictEqual(result1.allowed, true);

      const result2 = limiter.isAllowed('user1');
      assert.strictEqual(result2.allowed, false);

      await new Promise(resolve => {
        setTimeout(() => {
          const result3 = limiter.isAllowed('user1');
          assert.strictEqual(result3.allowed, true);
          limiter.destroy();
          resolve();
        }, 150);
      });
    });

    await t.test('tracks separate keys independently', () => {
      const limiter = new RateLimiter({ maxRequests: 2, windowMs: 1000 });

      limiter.isAllowed('user1');
      limiter.isAllowed('user1');
      const user1 = limiter.isAllowed('user1');
      assert.strictEqual(user1.allowed, false);

      const user2 = limiter.isAllowed('user2');
      assert.strictEqual(user2.allowed, true);

      limiter.destroy();
    });

    await t.test('provides statistics', () => {
      const limiter = new RateLimiter({ maxRequests: 5 });
      limiter.isAllowed('user1');
      limiter.isAllowed('user1');
      limiter.isAllowed('user2');

      const stats = limiter.getStats();
      assert.strictEqual(stats.totalKeys, 2);
      assert.strictEqual(stats.activeKeys, 2);

      limiter.destroy();
    });
  });

  await t.test('PayloadValidator', async (t) => {
    await t.test('validates payload size', () => {
      const validator = new PayloadValidator({ maxBodySize: 100 });

      const smallPayload = { name: 'test' };
      const result1 = validator.validate(smallPayload);
      assert.strictEqual(result1.valid, true);

      const largePayload = { data: 'x'.repeat(200) };
      const result2 = validator.validate(largePayload);
      assert.strictEqual(result2.valid, false);
      assert.ok(result2.issues);
    });

    await t.test('validates array length', () => {
      const validator = new PayloadValidator({ maxArrayLength: 5 });

      const payload = { items: Array(10).fill(0) };
      const result = validator.validate(payload);
      assert.strictEqual(result.valid, false);
    });

    await t.test('validates string length', () => {
      const validator = new PayloadValidator({ maxStringLength: 10 });

      const payload = { text: 'x'.repeat(20) };
      const result = validator.validate(payload);
      assert.strictEqual(result.valid, false);
    });

    await t.test('validates nesting depth', () => {
      const validator = new PayloadValidator();

      let obj = {};
      let current = obj;
      for (let i = 0; i < 25; i++) {
        current.next = {};
        current = current.next;
      }

      const result = validator.validate(obj);
      assert.strictEqual(result.valid, false);
    });

    await t.test('returns payload size', () => {
      const validator = new PayloadValidator();
      const payload = { name: 'test' };

      const result = validator.validate(payload);
      assert.ok(result.size > 0);
    });
  });

  await t.test('SSRFProtection', async (t) => {
    await t.test('blocks localhost addresses', () => {
      const protection = new SSRFProtection();

      const result = protection.validateUrl('http://localhost:8080');
      assert.strictEqual(result.safe, false);
    });

    await t.test('blocks private IP ranges', () => {
      const protection = new SSRFProtection();

      const result1 = protection.validateUrl('http://192.168.1.1');
      assert.strictEqual(result1.safe, false);

      const result2 = protection.validateUrl('http://10.0.0.1');
      assert.strictEqual(result2.safe, false);

      const result3 = protection.validateUrl('http://172.16.0.1');
      assert.strictEqual(result3.safe, false);
    });

    await t.test('blocks AWS metadata', () => {
      const protection = new SSRFProtection();

      const result = protection.validateUrl('http://169.254.169.254');
      assert.strictEqual(result.safe, false);
    });

    await t.test('blocks dangerous protocols', () => {
      const protection = new SSRFProtection();

      const result = protection.validateUrl('file:///etc/passwd');
      assert.strictEqual(result.safe, false);
    });

    await t.test('allows whitelisted domains', () => {
      const protection = new SSRFProtection({
        allowedDomains: ['example.com']
      });

      const result1 = protection.validateUrl('https://example.com/api');
      assert.strictEqual(result1.safe, true);

      const result2 = protection.validateUrl('https://other.com/api');
      assert.strictEqual(result2.safe, false);
    });

    await t.test('rejects invalid URLs', () => {
      const protection = new SSRFProtection();

      const result = protection.validateUrl('not a url');
      assert.strictEqual(result.safe, false);
    });
  });

  await t.test('SecurityAuditLog', async (t) => {
    await t.test('logs security events', () => {
      const log = new SecurityAuditLog();

      log.log({
        type: 'authentication',
        severity: 'info',
        correlationId: 'corr-123',
        principal: 'user@example.com',
        action: 'login',
        resource: 'user_account',
        result: 'allowed'
      });

      assert.strictEqual(log.events.length, 1);
      assert.strictEqual(log.events[0].type, 'authentication');
    });

    await t.test('filters events by type', () => {
      const log = new SecurityAuditLog();

      log.log({ type: 'authentication', result: 'allowed' });
      log.log({ type: 'authorization', result: 'denied' });
      log.log({ type: 'authentication', result: 'denied' });

      const authEvents = log.getEvents({ type: 'authentication' });
      assert.strictEqual(authEvents.length, 2);
    });

    await t.test('filters events by result', () => {
      const log = new SecurityAuditLog();

      log.log({ type: 'authorization', result: 'allowed' });
      log.log({ type: 'authorization', result: 'denied' });

      const deniedEvents = log.getEvents({ result: 'denied' });
      assert.strictEqual(deniedEvents.length, 1);
    });

    await t.test('respects limit', () => {
      const log = new SecurityAuditLog();

      for (let i = 0; i < 10; i++) {
        log.log({ type: 'test', result: 'allowed' });
      }

      const events = log.getEvents({ limit: 3 });
      assert.strictEqual(events.length, 3);
    });

    await t.test('provides summary', () => {
      const log = new SecurityAuditLog();

      log.log({ type: 'auth', severity: 'info', result: 'allowed' });
      log.log({ type: 'authz', severity: 'warning', result: 'denied' });
      log.log({ type: 'auth', severity: 'critical', result: 'denied' });

      const summary = log.getSummary();
      assert.strictEqual(summary.total, 3);
      assert.ok(summary.byType.auth);
      assert.ok(summary.byType.authz);
    });

    await t.test('enforces max events limit', () => {
      const log = new SecurityAuditLog();
      const maxEvents = log.maxEvents;

      for (let i = 0; i < maxEvents + 100; i++) {
        log.log({ type: 'test' });
      }

      assert.strictEqual(log.events.length, maxEvents);
    });

    await t.test('clears events', () => {
      const log = new SecurityAuditLog();

      log.log({ type: 'test' });
      assert.strictEqual(log.events.length, 1);

      log.clear();
      assert.strictEqual(log.events.length, 0);
    });
  });
});
