import type { ReactNode } from 'react'
import type { HarnessId } from '@/types/api'
import { OmpMark, PiMark, PrimeMark } from './ui'

const HARNESS_MARKS = { omp: OmpMark, prime: PrimeMark, pi: PiMark } satisfies Record<HarnessId, (props: { size?: number }) => ReactNode>

/** The brand mark for a harness, so callers do not each keep their own map. */
export function HarnessMark({ harness, size = 24 }: { harness: HarnessId; size?: number }) {
  const Mark = HARNESS_MARKS[harness]
  return <Mark size={size} />
}
