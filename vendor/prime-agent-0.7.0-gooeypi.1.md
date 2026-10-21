# prime-agent 0.7.0-gooeypi.1

This artifact is a GooeyPi-maintained patch of the previously trusted
`prime-agent-0.7.0.tgz` vendor archive.

- Base SHA-256: `88b6578518c72cd51a825bc80f28e0fef9a64c67de4a7d6fd7afd7ca1b34da0b`
- Patched SHA-256: `b1cc1f83a080328bfd958fefb1e5098991ba031f6f38a03bfd3196c5b874a19c`
  (the enforced SHA-512 pin lives in `scripts/release/dependency-pins.json`)
- Patched files: `dist/bundle/chunk-L3VO7F2S.js` and `package.json` (prerelease
  version plus the `./auth-storage`, `./config`, and `./model-registry` exports)

The reviewable source diff is
`vendor/patches/prime-agent-0.7.0-gooeypi.1.patch`. Run
`npm run vendor:verify-patches` to verify the trusted base checksum, apply that
diff, and compare every rebuilt package file with this reviewed archive.

The Prime Agent CLI bundle embeds the same MCP OAuth implementation shipped by
`prime-agent-ai`. This patch mirrors GooeyPi's confidential-client support so
Prime sessions retain the dynamically registered `client_secret` and selected
token authentication method during authorization-code and refresh-token
requests.

The dependency-pin release tests bind the archive to its reviewed SHA-512
digest. The end-to-end token behavior is covered by
`tests/backend/mcp-oauth.test.ts` against the unbundled implementation shared
with the desktop host.
