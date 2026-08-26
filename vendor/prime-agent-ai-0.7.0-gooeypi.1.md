# prime-agent-ai 0.7.0-gooeypi.1

This artifact is a GooeyPi-maintained patch of the previously trusted
`prime-agent-ai-0.7.0.tgz` vendor archive.

- Base SHA-256: `7cdbb3e835f48dd103325f7a351ce540b27af4d161aeb9c7b9bdcc12fe7909af`
- Patched SHA-256: `5cd2a43cc18f3b9488982be6286273e8733d3b85a22274e1a0989d04c0fbc147`
- Patched file: `dist/mcp/oauth.js`

The reviewable source diff is
`vendor/patches/prime-agent-ai-0.7.0-gooeypi.1.patch`. Run
`npm run vendor:verify-patches` to verify the trusted base checksum, apply that
diff, compare every rebuilt package file with this reviewed archive, and prove
that the pinned npm toolchain can repack the result reproducibly.

The patch makes dynamic MCP OAuth registration honor the authorization
server's `token_endpoint_auth_methods_supported` metadata. It retains the
issued `client_secret` and selected authentication method in Prime Agent's
mode-0600 credential store, then applies the same method to authorization-code
and refresh-token requests. Confidential registrations without a secret fail
closed.

`tests/backend/mcp-oauth.test.ts` verifies `client_secret_post` exchange and
refresh behavior, while the dependency-pin release tests bind the archive to
its reviewed SHA-512 digest.
