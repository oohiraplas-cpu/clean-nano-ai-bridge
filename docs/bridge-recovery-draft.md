# Bridge recovery diagnostics (Draft)

The existing `check_dependencies` tool now includes `data.recovery` from
`SelfRecoveryService`. No new endpoint or production mutation route is enabled.

- A transient read exception (502/503/504, connection reset, timeout, DNS retry)
  is retried once. Authentication failures, rate limits and unknown errors stop.
- Each connection reports PASS/BLOCKED, attempt count and the next recovery step.
- Provider exception text is not returned by the diagnostic read wrapper.
- Negative health responses and missing app identity cannot yield verified health.
- Connectivity PASS is separate from recovery completion. Azure running SHA,
  independent PAC source, SharePoint approval/ETag, App Checker, backup/restore
  and published artifact remain unverified by this connection-only diagnostic.
- No save, publish, deployment, configuration, permission change, rollback,
  approval reservation or transaction replay is performed.

After deploying through a separately approved release, call `check_dependencies`
to obtain this report. The Draft implementation and mock tests do not demonstrate
live recovery or authorize production use. Existing legacy recovery actions are
not invoked by this diagnostic path.
