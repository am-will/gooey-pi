import { expect, it } from 'vitest'
import { covered } from './src/covered'
it('executes one real module', () => { expect(covered).toBe(1) })
