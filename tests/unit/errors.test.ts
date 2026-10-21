import { describe, expect, it } from 'vitest'
import { errorMessage } from '../../src/lib/errors'

describe('errorMessage', () => {
  it('returns an Error message with or without a fallback', () => {
    expect(errorMessage(new Error('Disk full'))).toBe('Disk full')
    expect(errorMessage(new TypeError('Bad input'), 'Could not save.')).toBe('Bad input')
  })

  it('keeps the no-fallback behaviour for empty Error messages and non-Error values', () => {
    expect(errorMessage(new Error(''))).toBe('')
    expect(errorMessage('plain failure')).toBe('plain failure')
    expect(errorMessage(undefined)).toBe('undefined')
    expect(errorMessage(null)).toBe('null')
    expect(errorMessage(42)).toBe('42')
  })

  it('uses the fallback for an Error without a message and for non-Error values', () => {
    expect(errorMessage(new Error(''), 'Could not save.')).toBe('Could not save.')
    expect(errorMessage('plain failure', 'Could not save.')).toBe('Could not save.')
    expect(errorMessage(undefined, 'Could not save.')).toBe('Could not save.')
    expect(errorMessage({ message: 'not an Error' }, 'Could not save.')).toBe('Could not save.')
  })

  it('honours an explicitly empty fallback', () => {
    expect(errorMessage('plain failure', '')).toBe('')
  })
})
