# CNAI Memory Engine Registry

Purpose: retain reusable, verified execution state without converting assumptions into facts.

## State memory schema
- appId
- environment
- branch
- canonicalBranch
- sha
- validationPattern
- successfulPath
- correlationId

## Rules
1. Real-environment evidence overrides stored memory.
2. appId/environment/branch/canonicalBranch/sha are snapshots, not permanent constants.
3. Never promote an unverified path to successfulPath.
4. Never store Secret, Token, Passkey, credentials, or raw authentication material.
5. Before every write, State Manager must re-fetch/revalidate current state.
6. Correlation IDs use the existing State Manager generator: `aid-<timestamp>-<randomhex>`.
7. A failed or stale state is retained only as audit evidence, never as a write authority.

## Current verified reusable pattern
`health_check -> resolve target/state -> lock canonical branch/SHA -> write -> re-read -> runtime verify -> audit`

The exact runtime SHA is recorded only after production deployment evidence confirms it.
