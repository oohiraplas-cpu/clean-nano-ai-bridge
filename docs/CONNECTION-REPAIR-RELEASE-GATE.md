# PR #263 — Release safety, audit and recovery gate

## Verified scope
- Read-only connection diagnostics and Microsoft/Azure probe adapter interface.
- Explicit scoped approval validation, fail-closed unknown action/identity/expiry.
- Transactional store interface with compare-and-swap, tested using a mock store.
- No live Azure/Microsoft 365 mutation, no secret rotation, no production endpoint wired.

## Release checklist (all required for COMPLETE)
1. Identify production app, runtime SHA, environment and owner. Capture current configuration metadata, excluding secrets.
2. Confirm existing Microsoft Graph/Entra OAuth or managed identity permissions with least privilege. No premium licenses or new resources.
3. Select an existing durable transactional store, confirm actual schema, permissions and atomic conditional update. Do not use the process-local Map for production approvals.
4. Bind pending approval to authenticated principal and exact service/action/target/expiry; atomically consume once.
5. Implement provider-native secure repair with snapshot, dry-run, verify and rollback. Do not log or return secret values.
6. Independent normal/abnormal tests: 401/403, expired approval, replay, concurrency, provider timeout, failed rollback, missing permission and secrets masking.
7. Confirm live E2E and read-back, audit log, recovery rehearsal, production SHA and zero unexpected costs.
8. Only then request a single scoped release approval and deploy.

## Recovery
- Before change: capture last known good commit, deployment ID, configuration names (never values), permissions and relevant resource identifiers.
- If deployment validation fails: stop writes; restore the last known good deployment through existing deployment pipeline, verify health, and record audit evidence.
- If credential rotation fails: keep the old credential active until replacement is independently verified; never revoke first. Revoke only after explicit approval and verification.
- If approval store is unavailable or CAS fails: fail closed, do not execute privileged writes. Resume from checkpoint after store recovery.
- If rollback cannot be independently verified: mark BLOCKED and escalate a single concrete human action.

## Status
Code/CI may pass while provider integration remains BLOCKED. No production publication or auto-rotation is authorized by this document.

## Independent source audit findings (2026-11-17)
- connectionRepairOrchestrator accepts request-supplied approved and approvalScope. This is not authenticated production approval. Never connect production mutation to these flags.
- durableConnectionApproval uses an injected CAS interface, not a real store or authenticated identity attestation. Target binding and actual secure write are absent.
- connectionProviderAdapters uses injected probes, not provider-native live API clients. HTTP 200 alone is not PASS without authorized operation. Probe timeouts now fail closed.
- These are release blockers even when CI passes.

## Authenticated approval boundary update
- authenticatedConnectionApproval accepts only a principal returned by injected trusted auth middleware, not a request-supplied subject ID. It requires verified=true, nonempty issuer, tenantId and subjectId. Unit tests cover spoofing, auth errors and fail-closed behavior.
- IMPORTANT: no actual Entra token validation or trusted middleware is wired here. The injected resolver must independently validate token signature, issuer, audience, tenant, expiry and session before setting verified=true. Do not treat an arbitrary resolver or boolean as proof of identity.
- Production release remains BLOCKED pending trusted auth middleware, real transactional store, and verified provider-specific adapters.

## Existing asset reuse investigation
- Existing src/recoveryOAuth.js validates Entra JWT RS256 signature against Microsoft signing keys, issuer, audience, tenant, client, fixed user, scope and expiry. Added verifiedPrincipal() that returns identity only after authorized(token) passes. Added read-only recoveryPrincipalResolver and negative tests.
- Existing src/approvalLedger.js is SharePoint READ-ONLY approval verification, and src/sharePointTaskStore.js uses Graph client credentials. Neither provides a production atomic approval compare-and-swap; do not repurpose either as durable single-use store without validated list schema, ETag concurrency, permissions and authenticated identity binding.
- New resolver is not mounted in production Express middleware; trustedMiddleware flag is an integration contract, not proof by itself. It must only be set by server-owned middleware after secure bearer extraction. Do not accept this flag from HTTP request JSON.
- Existing recovery auth is scoped to a fixed user and mcp.access. Do not broaden to other users/scopes without explicit permission and test.

