import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { build } from 'esbuild'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

async function closeFixture(application: ElectronApplication): Promise<void> {
  const child = application.process()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      application.close().catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve() }, 5_000) }),
    ])
  } finally { clearTimeout(timer) }
}

// biome-ignore lint/correctness/noEmptyPattern: Playwright derives fixture usage from this destructuring pattern
test('desktop pet leaves its empty gutter clickable while retaining companion interactions', async ({}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'gooeypi-pet-hitbox-'))
  const home = join(directory, 'home')
  await mkdir(home)
  let application: ElectronApplication | undefined
  try {
    const main = join(directory, 'main.cjs')
    await writeFile(main, `const { app, BrowserWindow } = require('electron')
app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))})
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 800, height: 600, useContentSize: true, show: false, webPreferences: { contextIsolation: true, sandbox: true } })
  window.loadFile(${JSON.stringify(join(directory, 'index.html'))})
})`)
    const css = await readFile(new URL('../../src/styles/pets.css', import.meta.url), 'utf8')
    await writeFile(join(directory, 'index.html'), `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div><button id="underlying-action" style="position:fixed;width:20px;height:20px;padding:0" onclick="this.dataset.clicks='1'" aria-label="Underlying action"></button><script type="module" src="./renderer.js"></script>`)
    await build({
      stdin: {
        contents: `import { createRoot } from 'react-dom/client'
import { DesktopPet } from './src/components/DesktopPet'
const pets = { list: async () => [{ id: 'orb', petId: 'orb', displayName: 'Orb', description: 'Orb', source: 'built-in', kind: 'orb' }], sprite: async () => '' }
createRoot(document.getElementById('root')).render(<DesktopPet pets={pets} petId="orb" agentBusy voiceActive={false} reduceMotion><button id="companion-action" onClick={event => { event.currentTarget.dataset.clicks = '1' }}>Companion action</button></DesktopPet>)`,
        loader: 'tsx', resolveDir: fileURLToPath(new URL('../..', import.meta.url)),
      },
      outfile: join(directory, 'renderer.js'), bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic',
      alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) }, logLevel: 'silent',
    })
    application = await electron.launch({ args: [main], env: { HOME: home, PATH: process.env.PATH ?? '', TMPDIR: directory }, timeout: 20_000 })
    await application.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
    const page = await application.firstWindow({ timeout: 15_000 })
    const pet = page.locator('.desktop-pet')
    await expect(pet).toBeVisible()
    const geometry = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('.desktop-pet')!
      const drag = document.querySelector<HTMLElement>('.desktop-pet__drag-target')!
      const rootRect = surface.getBoundingClientRect()
      const dragRect = drag.getBoundingClientRect()
      const point = { x: rootRect.right - 2, y: rootRect.top + 4 }
      const underlying = document.getElementById('underlying-action')!
      underlying.style.left = `${point.x - 10}px`
      underlying.style.top = `${point.y - 10}px`
      return { viewport: { width: innerWidth, height: innerHeight }, root: rootRect.toJSON(), drag: dragRect.toJSON(), point, hit: document.elementFromPoint(point.x, point.y)?.id || document.elementFromPoint(point.x, point.y)?.className }
    })
    await testInfo.attach('pet-hitbox-geometry', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' })
    expect(geometry.point.x).toBeGreaterThan(geometry.drag.right)
    const underlying = page.getByRole('button', { name: 'Underlying action', exact: true })
    await underlying.click({ timeout: 5_000 })
    expect(geometry.hit).toBe('underlying-action')
    await expect(underlying).toHaveAttribute('data-clicks', '1')
    const companion = page.getByRole('button', { name: 'Companion action', exact: true })
    await companion.click()
    await expect(companion).toHaveAttribute('data-clicks', '1')
    const drag = page.getByRole('button', { name: 'Orb, draggable GooeyPi pet' })
    const before = await pet.boundingBox()
    const handle = await drag.boundingBox()
    if (!before || !handle) throw new Error('Missing companion drag bounds')
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width / 2 - 24, handle.y + handle.height / 2)
    await page.mouse.up()
    await expect.poll(async () => (await pet.boundingBox())?.x).toBe(before.x - 24)
  } finally {
    if (application) {
      await application.context().tracing.stop({ path: testInfo.outputPath('pet-hitbox-trace.zip') }).catch(() => undefined)
      await closeFixture(application)
    }
    await rm(directory, { recursive: true, force: true })
  }
})
