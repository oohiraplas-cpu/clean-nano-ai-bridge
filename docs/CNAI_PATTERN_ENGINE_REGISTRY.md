# CNAI Pattern Engine Registry

Reusable Fail-Closed validation patterns.

| Pattern | Input | Expected |
|---|---|---|
| Missing State | required state field absent | Reject before write |
| Invalid SHA | SHA not 40 lowercase hex chars | Reject before write |
| Branch Mismatch | branch != canonicalBranch | Reject before write |
| Valid State | all required fields valid and branch canonical | Allow policy evaluation/execution |
| Read Only | non-write MCP tool | State write gate not required |

## Promotion rule
A pattern becomes a standard successful execution pattern only after automated test evidence and, where applicable, real-environment verification.

## Anti-repeat
When a pattern fails, identify the changed cause/input/permission/connection/state before retrying. Never repeat an identical failed write.
