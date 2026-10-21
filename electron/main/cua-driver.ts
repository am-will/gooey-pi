import { performance } from 'node:perf_hooks'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, posix, win32 } from 'node:path'
import { runProcess } from './process-utils'

export const CUA_DRIVER_INSTALL_URL = 'https://cua.ai/docs/how-to-guides/driver/install'
const VERSION_PATTERN = /\b(?:cua-driver(?:-rs)?\s+)?v?(\d+\.\d+\.\d+)\b/i

export interface CuaDriverStatus {
  available: boolean
  path: string | null
  version: string | null
  installUrl: string
  detail: string
}

type CandidateAccess = (path: string, mode?: number) => Promise<void>
type DriverProbe = (path: string) => Promise<string | null>

export interface CuaDriverServiceOptions {
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
  home?: string
  access?: CandidateAccess
  probe?: DriverProbe
  now?: () => number
}

export function cuaDriverExecutableCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string[] {
  const pathApi = platform === 'win32' ? win32 : posix
  const executable = platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
  const candidates: string[] = []
  if (env.CUA_DRIVER_PATH && pathApi.isAbsolute(env.CUA_DRIVER_PATH)) candidates.push(env.CUA_DRIVER_PATH)
  for (const value of platform === 'win32' ? [env.Path, env.PATH] : [env.PATH]) {
    for (const directory of (value ?? '').split(platform === 'win32' ? ';' : delimiter)) {
      if (directory && pathApi.isAbsolute(directory)) candidates.push(pathApi.join(directory, executable))
    }
  }
  if (platform === 'win32') {
    if (env.LOCALAPPDATA && win32.isAbsolute(env.LOCALAPPDATA)) {
      candidates.push(
        win32.join(env.LOCALAPPDATA, 'Programs', 'trycua', 'cua-driver-rs', 'bin', executable),
        win32.join(env.LOCALAPPDATA, 'Programs', 'CuaDriver', executable),
      )
    }
    candidates.push(win32.join(home, '.local', 'bin', executable))
  } else {
    candidates.push(posix.join(home, '.local', 'bin', executable), '/usr/local/bin/cua-driver', '/usr/bin/cua-driver')
    if (platform === 'darwin') candidates.push('/opt/homebrew/bin/cua-driver')
    if (platform === 'linux') candidates.push('/home/linuxbrew/.linuxbrew/bin/cua-driver')
  }
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = platform === 'win32' ? candidate.toLowerCase() : candidate
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function probeCuaDriverExecutable(path: string): Promise<string | null> {
  try {
    const result = await runProcess(path, ['--version'], { timeoutMs: 5_000, maxBytes: 16 * 1024 })
    if (result.code !== 0 || result.timedOut || result.outputExceeded) return null
    return VERSION_PATTERN.exec(`${result.stdout}\n${result.stderr}`)?.[1] ?? null
  } catch {
    return null
  }
}

export class CuaDriverService {
  private lastAvailablePath: string | null = null
  private readonly platform: NodeJS.Platform
  private readonly environment: NodeJS.ProcessEnv
  private readonly home: string
  private readonly checkAccess: CandidateAccess
  private readonly probe: DriverProbe
  private readonly now: () => number
  private cached: { status: CuaDriverStatus; expiresAt: number } | undefined
  private pending: Promise<CuaDriverStatus> | undefined

  constructor(options: CuaDriverServiceOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.environment = options.environment ?? process.env
    this.home = options.home ?? homedir()
    this.checkAccess = options.access ?? access
    this.probe = options.probe ?? probeCuaDriverExecutable
    this.now = options.now ?? (() => performance.now())
  }

  async status(force = false): Promise<CuaDriverStatus> {
    if (!force && this.cached && this.cached.expiresAt > this.now()) return { ...this.cached.status }
    if (this.pending) return { ...await this.pending }
    const pending: Promise<CuaDriverStatus> = this.discover().then((status) => {
      this.cached = { status, expiresAt: this.now() + 5_000 }
      return status
    }).finally(() => { if (this.pending === pending) this.pending = undefined })
    this.pending = pending
    return { ...await pending }
  }

  private async discover(): Promise<CuaDriverStatus> {
    for (const candidate of cuaDriverExecutableCandidates(this.environment, this.platform, this.home)) {
      try {
        await this.checkAccess(candidate, this.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
        const version = await this.probe(candidate)
        if (!version) continue
        this.lastAvailablePath = candidate
        return {
          available: true,
          path: candidate,
          version,
          installUrl: CUA_DRIVER_INSTALL_URL,
          detail: `Cua Driver ${version} is ready at ${candidate}.`,
        }
      } catch { /* try the next bounded candidate */ }
    }
    this.lastAvailablePath = null
    return {
      available: false,
      path: null,
      version: null,
      installUrl: CUA_DRIVER_INSTALL_URL,
      detail: 'Install Cua Driver before enabling Computer Use, then refresh this page.',
    }
  }

  executable(): string | null { return this.lastAvailablePath }

  async requireAvailable(): Promise<CuaDriverStatus> {
    const status = await this.status(true)
    if (!status.available || !status.path) throw new Error(`${status.detail} ${status.installUrl}`)
    return status
  }
}
