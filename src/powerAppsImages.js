const yaml = require('js-yaml');

const MAX_IMAGE_BYTES = 1024 * 1024;
function invalid(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

// Raster images only: SVG may contain scripts or external resource references.
function imageDataUri(base64Content, contentType) {
  const signatures = {
    'image/png': bytes => bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
    'image/jpeg': bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
    'image/gif': bytes => /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')),
    'image/webp': bytes => bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  };
  if (!Object.hasOwn(signatures, contentType)) invalid('contentTypeはPNG/JPEG/GIF/WebPを指定してください');
  if (typeof base64Content !== 'string' || base64Content.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 100) invalid('画像は1MiB以内のBase64文字列が必要です');
  const prefix = `data:${contentType};base64,`;
  const content = base64Content.startsWith(prefix) ? base64Content.slice(prefix.length) : base64Content;
  if (!content || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) invalid('Base64形式が不正です');
  const bytes = Buffer.from(content, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== content) invalid('画像のサイズまたはBase64形式が不正です');
  if (!signatures[contentType](bytes)) invalid('画像の内容がcontentTypeと一致しません');
  return { dataUri: prefix + content, bytes: bytes.length };
}

function validateImageParams(params) {
  const allowed = ['operation', 'relativePath', 'screenName', 'controlName', 'base64Content', 'contentType', 'properties', 'message', 'branch', 'stateContext', 'stateSessionId'];
  if (!params || typeof params !== 'object' || Array.isArray(params)) invalid('paramsはJSONオブジェクトが必要です');
  for (const key of Object.keys(params)) if (!allowed.includes(key)) invalid(`未対応のプロパティです: ${key}`);
  if (!['add', 'edit'].includes(params.operation)) invalid('operationはaddまたはeditが必要です');
  for (const key of ['screenName', 'controlName']) if (typeof params[key] !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(params[key])) invalid(`${key}は英数字とアンダースコアで指定してください`);
  if (typeof params.relativePath !== 'string' || !params.relativePath.endsWith('.pa.yaml') || params.relativePath.includes('..') || params.relativePath.includes('\\')) invalid('relativePathは画面の.pa.yamlが必要です');
  if (params.message !== undefined && (typeof params.message !== 'string' || !params.message.trim() || params.message.length > 500)) invalid('messageは500文字以内の文字列が必要です');
  if (params.base64Content !== undefined || params.contentType !== undefined) imageDataUri(params.base64Content, params.contentType);
  else if (params.operation === 'add') invalid('画像追加にはbase64ContentとcontentTypeが必要です');
  if (params.properties !== undefined && (!params.properties || typeof params.properties !== 'object' || Array.isArray(params.properties))) invalid('propertiesはJSONオブジェクトが必要です');
  for (const [key, value] of Object.entries(params.properties || {})) {
    if (['X', 'Y', 'Width', 'Height'].includes(key)) {
      if (!Number.isFinite(value) || value < 0 || value > 10000 || (['Width', 'Height'].includes(key) && value === 0)) invalid(`${key}の値が不正です`);
    } else if (key === 'ImagePosition') {
      if (!['Fit', 'Fill', 'Stretch', 'Center', 'Tile'].includes(value)) invalid('ImagePositionが不正です');
    } else if (key === 'AccessibleLabel') {
      if (typeof value !== 'string' || value.length > 500 || /[\r\n\x00-\x1f]/.test(value)) invalid('AccessibleLabelは改行なしの500文字以内の文字列が必要です');
    } else invalid(`未対応の画像プロパティです: ${key}`);
  }
  if (params.operation === 'edit' && params.base64Content === undefined && !Object.keys(params.properties || {}).length) invalid('編集する画像またはpropertiesが必要です');
}

function editImageSource(source, params) {
  validateImageParams(params);
  const document = yaml.load(source);
  const screen = document?.Screens?.[params.screenName];
  if (!screen) invalid('指定画面がソースに存在しません', 404);
  const matches = [];
  function visit(children) {
    for (const entry of children || []) for (const [name, control] of Object.entries(entry)) {
      if (name === params.controlName) matches.push(control);
      visit(control.Children);
    }
  }
  visit(screen.Children);
  if (params.operation === 'add' && matches.length) invalid('同名コントロールが存在します。editを使用してください', 409);
  if (params.operation === 'edit' && matches.length !== 1) invalid('編集対象の画像コントロールを一意に特定できません', 404);
  if (params.operation === 'edit' && !/^Image@/.test(matches[0].Control || '')) invalid('編集対象がImageコントロールではありません', 409);
  const updates = { ...params.properties };
  if (params.base64Content !== undefined) updates.Image = imageDataUri(params.base64Content, params.contentType).dataUri;
  const formula = (key, value) => key === 'Image' || key === 'AccessibleLabel'
    ? `="${value.replace(/"/g, '""')}"`
    : key === 'ImagePosition' ? `=ImagePosition.${value}` : `=${value}`;
  // Preserve all unrelated source lines and comments rather than reserializing YAML.
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const screenIndex = lines.findIndex(line => line === `  ${params.screenName}:`);
  if (screenIndex < 0) invalid('対応していない画面ソース形式です');
  let screenEnd = screenIndex + 1;
  while (screenEnd < lines.length && !/^  \S/.test(lines[screenEnd])) screenEnd++;
  if (params.operation === 'add') {
    const defaults = { X: 0, Y: 0, Width: 160, Height: 160, ImagePosition: 'Fit', AccessibleLabel: params.controlName, ...updates };
    let children = lines.findIndex((line, index) => index > screenIndex && index < screenEnd && line === '    Children:');
    if (children < 0) {
      if (screen.Children !== undefined) invalid('対応していないChildren形式です');
      lines.splice(screenEnd, 0, '    Children:');
      children = screenEnd;
    }
    lines.splice(children + 1, 0, `      - ${params.controlName}:`, '          Control: Image@2.2.3', '          Properties:',
      ...Object.entries(defaults).map(([key, value]) => `            ${key}: ${JSON.stringify(formula(key, value))}`));
  } else {
    const indices = lines.map((line, index) => index > screenIndex && index < screenEnd && new RegExp(`^\\s*- ${params.controlName}:$`).test(line) ? index : -1).filter(index => index >= 0);
    if (indices.length !== 1) invalid('対応していない画像コントロール形式です');
    const start = indices[0];
    const indent = lines[start].match(/^ */)[0].length;
    let end = start + 1;
    while (end < screenEnd && (!lines[end].trim() || lines[end].match(/^ */)[0].length > indent)) end++;
    const propertyIndent = ' '.repeat(indent + 6);
    const properties = lines.findIndex((line, index) => index > start && index < end && line === `${' '.repeat(indent + 4)}Properties:`);
    if (properties < 0) invalid('画像コントロールのPropertiesがありません');
    let propertiesEnd = properties + 1;
    while (propertiesEnd < end && (!lines[propertiesEnd].trim() || lines[propertiesEnd].startsWith(propertyIndent))) propertiesEnd++;
    for (const [key, value] of Object.entries(updates)) {
      const index = lines.findIndex((line, index) => index > properties && index < propertiesEnd && line.startsWith(`${propertyIndent}${key}:`));
      const replacement = `${propertyIndent}${key}: ${JSON.stringify(formula(key, value))}`;
      if (index >= 0) {
        // Refuse multiline property rewrites to avoid leaving an invalid continuation.
        if (index + 1 < propertiesEnd && lines[index + 1].startsWith(propertyIndent + ' ')) invalid('複数行の画像プロパティ編集は未対応です');
        lines[index] = replacement;
      } else { lines.splice(propertiesEnd++, 0, replacement); }
    }
  }
  const content = lines.join(newline);
  yaml.load(content);
  return content;
}

module.exports = { editImageSource, validateImageParams, imageDataUri, MAX_IMAGE_BYTES };
