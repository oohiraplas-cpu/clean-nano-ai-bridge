'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const w = require('../src/completionWorkflow');
const author = {id:'author'}, other = {id:'other'}, approver = {id:'manager',canApprove:true};
test('completion locks all edits and retains immutable prior version', () => {
  const draft = w.createDraft('1',{title:'A'},author);
  const finished = w.complete(draft,author);
  assert.equal(finished.state,w.STATES.COMPLETED);
  assert.equal(finished.history[0].content.title,'A');
  assert.throws(()=>w.edit(finished,{title:'B'},author),/denied/);
  assert.throws(()=>w.edit(finished,{title:'B'},other),/denied/);
});
test('approved revision allows only nominated editor, retains original snapshot', () => {
  const finished=w.complete(w.createDraft('1',{title:'A'},author),author);
  const requested=w.requestRevision(finished,author,'typo');
  assert.throws(()=>w.decideRevision(requested,author,requested.requests[0].id,'approve','author'),/denied/);
  const opened=w.decideRevision(requested,approver,requested.requests[0].id,'approve','author');
  assert.throws(()=>w.edit(opened,{title:'X'},other),/denied/);
  const revised=w.complete(w.edit(opened,{title:'B'},author),author);
  assert.equal(revised.version,2);
  assert.deepEqual(revised.history.map(x=>x.content.title),['A','B']);
  assert.equal(revised.state,w.STATES.COMPLETED);
});
test('rejected request relocks and never grants editing', () => {
  const finished=w.complete(w.createDraft('1',{title:'A'},author),author);
  const requested=w.requestRevision(finished,other,'correction');
  const rejected=w.decideRevision(requested,approver,requested.requests[0].id,'reject');
  assert.equal(rejected.state,w.STATES.COMPLETED);
  assert.throws(()=>w.edit(rejected,{title:'X'},author),/denied/);
});
test('missing identity or reason fail closed', () => {
  assert.throws(()=>w.createDraft('1',{},{}),/actor/);
  const finished=w.complete(w.createDraft('1',{a:1},author),author);
  assert.throws(()=>w.requestRevision(finished,author,''),/denied/);
});
