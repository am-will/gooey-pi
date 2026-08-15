# extract-zip 2.0.2-gooeypi.1

This artifact is a GooeyPi-maintained security patch of the public
`extract-zip@2.0.1` npm package. The unmodified base archive is retained as
`vendor/extract-zip-2.0.1.tgz` for byte-level review.

- Source: `https://registry.npmjs.org/extract-zip/-/extract-zip-2.0.1.tgz`
- Base npm integrity: `sha512-GDhU9ntwuKyGXdZBUgTIe+vXnWj0fppUEtMDL0+idd5Sta8TGpHssn/eusA9mrPr9qNDym6SxAYZjNvCn/9RBg==`
- Base SHA-256: `59b4e0ae67fa617bb64ca0686effb02253d820ce57f913c95116dc7cb373dab4`
- Patched SHA-256: `892ec53efb0c49ba2feacdb159b71f03821174fac77ee0c30dc9f8af06e1d7c0`
- Changed files: `index.js`, `package.json`
- License retained: BSD-2-Clause (`LICENSE` is unchanged)

The patch rejects every ZIP entry marked as a symbolic link before invoking the
entry callback, resolving its destination, opening its data stream, or creating
entry-specific directories. It resolves and lexically contains every remaining
entry destination before the first `mkdir`, then retains upstream's
canonical-path containment check after directory creation as defense in depth.
Ordinary files and
directories retain the upstream extraction path. The now-unreachable symlink
implementation and its `get-stream` dependency were removed. Version
`2.0.2-gooeypi.1` is above the GitHub advisory's affected range (`<=2.0.1`)
while making the local patch identity explicit.

`tests/backend/extract-zip.test.ts` builds deterministic real ZIP archives and
verifies that escaping symlinks and parent-traversal entries are rejected
without outside files or directories while a representative nested Prime tool
archive still extracts normally. Release-pin tests bind the installed override
to the reviewed archive bytes.
