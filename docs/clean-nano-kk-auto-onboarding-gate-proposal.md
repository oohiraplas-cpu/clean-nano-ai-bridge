# clean nano kk — auto-approved My Data onboarding gate (design only)

Status: PROPOSAL / NOT DEPLOYED. This file is not a Power Apps source modification.

## Preconditions and blockers
- Confirm the authoritative, admin-only override store and its SharePoint list-level ACL. BLOCKED.
- Confirm a unique UPN/person key, duplicate handling and delegated query limits. BLOCKED.
- Confirm registration persisted and read-back matches the authenticated user. BLOCKED.
- Existing S5 salary and S11 report save/submit logic must not be changed.
- Do not interpret UserType/EmploymentType/Role self-entry as privileged authorization.
- Do not use a client-side global alone as a security boundary; SharePoint ACL must independently enforce access.

## Proposed minimum Power Fx integration points (not executable until prerequisites PASS)
1. App startup / S1_Home.OnVisible: reset any prior user's cached registration state; verify Entra identity; query only the authenticated person's registration through a validated unique key; on missing registration navigate to S8; on query error, duplicates or mismatch deny.
2. S8_UserOnboarding: bind immutable UserUPN to Lower(Trim(User().Email)); require agreed mandatory fields; reject user-controlled admin status. Keep submission through existing Form3.
3. S9_UserConfirm: recheck duplicate/mismatch; SubmitForm(Form3) only when Form3.Valid and no conflict; fail closed on errors.
4. Form3.OnSuccess: treat the callback as a save signal, but require a fresh, uniquely matched read-back and verified administrator override status before marking BASIC approved; navigate to S10 only after verification. OnFailure: stay in registration.
5. S10_RegistrationComplete: show auto-approved basic state or an explicit verification error. Navigation to S1 only when the read-back gate passes.
6. S2/S3/S4/S5/S7/S11 OnVisible: require verified basic registration and no verified suspension/revocation before executing existing data retrieval or other OnVisible effects; on failure redirect to S8 or a restricted status screen.
7. Every navigation into other screens must be protected by the same shared gate. This is defense in depth, not a substitute for data source ACL.
8. Admin-only override must be stored in a non-user-editable, audited source. A verified suspension/revocation always takes precedence over auto approval. Never let an unverified/failed override lookup silently mean no override.

## Access decisions
- Unknown identity, failed query, duplicate record, unverified override: DENY.
- Verified identity, no registration: ONBOARDING_ONLY.
- Form incomplete or save/read-back not verified: ONBOARDING_ONLY.
- Verified saved registration and verified no blocking override: BASIC_ONLY.
- Privileged features: separately authorized, never granted by registration alone.
- Verified admin suspension/revocation: DENY.

## Regression and release gate
- Run test/onboardingRegistrationGateContract.test.js.
- Validate every target screen (S1/S2/S3/S4/S5/S7/S8/S9/S10/S11) and all navigation paths.
- Obtain App Checker 0 critical issues, actual iPhone UI evidence, read-back, and rollback verification.
- Do not merge main, save/publish Power Apps, change ACL or incur charges until separately authorized and prerequisites PASS.
