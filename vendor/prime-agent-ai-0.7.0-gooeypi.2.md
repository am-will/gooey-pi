# prime-agent-ai 0.7.0-gooeypi.2

This artifact is a GooeyPi-maintained patch of
`prime-agent-ai-0.7.0-gooeypi.1.tgz`.

- Base SHA-256: `5cd2a43cc18f3b9488982be6286273e8733d3b85a22274e1a0989d04c0fbc147`
- Patched SHA-256: `7edafb2ce7ab54af0e92744e458329a6f16d1a25df36038762f5addc29a41bb5`
- Patched files: `package.json`, `dist/mcp/oauth.js`

The patch requires HTTPS for remote MCP OAuth servers and for every discovered
authorization, token, and dynamic-registration endpoint. Plain HTTP remains
available for loopback hosts (`localhost`, `.localhost`, `127.0.0.0/8`, and
IPv6 `::1`). Discovery, registration, authorization-code exchange, and token
refresh all fail closed on HTTP redirects, so credentials cannot follow an
HTTPS-to-HTTP downgrade.

GooeyPi validates configured MCP URLs before writing Prime, OMP, or Pi settings.
This vendored patch additionally protects Prime Agent's OAuth discovery and
credential-bearing requests. Browser navigation after opening the validated
authorization URL remains controlled by the user's browser and the remote
authorization server.

`tests/backend/mcp-oauth.test.ts` covers configured and discovered plaintext
endpoints, stored token endpoints, redirect policy, and the loopback exception.