## SharePoint ETag CAS adapter (isolated, not deployed)
- sharePointApprovalCasStore requires explicit verified fieldMap and injected fetchItem/patchItem. Conditional PATCH must be implemented with SharePoint If-Match header; HTTP 409/412 is treated as a lost race, other failures fail closed. Mock concurrency tests are present.
- Existing approvalLedger is read-only and cannot be assumed to contain the required fields. No production list schema or unique RequestId constraint was verified; do not wire adapter until those are checked.
- ETag CAS prevents concurrent updates to one item, but duplicate rows with the same requestId require a unique constraint or an explicit duplicate-detection fail-closed fetchItem implementation.
- The adapter has no production Graph HTTP implementation, verified authenticated principal binding, or rollback-capable repair adapter. CI success is not live E2E.

## Graph transport implementation and live schema blocker
- src/graphApprovalTransport.js is an injected Microsoft Graph transport for GET with escaped OData requestId filter, strict duplicate/nextLink rejection, and PATCH with If-Match ETag; no production endpoint or token configured. Test mocks only.
- Live approval list site hostname/path, list GUID, internal column names, indexed unique requestId constraint, and ETag behavior have not been verified. SharePoint connector needs a concrete site path to enumerate lists. Existing src/approvalLedger.js only has a configurable fieldMap, not an actual site reference.
- The transport's fetchItem/patchItem must be wired only after live read-only schema inspection and a dedicated approval list is confirmed. Graph permissions and actual conditional-write E2E remain BLOCKED.

## Priority change: Power Apps and Power Automate
- SharePoint approval-store discovery and Graph ETag integration are DEFERRED; prior branch files are retained but not deployed or invoked.
- src/powerPlatformReadOnlyAdapter.js uses only an injected existing Dataverse client.get for Power Apps canvasapps and Power Automate workflows read-only probes and GUID-scoped inspection. No token or sensitive response is exposed. Fail-closed tests cover missing client, malformed response, invalid IDs, authorization errors and timeouts.
- Live Bridge MAX health_check, get_bridge_capabilities, check_dependencies each returned UNAUTHORIZED during this work. No successful live Microsoft Power Apps/Automate access is claimed; CI with mocked clients is not E2E.
- Existing src/powerAppsSolutionWriter.js and src/powerAutomateFlowWriter.js contain potentially mutating import/patch/publish operations. They remain unmodified and MUST NOT be called without approved change gate, backup, verified target, and rollback.
- The adapter is not mounted on a production route. Real credentials/Dataverse access, independently verified identity, and safe integration remain BLOCKED.

## Power Platform authentication preflight
- src/powerPlatformAuthPreflight.js checks only presence of existing POWERAPPS_* / AZURE_* configuration and the Dataverse org URL shape, without disclosing credentials or attempting login. It returns PARTIAL even when configured, never PASS.
- This does not fix Bridge MAX UNAUTHORIZED; actual tenant permissions, client secret validity, token issuance, environment access and authorized Dataverse GET must be verified via trusted existing connection.
- No production writes, app publishes, flow executions, or external releases were performed.

## Power Platform Dataverse GET transport
- src/dataverseReadOnlyClient.js reuses the existing Power Apps/Automate Entra tenant/client/secret configuration, with strict HTTPS Dataverse org allowlist, client-credentials token cache and fixed read-only OData paths. It never imports the mutating solution/flow writers. POST is used only for Entra token acquisition; Dataverse requests are GET only.
- Tests use fake token and Dataverse responses; they verify GET-only behavior, token reuse, path rejection and 401 fail-closed. They do NOT prove the real Entra app has Dataverse access or that the actual org URL is configured.
- No production route was registered, no credential was rotated, no live Microsoft authentication succeeded, no app/flow was edited or published. Release BLOCKED pending real authorized read-only probe, least-privilege permissions audit and E2E.

## Authentication path mismatch audit (read-only)
- The Bridge MCP key authorization and the Power Platform Entra client-credentials Dataverse authorization are distinct trust boundaries. Bridge UNAUTHORIZED cannot be fixed merely by a successful Dataverse token, and no credentials were changed.
- The existing config.js provides a default Dataverse org URL even if POWERAPPS_ORG_URL is absent; this default is not evidence that the deployment is configured or authorized. The preflight now requires an explicit verified-shape Dataverse URL, valid tenant/client GUIDs, and existing credentials. It returns PARTIAL at best until a real authorized GET succeeds.
- recoveryOAuth.js validates a separate /recovery/mcp Entra JWT with strict audience/client/scope/user; it is not the Bridge MAX /mcp API-key path. Do not substitute those credentials or relax verification to bypass 401.
- This is a static code-level diagnosis, not proof of the actual production cause. No runtime environment values were inspected and no live Dataverse GET succeeded.

