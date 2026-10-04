# Dependency review for PR #48

The immutable Git source contains 13 files / 230,766 bytes, 3,398 formulas, 11 screens and 280 controls. There are 12 direct Navigate edges and five Back invocations whose destinations depend on session history. All 3,398 formulas were classified; none were skipped. Missing required source definitions: zero. This is static classification, not Power Fx compilation or live binding verification.

`powerapps-dependency-inventory.json` records source hashes, every unverified occurrence (1,484 occurrences in 90 category/target groups), source symbol declarations, and the recovery decision. Each occurrence retains its file, owner, property and token position, plus any inferred-scope evidence. Counts are occurrences, not unique services. The inventory contains no source or expression bodies.

## Corrected false positives and omissions

The previous name-only detector treated valid built-in functions/namespaces, Set/ClearCollect declarations, screen-local UpdateContext variables, Navigate destination context, With keys, As aliases and DataSourceInfo column arguments as missing global symbols. The binder now resolves source declarations before reads and applies their actual scopes. Global disambiguation `[@name]` bypasses local/context shadowing. Record fields and qualified property accesses remain unverified rather than being invented as globals. CR comments, scientific numeric literals and UTF-8 BOM preservation are covered by regressions. Empty exported `=` properties are recorded as unset, not missing names. Interpolation and unsupported syntax block source recovery rather than disappearing during tokenization.

Deleting a previously known source entity or variable cannot disguise it as an external binding or row field. Missing targets, malformed declarations, missing EditorState screen references and syntax findings still block snapshots. Secret scanning runs on raw files and decoded documents, covering escaped YAML/JSON expressions and short literal credential assignments.

## External dependencies with source evidence

| Dependency | Evidence location | Recorded result |
| --- | --- | --- |
| CN_AI_Bridge | App.pa.yaml / App / OnStart | Connector call binding unverified |
| Office365Outlook | Screen3.pa.yaml / iconMail1 / OnSelect | Connector call binding unverified |
| Office365ユーザー | Screen3.pa.yaml / PeopleBrowseGallery1 / Items | Connector call binding unverified |
| Office365Outlook_1 | Screen4.pa.yaml / dropdownCalendarSelection1 / Items | Connector call binding unverified |
| Office365Outlook_2 | Screen6.pa.yaml / dropdownCalendarSelection2 / Items | Connector call binding unverified |
| CN_電子日報台帳 | Screen2.pa.yaml / 現場名_DataCard1 / MaxLength (DataSourceInfo argument) | Data source and columns unverified |
| CN_勤怠明細台帳 | scr.pa.yaml / 原入力_DataCard1 / MaxLength (DataSourceInfo argument) | Data source and columns unverified |
| PowerAppsTheme | App.pa.yaml / App / Theme | Theme payload/binding unverified |
| 524373353 | Home.pa.yaml / ホーム / BackgroundImage | Image payload/binding unverified |
| SampleImage | Screen1.pa.yaml / TutorialNavigator1 / Items | Runtime resource binding unverified |

The captured Source tree has no connector definitions, connection references, external table schemas/data or image/theme binaries. These artifacts are absent from the captured bundle; the source does not prove that any live dependency is absent or broken. No external configuration is guessed or recreated. Qualified member values, item projections, row fields, ThisItem/ThisRecord and Back history likewise require a runtime/schema/session to verify.

## Recovery decision

Only `source_files_only` recovery is accepted: restore the exact captured file bytes to an already configured application's source working tree. No app import, connector provisioning, runtime state restoration or external-system write is performed. External artifacts and transient state are unnecessary for this bounded file operation, so their evidence is retained as explicit exclusions instead of blocking the archive. If an internal source definition is missing or analysis is incomplete, safe stop remains mandatory.

Snapshots are format v2 canonical SHA-256 envelopes with per-file hashes and byte counts, completeness receipts, atomic no-replace publication, private permissions, idempotency and verification on reuse. The local validation script checks all 13 before/after files byte for byte, repeated creation, tampered copies and invalid manifests even when the envelope hash is recomputed. Archives stay Git-ignored. Source restoration is verified; application recovery remains `not_verified` and structure/impact status remains `incomplete`.
