'use strict';
// AppSheet official REST API v2 (data plane only): Find / Add / Edit / invoke an action. It cannot edit the app definition.
// Uses the app's own access key (env only, sent as a header, never returned or logged). No Enterprise-only features are used;
// whether the current plan includes API access is checked by the first call (HTTP error => reported, nothing assumed).
const { maskSecrets } = require('./secretMasking');

function createAppSheetApi({ appId, accessKey, fetchImpl = fetch, region = 'api.appsheet.com' }) {
  async function call(table, body) {
    if (!appId || !accessKey) { const e = new Error('AppSheet APIが未設定です（GOOGLE_APPSHEET_APP_ID / GOOGLE_APPSHEET_ACCESS_KEY）'); e.code = 'NOT_CONFIGURED'; throw e; }
    const res = await fetchImpl(`https://${region}/api/v2/apps/${encodeURIComponent(appId)}/tables/${encodeURIComponent(table)}/Action`, {
      method: 'POST', headers: { 'content-type': 'application/json', ApplicationAccessKey: accessKey }, body: JSON.stringify(body)
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(maskSecrets(`AppSheet API エラー (HTTP ${res.status})`));
    try { return raw ? JSON.parse(raw) : []; } catch (_) { return []; }
  }
  const props = (extra = {}) => ({ Locale: 'ja-JP', ...extra });
  return {
    // runAs evaluates Security Filters for that user (Properties.RunAsUserEmailAddress). Behaviour must be confirmed on the real app.
    find: (table, { selector, runAs } = {}) => call(table, { Action: 'Find', Properties: props({ ...(selector ? { Selector: selector } : {}), ...(runAs ? { RunAsUserEmailAddress: runAs } : {}) }), Rows: [] }),
    invokeAction: (table, action, rows) => call(table, { Action: action, Properties: props(), Rows: rows })
  };
}
module.exports = { createAppSheetApi };
