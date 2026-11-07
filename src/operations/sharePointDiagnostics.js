'use strict';

// SharePoint 接続の診断（Lane B）。permission_check と connection_test が同じ結果を使う。
// 段階: 認証構成 → サイト読取（siteGet） → 権限の読取（permissionsGet）。
// - 実通信は adapter の READ メソッドだけを使う（書込みは行わない）。
// - 結果には件数・真偽値・種別コードのみを含め、サイトIDやトークンは含めない。
// - 未構成は BLOCKED（実環境未確認）、通信失敗・拒否は FAIL として区別する。

const KNOWN_CODES = /^[A-Z_]{3,40}$/;

function codeOf(error) {
  return typeof error?.code === 'string' && KNOWN_CODES.test(error.code) ? error.code : 'INTERNAL_ERROR';
}

async function runSharePointDiagnostics(adapter) {
  const checks = [];
  if (!adapter || adapter.configured !== true) {
    checks.push({ name: 'auth', result: 'BLOCKED', reasonCode: 'AUTH_NOT_CONFIGURED' });
    return summarize(checks, { siteReadable: false, siteReachable: false, permissionsReadable: false });
  }

  let siteReachable = false;
  let siteReadable = false;
  try {
    const site = await adapter.siteGet();
    siteReachable = true;
    siteReadable = typeof site?.siteId === 'string';
    checks.push({ name: 'site', result: siteReadable ? 'PASS' : 'FAIL', reasonCode: siteReadable ? null : 'UPSTREAM_INVALID_RESPONSE' });
  } catch (error) {
    const code = codeOf(error);
    const result = code === 'AUTH_NOT_CONFIGURED' ? 'BLOCKED' : 'FAIL';
    checks.push({ name: 'site', result, reasonCode: code });
  }

  let permissionsReadable = false;
  if (siteReadable) {
    try {
      const permissions = await adapter.permissionsGet();
      permissionsReadable = Array.isArray(permissions);
      checks.push({ name: 'permissions_read', result: permissionsReadable ? 'PASS' : 'FAIL', reasonCode: permissionsReadable ? null : 'UPSTREAM_INVALID_RESPONSE', count: permissionsReadable ? permissions.length : 0 });
    } catch (error) {
      checks.push({ name: 'permissions_read', result: 'FAIL', reasonCode: codeOf(error) });
    }
  } else {
    checks.push({ name: 'permissions_read', result: 'SKIPPED', reasonCode: 'SITE_NOT_READABLE' });
  }

  return summarize(checks, { siteReadable, siteReachable, permissionsReadable });
}

function summarize(checks, flags) {
  const results = checks.map((check) => check.result);
  const status = results.includes('BLOCKED') ? 'BLOCKED' : (results.includes('FAIL') ? 'FAIL' : 'PASS');
  return { status, checks, executed: false, ...flags };
}

module.exports = { runSharePointDiagnostics };
