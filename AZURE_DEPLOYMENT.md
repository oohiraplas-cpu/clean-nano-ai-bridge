# Azure Web App deployment

Target Web App: `clean-nano-ai-bridge`

The workflow `.github/workflows/azure-webapp-deploy.yml` deploys `main` to the existing Azure Web App when the repository secret `AZURE_WEBAPP_PUBLISH_PROFILE` is configured.

If the secret is absent, the workflow exits safely without deploying.

## Required repository secret

`AZURE_WEBAPP_PUBLISH_PROFILE`

Use the publish profile downloaded from the existing Azure Web App. Do not commit the profile XML to this repository.

## Power Apps Git Integration App Settings

Configure these values in the existing Azure Web App App Settings / Environment Variables. Do not commit secret values.

- `POWERAPPS_ORG_URL`
- `POWERAPPS_SOLUTION_UNIQUE_NAME`
- `POWERAPPS_GITHUB_TOKEN`
- `POWERAPPS_GITHUB_OWNER=oohiraplas-cpu`
- `POWERAPPS_GITHUB_REPO`
- `POWERAPPS_GITHUB_BRANCH=main`
- `POWERAPPS_GITHUB_ROOT`

Existing Bridge settings and MCP keys must remain unchanged.
