const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const SwaggerParser = require('@apidevtools/swagger-parser');

test('OpenAPI定義が有効で、必須operationIdを持つ', async () => {
  const document = await SwaggerParser.validate(path.join(__dirname, '..', 'openapi.yaml'));
  for (const methods of Object.values(document.paths)) {
    for (const operation of Object.values(methods)) assert.ok(operation.operationId);
  }
});