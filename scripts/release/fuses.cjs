const { FuseState, FuseV1Options } = require('@electron/fuses')

/**
 * The Electron fuses every packaged binary ships with. after-pack.cjs flips
 * them on every platform and both package verifiers read them back, so the
 * hardened fuse wire is defined only here. Kept out of lib.mjs because
 * bootstrap-npm.mjs imports lib.mjs before `npm ci` installs @electron/fuses.
 */
const ELECTRON_FUSE_CONFIG = Object.freeze({
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.WasmTrapHandlers]: true,
})

/** Throws unless a fuse wire read from a packaged binary carries every configured fuse state. */
function assertFuseWire(wire) {
  for (const [option, enabled] of Object.entries(ELECTRON_FUSE_CONFIG)) {
    const expected = enabled ? FuseState.ENABLE : FuseState.DISABLE
    const actual = wire[option]
    if (actual !== expected) throw new Error(`Electron fuse ${FuseV1Options[option]} is ${FuseState[actual] ?? String(actual)}, expected ${FuseState[expected]}`)
  }
}

exports.ELECTRON_FUSE_CONFIG = ELECTRON_FUSE_CONFIG
exports.assertFuseWire = assertFuseWire