## Bridge MAX 401 static root-cause candidates
- src/server.js apiKeyMiddleware(getKey) accepts x-api-key, Authorization Bearer, and query api_key/x-api-key. It uses timingSafeEqual, but if the configured key is absent it calls next(), an insecure fail-open behavior. This is a code-level finding, NOT proof of which key is configured in Azure or the root cause of current 401.
- Bridge main MCP_API_KEY and connector CONNECTOR_API_KEY are separate from Dataverse POWERAPPS_*/AZURE_* Entra credentials and from recoveryOAuth /recovery/mcp. A token issued for Dataverse must not be accepted as a Bridge API key.
- Added src/bridgeAuthConfigDiagnostic.js with mocked independent tests to report missing key names only; never returns values and never claims real authentication success. Actual deployed settings, key mismatch, plugin credential transport and upstream Azure authentication remain unverified.
- No runtime server authentication middleware was changed, since changing the existing production security boundary without isolated E2E would be unsafe. A separate tested fail-closed migration and authorized release gate are needed.

## Correction after route-level inspection
- Previous note describing a Bridge authentication fail-open risk was incomplete: although the shared apiKeyMiddleware calls next() for an absent key, src/server.js wraps /mcp with mcpAuth (503 on missing MCP_API_KEY), /connector/mcp with connectorAuth (404 on missing CONNECTOR_API_KEY), and webhook with its own fail-closed guard. The examined MCP routes therefore already fail closed. Do NOT weaken or redundantly change production auth middleware based on the helper alone.
- Added test/bridgeMcpAuthRouteContract.test.js to protect those route-level fail-closed contracts against regression. This is a static regression check, not a live HTTP E2E test. Existing 401 remains unproven as to cause; likely candidates include credential mismatch, connector configuration, and upstream authentication, none confirmed.

## 2026-11-17 auth mismatch classification
- CI #2227 passed for prior static fail-closed route checks. Added a separate, non-executing classifier and independent tests for Bridge API-key versus Dataverse Entra client-credentials transport mismatch, 401/403/404/503 and HTTP 200 not being proof of authorized operation.
- No credential settings, production middleware, deployment or external connections were modified. Current Bridge 401 root cause remains unverified; source code inspection alone cannot distinguish wrong key from upstream auth. Real Dataverse GET remains blocked until a trusted authorized connection is available.

## Bridge 401 routing and transport audit
- server.js supports x-api-key, Authorization Bearer containing the configured API key, or query api_key for /mcp and /connector/mcp; those paths have different configured secrets. A Microsoft Entra JWT is not automatically a valid Bridge API key. /recovery/mcp is separately protected by verified Entra JWT when recovery OAuth is configured.
- Added static path/auth contract inspector and independent tests; all outcomes are PARTIAL or BLOCKED until real authenticated call. The GET /mcp endpoint intentionally returns 405 after authentication, so GET success is not a valid MCP E2E probe. POST tools/list or tools/call is required.
- Azure App Service Easy Auth and deployed environment values cannot be inferred from repository source. An upstream 401 before Express remains possible. Do not bypass upstream authentication or log credentials.
- Power Apps/Automate Dataverse GET adapter remains isolated from Bridge MCP API key; its mock tests do not establish real Dataverse permissions.

## Current live connection gate
- CI #2239 passed prior code. Live Bridge MAX health_check and get_bridge_capabilities, and legacy Bridge health_check were attempted and each returned UNAUTHORIZED. No live Dataverse GET could be issued through those authenticated connectors.
- Added independent fake-provider tests for Dataverse 401/403, HTTP redirect and invalid token response, preserving fail-closed behavior. The latest CI for this new commit must complete before marking these tests PASS.
- Azure Easy Auth state, real MCP plugin credentials and Dataverse app-user permissions are not visible through the available authorized channel. No production changes or credential rotation were made.
