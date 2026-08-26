# Repository engineering guidance

## File size

Keep handwritten production files at or below 750 lines when practical. Treat 750 lines as a review threshold, not a reason to create arbitrary wrapper modules or split cohesive logic.

When changing an existing production file above the threshold, avoid increasing its size unless the change cannot be separated without weakening cohesion. Prefer extracting a complete responsibility with a narrow interface, and explain any intentional exception in the pull request.

This threshold does not apply to tests, generated files, vendored code, lockfiles, fixtures, or data assets. Correctness, security boundaries, and maintainable ownership take precedence over line count.
