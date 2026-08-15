# npm 12.0.2

`npm-12.0.2.tgz` is the exact, unmodified npm package published by GitHub Inc.
It is vendored only to bootstrap the repository-pinned package manager without
depending on mutable registry content or network availability.

- Retrieved: 2026-08-15
- Canonical package URL: `https://registry.npmjs.org/npm/-/npm-12.0.2.tgz`
- Registry SHA-512 integrity: `sha512-uIXokLlBj6FpNUTQX1PmT5pz7BlIN9QlixX+zdaSNHsd0qUXsbDLr50xzY6Sw7cJVr0uzHKDOle0swmPW/p5Qw==`
- Registry SHA-1: `788d93dc8869000b1078e0395c60748a0aadc4f1`
- Independently computed SHA-256: `5dbb86c71d07a1957f2e90734092dd6a58bdcd9ebc2d8d41ca1c6e6a21d364e1`
- Compressed size: 3,045,132 bytes
- Registry unpacked size: 12,362,712 bytes across 1,942 files
- Upstream tag: `npm/cli@v12.0.2`, commit `b888cc9a9ff34a8b023ff47b784692396635397b`
- Package license: Artistic-2.0
- Supported Node.js versions: `^22.22.2 || ^24.15.0 || >=26.0.0`

The downloaded bytes were hashed locally and matched the registry's SHA-512
integrity metadata. The archive's `package/package.json` independently reports
the expected name, version, license, engine range, and bundled dependency list.
The upstream npm license is retained as `package/LICENSE`, and license material
for bundled dependencies remains inside the unmodified archive.

The executable bootstrap checks the same SHA-512 and exact byte size before
invoking npm's installer, then installs this absolute local archive with
`--offline`, `--ignore-scripts`, `--no-audit`, and `--no-fund`. Git history and
security-sensitive review of changes to this archive, its provenance record,
and `scripts/release/dependency-pins.json` form the integrity boundary. The
invoking Node.js/npm processes and local filesystem remain trusted; the archive
digest does not independently authenticate the installed tree after the
invoking npm extracts it.
