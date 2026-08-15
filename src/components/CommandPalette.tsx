import { Bell, CalendarClock, Folder, LayoutPanelLeft, NotebookPen, PackageOpen, Search, Settings, Terminal, } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { WorkspaceView } from '@/types/api'
import { shortcutLabel } from '@/lib/platform-shortcuts'
import { BrowserGlobe, useAppShellOverlay, useFocusTrap } from './ui'

interface Command { id:string; label:string; detail:string; shortcut?:string; icon:ReactNode; run():void }

export function CommandPalette({ open, onClose, onNavigate, onNewSession, onToggleSidebar, onToggleTerminal, onOpenBrowser, platform = 'darwin' }: { open:boolean; onClose():void; onNavigate(view:WorkspaceView):void; onNewSession():void; onToggleSidebar():void; onToggleTerminal():void; onOpenBrowser():void; platform?:NodeJS.Platform }) {
  const [query,setQuery]=useState('')
  const [active,setActive]=useState(0)
  const inputRef=useRef<HTMLInputElement>(null)
  const paletteRef=useFocusTrap<HTMLDivElement>(open,onClose)
  const commands:Command[]=[
    {id:'new',label:'New session',detail:'Start fresh in the current project',shortcut:shortcutLabel(platform, ['Primary', 'N']),icon:<NotebookPen size={14}/>,run:onNewSession},
    {id:'projects',label:'Open Projects',detail:'Browse local workspaces',icon:<Folder size={14}/>,run:()=>onNavigate('projects')},
    {id:'activity',label:'Open Activity',detail:'See work that needs attention',icon:<Bell size={14}/>,run:()=>onNavigate('activity')},
    {id:'scheduled',label:'Open Scheduled',detail:'Manage recurring work',icon:<CalendarClock size={14}/>,run:()=>onNavigate('scheduled')},
    {id:'plugins',label:'Open Capabilities',detail:'Extend the active harness',icon:<PackageOpen size={14}/>,run:()=>onNavigate('plugins')},
    {id:'browser',label:'Toggle browser',detail:'Open the in-app browser',shortcut:shortcutLabel(platform, ['Primary', 'Shift', 'B']),icon:<BrowserGlobe size={14}/>,run:onOpenBrowser},
    {id:'terminal',label:'Toggle terminal',detail:'Open a project shell',shortcut:shortcutLabel(platform, ['Primary', 'J']),icon:<Terminal size={14}/>,run:onToggleTerminal},
    {id:'sidebar',label:'Toggle sidebar',detail:'Show or hide project navigation',shortcut:shortcutLabel(platform, ['Primary', 'B']),icon:<LayoutPanelLeft size={14}/>,run:onToggleSidebar},
    {id:'settings',label:'Open Settings',detail:'Configure GooeyPi',shortcut:shortcutLabel(platform, ['Primary', ',']),icon:<Settings size={14}/>,run:()=>onNavigate('settings')},
  ]
  const visible=commands.filter((command)=>`${command.label} ${command.detail}`.toLowerCase().includes(query.toLowerCase()))
  useEffect(()=>{if(open){setQuery('');setActive(0);requestAnimationFrame(()=>inputRef.current?.focus())}},[open])
  useEffect(()=>setActive(0),[query])
  useAppShellOverlay(open)
  if(!open)return null
  const choose=(command?:Command)=>{if(!command)return;command.run();onClose()}
  return createPortal(<div className="palette-backdrop" onMouseDown={(event)=>event.target===event.currentTarget&&onClose()}><div ref={paletteRef} className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" tabIndex={-1}><div className="command-search"><Search size={16}/><input ref={inputRef} value={query} role="combobox" aria-expanded="true" aria-controls="command-results" aria-activedescendant={visible[active] ? `command-${visible[active].id}` : undefined} onChange={(event)=>setQuery(event.target.value)} placeholder="Search commands, projects, and sessions" onKeyDown={(event)=>{if(event.key==='ArrowDown'){event.preventDefault();setActive((value)=>Math.min(visible.length-1,value+1))}if(event.key==='ArrowUp'){event.preventDefault();setActive((value)=>Math.max(0,value-1))}if(event.key==='Enter'){event.preventDefault();choose(visible[active])}if(event.key==='Escape')onClose()}}/><button type="button" onClick={onClose} aria-label="Close command palette"><kbd>esc</kbd></button></div><div id="command-results" className="command-results" role="listbox" aria-label="Commands"><div className="command-section-label">Commands</div>{visible.map((command,index)=><button id={`command-${command.id}`} type="button" role="option" aria-selected={index===active} key={command.id} className={index===active?'is-active':''} onMouseEnter={()=>setActive(index)} onClick={()=>choose(command)}><span>{command.icon}</span><span><strong>{command.label}</strong><small>{command.detail}</small></span>{command.shortcut?<kbd>{command.shortcut}</kbd>:null}</button>)}{visible.length===0?<p>No commands match “{query}”.</p>:null}</div><footer><span>↑↓ Navigate</span><span>↵ Open</span><span>esc Close</span></footer> </div></div>,document.body)
}
