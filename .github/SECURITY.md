# Security Policy

## Supported versions

Security fixes are provided for the latest GooeyPi release published on GitHub Releases.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Earlier releases | No |

When it is safe to do so, confirm whether the issue affects the latest release before reporting it. If updating or retesting would be unsafe, include the version you tested and explain the constraint.

## Report a vulnerability

Do not disclose suspected vulnerabilities in a public issue, discussion, or pull request.

1. Open GooeyPi's [private vulnerability reporting form](https://github.com/am-will/gooey-pi/security/advisories/new).
2. Complete and submit the private advisory form.
3. Use the advisory for all sensitive follow-up information.

If the private reporting form is unavailable, open a public issue titled `[Security] Private reporting unavailable` and ask a maintainer to enable private vulnerability reporting. Do not include any vulnerability details in that issue.

## What to include

Include enough information to reproduce and assess the issue safely:

- the affected release or commit, operating system, and relevant configuration;
- a description of the security impact and affected users or systems;
- prerequisites and complete reproduction steps;
- a minimal, non-destructive proof of concept, if available;
- sanitized logs, screenshots, or stack traces;
- suggested remediation or mitigations, if known;
- your preferred credit and any coordinated-disclosure constraints.

Do not include real credentials, private keys, access tokens, production data, personal information, or unrelated project content. Use test accounts and controlled data wherever possible.

## What to expect

Maintainers aim to:

- acknowledge a new report within **5 business days**;
- provide an initial assessment within **10 business days**;
- provide a status update at least every **30 calendar days** while the report remains open.

These are response targets, not guaranteed resolution times. Severity, reproducibility, release coordination, and upstream dependencies may affect when a fix is available.

## Coordinated disclosure

Keep the report confidential until the advisory is published or another disclosure date is agreed in the private advisory. Maintainers will validate the report, coordinate a fix and supported release, and publish a GitHub security advisory when appropriate.

We aim for public disclosure after users have had a reasonable opportunity to update, normally within **90 days** of acknowledgement. The reporter and maintainers may agree to adjust that timeline for active exploitation, upstream dependencies, complex remediation, or other material risks. Reporter credit is included when requested.
