---
name: review-pr-viability
description: Review a pull request or issue for value, implementation quality, maintainability, regression risk, and reliance on upstream changes.
---

# Review PR or issue viability

Assess only; do not modify code or GitHub state unless explicitly asked.

- Inspect the proposal, complete diff, relevant architecture, current base branch, and tests. Judge the idea separately from its implementation.
- Evaluate user value, correctness, maintainability, DRYness, minimum viable scope, regressions, compatibility, security/privacy, performance, and test coverage.
- Determine whether it works with released interfaces in this repository. Flag any required upstream change, unreleased dependency, fork/patch, protocol change, or coordinated external rollout. Distinguish required from optional upstream improvements.
- Report actionable findings first with file and line evidence. Avoid speculative objections.

Finish with an explained **idea score** and **implementation-quality score** from 0–10, regression risk (Low/Medium/High), upstream dependency (None/Optional/Required/Unclear), and recommendation (Merge/Merge after fixes/Redesign/Reject). State the smallest safe path forward and the evidence or tests needed before merge.
