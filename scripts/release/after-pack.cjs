const { join } = require('node:path')
const { flipFuses, FuseVersion } = require('@electron/fuses')
const { ELECTRON_FUSE_CONFIG } = require('./fuses.cjs')

function executablePath(context, platform = process.platform) {
  const { appOutDir, packager } = context
  const { productFilename } = packager.appInfo
  if (platform === 'darwin') return join(appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename)
  if (platform === 'win32') return join(appOutDir, `${productFilename}.exe`)
  // app-builder-lib's LinuxPackager names the binary after the lowercased sanitized name unless executableName overrides it.
  return join(appOutDir, packager.appInfo.sanitizedName.toLowerCase())
}

exports.executablePath = executablePath

exports.default = async function hardenElectron(context) {
  await flipFuses(executablePath(context), {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: process.platform === 'darwin',
    ...ELECTRON_FUSE_CONFIG,
  })
}
