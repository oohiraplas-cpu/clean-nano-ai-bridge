# Registered MCP State Context

`src/stateContext.js` is the single schema and JSDoc type definition. Existing
51 tool names and response fields remain. Additional fields are additive.

## Copilot Studio sequence

1. `health_check({})`, then `get_powerapps_state({})` returns the observed `appId`, `environmentId`, the
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

## Read-only saved-canvas source adapter

`PowerAppsStore.getSourceFile` now delegates to `PowerAppsRuntimeSourceAdapter`.
Configure it only on an approved **test host** first; this PR changes no deployed
host, authentication profile, application settings or Power Apps resource.

The adapter executes only these PAC reads, selecting the exact observed IDs:

```sh
pac canvas list --environment 4d0aab59-43ec-ecf1-a9d1-869f2517adbb
pac canvas download --name f42a9b03-59b9-49d3-a33b-0a210cd3d51e --environment 4d0aab59-43ec-ecf1-a9d1-869f2517adbb --file-name <private-temporary-app.msapp>
```

`canvas list` verifies app membership in the explicitly selected environment;
`canvas download` obtains the **saved** canvas app. This is not the unsaved
Studio editor buffer, and does not guarantee it is the published app version.
Read-only inspection of the downloaded ZIP selects one explicitly mapped
`Src/*.pa.yaml` entry. It never runs pack, unpack, save, publish, import,
permission changes or authentication mutation. A package without modern `Src`
source is unavailable; do not resave the app to manufacture source.

### Prerequisites and configuration

1. A supported PAC CLI with `canvas list` / `canvas download` on the server,
   Python 3, and an already authenticated PAC profile that can **read this app**.
   This adapter does not bootstrap authentication or bypass conditional access.
   Use an isolated service account/profile and a least-privilege app reader.
   Some older installed PAC versions cannot export saved modern source; fail
   closed and upgrade the test-host CLI rather than editing Power Apps.
2. Keep credentials and profile material in a protected Secret Store-backed
   runtime. Do not commit profiles, export archives, tokens, connection details
   or `.env`. Do not put secrets into CLI arguments. Existing Bridge Azure
   credential configuration does **not** automatically authenticate PAC.
   PAC auth capability and export authorization must be confirmed on the host;
   neither extra permission nor cost is assumed by this implementation.
3. Inspect the exported ZIP entry names locally in a protected temporary folder.
   Record the exact `Src/...pa.yaml` entry for the requested screen. The Git path
   uses `Source/` while supported `.msapp` source uses `Src/`; they are not
   interchangeable. Do not guess the package entry or fallback to JSON/fx.yaml.
4. Set non-secret test-host configuration:
   - `POWERAPPS_RUNTIME_SOURCE_ADAPTER=pac`
   - `POWERAPPS_RUNTIME_PYTHON`: Python executable (`python3` on Linux, your
     installed Python executable on Windows).
   - `POWERAPPS_RUNTIME_PAC`: native PAC executable or absolute executable path.
     No shell command, `.cmd` wrapper or arguments in this setting.
   - `POWERAPPS_RUNTIME_SOURCE_MAP`: JSON object mapping
     `powerapps/CN_AI依頼台帳/Source/S1_Home.pa.yaml` to the **observed** exact
     `Src/...pa.yaml` or `Src\\...pa.yaml` archive entry. The entry used in tests is a fixture only.
   - Existing `POWERAPPS_APP_ID`, `POWERAPPS_ENVIRONMENT_ID` and
     `POWERAPPS_GITHUB_BRANCH=main` must identify the selected target.
5. Start the isolated test instance with the normal `npm start`. Do not change
   production settings or deploy to production as part of this verification.

The Python helper receives only app/environment/entry configuration over stdin.
It invokes PAC without a shell, suppresses stdout/stderr diagnostics, and uses
bounded reads (128 MiB archive, 2 MiB source), strict UTF-8 or BOM-tagged UTF-16
and a private temporary directory. It reads one ZIP entry in memory without
extracting paths, rejects missing/duplicate entries, and deletes the archive on
normal completion/failure. A process kill/host failure can leave a temporary
archive: use an isolated encrypted host with OS temporary-directory cleanup.
PAC can cache downloaded/authentication data outside this temporary directory;
protect and clean the service profile through host policy too.

### Integration and result contract

