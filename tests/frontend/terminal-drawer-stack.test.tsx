// @vitest-environment jsdom
import { act, forwardRef, useEffect, useImperativeHandle, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { TerminalDrawer as DrawerComponent, TerminalDrawerHandle } from '../../src/components/TerminalDrawer'
import { TerminalDrawerStack } from '../../src/components/TerminalDrawerStack'
import type { TerminalSessionMount } from '../../src/app/terminal-sessions'

const loading = vi.hoisted(() => {
  let finish!: () => void
  return { promise: new Promise<void>((resolve) => { finish = resolve }), finish: () => finish(), mounts: 0 }
})
vi.mock('@/components/TerminalDrawer', async () => {
  await loading.promise
  return {
    TerminalDrawer: forwardRef<TerminalDrawerHandle, ComponentProps<typeof DrawerComponent>>(function Drawer(props, ref) {
      useImperativeHandle(ref, () => ({ clearSelection() {}, readSelectionContext: () => undefined, runCommand: () => 'tab', stopCommand() {} }), [])
      useEffect(() => { loading.mounts += 1; props.onReady?.(); return () => { loading.mounts -= 1 } }, [])
      useEffect(() => { if (!props.visible) props.onSelectionChange?.() }, [props.visible])
      return <section data-drawer={props.cwd} hidden={!props.visible}>
        <input defaultValue="retained" />
        <button type="button" data-action="close" onClick={props.onClose}>Close</button>
        <button type="button" data-action="consumed" onClick={props.onInitialCommandConsumed}>Consumed</button>
        <button type="button" data-action="selection" onClick={() => props.onSelectionChange?.({ tabId: 'tab', label: 'shell', text: 'selected', truncated: false })}>Select</button>
      </section>
    }),
  }
})
globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('gates lazy fallbacks and drawers by parent visibility while retaining keyed instances and callbacks', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const drawerRefs = { current: new Map<string, TerminalDrawerHandle>() }
  const onClose = vi.fn(); const onInitialCommandConsumed = vi.fn(); const onSelectionChange = vi.fn(); const onReady = vi.fn()
  const terminals: TerminalSessionMount[] = [{ id: 'one', workspaceKey: 'a', cwd: '/one' }, { id: 'two', workspaceKey: 'b', cwd: '/two' }]
  let visible = false
  const render = () => root.render(<TerminalDrawerStack terminals={terminals} activeId="two" visible={visible} drawerRefs={drawerRefs} height={200} minHeight={100} maxHeight={400} defaultHeight={200} onHeightChange={() => undefined} onClose={onClose} onInitialCommandConsumed={onInitialCommandConsumed} onSelectionChange={onSelectionChange} onReady={onReady} />)
  const click = async (drawer: string, action: string) => {
    const button = host.querySelector(`[data-drawer="${drawer}"] [data-action="${action}"]`)
    if (!button) throw new Error('Missing test drawer button')
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  }
  try {
    await act(async () => { render() })
    expect(host.querySelector('.terminal-drawer--loading')).toBeNull()
    visible = true
    await act(async () => { render() })
    expect(host.querySelectorAll('.terminal-drawer--loading')).toHaveLength(1)
    visible = false
    await act(async () => { render() })
    expect(host.querySelector('.terminal-drawer--loading')).toBeNull()
    await act(async () => { loading.finish(); await loading.promise })
    expect(loading.mounts).toBe(2)
    expect(drawerRefs.current.size).toBe(2)
    expect(onReady).toHaveBeenCalledTimes(2)
    expect([...host.querySelectorAll('section')].every((drawer) => drawer.hidden)).toBe(true)
    visible = true
    await act(async () => { render() })
    const input = host.querySelector<HTMLInputElement>('[data-drawer="/two"] input')!
    input.value = 'keep this terminal state'
    onSelectionChange.mockClear()
    await click('/one', 'selection')
    expect(onSelectionChange).not.toHaveBeenCalled()
    await click('/two', 'selection')
    expect(onSelectionChange).toHaveBeenCalledWith({ tabId: 'tab', label: 'shell', text: 'selected', truncated: false })
    await click('/two', 'close'); await click('/two', 'consumed')
    expect(onClose).toHaveBeenCalledWith('two')
    expect(onInitialCommandConsumed).toHaveBeenCalledWith('two')
    onSelectionChange.mockClear()
    visible = false
    await act(async () => { render() })
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith(undefined)
    visible = true
    await act(async () => { render() })
    expect(host.querySelector('[data-drawer="/two"] input')).toBe(input)
    expect(input.value).toBe('keep this terminal state')
    expect(loading.mounts).toBe(2)
    await act(async () => { root.render(null) })
    expect(drawerRefs.current.size).toBe(0)
    expect(loading.mounts).toBe(0)
  } finally { await act(async () => root.unmount()); host.remove() }
})
