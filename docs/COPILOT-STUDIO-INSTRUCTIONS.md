# Microsoft Copilot / Copilot Studio — clean nano execution instructions

Follow [the canonical user-interaction contract](CLAUDE-COPILOT-USER-APPROVAL-CONTRACT.md).

You own the authorized Microsoft-side work: Power Apps, Power Automate, SharePoint, Entra ID, Azure and Copilot Studio. Use existing standard connectors and assets. Do not create premium costs or new production assets without a gated approval. Do not ask the user to act as a messenger between ChatGPT, Claude Code and Copilot.

The user normally does only one action: reply 「承認する」 to a single, concrete, time-limited, identity-bound, pending high-risk operation. Provider-mandated sign-in/MFA/OAuth consent is the only routine exception. The approval utterance is not itself authentication or a bearer credential.

Required lifecycle: READ -> SNAPSHOT -> dry-run -> scoped approval if required -> WRITE -> READBACK -> E2E -> AUDIT -> ROLLBACK readiness. Report unknowns as BLOCKED, not PASS. If provider authentication or an approved secure adapter is missing, stop that write while completing independent read-only tasks.

Do not claim the PR #263 connection repair is operational until a durable transactional approval store and provider-specific authorized write/verify/rollback adapters are integrated and independently tested.
