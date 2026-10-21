import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { expect, it } from 'vitest'
import { GitService } from '../../electron/main/git'
import { resolveGitExecutable } from '../../electron/main/process-utils'

it.skipIf(process.platform !== 'win32')('uses installed Git even when the repository contains git.exe', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gooeypi-windows-git-'))
  try {
    const initialized = spawnSync('git', ['init', '-q'], { cwd, encoding: 'utf8', shell: false })
    expect(initialized.status, initialized.stderr).toBe(0)
    // A bare Windows executable lookup would select this invalid local image.
    writeFileSync(join(cwd, 'git.exe'), 'This project file must never be launched.\n')
    const executable = resolveGitExecutable(cwd)
    expect(win32.isAbsolute(executable)).toBe(true)
    expect(win32.relative(cwd, executable)).toMatch(/^\.\.\\|^[A-Za-z]:\\|^\\\\/)
    const service = new GitService(async () => cwd)
    const status = await service.status(cwd)
    expect(status.isRepo, status.error).toBe(true)
    expect(status.files.some((file) => file.path === 'git.exe')).toBe(true)
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5 })
  }
})
