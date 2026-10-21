# B: Confidential partner rate ledger — proposal only
No production list creation or existing list edits.

Proposed restricted CN_協力会社単価台帳:
RateVersionKey (unique), PartnerKey, EffectiveFrom, EffectiveTo, TaxExclusiveRateYen, RateUnit, ApprovalStatus, ApprovedBy, ApprovedAt, AuditReference. No overlap of approved effective-date intervals per PartnerKey + RateUnit; use a privileged serialized validation path. Persist exact applied version in restricted invoice snapshot. SharePoint ACL: company authorized finance admins only; worker app must not query rate list directly.
Labor may be fractional: use exact decimal arithmetic or scaled integer units; avoid JS floating-point money. Confirm consumption tax rules and invoice rounding before implementation. For one active registered worker PDF can show the approved tax-exclusive rate via a privileged sanitized invoice view; for 2+ never return the rate field to PDF renderer. Tax-exclusive subtotal/tax/total remain visible. Price source, ACL and tax rules are BLOCKED.
