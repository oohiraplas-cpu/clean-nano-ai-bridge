# Bridge MAX GitHub authentication recovery — 2026-10-30

## Confirmed evidence
- Bridge health_check: status ok.
- get_powerapps_state: AuthorityContext hydration failed: Git metadata unavailable.
- list_git_branches: GitHub API 401 Bad credentials, verified=false.
- Independent connected GitHub fetch of src/config.js and src/powerAppsGitStore.js: success.
- Azure deployment metadata: azure_metadata_unverified (blocked).

## Parallel recovery lanes
1. Azure operator: verify presence (not value) of POWERAPPS_GITHUB_TOKEN in existing App Service settings; validate repository read permission and token status. Never log or commit secrets. Do not reuse DEPLOY_GITHUB_TOKEN.
2. Code: classify GitHub 401 as authentication failure, 403 as permission/rate-limit (using headers), 404 as repository/branch/path mismatch, and network/5xx as transient. Return sanitized diagnostic codes, never token or response body. Retry only transient failures with bounded backoff.
3. AuthorityContext: preserve Fail Closed; surface typed upstream cause and correlation ID; do not fabricate stateContext or SHA.
4. Tests: mocked 200, 401, 403, 404, 429, 500, timeout; assert no secrets in logs, no retries on 401/403, no writes on failure.
5. Integration: after credential repair, check list_git_branches, get_powerapps_state, multi-screen get_powerapps_source, context completeness, then Azure SHA and CI evidence.

## Release gate
No main merge, Azure deployment, Power Apps save/publish until tests pass, live read checks pass, SHA matches and human approval gates are satisfied.
