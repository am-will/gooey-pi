import { vi } from 'vitest'

/** Subscription lifetimes and authorization denials must behave like the real services. */
export function serviceStub(): Record<string, unknown> {
  const methods: Record<string, unknown> = {
    onDidChange: vi.fn(() => vi.fn()),
    onPointer: vi.fn(() => vi.fn()),
    onActivity: vi.fn(() => vi.fn()),
    authorizePath: vi.fn(async () => { throw new Error('denied') }),
    requireSessionPath: vi.fn(async () => { throw new Error('denied') }),
    authorizeReveal: vi.fn(async () => { throw new Error('denied') }),
  }
  return new Proxy(methods, {
    get(target, key) {
      if (typeof key !== 'string') return undefined
      target[key] ??= vi.fn(async () => undefined)
      return target[key]
    },
  })
}

export function harnessStub(): Record<string, unknown> {
  return {
    projects: serviceStub(),
    sessions: serviceStub(),
    agents: { ...serviceStub(), has: vi.fn(() => false), requestRuntimeEnvironmentRefresh: vi.fn(async () => undefined) },
    catalog: serviceStub(),
    plugins: serviceStub(),
  }
}

export function ipcServiceStubs(): Record<string, unknown> {
  return {
    meta: { version: '0.0.0-test' },
    projects: serviceStub(), sessions: serviceStub(), agents: serviceStub(),
    terminals: serviceStub(), git: serviceStub(), plugins: serviceStub(),
    providers: serviceStub(), settings: serviceStub(), heartbeats: serviceStub(),
    schedules: serviceStub(), browser: serviceStub(), updates: serviceStub(),
    cuaDriver: serviceStub(), pets: serviceStub(),
    omp: harnessStub(), pi: harnessStub(),
    popupApplicationMenu: vi.fn(), setTitleBarTheme: vi.fn(),
    applyInterfaceZoom: vi.fn(),
  }
}
