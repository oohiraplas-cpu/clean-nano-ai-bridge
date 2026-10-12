'use strict';

const yaml = require('js-yaml');

function screenStructurePreview(content, screenName) {
  if (typeof content !== 'string' || content.length > 1000000) throw new Error('BLOCKED: source unavailable or too large');
  const parsed = yaml.load(content, { schema: yaml.JSON_SCHEMA });
  const screen = parsed?.Screens?.[screenName];
  if (!screen || !Array.isArray(screen.Children)) throw new Error('BLOCKED: screen not found or malformed');
  let count = 0;
  function project(children, depth) {
    if (depth > 20) throw new Error('BLOCKED: excessive screen nesting');
    return children.map(entry => {
      if (++count > 1000) throw new Error('BLOCKED: excessive controls');
      const [name, definition] = Object.entries(entry || {})[0] || [];
      if (!name || !definition || typeof definition !== 'object') throw new Error('BLOCKED: invalid control');
      const p = definition.Properties || {};
      const properties = {};
      for (const key of ['Text', 'X', 'Y', 'Width', 'Height', 'Visible', 'Fill', 'Color', 'OnSelect']) {
        if (typeof p[key] === 'string') properties[key] = p[key].slice(0, 2000);
      }
      return { name, controlType: definition.Control || null, properties, children: Array.isArray(definition.Children) ? project(definition.Children, depth + 1) : [] };
    });
  }
  return { screenName, screenProperties: { Fill: screen.Properties?.Fill || null }, controls: project(screen.Children, 0), controlCount: count };
}

module.exports = { screenStructurePreview };
