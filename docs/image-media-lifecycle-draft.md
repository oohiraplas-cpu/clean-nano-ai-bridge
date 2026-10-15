# Image/media lifecycle (Draft-only, no production mutations)

## Existing capabilities
- `get_powerapps_media_asset`: Git-backed image read/export/list; `list` requires 1–50 explicit `relativePaths` (empty list is rejected).
- `update_powerapps_image`: adds/edits an image control on an existing screen; PNG/JPEG/GIF/WebP, <= 1 MiB. This is a Git/source change, **not** a Power Apps save or publish.
- Existing save/publish tools and `productionEvidenceGateDraft` must be reused, never bypassed.

## Proposed gated lifecycle
1. Read target app/environment, screen source and current blob SHA; verify registered StateRegistry session and authorized identity. Do not create a new app.
2. Produce or edit image **outside** Bridge with an explicitly connected, authorized image service or local editor. No assumption that image generation is covered by Microsoft 365 or free of API charges.
3. Validate MIME using decoded bytes, image size and dimensions, accessibility label, filename/path, and rights/licensing. Reject unsupported, over-limit, or untrusted content.
4. Create immutable preview/staging artifact and SHA-256 digest; never claim a source-derived mockup is a real device screenshot. Require iPhone layout verification.
5. Capture backup and expected Git blob SHA; request human approval tied to target, digest, plan hash, and one-time execution ID. Do not reuse approval from an earlier version.
6. Apply the minimal image-control change **only** to the authorized Draft and re-read the source. Detect concurrent changes and stop on mismatch.
7. Verify App Checker, save operation, SharePoint durable approval ETag reservation, independent PAC source, deployed SHA and published artifact/version **before** any production publish. If any check is unavailable, return BLOCKED; no automatic fallback to Git-only evidence.
8. After a separately authorized production operation, independently re-read published artifact/version. On failure, halt and offer a separately approved restore from the captured backup.

## Non-destructive storage and preview
- Existing SharePoint library/list IDs and field internal names must be discovered and independently verified before use. Do not create or overwrite a library or list automatically.
- Draft may hold image metadata (target, source digest, output digest, preview digest, author, approval status, timestamps); no secrets, credentials or image bytes in audit logs.
- Rollback must reference an independently verified backup, with a human approval and precondition check.

## Acceptance checks
- No approval / missing PAC / missing Azure SHA / missing SharePoint ETag => BLOCKED.
- Commit SHA and blob SHA are never interchanged.
- Wrong app, screen, session, digest, content type, or changed HEAD => BLOCKED.
- Git image update does not imply saved or published.
- No paid image-generation API is called without separate authorization.
- No existing assets are deleted, renamed or overwritten; no main merge or production changes.

Status: **Design only**. No image-generation service, live SharePoint versioning, real screenshot, PAC runtime, or production publication has been verified.