Run **health_check → get_powerapps_state → get_powerapps_source →
validate_powerapps_source → compare_powerapps_with_git**, forwarding the exact
server-returned context and session capability. The existing source tool still
returns the canonical **Git** snapshot and blob SHA; static validation validates
that registered Git snapshot. It is not relabelled as a runtime export.
`compare_powerapps_with_git` obtains the actual saved runtime source itself and
compares it to that same registered Git snapshot, never a client-supplied
runtime string. Git branch/SHA describe the canonical side; the runtime side
has its own SHA-256 content hash, not a fabricated Git SHA.

Before export, the existing State Manager checks the registered full context,
TTL, authenticated/session scope and exact file. The adapter revalidates after
export, and the dispatcher re-reads observed app/environment and Git source to
reject drift during export. It does not create a correlation ID, extend TTL,
reconstruct missing values, add a bypass or alter State Manager rules.

Additive top-level and `data.comparisonStatus` values:

| Value | Meaning |
|---|---|
| `identical` | Normalized source properties match; presentation-only differences are excluded. |
| `changed` | Comparison completed and substantive source properties differ. |
| `source_unavailable` | Unconfigured adapter/map, missing PAC/auth/export or unavailable source; never verified success. |
| `validation_blocked` | Invalid, expired, mismatched, cross-session context, observed drift or invalid/ambiguous YAML. |

`comparisonVerified=true` means both source snapshots were read and compared;
legacy `verified=true` still means matching content only. Legacy `in_sync` /
`diverged` diagnostic status, raw hashes and existing response fields remain.
Unavailable/blocked tools/call returns `isError:true`. The historical missing
reader diagnostic retains `data.status=unconfirmed`, but is now an explicit
error with `comparisonStatus=source_unavailable`, not a successful comparison.

Normalization removes BOM and line-ending differences, comments, YAML quoting
with identical decoded scalar values and mapping-key order. It preserves scalar
types, all formula whitespace and array order (including control order).
Duplicate keys, cycles, excessive complexity and unsupported encodings fail
closed. `changedProperties` contains JSON pointer paths and change kinds;
property values, formulas and line snippets are never returned. `changedLines`
contains actual 1-based line numbers on both sides. For a mixed semantic and
formatting edit, raw line ranges can include formatting noise; this is explicitly
flagged by `lineDiffIncludesPresentation`, while property changes remain semantic.
Line comparison above 2,000 lines per side reports `line_diff_limit`; property
comparison remains available and is capped at 500 changes with a truncation flag.

### Evidence boundaries

Local regression and HTTP MCP integration tests use controlled app/Git/PAC
fixtures. They prove executable integration and rejection paths, **not** real
Power Apps export authorization. The current workspace has no PAC or .NET and
no authenticated PAC profile. The connected production Bridge also exposes the
previous schemas and lacks the PR's registered-context response. It cannot run
this adapter until an approved test instance with PAC/profile/observed entry is
provided. No real saved-source comparison, Copilot UI success, production
installation or deployment is claimed by these fixture tests.

Official references:
- https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/canvas
- https://learn.microsoft.com/en-us/power-apps/maker/canvas-apps/power-apps-yaml

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

## Registered Git structure inspection

`inspect_powerapps_structure` preserves its existing configured-app metadata
mode. An explicitly supplied `appId` must match the observed app. For canonical
Git analysis, pass the complete server-returned `stateContext` and
`stateSessionId`, optionally the registered `relativePath` and matching `appId`.
The server reads the registered Git snapshot itself; this endpoint does not
accept caller-authored source content or source-origin labels. Registration,
TTL, session, live app/environment and Git identity checks apply before analysis.
Returned `sourceOrigin=github_canonical` describes Git analysis only, not a
saved-source export or runtime comparison. Modern `Children` entries and nested
controls are traversed; malformed YAML, duplicate keys and cyclic structures
fail rather than produce verified partial analysis.


### Backup evidence reuse

The existing manual CN_AI依頼台帳 backup workflow now records exact observed
archive entry names for both slash conventions, rejecting ambiguous/traversing
entries. This manifest can support mapping review, but explicitly records
appIdParityVerified=false and savedSourceComparisonVerified=false. Solution
export success or its display-name check must not be substituted for PAC canvas
list/download authorization, current app ID parity, registered-context comparison
or Copilot Studio verification. Authentication/configuration and production
release are not changed by this compatibility patch.
