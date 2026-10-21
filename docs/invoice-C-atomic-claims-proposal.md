# C: Atomic labor invoice claim — proposal only
No production list creation or existing list edits.

Proposed restricted CN_請求人工予約台帳:
ClaimKey (single text with enforceUniqueValues=true; stable canonical PartnerKey + LaborKey), PartnerKey, LaborKey, InvoiceKey, RequestId, ClaimStatus (Reserved/Committed/Released), ReservationExpiresAt, Version, AuditReference.
Single unique ClaimKey must be reserved using server-side create (conflict => duplicate) before invoice submit; a separate preflight lookup is insufficient. Enforce immutable original claim and audited reversal/reissue; do not simply delete an old unique key. Idempotency: RequestId stable per client retry, and committed response retrievable. Reserve, persist invoice PDF and header, commit claims with explicit compensating recovery and human review for partial failures. SharePoint Lists alone are not a multi-list ACID transaction: concurrency and failure injection tests remain mandatory. Authorization must verify membership and confirmed labor provenance. Actual uniqueness, reservations, recovery, and licensing are BLOCKED.
