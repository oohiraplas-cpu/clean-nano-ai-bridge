# A: Partner membership ledger — proposal only
No production list creation or existing list edits.

Proposed dedicated restricted ledger CN_協力会社所属台帳 (name provisional):
MembershipKey (unique, derived from EntraObjectId + PartnerKey + valid-from version); EntraObjectId; PartnerKey; WorkerRecordKey; MembershipStatus (Pending/Active/Suspended/Ended); EffectiveFrom/To; ApprovedBy; ApprovedAt; immutable AuditReference.
Only privileged company administrators can approve or edit mappings. Authenticated worker reads only authorized own membership; company-wide non-sensitive worker information requires separately authorized scoped projection. Cross-partner reads and rate-ledger access denied at SharePoint/flow layer, not merely hidden in Power Apps.
Never infer membership from email suffix, ContactEmail, names, or payroll record. Verify Entra identity, membership, active partner and roster snapshot server-side at invoice issue time. Effective ACL and identity-to-partner records are currently BLOCKED.
