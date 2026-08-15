# Security Policy

## Supported versions

GooeyPi provides security fixes only for the latest version published on GitHub Releases.

| Version | Supported |
| --- | --- |
| Latest release on GitHub Releases | Yes |
| Every earlier release | No |

When it is safe to do so, confirm whether the suspected vulnerability affects the latest published release before reporting it. If you cannot update or retest safely, report the version you used and explain why. Include any impact on `main` or older releases, but fixes are prepared for the latest supported release.

## Report a vulnerability

Do not report suspected vulnerabilities in a public issue, discussion, or pull request.

1. Open GooeyPi's [private vulnerability-reporting form](https://github.com/am-will/gooey-pi/security/advisories/new).
2. Complete and submit the form through the private GitHub advisory.
3. Continue discussion and share any sensitive follow-up material only in that advisory.

If **Report a vulnerability** is unavailable, open a public issue titled `[Security] Private reporting unavailable` that asks a maintainer to enable private vulnerability reporting. Do not include vulnerability details in that public request. Wait for a maintainer to confirm that the private form is available before sharing details.

## What to include

Provide enough information to reproduce and assess the problem safely:

- the affected release, commit, operating system, and relevant configuration;
- a concise description of the security impact and who or what could be affected;
- prerequisites and complete reproduction steps;
- a minimal, non-destructive proof of concept when one is available;
- sanitized logs, screenshots, or stack traces without credentials, tokens, personal data, or unrelated project content;
- any suggested remediation or mitigating control;
- your credit preference and coordinated-disclosure constraints.

Do not include real credentials, private keys, access tokens, production data, or personal information. Use test accounts and controlled data wherever possible.

## What to expect

Maintainers target the following response times:

- acknowledge a new report within **3 business days**;
- provide an initial assessment within **7 business days**;
- provide a status update at least every **14 calendar days** while work remains open.

These are response targets rather than guaranteed resolution times. Severity, reproducibility, release coordination, and upstream dependencies determine when a fix can ship.

## Coordinated disclosure

Keep the report confidential until the advisory is published or another disclosure date is agreed in the private advisory. Maintainers will validate the report, coordinate a fix and supported release, and publish a GitHub security advisory when appropriate.

We work toward public disclosure after users can update, normally within **90 days** of acknowledgement. The reporter and maintainers may agree to adjust that timeline for active exploitation, an upstream dependency, a complex remediation, or another material risk. Reporter credit is included when requested.
