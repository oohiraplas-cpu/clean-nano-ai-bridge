# A: Partner identity (READ-only design)

Verified CN_取引先台帳: PartnerKey, PartnerType, IsActive, RecordStatus. Verified CN_社員台帳: EmployeeID, EntraObjectId. No verified person-to-PartnerKey relationship exists in inspected columns.

Fail-closed contract: require authenticated personal Entra identity, explicit server-verified active PartnerKey membership, active subcontractor status and roster snapshot at issue time. Reject cross-partner labor rows. Do not treat ContactEmail, account domain, Power Apps Owner, or free-text company name as proof of membership. Never expose confidential rate records to worker clients. Status BLOCKED pending authoritative membership mapping and effective ACL evidence.
