import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareProjectSettingsPath, validateCapabilityMutation, validateMcpConnection, validateMcpStateInput } from '../../electron/main/plugins/mcp'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const connection = { name: 'files', scope: 'user', type: 'stdio', command: 'node', args: ['server.js', '--read-only'] }

describe('MCP mutation validation', () => {
  it.each(['omp', 'pi'] as const)('accepts valid local stdio configuration for %s', (harness) => {
    expect(validateMcpConnection(connection, harness)).toMatchObject(connection)
    expect(validateMcpStateInput({ name: 'files', scope: 'user', enabled: false }, harness)).toMatchObject({ enabled: false })
  })

  it.each(['--help', '-rf', 'node\n--evil', 'node\r--evil', 'node\0suffix', 'node\u2028suffix'])('rejects an invalid executable %j', (command) => {
    expect(() => validateMcpConnection({ ...connection, command }, 'omp')).toThrow()
  })

  it.each(['line\nnext', 'line\rnext', 'nul\0next', 'separator\u2029next'])('rejects command-argument control characters %j', (argument) => {
    expect(() => validateMcpConnection({ ...connection, args: [argument] }, 'pi')).toThrow()
  })

  it('bounds argument counts, rejects network setup and requires project context', () => {
    expect(() => validateMcpConnection({ ...connection, args: Array(65).fill('arg') }, 'omp')).toThrow('maximum count')
    expect(() => validateMcpConnection({ name: 'remote', scope: 'user', type: 'http', url: 'https://example.test' }, 'omp')).toThrow()
    expect(() => validateMcpStateInput({ name: 'files', scope: 'project', enabled: true }, 'pi')).toThrow('projectPath')
    expect(() => validateMcpStateInput({ name: 'files', scope: 'user', enabled: 'yes' }, 'pi')).toThrow('boolean')
  })

  it.each(['__proto__', 'prototype', 'constructor', '-flag', 'bad/name'])('rejects unsafe state names %s', (name) => {
    expect(() => validateMcpStateInput({ name, scope: 'user', enabled: true }, 'omp')).toThrow()
  })

  it.each(['--help', 'npm:package\n--evil', 'npm:package\0evil'])('rejects unsafe package mutation sources %j', (source) => {
    expect(() => validateCapabilityMutation({ kind: 'package', action: 'disable', name: 'tools', source, scope: 'user' }, 'omp')).toThrow()
  })

  it.skipIf(process.platform === 'win32')('rejects configuration-directory symlinks escaping an authorized project', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gooeypi-mcp-validation-'))
    directories.push(directory)
    const project = join(directory, 'project')
    const outside = join(directory, 'outside')
    mkdirSync(project); mkdirSync(outside)
    symlinkSync(outside, join(project, '.omp'))
    await expect(prepareProjectSettingsPath(project, { segments: ['.omp'], filename: 'mcp.json' })).rejects.toThrow('real directory')
  })
})
