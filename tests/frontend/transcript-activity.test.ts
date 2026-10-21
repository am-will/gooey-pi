import { describe, expect, it } from 'vitest'
import { classifyTool, formatWorkedDuration } from '../../src/components/transcript/timeline'

describe('transcript activity presentation', () => {
  it('formats only the elapsed units that are needed', () => {
    expect(formatWorkedDuration(8_000)).toBe('8s')
    expect(formatWorkedDuration(128_000)).toBe('2m08s')
    expect(formatWorkedDuration(3_728_000)).toBe('1h02m08s')
    expect(formatWorkedDuration(59 * 60_000 + 59_000)).toBe('59m59s')
  })

  it('maps tool names to recognizable activity icons', () => {
    expect(classifyTool('ask_user')).toBe('question')
    expect(classifyTool('bash')).toBe('terminal')
    expect(classifyTool('ipython')).toBe('terminal')
    expect(classifyTool('eval')).toBe('terminal')
    expect(classifyTool('web_search')).toBe('web')
    expect(classifyTool('git status')).toBe('git')
    expect(classifyTool('read_file')).toBe('file')
    expect(classifyTool('custom_mcp_tool')).toBe('mcp')
    expect(classifyTool('retrieval')).toBe('mcp')
  })
})
