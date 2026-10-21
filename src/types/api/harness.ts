export const HARNESS_IDS = ['omp', 'prime', 'pi'] as const
export type HarnessId = (typeof HARNESS_IDS)[number]
export type PrimeImplementation = 'typescript' | 'rust'
export interface HarnessStatus {
  path: string | null
  version: string | null
  /** Prime only: whether the discovered executable is the TypeScript or the Rust build. */
  implementation?: PrimeImplementation
  problem?: {
    path: string
    reason: string
  }
}
