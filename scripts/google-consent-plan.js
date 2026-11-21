#!/usr/bin/env node
'use strict';
// One-time human consent plan: prints the union of OAuth scopes the Google capability needs and a single consent URL.
// Reads only the (non-secret) client id. Never prints or needs a client secret / refresh token.
const { consentScopes, CAPABILITIES } = require('../src/googleCapability');
const scopes = consentScopes();
const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || '<GOOGLE_OAUTH_CLIENT_ID>';
const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: clientId, redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI || 'http://localhost', response_type: 'code', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', scope: scopes.join(' ') })}`;
console.log(JSON.stringify({ capabilityCount: Object.keys(CAPABILITIES).length, scopeCount: scopes.length, scopes, consentUrl: url, note: '同一Workspaceドメインの既存アカウントで1回だけ同意。得たrefresh tokenはデプロイ環境変数 GOOGLE_OAUTH_REFRESH_TOKEN にのみ設定（コード/ログ/チャットに貼らない）' }, null, 2));
