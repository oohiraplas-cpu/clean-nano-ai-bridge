const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../powerapps/CN_AI依頼台帳/Source/S8_UserOnboarding.pa.yaml'), 'utf8');
const card = source.split('            - UserUPN_DataCard1:')[1]?.split('\n            - ')[0];
test('onboarding UPN comes from signed-in user, not editable form input', () => {
  assert.ok(card, 'UserUPN card exists');
  assert.match(card, /Update: =Lower\(Trim\(User\(\)\.Email\)\)/);
  assert.match(card, /DisplayMode: =DisplayMode.View/);
  assert.doesNotMatch(card, /Update: =DataCardValue25\.Text/);
});
