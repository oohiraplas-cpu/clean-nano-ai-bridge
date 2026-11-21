'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const g = require('../src/googleCapability');
const cnaiRouter = require('../src/cnaiRouter');

const SID = 'script_id_1234567890';
const SHEET = 'sheet_id_1234567890';
const MANIFEST = { name: 'appsscript', type: 'JSON', source: '{"timeZone":"Asia/Tokyo"}' };

function draftFrom(raw, tamper) {
  const lines = raw.split('\r\n');
  const h = (n) => (lines.find((l) => l.startsWith(`${n}: `)) || '').slice(n.length + 2);
  const body = Buffer.from(lines[lines.length - 1], 'base64').toString('utf8');
  return { id: 'd1', message: { payload: { mimeType: 'text/plain', headers: [{ name: 'To', value: h('To') }, { name: 'Subject', value: tamper ? 'tampered' : h('Subject') }], body: { data: Buffer.from(body).toString('base64url') } } } };
}
function docFrom(state) {
  return { revisionId: `r${state.rev}`, title: 't', body: { content: [{ endIndex: state.doc.length + 1, paragraph: { elements: [{ textRun: { content: state.doc } }] } }] } };
}
function fakeClient(over = {}) {
  const state = { doc: 'hello\n', rev: 1, rows: [{ ID: 'r1', V: 'old' }], event: { id: 'ev1', summary: 'old', start: { dateTime: '2026-12-01T10:00:00+09:00' }, end: { dateTime: '2026-12-01T11:00:00+09:00' } }, files: [MANIFEST, { name: 'Code', type: 'SERVER_JS', source: 'function a(){}' }], grid: [['a', 'b']], deployments: [], calls: [] };
  const rec = (name, fn) => async (...args) => { state.calls.push(name); return fn(...args); };
  const client = {
    sheetsGet: rec('sheetsGet', async (_s, range) => ({ range, values: state.grid })),
    sheetsUpdate: rec('sheetsUpdate', async (_s, _r, values) => { state.grid = values; }),
    driveMeta: rec('driveMeta', async (fid) => ({ id: fid, name: 'x' })),
    driveList: rec('driveList', async () => ({ files: [] })),
    gasGetContent: rec('gasGetContent', async () => ({ files: state.files })),
    gasUpdateContent: rec('gasUpdateContent', async (_s, files) => { state.files = files; }),
    gasCreateVersion: rec('gasCreateVersion', async () => ({ versionNumber: 3 })),
    gasDeploy: rec('gasDeploy', async () => { const d = { deploymentId: 'dep1' }; state.deployments.push(d); return d; }),
    gasListDeployments: rec('gasListDeployments', async () => ({ deployments: state.deployments })),
    gasRun: rec('gasRun', async () => ({ done: true, response: { result: 'ok' } })),
    gmailSearch: rec('gmailSearch', async () => ({ messages: [{ id: 'm1' }] })),
    gmailGet: rec('gmailGet', async (id) => state.sent ? { id, labelIds: ['SENT'], payload: { headers: [{ name: 'Subject', value: `=?UTF-8?B?${Buffer.from(state.sent.subject).toString('base64')}?=` }] } } : { id, snippet: 's', payload: { headers: [{ name: 'From', value: 'a@x.co.jp' }] } }),
    gmailDraftCreate: rec('gmailDraftCreate', async (raw) => { state.raw = Buffer.from(raw, 'base64url').toString('utf8'); return { id: 'd1' }; }),
    gmailDraftGet: rec('gmailDraftGet', async () => draftFrom(state.raw, state.tamper)),
    gmailDraftDelete: rec('gmailDraftDelete', async () => ({})),
    gmailDraftSend: rec('gmailDraftSend', async () => { const m = draftFrom(state.raw).message; state.sent = { subject: Buffer.from(/Subject: =\?UTF-8\?B\?(.+)\?=/.exec(state.raw)[1], 'base64').toString('utf8') }; return { id: 'sent1', ...m }; }),
    chatList: rec('chatList', async () => ({ messages: [] })),
    chatGet: rec('chatGet', async () => ({ text: state.chat })),
    chatCreate: rec('chatCreate', async (_s, t) => { state.chat = t; return { name: 'spaces/AAA/messages/1' }; }),
    docsGet: rec('docsGet', async () => docFrom(state)),
    docsBatchUpdate: rec('docsBatchUpdate', async (_d, reqs) => { const r = reqs[0]; if (r.insertText) state.doc = state.doc.replace(/\n$/, '') + r.insertText.text + '\n'; else state.doc = state.doc.split(r.replaceAllText.containsText.text).join(r.replaceAllText.replaceText); state.rev += 1; }),
    calList: rec('calList', async () => ({ items: [] })),
    calGet: rec('calGet', async () => state.event),
    calInsert: rec('calInsert', async (_c, b) => { state.event = { id: 'ev1', ...b }; return state.event; }),
    calPatch: rec('calPatch', async (_c, _e, b) => { state.event = { ...state.event, ...b }; return state.event; }),
    appsheet: rec('appsheet', async (_a, _t, _k, body) => { if (body.Action === 'Add' || body.Action === 'Edit') { for (const r of body.Rows) state.rows = [...state.rows.filter((x) => x.ID !== r.ID), r]; return []; } return state.rows; }),
    ...over
  };
  return { client, state };
}
const CFG = { workspaceDomain: 'cleannano.co.jp' };
const run = (deps, capability, params, approvedByHuman) => g.executeGoogleCapability({ config: {}, ...deps }, { capability, params, approvedByHuman });
const newFiles = [MANIFEST, { name: 'Code', type: 'SERVER_JS', source: 'function b(){}' }];

