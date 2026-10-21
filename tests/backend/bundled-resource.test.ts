import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bundledResourcePath, resolveExtensionPath } from '../../electron/main/extension-manifest'

describe('bundled resource location', () => {
  it.each([false, true])('keeps extensions, skills, icons and pets under the same packaged=%s root', (isPackaged) => {
    const context = { isPackaged, appPath: '/workspace', resourcesPath: '/installed/resources' }
    const root = isPackaged ? '/installed/resources' : '/workspace/assets'
    expect(bundledResourcePath(context, 'icon.png')).toBe(join(root, 'icon.png'))
    expect(bundledResourcePath(context, 'pets')).toBe(join(root, 'pets'))
    expect(bundledResourcePath(context, 'skills', 'browser', 'SKILL.md')).toBe(join(root, 'skills', 'browser', 'SKILL.md'))
    expect(resolveExtensionPath('browser.ts', context)).toBe(join(root, 'extensions', 'browser.ts'))
  })
})
