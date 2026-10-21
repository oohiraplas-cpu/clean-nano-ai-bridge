# Subcontractor invoice: isolated static design (2026-10-22)

Status: DESIGN ONLY; NO runtime integration, SharePoint mutations, Power Apps save/publish, main merge, or premium connector.

## Verified READ sources
- CN_取引先台帳: PartnerKey, PartnerType (協力会社), IsActive, RecordStatus.
- CN_人工明細台帳: LaborKey, DailyReportKey, EmployeeRecordKey, ConfirmedLabor, RecordStatus (Confirmed).
- CN_請求台帳: InvoiceKey, CorrelationId; no verified monetary or invoice-line columns.
- CN_社員台帳: EmployeeID, EntraObjectId; no verified PartnerKey relationship.
- Existing electronic report Screen3.pa.yaml calls PDF(Screen2,{ExpandContainers:true}) as an Outlook email attachment; not evidence of invoice storage.
- src/powerAutomateRunner.js requires configured POWER_AUTOMATE_FLOWS; invoice flow not verified.

## Required inputs (do not infer or default)
Authenticated personal user; verified PartnerKey membership; active subcontractor; verified immutable roster of registered active workers at invoice issue time; authorized confidential partner-specific tax-exclusive unit rate with effective date; confirmed labor lines with unique LaborKey; invoice period; applicable tax rules; confirmed invoice storage mechanism.

## Fail closed
Reject if any identity, membership, partner, unit-rate source, labor confirmation, invoice uniqueness, tax rules, storage permission or PDF persistence is unavailable. Never use employee salary fields as subcontractor rate. Never send price records to unauthorized users.

## Invoice calculation and presentation
Only labor rows with RecordStatus=Confirmed, valid nonnegative ConfirmedLabor, and verified partner membership.
Tax-exclusive subtotal = sum(ConfirmedLabor * applicable partner rate), using decimal currency arithmetic.
Apply verified tax rate and explicit rounding policy; never silently assume rate or rounding.
Registered active workers == 1: PDF includes tax-exclusive unit rate.
Registered active workers >= 2: PDF entirely omits unit-rate column and all per-worker unit rates, including metadata/alt text; display headcount, total labor, subtotal, tax, total.
Registered active workers == 0 or unknown: reject.
The rule is based on registered active worker count, not number of rows in the invoice.
Never infer a unit rate from a total or reverse-calculate it for display.

## Duplicate protection
A server-side atomic reservation/uniqueness constraint is required for (PartnerKey, LaborKey, invoice status) before saving/submitting; check existing invoice lines, not just InvoiceKey. Concurrent submissions must not double bill. Retry must be idempotent by stable request ID. Canceled/reissued invoices require explicit audited linkage.

## Lifecycle
Draft -> preview -> save -> submit -> company approval. A PDF preview is not proof of successful persisted PDF or invoice record. Preserve immutable snapshot of roster count, rates effective date (confidential), labor IDs, totals, tax settings and content checksum at issue time.

## BLOCKED until verified
PartnerKey-to-person membership and ACL; partner rate source/ACL; invoice line persistence and unique constraints; Power Automate invoice PDF storage/preview and license class; tax rate/rounding; runtime authorization; mobile E2E.