test('registry: GAS capabilities and Gemini owner, AppSheet not required', () => {
  const d = g.describeCapabilities({ providers: { gemini: { status: 'BLOCKED' } } });
  for (const c of ['gas.read', 'gas.update', 'gas.deploy', 'gas.execute', 'gas.verify']) assert.ok(d.capabilities.some((x) => x.capability === c), c);
  assert.equal(d.implementationOwner, 'gemini');
  assert.equal(d.ownerStatus, 'BLOCKED');
  assert.equal(d.appSheetApiRequired, false);
});

test('READ runs automatically without approval (gas.read / sheets.read / drive.read / cnkk.read)', async () => {
  const { client } = fakeClient();
  const r = await run({ client }, 'gas.read', { scriptId: SID });
  assert.equal(r.success, true);
  assert.equal(r.verified, true);
  assert.equal(r.files.some((f) => 'source' in f), false);
  assert.equal((await run({ client }, 'sheets.read', { spreadsheetId: SHEET, range: 'A1:B1' })).verified, true);
  assert.equal((await run({ client }, 'drive.read', { fileId: SHEET })).success, true);
  const c = await g.executeGoogleCapability({ client, config: { cnkk: { spreadsheetId: SHEET } } }, { capability: 'cnkk.read', params: { range: 'A1:B1' } });
  assert.equal(c.success, true);
});

test('gas.update / gas.deploy are blocked without human approval and make no API call', async () => {
  for (const [cap, params] of [['gas.update', { scriptId: SID, files: newFiles }], ['gas.deploy', { scriptId: SID }]]) {
    const { client, state } = fakeClient();
    const r = await run({ client }, cap, params);
    assert.equal(r.errorCode, 'HUMAN_APPROVAL_REQUIRED');
    assert.equal(state.calls.length, 0);
    assert.equal(r.evidence.humanGate.required, true);
  }
});

test('gas.update approved: snapshot -> write -> re-fetch -> VERIFIED with evidence', async () => {
  const snapshots = new Map();
  const { client, state } = fakeClient();
  const r = await run({ client, snapshots }, 'gas.update', { scriptId: SID, files: newFiles }, true);
  assert.equal(r.success, true);
  assert.equal(r.verified, true);
  assert.ok(snapshots.get(r.snapshotId).files.some((f) => f.source === 'function a(){}'));
  assert.deepEqual(state.calls, ['gasGetContent', 'gasUpdateContent', 'gasGetContent']);
  assert.notEqual(r.evidence.before.manifestHash, r.evidence.after.manifestHash);
  assert.equal(r.evidence.humanGate.approved, true);
});

