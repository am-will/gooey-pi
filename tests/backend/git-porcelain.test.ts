import { describe, expect, it } from 'vitest'
import { changedPathStatesFromStatus, parseNumstat, parseStatus } from '../../electron/main/git-porcelain'

const empty = () => parseNumstat('')
describe('Git NUL-delimited porcelain', () => {
  it('pairs rename statistics with the destination while consuming both name records', () => {
    const staged = parseNumstat('3\t2\t\0old\tname.txt\0new\nname.txt\0-\t-\tbinary.bin\0')
    const status = parseStatus('## main...origin/main [ahead 2, behind 1]\0R  new\nname.txt\0old\tname.txt\0 M binary.bin\0', staged, empty())
    expect(status).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 })
    expect(status.files).toEqual([
      { path: 'new\nname.txt', status: 'R', staged: true, additions: 3, deletions: 2 },
      { path: 'binary.bin', status: 'M', staged: false, additions: 0, deletions: 0 },
    ])
  })

  it('consumes copy sources and retains visible untracked nested repository names', () => {
    const status = parseStatus('C  copied.txt\0source.txt\0?? nested/\0', empty(), empty())
    expect(status.files.map((file) => file.path)).toEqual(['copied.txt', 'nested'])
    expect(changedPathStatesFromStatus('R  next.txt\0previous.txt\0').get('next.txt')?.restorePaths).toEqual(['next.txt', 'previous.txt'])
  })

  it('reports truncation only when statistics exceed the record budget', () => {
    expect(parseNumstat('1\t0\ta\0', 1).truncated).toBe(false)
    const result = parseNumstat('1\t0\ta\x002\t0\tb\0', 1)
    expect(result.values.size).toBe(1)
    expect(result.truncated).toBe(true)
  })
})
