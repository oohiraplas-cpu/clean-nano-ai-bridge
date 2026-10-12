'use strict';

/**
 * SharePoint Lists mutation contract (Draft only).
 * This module does not execute Graph writes. A separate trusted adapter must
 * enforce the approved plan immediately before each operation.
 */
const crypto = require('node:crypto');
const OPERATIONS = Object.freeze(['create_list', 'create_column', 'create_item', 'update_item']);
const SHA = /^[a-f0-9]{40}$/;
const ID = /^[A-Za-z0-9_,.-]{1,256}$/;
const COLUMN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const BLOCKED = new Set(['id','createdDateTime','lastModifiedDateTime','createdBy','lastModifiedBy','contentType']);
function plain(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (plain(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  throw new Error('UNSUPPORTED_CHANGE_VALUE');
}
function validatePlan(plan) {
  if (!plain(plan) || !OPERATIONS.includes(plan.operation)) throw new Error('INVALID_OPERATION');
  if (!ID.test(plan.siteId || '') || !SHA.test(plan.runtimeCommitSha || '')) throw new Error('INVALID_TARGET_OR_SHA');
  if (!plain(plan.params)) throw new Error('INVALID_PARAMS');
  const p = plan.params;
  if (plan.operation === 'create_list') {
    if (typeof p.displayName !== 'string' || !p.displayName.trim() || p.displayName.length > 255 || p.template !== 'genericList') throw new Error('INVALID_LIST');
  } else {
    if (!ID.test(plan.listId || '')) throw new Error('INVALID_LIST_ID');
    if (plan.operation === 'create_column') {
      if (!COLUMN.test(p.name || '') || typeof p.displayName !== 'string' || !p.displayName.trim() || !plain(p.columnDefinition)) throw new Error('INVALID_COLUMN');
      if (p.columnDefinition.name !== p.name || p.columnDefinition.displayName !== p.displayName) throw new Error('COLUMN_MISMATCH');
      if (p.columnDefinition.required === true || p.columnDefinition.hidden === true) throw new Error('RESTRICTED_COLUMN');
      const allowed = new Set(['name','displayName','description','required','hidden','text','number','boolean','dateTime','choice']);
      const types = ['text','number','boolean','dateTime','choice'];
      if (Object.keys(p.columnDefinition).some(k => !allowed.has(k)) || types.filter(k => Object.hasOwn(p.columnDefinition,k)).length !== 1) throw new Error('INVALID_COLUMN_TYPE');
    } else {
      if (plan.operation === 'update_item' && !ID.test(plan.itemId || '')) throw new Error('INVALID_ITEM_ID');
      if (!plain(p.fields) || !Object.keys(p.fields).length) throw new Error('INVALID_FIELDS');
      for (const key of Object.keys(p.fields)) if (!COLUMN.test(key) || BLOCKED.has(key)) throw new Error('RESTRICTED_FIELD');
    }
  }
  return true;
}
function changeHash(plan) {
  validatePlan(plan);
  return crypto.createHash('sha256').update(canonical({
    operation:plan.operation,siteId:plan.siteId,listId:plan.listId || null,
    itemId:plan.itemId || null,runtimeCommitSha:plan.runtimeCommitSha,params:plan.params
  })).digest('hex');
}
function verifyApproval(plan, approval) {
  const digest = changeHash(plan);
  if (!plain(approval) || approval.status !== 'APPROVED' ||
      approval.revoked === true || approval.executionId ||
      approval.operation !== plan.operation ||
      approval.siteId !== plan.siteId ||
      (approval.listId || null) !== (plan.listId || null) ||
      (approval.itemId || null) !== (plan.itemId || null) ||
      approval.runtimeCommitSha !== plan.runtimeCommitSha ||
      approval.changeHash !== digest ||
      !approval.approver || !approval.approvedAt) throw new Error('APPROVAL_SCOPE_MISMATCH');
  return digest;
}
module.exports = { OPERATIONS, canonical, validatePlan, changeHash, verifyApproval };
