/**
 * Renderer-safe copy of node:path's absolute-path rule for a target platform,
 * so settings validation agrees with main's `isAbsolutePathForPlatform`.
 * win32 accepts a rooted path (`\foo`, `/foo`, `\\server\share`) or a drive
 * root (`C:\`, `c:/`); every other platform requires a leading `/`.
 */
export function isAbsolutePathForPlatform(value: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? /^(?:[\\/]|[A-Za-z]:[\\/])/.test(value) : value.startsWith('/')
}
