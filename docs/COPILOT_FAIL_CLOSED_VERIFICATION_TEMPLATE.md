# Copilot -> Bridge Fail-Closed Verification Template

Preparation only. Do not execute until the production deployment has completed and runtime state is re-read.

1. `health_check`
2. Retrieve the available Bridge tools / capabilities.
3. Resolve/re-read Power Apps target and current state.
4. Capture appId, environment, branch, canonicalBranch, current SHA and a new correlationId.
5. Negative test: invoke a harmless write validation path with Missing State and confirm rejection before any mutation.
6. Negative test: Invalid SHA -> reject.
7. Negative test: Branch Mismatch -> reject.
8. Positive State Gate test with valid state context. Do not mutate production data solely for testing.
9. For an already-approved real change only: save.
10. Re-read and verify runtime/state.
11. Record evidence under the same correlationId.

Stop immediately on state contradiction, unexpected permission expansion, secret exposure, or unverified target.
