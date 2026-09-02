import { describe, expect, it } from 'vitest'
import { sortProjects } from '../../src/lib/project-order'
import type { ProjectRecord } from '../../src/types/api'

function project(id: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id,
    harness: 'prime',
    name: id,
    path: `/${id}`,
    folders: [`/${id}`],
    primaryFolder: `/${id}`,
    pinned: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastOpenedAt: '2026-01-01T00:00:00.000Z',
    sessionCount: 0,
    ...overrides,
  }
}

describe('sortProjects', () => {
  it('puts pinned projects first and sorts remaining projects by recent activity', () => {
    const projects = [
      project('old-pinned', { pinned: true, lastOpenedAt: '2020-01-01T00:00:00.000Z' }),
      project('new', { lastOpenedAt: '2026-03-01T00:00:00.000Z' }),
      project('new-pinned', { pinned: true, lastOpenedAt: '2026-04-01T00:00:00.000Z' }),
      project('old', { lastOpenedAt: '2020-02-01T00:00:00.000Z' }),
    ]

    expect(sortProjects(projects, 'recent').map(({ id }) => id)).toEqual(['new-pinned', 'old-pinned', 'new', 'old'])
  })

  it('sorts alphabetically with case-insensitive numeric names', () => {
    const projects = [
      project('z', { name: 'project 10' }),
      project('a', { name: 'Project 2' }),
      project('m', { name: 'alpha' }),
    ]

    expect(sortProjects(projects, 'alphabetical').map(({ id }) => id)).toEqual(['m', 'a', 'z'])
  })

  it('uses ids to break ties for equal timestamps and names', () => {
    const recent = [
      project('z', { lastOpenedAt: '2026-01-01T00:00:00.000Z' }),
      project('a', { lastOpenedAt: '2026-01-01T00:00:00.000Z' }),
    ]
    const alphabetical = [
      project('z', { name: 'Same' }),
      project('a', { name: 'same' }),
    ]

    expect(sortProjects(recent, 'recent').map(({ id }) => id)).toEqual(['a', 'z'])
    expect(sortProjects(alphabetical, 'alphabetical').map(({ id }) => id)).toEqual(['a', 'z'])
  })

  it('puts unparseable recent dates last and does not mutate the input', () => {
    const projects = [
      project('invalid', { lastOpenedAt: 'not-a-date' }),
      project('valid', { lastOpenedAt: '2026-01-01T00:00:00.000Z' }),
    ]
    const original = [...projects]

    expect(sortProjects(projects, 'recent').map(({ id }) => id)).toEqual(['valid', 'invalid'])
    expect(projects).toEqual(original)
  })
})
