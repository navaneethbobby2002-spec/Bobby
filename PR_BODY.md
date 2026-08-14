Gitleaks baseline and scan summary

Local authoritative gitleaks scan (pre-PR) results:

- Total findings: 430
  - generic-api-key: 240
  - curl auth tokens: 146
  - JWT: 23
  - GCP: 9
  - private key: 3

Top files with findings:

- .omo/drafts/claude_request.md
- .env.example
- src/lib/oauth/constants/oauth.ts
- open-sse/config/providerRegistry.ts
- tests

Action taken in this branch (security/sanitize-fixtures):

- Added gitleaks-baseline.json (copied from gitleaks-local.json) at the repository root to serve as the baseline of legacy findings.
- Updated .github/workflows/gitleaks.yml to pass --baseline-path=gitleaks-baseline.json so CI detection ignores baseline matches.
- Added an allowlist entry for gitleaks-baseline.json to .gitleaks.toml.
- Added gitleaks-local.json to .gitignore to avoid accidentally committing the local scan artifact.

Maintainer request / next steps:

- Please manually confirm that the four listed files below contain only placeholder or non-sensitive values (and not real credentials):
  - .omo/drafts/claude_request.md
  - .env.example
  - src/lib/oauth/constants/oauth.ts
  - open-sse/config/providerRegistry.ts

  If any contain real secrets, rotate/revoke them immediately and update the baseline after removing secrets from history.

- After maintainers confirm, update gitleaks-baseline.json (if appropriate) and commit the updated baseline as part of the repo policy review.

Notes:

- The baseline is intended as a pragmatic first step to reduce noise from historical findings; it does not replace the need to remediate real secrets.
- The gitleaks CI job will upload a reports/gitleaks-report.json artifact for each PR run; use that to triage new findings.
