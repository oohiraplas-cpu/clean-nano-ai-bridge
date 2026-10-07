# Registered MCP State Context

`src/stateContext.js` is the single schema and JSDoc type definition. Existing
51 tool names and response fields remain. Additional fields are additive.

## Copilot Studio sequence

1. `get_powerapps_state({})` returns the observed `appId`, `environmentId`, the
   existing `operationId`, and a new UUID `correlationId`. It returns a partial
   `stateContext`, a random `stateSessionId`, and `stateContextExpiresAt`.
2. Pass its `correlationId` and `stateSessionId` to `get_powerapps_source`, along
   with the explicitly selected `relativePath`. The observed source completes
   `stateContext`. Do not synthesize missing fields or use `operationId` as a
   correlation ID.
3. Pass the returned **entire** `stateContext` and `stateSessionId` to
   `validate_powerapps_source` and `compare_powerapps_with_git`. Keep the same
   MCP transport session header if the client uses one.
4. Optional `relativePath` / `targetFile` must equal the requested or resolved
   path. `expectedBranch` must equal the observed branch and `targetApp` must
   equal the observed app. Omitted source content is loaded from the registered
   snapshot; supplied source content must exactly match that snapshot.

Successful static validation adds `validationStatus: "VALID"` while preserving
the existing `status`, `verified`, `data`, warnings and errors. It establishes
static validity only, not Power Apps runtime functional correctness.

## Identity, lifetime and reuse

- The server generates correlation and execution-session UUIDs independently
  from operation IDs. Client-created correlation IDs cannot be registered.
- Records bind app, environment, branch, canonical branch, **file blob SHA**,
  resolved path, content digest, authenticated credential scope, and the MCP
  transport session (when supplied).
- SHA is the Git contents API blob SHA, not a branch HEAD commit SHA. For example,
  a value copied from the file response cannot be used as a branch base commit.
- Default TTL: 300,000 ms from initial state acquisition; source retrieval and
  reuse never extend it. `STATE_CONTEXT_TTL_MS` configures it.
- Default capacity: 1,000 live records (`STATE_CONTEXT_MAX_ENTRIES`). Expired
  records are pruned on registration; full capacity fails closed.
- Reuse is allowed for repeated source reads and validation/comparison only
  within the same execution session, TTL, target file and exact observed tuple.
  A new file, app, environment, branch or SHA requires a new state acquisition.
- Missing/expired/unregistered contexts, changed live state and cross-session
  use fail closed with field-specific `failures`. Both JSON-RPC tools/call,
  direct method aliases and legacy requests use the registered validation.
- Validation/comparison always require registration, even when the historical
  write-enforcement toggle is off. Other write/save/publish/permission gates and
  human approval requirements are unchanged.
- Stateless clients must forward `stateSessionId` explicitly. It is a bearer
  execution capability, not proof of a human identity or a replacement for MCP
  authentication. Do not share it or reuse it across conversations.

## Availability and backwards compatibility

The registry is process-local. App restart or a request routed to another
instance fails closed; reacquire state. A multi-instance production installation
needs session affinity or an independently reviewed shared-registry adapter.
No context is reconstructed from caller-supplied values. This patch does not
change Azure settings or introduce a persistence service.

Standalone source reads attempt to establish their own observed app state. With
enforcement disabled, historical source reads still return source if app state
cannot be acquired; they explicitly return `stateContextComplete: false` and
cannot authorize the guarded tools. Production-enforced reads fail closed if
the app state or full source identity cannot be observed.

## Comparison limitation in the current production adapter

The existing `PowerAppsStore` has no `getSourceFile` runtime-source reader.
Therefore it cannot prove runtime-vs-Git equality. The comparison response now
reports `status: warning`, `verified: false`, `data.status: unconfirmed`,
`data.hasDifferences: null`, the target blob SHA and comparison sources when the
reader is absent. A Git snapshot is never relabelled as runtime Power Apps
content. Injected real runtime readers can return an actual boolean difference;
matching/different content paths are tested. Adding a supported runtime source
reader is a separate prerequisite for a verified production comparison.

## Validation

Run `npm test`. The contract tests exercise public schemas, acquisition,
validation, comparison, all missing/mismatched fields, TTL, session isolation,
live drift, content/path consistency, and alternate transports.

After deploying to a test endpoint, run the integration probe:

```sh
BRIDGE_MCP_URL=https://<test-host>/mcp node scripts/verify-state-context-contract.js
```

Provide `BRIDGE_MCP_API_KEY` only via Secret Store/environment when required.
The probe is read-only and prints metadata/verification results, never source
content, keys or execution-session capabilities. Copilot Studio must refresh
its MCP tool discovery after deployment; a local probe does not verify the
Copilot Studio UI or cached schema.
