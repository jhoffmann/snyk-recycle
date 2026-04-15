# snyk-recycle

A CLI tool for cycling Snyk project activation states to force recreation of GitHub webhooks.

## Prerequisites

- [Bun](https://bun.com) installed
- `SNYK_PAT` and `SNYK_ORG_ID` set in `.env`
- [`gh`](https://cli.github.com) CLI authenticated

## Setup

```bash
bun install
```

## Runbook: Cycling a webhook

### 1. Identify affected projects

List all Snyk projects for the affected repository to confirm their current state:

```bash
bun run index.ts list --names-start-with "<OrgName>/<repo-name>"
```

The output shows each project's status and whether the Snyk webhook is present on the repo.

### 2. Deactivate all projects for the repo

Deactivating projects causes Snyk to remove its webhook from GitHub:

```bash
bun run index.ts deactivate --names-start-with "<OrgName>/<repo-name>"
```

After deactivation the tool automatically queries the GitHub repo's webhooks and confirms the Snyk webhook is no longer present.

### 3. Reactivate all projects for the repo

Reactivating projects causes Snyk to recreate its webhook:

```bash
bun run index.ts activate --names-start-with "<OrgName>/<repo-name>"
```

After activation the tool automatically queries the GitHub repo's webhooks and confirms the Snyk webhook is present and active, along with its new hook ID.

### 4. Confirm final state

Run `list` to get a full picture of project statuses and webhook state:

```bash
bun run index.ts list --names-start-with "<OrgName>/<repo-name>"
```

All projects should be `active` and the Snyk webhook should be `present (active=true)`.
