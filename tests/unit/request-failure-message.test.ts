import { describe, expect, it } from 'vitest'
import { requestFailureMessage } from '../../src/app/workspace'

describe('requestFailureMessage', () => {
  it('shows the failure without the Electron IPC prefix', () => {
    expect(requestFailureMessage(new Error("Error invoking remote method 'agent:prompt': Error: No runtime is running"))).toBe('Request failed: No runtime is running')
  })

  it('names no harness when the failure carries no detail', () => {
    expect(requestFailureMessage(new Error(''))).toBe('The agent could not process the request.')
    expect(requestFailureMessage(new Error("Error invoking remote method 'agent:prompt': Error: "))).toBe('The agent could not process the request.')
  })
})
