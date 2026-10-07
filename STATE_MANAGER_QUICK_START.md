# State Manager Enforcement - Quick Start Guide

## Enable State Manager Enforcement

### Option 1: Environment Variable
```bash
export BRIDGE_STATE_MANAGER_ENFORCE=true
npm start
```

### Option 2: .env File
```bash
# .env (or .env.production)
BRIDGE_STATE_MANAGER_ENFORCE=true
```

### Option 3: Docker/Cloud Deployment
```bash
docker run -e BRIDGE_STATE_MANAGER_ENFORCE=true clean-nano-ai-bridge
```

## Test State Manager Enforcement

### Run All State Manager Tests
```bash
npm test -- test/stateManager.test.js
```

### Run With Enforcement Enabled
```bash
BRIDGE_STATE_MANAGER_ENFORCE=true npm test
```

### Run Specific Test
```bash
npm test -- test/stateManager.test.js --test-name-pattern "validate write operation"
```

## How to Use State Manager in Calls

### Pattern 1: Explicit State Context
```json
{
  "method": "update_powerapps_app",
  "params": {
    "stateContext": {
      "appId": "app-abc123",
      "environment": "Default-def456",
      "branch": "main",
      "canonicalBranch": "main",
      "sha": "1234567890abcdef1234567890abcdef12345678",
      "correlationId": "req-12345678"
    },
    "relativePath": "Screen1.pa.yaml",
    "content": "..."
  }
}
```

### Pattern 2: Inline State Fields
```json
{
  "method": "update_powerapps_app",
  "params": {
    "appId": "app-abc123",
    "environment": "Default-def456",
    "branch": "main",
    "canonicalBranch": "main",
    "sha": "1234567890abcdef1234567890abcdef12345678",
    "correlationId": "req-12345678",
    "relativePath": "Screen1.pa.yaml",
    "content": "..."
  }
}
```

### Pattern 3: Nested in Payload
```json
{
  "method": "update_powerapps_app",
  "params": {
    "payload": {
      "stateContext": {
        "appId": "app-abc123",
        "environment": "Default-def456",
        "branch": "main",
        "canonicalBranch": "main",
        "sha": "1234567890abcdef1234567890abcdef12345678",
        "correlationId": "req-12345678"
      },
      "relativePath": "Screen1.pa.yaml",
      "content": "..."
    }
  }
}
```

## Valid State Context Example

```javascript
{
  appId: "app-8a2c9e4d-5f1b-4c3a-9d2b-1e5c7a4f9d3b",
  environment: "Default-8a2c9e4d",
  branch: "main",
  canonicalBranch: "main",
  sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b",
  correlationId: "req-20261007-abcdef1234567890"
}
```

## Common Validation Errors

### Missing Field
```
Error: appId: missing
Fix: Include appId in state context
```

### Branch Mismatch
```
Error: branch mismatch: branch="feature/xyz" != canonicalBranch="main"
Fix: Use branch="main" (must match canonicalBranch)
```

### Invalid SHA
```
Error: sha: must be 40-character hex string (got: invalid...)
Fix: Use valid 40-character hex SHA from git
```

### Empty String
```
Error: environment: empty or invalid
Fix: Provide non-empty environment value
```

## Fail-Closed Tools (Require State)

1. `update_powerapps_app` - Updates Power Apps source
2. `save_powerapps_app` - Saves to Power Platform
3. `publish_powerapps_app` - Publishes app
4. `ensure_sharepoint_columns` - Creates SharePoint columns
5. `create_employee_ledger_entry` - Creates ledger entry
6. `update_employee_ledger_entry` - Updates ledger entry
7. `run_power_automate_flow` - Executes flow
8. `validate_powerapps_change` - Validates changes
9. `verify_save_result` - Verifies save
10. `deploy_to_test` - Deploys to test
11. `rollback_deployment` - Rolls back deployment
12. `update_permissions` - Updates permissions
13. `lock_user_info` - Locks user info
14. `validate_powerapps_source` - Validates source
15. `compare_powerapps_with_git` - Compares with git
16. `run_powerapps_tests` - Runs tests

## Read-Only Tools (No State Required)

- `get_powerapps_app`
- `get_powerapps_state`
- `get_powerapps_source`
- `get_sharepoint_list`
- `get_sharepoint_columns`
- `health_check`
- `get_tasks`
- And 40+ other read operations...

## Debugging

### Check if Enforcement is Enabled
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "x-api-key: test" \
  -d '{"method":"health_check"}'
# Should return { "status": "ok" } regardless
```

### Test Enforcement with Missing State
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "x-api-key: test" \
  -d '{
    "method":"update_powerapps_app",
    "params":{"relativePath":"test.yaml","content":"x"}
  }'
# Should return error if BRIDGE_STATE_MANAGER_ENFORCE=true
```

### View Configuration
```javascript
const { getConfig } = require('./src/config');
const config = getConfig();
console.log('State Manager Enforce:', config.enforceStateManager);
```

## Production Checklist

- [ ] Set `BRIDGE_STATE_MANAGER_ENFORCE=true` in production
- [ ] Ensure all Copilot/ChatGPT/Claude calls include state context
- [ ] Test state context extraction with 3 input patterns
- [ ] Verify audit trail metadata in responses
- [ ] Monitor correlation IDs in logs
- [ ] Set up alert on validation failures
- [ ] Document state context format for integrations

## Support

For issues or questions:
1. Check test suite: `test/stateManager.test.js`
2. Review implementation: `src/stateManager.js`
3. Check server integration: `src/server.js` lines 1257-1325
4. Reference PHASE_6_STATE_MANAGER_ENFORCEMENT.md