test('gas.update: readback mismatch is not reported as success', async () => {
  const { client } = fakeClient({ gasUpdateContent: async () => {} });
  const r = await run({ client }, 'gas.update', { scriptId: SID, files: newFiles }, true);
  assert.equal(r.success, false);
  assert.equal(r.errorCode, 'VERIFICATION_FAILED');
});

test('gas.update rejects files without appsscript manifest', async () => {
  const { client, state } = fakeClient();
  const r = await run({ client }, 'gas.update', { scriptId: SID, files: [newFiles[1]] }, true);
  assert.equal(r.errorCode, 'INVALID_INPUT');
  assert.equal(state.calls.includes('gasUpdateContent'), false);
});

test('gas.deploy approved: creates version+deployment and re-lists', async () => {
  const { client } = fakeClient();
  const r = await run({ client }, 'gas.deploy', { scriptId: SID, description: 'v' }, true);
  assert.equal(r.verified, true);
  assert.equal(r.deploymentId, 'dep1');
  assert.equal(r.evidence.after.versionNumber, 3);
});

test('gas.execute: gated unless function is allowlisted; result is never VERIFIED by itself', async () => {
  const { client, state } = fakeClient();
  const blocked = await run({ client }, 'gas.execute', { scriptId: SID, function: 'doWork' });
  assert.equal(blocked.errorCode, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal(state.calls.length, 0);
  const allowed = await g.executeGoogleCapability({ client, config: { readonlyFunctions: ['getStatus'] } }, { capability: 'gas.execute', params: { scriptId: SID, function: 'getStatus' } });
  assert.equal(allowed.success, true);
  assert.equal(allowed.verified, false);
});

test('gas.verify: compares against expectation; no expectation -> not PASS', async () => {
  const { client } = fakeClient();
  const read = await run({ client }, 'gas.read', { scriptId: SID });
  const ok = await run({ client }, 'gas.verify', { scriptId: SID, expectedManifestHash: read.manifestHash });
  assert.equal(ok.verified, true);
  const bad = await run({ client }, 'gas.verify', { scriptId: SID, expectedManifestHash: 'x' });
  assert.equal(bad.errorCode, 'VERIFICATION_FAILED');
  const none = await run({ client }, 'gas.verify', { scriptId: SID });
  assert.equal(none.verified, false);
  assert.equal(none.errorCode, 'NO_EXPECTATION');
});

test('sheets.update / cnkk.update: Human Gate, then snapshot + readback verified', async () => {
  const { client, state } = fakeClient();
  const cfg = { cnkk: { spreadsheetId: SHEET } };
  const gated = await g.executeGoogleCapability({ client, config: cfg }, { capability: 'cnkk.update', params: { range: 'A1:B1', values: [['x', 'y']] } });
  assert.equal(gated.errorCode, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal(state.calls.length, 0);
  assert.equal(gated.approvalSummary.cells, 2);
  const r = await g.executeGoogleCapability({ client, config: cfg }, { capability: 'cnkk.update', params: { range: 'A1:B1', values: [['x', 'y']] }, approvedByHuman: true });
  assert.equal(r.verified, true);
  assert.equal(r.verifier.status, 'PASS');
  assert.ok(r.snapshotId);
  const unconfigured = await run({ client }, 'cnkk.update', { range: 'A1', values: [['x']] }, true);
  assert.equal(unconfigured.errorCode, 'ADAPTER_NOT_CONFIGURED');
});

test('no client / unknown capability fail closed; secrets are masked from errors and output', async () => {
  assert.equal((await run({}, 'gas.read', { scriptId: SID })).errorCode, 'ADAPTER_NOT_CONFIGURED');
  assert.equal((await run({ client: {} }, 'gas.nope', {})).errorCode, 'UNKNOWN_CAPABILITY');
  const { client } = fakeClient({ gasGetContent: async () => { throw new g.GoogleCapabilityError('boom Bearer abcdefghijklmnop1234', 'UPSTREAM_ERROR'); } });
  const r = await run({ client }, 'gas.read', { scriptId: SID });
  assert.equal(JSON.stringify(r).includes('abcdefghijklmnop1234'), false);
});

test('OAuth client: per-capability narrowed scope, token cached, consent shortfall reported', async () => {
  const forms = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('oauth2')) {
      const f = Object.fromEntries(new URLSearchParams(init.body));
      forms.push(f);
      if (f.scope.includes('documents')) return { ok: false, status: 400, json: async () => ({}) };
      return { ok: true, json: async () => ({ access_token: 'tok_SECRET_123456', expires_in: 3600 }) };
    }
    assert.equal(init.headers.authorization, 'Bearer tok_SECRET_123456');
    return { ok: true, text: async () => JSON.stringify({ files: [] }) };
  };
  const client = g.createGoogleClient({ oauth: { clientId: 'a', clientSecret: 'b', refreshToken: 'c' }, fetchImpl });
  await client.forScopes(g.CAPABILITIES['gas.read'].scopes).gasGetContent(SID);
  await client.forScopes(g.CAPABILITIES['gas.read'].scopes).gasGetContent(SID);
  assert.equal(forms.length, 1);
  assert.equal(forms[0].scope, 'https://www.googleapis.com/auth/script.projects.readonly');
  const r = await g.executeGoogleCapability({ client, config: {} }, { capability: 'docs.read', params: { documentId: SHEET } });
  assert.equal(r.errorCode, 'CONSENT_REQUIRED');
  assert.deepEqual(r.missingScopes, ['https://www.googleapis.com/auth/documents.readonly']);
  assert.equal(JSON.stringify(r).includes('tok_SECRET'), false);
  const bad = g.createGoogleClient({ oauth: {}, fetchImpl });
  await assert.rejects(() => bad.forScopes(['x']).gasGetContent(SID), /未構成/);
});

