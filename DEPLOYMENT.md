# Production deployment

Merging to `main` runs `.github/workflows/release.yml`. After the extension checks and production builds pass, it:

1. uploads a versioned Chrome extension ZIP;
2. submits the extension to every fully configured browser store; and
3. tells the Render service to deploy the exact merged commit.

The workflow uses `0.1.<GitHub run number>.<run attempt>` as the extension manifest version. Store versions must increase, so keep this workflow for releases instead of manually submitting the same version again.

## Render

The production service is already provisioned as a Node web service:

- Service ID: `srv-dc3ojfui0phs73832dk0`
- URL: https://hyper-bar.onrender.com
- Branch: `main`
- Build command: `npm ci --legacy-peer-deps && npm run build:site`
- Start command: `npm start -w apps/site`
- Health check: `/`
- Auto-deploy: off (GitHub Actions triggers deploys after checks)

The Render deploy hook is already stored in the GitHub `production` environment as `RENDER_DEPLOY_HOOK_URL`.

This project uses a web service rather than Render's static-site runtime because the Next.js favicon endpoint is server-rendered.

## Browser stores

The first version must already have been created in each store's developer dashboard. CI updates an existing extension; it does not create the listing or fill in store metadata.

Add the following non-secret IDs to the GitHub `production` environment as variables and the credentials as secrets. You may configure Chrome, Edge, or both. A partially configured store fails the release.

### Microsoft Edge Add-ons

Variables:

- `EDGE_PRODUCT_ID`

Secrets:

- `EDGE_CLIENT_ID`
- `EDGE_API_KEY`

### Chrome Web Store (API v2)

Variables:

- `CHROME_EXTENSION_ID`
- `CHROME_PUBLISHER_ID`

Secrets:

- `CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL`
- `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY`

Keep multiline service-account private keys exactly as exported. GitHub Actions environment secrets preserve line breaks. If desired, a protected `production` environment can require approval before the release jobs start.

## GitHub setup

1. Open the repository's **Settings > Environments** page.
2. Create an environment named `production` (optionally with required reviewers).
3. Add the Render secret, plus the variables and secrets for each browser store being published.
4. Ensure the workflow can access the environment, then merge to `main`.

The `check` job also runs on pull requests. Store uploads and Render deploys run only for `main`.
