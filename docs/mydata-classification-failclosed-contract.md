# My Data employment classification — fail-closed implementation contract

Status: DESIGN ONLY / BLOCKED for Power Apps deployment.

## Observed
- S8_UserOnboarding Form3: new record into CN_本人マイデータ.
- S9_UserConfirm Button7: duplicate UserUPN check then SubmitForm(Form3).
- SharePoint CN_本人マイデータ: UserType and EmploymentType are optional, editable text columns; UserUPN is required.
- Neither S8 nor S9 defines UserType/EmploymentType data cards. No authoritative classification value mapping is established.

## Required before implementation
1. Identify existing administrator-controlled source of truth for three classifications: 社員, アルバイト, 協力会社. Document the exact field and values. Never infer from email domain or company name.
2. Resolve authenticated user to one unambiguous ledger record (Entra ID/UPN and employee ID as appropriate). Reject absent or duplicate identities.
3. Prevent user-controlled input for UserType and EmploymentType in all screens, forms, flows and list access. Ensure server-side effective ACL or approved admin-only write path; hiding controls alone is insufficient.
4. At registration, only an authorized administrator or verified provisioning flow may assign classification. Reject missing/ambiguous classification; preserve existing records and registration paths until migration reviewed.
5. Keep Time tree attendance and electronic daily report submission unchanged; read classification only from verified record.
6. Salary remains fail-closed based on identity plus effective SharePoint ACL; never grant access based on classification alone.
7. Validate employee/part-time/subcontractor cases, impersonation, duplicate UPN, category-change attempt, direct SharePoint edit, reauthentication, and rollback in isolated test environment.

No SharePoint data, app saves, deployments, permissions or publication authorized by this document.
