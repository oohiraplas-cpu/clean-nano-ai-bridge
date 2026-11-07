'use strict';

// action ごとの入力スキーマ検証（Files / ZIP / 構造化データ / Entra / Power Platform 共通）。
// 対応: type(string|integer|boolean|array|object), enum, pattern, minLength/maxLength,
// minimum/maximum, minItems/maxItems, items, required, additionalProperties(false)。
// 違反は VALIDATION_FAILED として呼出元へ返す（秘密値は含めない）。

function checkSpec(name, spec, value) {
  const problems = [];
  if (value === undefined) return problems;
  const type = spec.type;
  if (type === 'string') {
    if (typeof value !== 'string') return [`${name} は文字列で指定してください`];
    if (spec.minLength !== undefined && value.length < spec.minLength) problems.push(`${name} が短すぎます`);
    if (spec.maxLength !== undefined && value.length > spec.maxLength) problems.push(`${name} が長すぎます`);
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) problems.push(`${name} の形式が不正です`);
  } else if (type === 'integer') {
    if (!Number.isInteger(value)) return [`${name} は整数で指定してください`];
    if (spec.minimum !== undefined && value < spec.minimum) problems.push(`${name} が下限未満です`);
    if (spec.maximum !== undefined && value > spec.maximum) problems.push(`${name} が上限を超えています`);
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') return [`${name} は真偽値で指定してください`];
  } else if (type === 'array') {
    if (!Array.isArray(value)) return [`${name} は配列で指定してください`];
    if (spec.minItems !== undefined && value.length < spec.minItems) problems.push(`${name} の件数が不足です`);
    if (spec.maxItems !== undefined && value.length > spec.maxItems) problems.push(`${name} の件数が上限を超えています`);
    if (spec.items) value.forEach((item, i) => problems.push(...checkSpec(`${name}[${i}]`, spec.items, item)));
  } else if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${name} はオブジェクトで指定してください`];
    return problems.concat(validateAction(spec, value, name));
  }
  if (spec.enum && !spec.enum.includes(value)) problems.push(`${name} の値が不正です`);
  return problems;
}

/** schema: { required?: string[], properties: {...}, additionalProperties?: boolean } */
function validateAction(schema, args, prefix = '') {
  const problems = [];
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  for (const key of schema.required || []) {
    if (input[key] === undefined) problems.push(`${prefix}${key} は必須です`);
  }
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
      if (schema.additionalProperties === false) problems.push(`${prefix}${key} は未知の項目です`);
      continue;
    }
    problems.push(...checkSpec(`${prefix}${key}`, schema.properties[key], input[key]));
  }
  return problems;
}

module.exports = { validateAction };