test('Router: gas/sheets/cnkk hints route to googleWorkspace; unconfigured -> BLOCKED; configured -> executed', async () => {
  for (const hint of ['gas', 'sheets', 'drive', 'cnkk', 'google', 'appsscript']) {
    assert.equal(cnaiRouter.classify({ requestType: 'q', platformHint: hint }).route, 'googleWorkspace');
  }
  const blocked = await cnaiRouter.routeRequest(cnaiRouter.createRouterState(), { requestType: 'gas.read', platformHint: 'gas', payload: { params: { scriptId: SID } } });
  assert.equal(blocked.executionStatus, 'BLOCKED');
  assert.equal(blocked.errorCode, 'ADAPTER_NOT_CONFIGURED');

  const { client } = fakeClient();
  const adapters = cnaiRouter.defaultAdapters({ adapters: { googleWorkspace: g.createGoogleWorkspaceAdapter({ client, config: {} }) } });
  const state = cnaiRouter.createRouterState();
  const read = await cnaiRouter.routeRequest(state, { requestType: 'gas.read', platformHint: 'gas', payload: { params: { scriptId: SID } } }, adapters);
  assert.equal(read.executionStatus, 'COMPLETED');
  const upd = { requestType: 'gas.update', platformHint: 'gas', payload: { params: { scriptId: SID, files: newFiles } } };
  const gated = await cnaiRouter.routeRequest(state, upd, adapters);
  assert.equal(gated.executionStatus, 'BLOCKED');
  assert.equal(gated.errorCode, 'HUMAN_APPROVAL_REQUIRED');
  const done = await cnaiRouter.resumeRequest(state, gated.requestId, { ...upd, approvedByHuman: true }, adapters);
  assert.equal(done.executionStatus, 'COMPLETED');
  assert.equal(done.lastDispatchOutput.evidence.after.fileCount, 2);
});

const runC = (client, capability, params, approvedByHuman, config = CFG) => g.executeGoogleCapability({ client, config }, { capability, params, approvedByHuman });
const MAIL = { to: ['a@cleannano.co.jp'], subject: '件名', body: '本文です' };
const CAL_ID = 'primary';

