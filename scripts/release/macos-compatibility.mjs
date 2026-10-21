function versionParts(value, label) {
  if (typeof value !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(value)) throw new Error(`${label} has an invalid macOS version: ${value}`)
  const parts = value.split('.').map(Number)
  return [parts[0], parts[1], parts[2] ?? 0]
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

/** Every architecture's Mach-O deployment command must fit the advertised macOS floor. */
export function assertMacOSDeploymentTargets(output, minimumSystemVersion, label) {
  const floor = versionParts(minimumSystemVersion, 'Declared minimum')
  let found = false
  for (const command of output.split(/\n(?=Load command \d+)/)) {
    let minimum
    if (/\bcmd LC_BUILD_VERSION\b/.test(command)) {
      if (!/^\s*platform\s+(?:1|macos)\s*$/m.test(command)) throw new Error(`${label} contains a non-macOS build target`)
      minimum = /^\s*minos\s+(\S+)\s*$/m.exec(command)?.[1]
    } else if (/\bcmd LC_VERSION_MIN_MACOSX\b/.test(command)) {
      minimum = /^\s*version\s+(\S+)\s*$/m.exec(command)?.[1]
    } else continue
    found = true
    if (compareVersions(versionParts(minimum, label), floor) > 0) {
      throw new Error(`${label} requires macOS ${minimum}, above the declared minimum ${minimumSystemVersion}`)
    }
  }
  if (!found) throw new Error(`${label} has no macOS deployment target`)
}

export function assertMacOSBundleMinimum(actual, expected) {
  if (compareVersions(versionParts(actual, 'App Info.plist'), versionParts(expected, 'Declared minimum')) !== 0) {
    throw new Error(`App Info.plist minimum macOS ${actual} does not match the declared minimum ${expected}`)
  }
}
