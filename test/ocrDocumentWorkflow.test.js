const test = require('node:test');
const assert = require('node:assert/strict');
const flow = require('../src/ocrDocumentWorkflow');
const master = [{customerNumber:'02-027652-20', receptionNumber:'91808', address:'中央区新川1-25-16'}];
const text = '受付番号 91808 お客さま番号 02-027652-20 中央区新川1-25-16';

test('読取・記載・完成の二段階確認後だけ出力意図を作る', () => {
  const read = flow.start(text, master, {documentId:'sample-1'});
  assert.equal(read.phase, flow.PHASES.READ);
  assert.equal(flow.outputIntent(read, 'pdf').ok, false);
  const draft = flow.confirmRead(read, {actor:'operator'});
  assert.equal(draft.phase, flow.PHASES.DRAFT);
  const final = flow.previewFinal(draft, {recipient:'元請', templateId:'verified-template'});
  assert.equal(flow.outputIntent(final, 'pdf').ok, false);
  assert.equal(flow.approveFinal(final, {actor:'AI'}).ok, false);
  const approved = flow.approveFinal(final, {actor:'operator'});
  const pdf = flow.outputIntent(approved, 'pdf');
  assert.equal(pdf.ok, true);
  assert.equal(pdf.generated, false);
  assert.equal(pdf.sent, false);
  assert.equal(flow.outputIntent(approved, 'fax', {faxNumber:'03-1234-5678'}).ok, false);
  const fax = flow.outputIntent(approved, 'fax', {faxNumber:'03-1234-5678', confirmedFaxNumber:'03-1234-5678'});
  assert.equal(fax.ok, true);
  assert.equal(fax.sent, false);
});

test('不一致・訂正・未確認の本人自社帳票は停止', () => {
  assert.equal(flow.start('お客さま番号 02-027652-20', master, {documentId:'x'}).ok, false);
  assert.equal(flow.start(text, master, {kind:'mydata', documentId:'x'}).ok, false);
  assert.equal(flow.start(text, master, {kind:'company', documentId:'x'}).ok, false);
  const read = flow.start(text, master, {documentId:'x'});
  assert.equal(flow.confirmRead(read, {actor:'operator', corrections:{address:'別住所'}}).ok, false);
  assert.equal(flow.confirmRead(read).ok, false);
});