test('gmail.read auto; gmail.draft auto + readback; send gated with approvalSummary and zero calls', async () => {
  const { client, state } = fakeClient();
  assert.equal((await runC(client, 'gmail.read', { messageId: 'm1' })).message.from, 'a@x.co.jp');
  const d = await runC(client, 'gmail.draft', MAIL);
  assert.equal(d.verified, true);
  state.calls.length = 0;
  const gated = await runC(client, 'gmail.send', MAIL);
  assert.equal(gated.errorCode, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal(state.calls.length, 0);
  assert.deepEqual(gated.approvalSummary.to, MAIL.to);
  assert.match(gated.proposalHash, /^[0-9a-f]{64}$/);
});

test('gmail.send approved: predraft verified -> send -> SENT readback; tampered draft aborts before send', async () => {
  const { client, state } = fakeClient();
  const r = await runC(client, 'gmail.send', MAIL, true);
  assert.equal(r.verified, true);
  assert.equal(r.evidence.after.labelIds[0], 'SENT');
  assert.ok(state.calls.includes('gmailDraftSend'));
  const t = fakeClient(); t.state.tamper = true;
  const bad = await runC(t.client, 'gmail.send', MAIL, true);
  assert.equal(bad.errorCode, 'VERIFICATION_FAILED');
  assert.equal(t.state.calls.includes('gmailDraftSend'), false);
  assert.ok(t.state.calls.includes('gmailDraftDelete'));
});

test('mail: external recipients, header injection and missing domain are refused (fail-closed)', async () => {
  const { client, state } = fakeClient();
  assert.equal((await runC(client, 'gmail.send', { ...MAIL, to: ['x@gmail.com'] }, true)).errorCode, 'EXTERNAL_RECIPIENT_BLOCKED');
  assert.equal((await runC(client, 'gmail.send', { ...MAIL, to: ['x@gmail.com'], allowExternal: true }, true)).verified, true);
  assert.equal((await runC(client, 'gmail.send', { ...MAIL, subject: 'a\r\nBcc: z@z.com' }, true)).errorCode, 'INVALID_INPUT');
  assert.equal((await runC(client, 'gmail.send', MAIL, true, {})).errorCode, 'ADAPTER_NOT_CONFIGURED');
  assert.equal(state.calls.filter((c) => c === 'gmailDraftSend').length, 1);
});

test('chat.read auto; chat.send gated then posted text re-fetched', async () => {
  const { client, state } = fakeClient();
  assert.equal((await runC(client, 'chat.read', { space: 'spaces/AAA' })).verified, true);
  assert.equal((await runC(client, 'chat.send', { space: 'spaces/AAA', text: 'hi' })).errorCode, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal(state.calls.includes('chatCreate'), false);
  const r = await runC(client, 'chat.send', { space: 'spaces/AAA', text: 'hi' }, true);
  assert.equal(r.verified, true);
  assert.equal((await runC(client, 'chat.send', { space: 'bad', text: 'hi' }, true)).errorCode, 'INVALID_INPUT');
});

test('docs.read auto; docs.write gated, snapshot, readback (append and replace)', async () => {
  const { client, state } = fakeClient();
  assert.equal((await runC(client, 'docs.read', { documentId: SHEET })).text, 'hello\n');
  assert.equal((await runC(client, 'docs.write', { documentId: SHEET, operation: 'append', text: 'X' })).errorCode, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal(state.calls.includes('docsBatchUpdate'), false);
  const a = await runC(client, 'docs.write', { documentId: SHEET, operation: 'append', text: 'World' }, true);
  assert.equal(a.verified, true);
  assert.equal(state.doc, 'helloWorld\n');
  assert.equal(a.evidence.checks.find((c) => c.name === 'revision_changed').passed, true);
  const r = await runC(client, 'docs.write', { documentId: SHEET, operation: 'replace', find: 'World', text: 'Nano' }, true);
  assert.equal(r.verified, true);
  assert.equal(state.doc, 'helloNano\n');
  const bad = await runC(fakeClient({ docsBatchUpdate: async () => {} }).client, 'docs.write', { documentId: SHEET, operation: 'append', text: 'Q' }, true);
  assert.equal(bad.errorCode, 'VERIFICATION_FAILED');
});

test('calendar.read auto; calendar.write gated; create/update verified; delete not offered', async () => {
  const { client, state } = fakeClient();
  assert.equal((await runC(client, 'calendar.read', { calendarId: CAL_ID })).verified, true);
  const ev = { summary: '会議', start: { dateTime: '2026-12-02T10:00:00+09:00' }, end: { dateTime: '2026-12-02T11:00:00+09:00' }, attendees: ['a@cleannano.co.jp'] };
  assert.equal((await runC(client, 'calendar.write', { action: 'create', event: ev })).errorCode, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal(state.calls.includes('calInsert'), false);
  const c = await runC(client, 'calendar.write', { action: 'create', event: ev }, true);
  assert.equal(c.verified, true);
  const u = await runC(client, 'calendar.write', { action: 'update', eventId: 'ev1', event: { summary: '会議2' } }, true);
  assert.equal(u.verified, true);
  assert.ok(u.snapshotId);
  assert.equal((await runC(client, 'calendar.write', { action: 'delete', eventId: 'ev1', event: {} }, true)).errorCode, 'INVALID_INPUT');
  assert.equal((await runC(client, 'calendar.write', { action: 'create', event: { ...ev, attendees: ['z@gmail.com'] } }, true)).errorCode, 'EXTERNAL_RECIPIENT_BLOCKED');
});

test('AppSheet is optional: unconfigured -> fail-closed; configured write is gated, snapshotted and verified; CNKK can select it', async () => {
  const { client, state } = fakeClient();
  assert.equal((await runC(client, 'appsheet.read', { table: 'T' })).errorCode, 'ADAPTER_NOT_CONFIGURED');
  const cfg = { appsheet: { appId: 'app1234567890', accessKey: 'KEY_SECRET_123' }, cnkk: { backend: 'appsheet', appsheetTable: 'CNKK' } };
  const params = { action: 'Edit', keyColumn: 'ID', rows: [{ ID: 'r1', V: 'new' }] };
  assert.equal((await runC(client, 'cnkk.update', params, false, cfg)).errorCode, 'HUMAN_APPROVAL_REQUIRED');
  const r = await runC(client, 'cnkk.update', params, true, cfg);
  assert.equal(r.verified, true);
  assert.ok(r.snapshotId);
  assert.deepEqual(state.rows, [{ ID: 'r1', V: 'new' }]);
  assert.equal(JSON.stringify(r).includes('KEY_SECRET_123'), false);
  assert.equal((await runC(client, 'cnkk.read', {}, false, cfg)).verified, true);
});

test('gemini.status reports owner; gemini.generate is off unless explicitly enabled; google.status reports consent gaps', async () => {
  const st = await g.executeGoogleCapability({ config: {}, providerRegistry: { providers: { gemini: { status: 'BLOCKED' } } } }, { capability: 'gemini.status' });
  assert.equal(st.ownerStatus, 'BLOCKED');
  const { client } = fakeClient();
  assert.equal((await runC(client, 'gemini.generate', { prompt: 'x' })).errorCode, 'ADAPTER_NOT_CONFIGURED');
  const real = g.createGoogleClient({ oauth: { clientId: 'a', clientSecret: 'b', refreshToken: 'c' }, fetchImpl: async (u, init) => {
    const f = Object.fromEntries(new URLSearchParams(init.body));
    return f.scope.includes('gmail.compose') ? { ok: false, status: 400, json: async () => ({}) } : { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) };
  } });
  const s = await g.executeGoogleCapability({ client: real, config: {} }, { capability: 'google.status' });
  assert.ok(s.capabilities.find((c) => c.capability === 'gmail.send').status === 'CONSENT_REQUIRED');
  assert.ok(s.missingScopes.includes('https://www.googleapis.com/auth/gmail.compose'));
  assert.ok(g.consentScopes().length >= 14);
});

test('every capability has least-privilege scopes (no broad mail/drive scope) and a gate for sends/writes', () => {
  const all = g.consentScopes();
  for (const bad of ['mail.google.com', 'auth/drive', 'gmail.modify', 'gmail.send']) assert.equal(all.some((s) => s.endsWith(bad) || s.includes(`/${bad}`) && bad === 'mail.google.com'), false, bad);
  for (const [name, d] of Object.entries(g.CAPABILITIES)) if (!d.readOnly && name !== 'gmail.draft') assert.ok(d.humanGate, name);
});

test('approval is bound to the proposed payload: resume executes the stored proposal, a different payload is refused', async () => {
  const { client, state } = fakeClient();
  const adapters = cnaiRouter.defaultAdapters({ adapters: { googleWorkspace: g.createGoogleWorkspaceAdapter({ client, config: CFG }) } });
  const rs = cnaiRouter.createRouterState();
  const req = { requestType: 'gmail.send', payload: { capability: 'gmail.send', params: MAIL } };
  const blocked = await cnaiRouter.routeRequest(rs, req, adapters);
  assert.equal(blocked.selectedRoute, 'googleWorkspace');
  assert.equal(blocked.executionStatus, 'BLOCKED');
  const hash = blocked.lastDispatchOutput.proposalHash;
  const swapped = await cnaiRouter.resumeRequest(rs, blocked.requestId, { payload: { capability: 'gmail.send', params: { ...MAIL, body: 'EVIL' } }, approvedByHuman: true }, adapters);
  assert.equal(swapped.errorCode, 'APPROVAL_PAYLOAD_MISMATCH');
  assert.equal(state.calls.includes('gmailDraftSend'), false);
  const wrongHash = await cnaiRouter.resumeRequest(rs, blocked.requestId, { approvedByHuman: true, approvedProposalHash: 'f'.repeat(64) }, adapters);
  assert.equal(wrongHash.errorCode, 'APPROVAL_PAYLOAD_MISMATCH');
  const ok = await cnaiRouter.resumeRequest(rs, blocked.requestId, { approvedByHuman: true, approvedProposalHash: hash }, adapters);
  assert.equal(ok.executionStatus, 'COMPLETED');
  assert.equal(ok.lastDispatchOutput.verifier.status, 'PASS');
  assert.equal(state.calls.filter((c) => c === 'gmailDraftSend').length, 1);
});

test('Router auto-selects googleWorkspace from the capability name alone (no hint)', () => {
  for (const name of ['gmail.send', 'chat.read', 'docs.write', 'calendar.read', 'gas.verify', 'appsheet.read', 'cnkk.update', 'gemini.status', 'google.status']) {
    assert.equal(cnaiRouter.classify({ requestType: name }).route, 'googleWorkspace', name);
  }
  assert.equal(cnaiRouter.classify({ requestType: 'q', platformHint: 'gemini' }).route, 'googleWorkspace');
});

test('Copilot entry: reads run, writes are proposals only (never executed), non-gated writes rejected', async () => {
  const entry = require('../src/googleCopilotEntry');
  const { client, state } = fakeClient();
  const adapter = g.createGoogleWorkspaceAdapter({ client, config: CFG });
  const rs = cnaiRouter.createRouterState();
  const call = (input) => entry.handle(input, { adapter, state: rs });
  const read = await call({ requestId: 'r1', capability: 'calendar.read', params: {} });
  assert.equal(read.status, 'COMPLETED');
  assert.equal(read.owner, 'gemini');
  const prop = await call({ requestId: 'r2', capability: 'gmail.send', params: MAIL });
  assert.equal(prop.status, 'BLOCKED');
  assert.equal(prop.approval.required, true);
  assert.equal(prop.approval.summary.subject, MAIL.subject);
  assert.equal(state.calls.includes('gmailDraftCreate'), false);
  assert.equal((await call({ requestId: 'r3', capability: 'gmail.draft', params: MAIL })).errorCode, 'READ_ONLY_VIOLATION');
  assert.equal((await call({ requestId: 'r2', capability: 'gmail.send', params: MAIL })).duplicate, true);
  assert.equal((await call({ requestId: 'r4', capability: 'gmail.send', params: MAIL, approvedByHuman: true })).errorCode, 'INVALID_REQUEST');
  // human approval through the router (authenticated path) executes the stored proposal
  const done = await cnaiRouter.resumeRequest(rs, prop.routerRequestId, { approvedByHuman: true }, { ...cnaiRouter.defaultAdapters(), googleWorkspace: adapter });
  assert.equal(done.executionStatus, 'COMPLETED');
});
