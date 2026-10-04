// One schema source for discovery, OpenAPI and runtime validation of the new tools.
const branch = { type: 'string', minLength: 1, maxLength: 200, pattern: '^(?!.*(?:\\.\\.|[~^:?*\\\\\\s\\[\\x00-\\x1f]))(?!/)(?!.*//)(?!.*@\\{)(?!.*\\.lock(?:/|$))(?!.*[/.]$)[^/]+(?:/[^/]+)*$' };
const relativePath = { type: 'string', minLength: 1, maxLength: 300, pattern: '^(?!/)(?!.*(?:\\.\\.|\\\\|//|[\\x00-\\x1f]))[^/]+(?:/[^/]+)*\\.(?:pa\\.yaml|yaml|yml|json)$' };
const changes = {
  type: 'array', minItems: 1, maxItems: 50,
  items: { type: 'object', additionalProperties: false, required: ['relativePath'],
    properties: { relativePath, content: { type: 'string', minLength: 1, maxLength: 1000000 }, delete: { type: 'boolean' } },
    oneOf: [
      { required: ['content'], properties: { delete: { enum: [false] } } },
      { required: ['delete'], properties: { delete: { enum: [true] } }, not: { required: ['content'] } }
    ] }
};
const INSPECTION_TOOLS = [
  { name: 'inspect_powerapps_structure', description: '正本branchの全ソースを同一commitで取得し構造と参照を静的解析します。解析範囲・未検証・参照切れを区別し、ソースや秘密値を応答しません。', inputSchema: { type: 'object', additionalProperties: false, required: ['branch'], properties: { branch } } },
  { name: 'analyze_change_impact', description: '正本ソース全体に変更案を重ね、confirmed（定義・直接参照）とpossible（推定・動的参照）の影響を分離します。外部への変更は実行しません。', inputSchema: { type: 'object', additionalProperties: false, required: ['branch', 'changes'], properties: { branch, changes } } },
  { name: 'create_change_snapshot', description: '安全検査済みの正本全ソースと変更案をGit管理対象外へSHA-256で原子的・冪等に保存します。未検証・参照切れ・秘密値・改ざんは拒否します。', inputSchema: { type: 'object', additionalProperties: false, required: ['branch'], properties: { branch, changes } } }
];

function validateSchema(value, schema) {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    if ((schema.required || []).some(key => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) return false;
    for (const [key, item] of Object.entries(value)) if (schema.properties[key] && !validateSchema(item, schema.properties[key])) return false;
  }
  if (schema.type === 'string' && (typeof value !== 'string' || !value.trim() || value.length < (schema.minLength || 0) || value.length > (schema.maxLength || Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) return false;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return false;
  if (schema.type === 'array' && (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems || value.some(item => !validateSchema(item, schema.items)))) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.oneOf && schema.oneOf.filter(s => validateSchema(value, s)).length !== 1) return false;
  if (schema.required && !schema.type && schema.required.some(key => !Object.hasOwn(value, key))) return false;
  if (schema.properties && !schema.type) for (const [key, s] of Object.entries(schema.properties)) if (Object.hasOwn(value, key) && !validateSchema(value[key], s)) return false;
  if (schema.not && validateSchema(value, schema.not)) return false;
  return true;
}
function validateInspectionParams(method, params) {
  const tool = INSPECTION_TOOLS.find(t => t.name === method);
  if (!tool || !validateSchema(params, tool.inputSchema)) return '構造・影響・スナップショットの入力が不正です';
  if (params.changes && new Set(params.changes.map(c => c.relativePath)).size !== params.changes.length) return '変更対象の重複は許可されません';
  return null;
}
module.exports = { INSPECTION_TOOLS, validateInspectionParams };
