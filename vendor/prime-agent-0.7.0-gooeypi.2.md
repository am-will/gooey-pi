# prime-agent 0.7.0-gooeypi.2

This artifact is a GooeyPi-maintained security revision of the retained
`prime-agent-0.7.0-gooeypi.1.tgz` vendor archive. That intermediate archive
already contains GooeyPi's MCP OAuth compatibility patch; it and the original
`prime-agent-0.7.0.tgz` remain alongside this file for complete review.

- Original `0.7.0` SHA-256: `88b6578518c72cd51a825bc80f28e0fef9a64c67de4a7d6fd7afd7ca1b34da0b`
- Intermediate `0.7.0-gooeypi.1` SHA-256: `ec72ee7452587187fb1fa570940237fe0ee7fec14cad3d3aa130db1607506247`
- Final `0.7.0-gooeypi.2` SHA-256: `d77a62e2f3a85c9fa5264405a75c95213274458e8bc26e78b5a35da6c64f7171`
- Final SHA-512 integrity: `sha512-Ylitnx182ue076jyVty39hhtzi6XJN7/q+SssERV5gtTbIRJwSC8ZTGbDFF4VfiRJKRdV/sqSu/LP6JR6zOKvA==`
- Changed from `.1`: `dist/bundle/chunk-L3VO7F2S.js`, `package.json` (version only)
- Bundle SHA-256 before: `72106d4cce8176aac94f361163ef0bdead5e05d3a45ed70c30a6b95d9e310557`
- Bundle SHA-256 after: `67d0c528d5af7fc0f6d76a8d267a15ceda8d902cbc937548e50dd6004aaf4d38`
- License metadata retained: MIT

Prime's CLI bundle embeds `extract-zip@2.0.1` at build time, so the root npm
override does not affect the executable downloader. This patch changes that
embedded module to reject every symlink before callbacks, destination
resolution, streams, or entry-specific directory creation. Every ordinary
destination is resolved and lexically contained before the first `mkdir`, and
the existing canonical containment check remains as defense in depth. Ordinary
files and directories retain the existing extraction path.

`tests/backend/extract-zip.test.ts` reads the installed production bundle,
verifies the fd/ripgrep ZIP downloader calls this embedded module, evaluates
the exact bundled dependency region, and exercises malicious symlink,
parent-traversal, and legitimate Prime-style archives. Dependency-pin tests
bind the final tarball bytes to the lockfile. The original archive contains no
standalone license file; its MIT `package.json` declaration is unchanged.
