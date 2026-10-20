import { ChevronDown, X } from 'lucide-react'
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode, type RefObject, type SelectHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { GOOEYPI_MASCOT_SRC } from '@/lib/assets'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  size?: 'small' | 'regular'
}

export function IconButton({ label, size = 'regular', className = '', children, ...props }: IconButtonProps) {
  return (
    <button type="button" className={`icon-button icon-button--${size} ${className}`} aria-label={label} title={label} {...props}>
      {children}
    </button>
  )
}

export function BrowserGlobe({ size = 18 }: { size?: number }) {
  return (
    <svg
      className="browser-globe"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="3.65" ry="9" />
      <path d="M3 12h18" />
    </svg>
  )
}

interface SelectControlProps extends SelectHTMLAttributes<HTMLSelectElement> {
  icon?: ReactNode
  compact?: boolean
  label: string
}

export function SelectControl({ icon, compact, className = '', label, children, ...props }: SelectControlProps) {
  return (
    <label className={`select-control ${compact ? 'select-control--compact' : ''} ${className}`} title={label}>
      <span className="select-control__icon" aria-hidden="true">{icon}</span>
      <span className="sr-only">{label}</span>
      <select aria-label={label} {...props}>{children}</select>
      <ChevronDown className="select-control__chevron" size={12} aria-hidden="true" />
    </label>
  )
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange(value: T): void
  label: string
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={value === option.value ? 'is-active' : ''}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-state__icon">{icon}</div> : null}
      <h2>{title}</h2>
      <p>{children}</p>
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  )
}

const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function useFocusTrap<T extends HTMLElement>(active: boolean, onEscape?: () => void): RefObject<T | null> {
  const containerRef = useRef<T>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const escapeRef = useRef(onEscape)
  escapeRef.current = onEscape
  useEffect(() => {
    if (!active || !containerRef.current) return
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const container = containerRef.current
    const focusInitial = () => {
      const preferred = container.querySelector<HTMLElement>('[autofocus]')
      const first = preferred ?? container.querySelector<HTMLElement>(focusableSelector)
      first?.focus()
    }
    const frame = requestAnimationFrame(focusInitial)
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.target instanceof Node) || !container.contains(event.target)) return
      if (event.key === 'Escape' && escapeRef.current) { event.preventDefault(); escapeRef.current(); return }
      if (event.key !== 'Tab') return
      const items = [...container.querySelectorAll<HTMLElement>(focusableSelector)].filter((item) => !item.hidden && item.getClientRects().length > 0)
      if (!items.length) { event.preventDefault(); container.focus(); return }
      const first = items[0]; const last = items.at(-1)!
      if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown, true)
      const restore = previousFocus.current
      requestAnimationFrame(() => { if (restore?.isConnected) restore.focus() })
    }
  }, [active])
  return containerRef
}

// Overlays (modals, the command palette) share one refcount so stacked or
// sibling overlays only toggle the app shell's inert state on 0<->1 transitions.
let appShellOverlayCount = 0

export function useAppShellOverlay(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const shell = document.querySelector<HTMLElement>('.app-shell')
    if (!shell) return
    appShellOverlayCount += 1
    if (appShellOverlayCount === 1) { shell.inert = true; shell.setAttribute('aria-hidden', 'true') }
    return () => {
      appShellOverlayCount -= 1
      if (appShellOverlayCount === 0) { shell.inert = false; shell.removeAttribute('aria-hidden') }
    }
  }, [active])
}

export function Modal({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose(): void; footer?: ReactNode }) {
  const titleId = useId()
  const modalRef = useFocusTrap<HTMLElement>(true, onClose)
  useAppShellOverlay(true)
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={modalRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal__header"><h2 id={titleId}>{title}</h2><IconButton label="Close" onClick={onClose}><X size={16} /></IconButton></div>
        <div className="modal__body">{children}</div>
        {footer ? <div className="modal__footer">{footer}</div> : null}
      </section>
    </div>, document.body
  )
}

export function OmpMark({ size = 24 }: { size?: number }) {
  // The prong slots are cut out with a mask so the tile background shows
  // through, matching assets/brand/omp-icon.svg. useId keeps mask references
  // unique when several marks render at once (brand button plus its menu).
  const maskId = `omp-mark-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <span className="omp-mark" style={{ width: size, height: size }} role="img" aria-label="OMP">
      <svg viewBox="0 0 120 90" fill="none" focusable="false" aria-hidden="true">
        <mask id={maskId} maskUnits="userSpaceOnUse">
          <rect x="0" y="0" width="120" height="90" fill="#fff" />
          <rect x="76" y="59" width="3" height="8" rx="1" fill="#000" />
          <rect x="82" y="59" width="3" height="8" rx="1" fill="#000" />
        </mask>
        <g mask={`url(#${maskId})`}>
          <rect x="10" y="8" width="100" height="12" rx="2" fill="currentColor" />
          <rect x="25" y="20" width="12" height="62" rx="2" fill="currentColor" />
          <rect x="75" y="20" width="12" height="45" rx="2" fill="currentColor" />
          <rect x="71" y="55" width="20" height="16" rx="3" fill="#f97316" />
        </g>
        <circle cx="18" cy="14" r="2" fill="#f97316" opacity="0.8" />
        <circle cx="102" cy="14" r="2" fill="#f97316" opacity="0.8" />
      </svg>
    </span>
  )
}

export function PrimeMark({ size = 24 }: { size?: number }) {
  return (
    <span className="prime-mark" style={{ width: size, height: size }} role="img" aria-label="Prime Intellect">
      <svg viewBox="0 0 178 178" fill="none" focusable="false" aria-hidden="true">
        <path d="m 123.322,84.092671 c -0.192,0.0065 -0.43,0.0147 -0.74,0.0147 l -0.018,-0.0247 c -0.873,0.1977 -1.958,0.1266 -3.067,0.0537 -3.29,-0.216 -6.799,-0.4465 -5.635,6.2824 0.259,1.4822 -1.538,1.8465 -2.73,1.9082 -3.384,0.1853 -6.78,0.2594 -10.171,0.1915 -0.641,-0.0106 -1.2979,-0.5506 -1.8904,-1.0388 -0.1022,-0.0844 -0.2034,-0.1673 -0.3016,-0.2457 -0.1052,-0.0865 0.2898,-1.2042 0.4942,-1.2166 3.3078,-0.1931 4.5068,-2.4361 5.7028,-4.6724 0.603,-1.1253 1.204,-2.2488 2.072,-3.1088 7.856,-7.7874 15.878,-15.4265 25.054,-21.7008 0.895,-0.6114 1.989,-1.1733 2.73,-0.1111 0.571,0.8205 0.036,1.2854 -0.512,1.7627 -0.24,0.2088 -0.482,0.4199 -0.637,0.6642 -0.554,0.8792 -1.538,1.5273 -2.514,2.1717 -1.92,1.2655 -3.82,2.5172 -2.408,5.4798 1.225,2.5651 0.129,3.0202 -1.555,3.7198 l -0.069,0.0287 c -0.72,0.3021 -1.458,0.5764 -2.194,0.8506 -1.568,0.5835 -3.134,1.1662 -4.537,2.0149 -1.408,0.8522 -2.081,2.5134 0.222,3.4954 5.033,2.1428 18.064,-1.2784 20.608,-5.9965 2.377,-4.4147 5.931,-7.6891 9.481,-10.9611 1.992,-1.836 3.984,-3.6712 5.767,-5.7067 3.844,-4.3849 8.344,-8.1939 12.846,-12.005 2.239,-1.8944 4.478,-3.78938 6.637,-5.75588 1.624,-1.48207 2.297,-3.43353 1.026,-5.56412 -1.267,-2.118215 -3.416,-2.402287 -5.435,-1.926802 -13.309,3.130982 -26.166,7.355122 -37.585,15.241302 -18.23,12.5919 -36.4911,25.1406 -54.9002,37.4669 -6.2743,4.2056 -10.0723,2.1491 -12.1657,-5.1318 -4.6502,-16.1676 -11.4681,-30.2664 -31.0569,-32.4587 -7.1574,-0.8028 -12.4066,3.6807 -11.3692,10.7949 0.5249,3.6065 0.0495,7.003 -1.6858,10.3872 -0.3827,0.7472 -0.7689,1.4947 -1.1556,2.243 -2.672,5.1706 -5.3671,10.3857 -7.0394,15.8885 -0.1399,0.4602 -0.3002,0.9444 -0.4654,1.4437 -1.4909,4.5052 -3.3862,10.2323 5.659,10.5492 0.3705,0.0123 1.0808,0.944799 0.9943,1.290699 -0.1976,0.8213 -0.5991,1.797 -1.2413,2.2725 -8.6705,6.3917 -15.79706,14.1294 -18.860151,24.5971 -1.550066,5.2865 -0.524909,10.7765 3.989391,14.8705 3.22984,2.928 7.35516,4.625 10.97396,2.162 3.3009,-2.247 6.9232,-3.754 10.538,-5.259 3.1819,-1.324 6.358,-2.646 9.3041,-4.468 0.7101,-0.439 1.5727,-0.841 2.4456,-1.248 2.4138,-1.1228 4.9063,-2.2843 4.4709,-4.3841 -0.6854,-3.2908 -4.1623,-6.3418 -7.0586,-8.7384 -2.8716,-2.3769 -10.1897,-18.3411 -9.3189,-22.176099 1.2193,-5.3704 3.9645,-10.0201 6.7125,-14.6744 2.3458,-3.9731 4.6935,-7.9497 6.0956,-12.3806 0.5804,-1.828 2.8037,-2.8284 4.9466,-2.0997 1.4543,0.4928 1.2068,1.8278 0.9762,3.0715 -0.0063,0.0344 -0.0127,0.0685 -0.019,0.1027 -0.8688,4.7802 -1.721,9.566 -2.5733,14.3517 -0.4261,2.3924 -0.8521,4.7847 -1.2803,7.1762 -0.2717,1.5316 0.2038,2.7544 1.7909,3.0631 3.0569,0.599 2.989,1.9762 1.6119,4.341499 -1.4636,2.5072 -1.6674,5.5703 -0.0309,7.8861 1.6427,2.3282 4.3908,2.8161 7.1821,1.4204 1.7415,-0.8646 3.094,-0.0927 3.0755,1.6612 -0.1112,9.3688 3.8103,7.2561 8.584,3.1681 0.439,-0.3763 1.0373,-0.5846 1.6152,-0.7857 0.1048,-0.0366 0.2091,-0.0728 0.3116,-0.1098 0.4529,-0.1616 0.9062,-0.3224 1.3595,-0.4833 8.986,-3.1884 17.9603,-6.3725 23.0334,-15.573099 0.392,-0.7187 1.6783,-1.0669 2.6795,-1.3377 0.057,-0.0154 0.113,-0.0307 0.1681,-0.0456 5.8013,-1.5766 11.7248,-1.6001 17.6438,-1.6237 4.445,-0.0176 8.888,-0.0352 13.277,-0.7107 4.329,-0.667 9.047,-3.1928 9.084,-7.3736 0.035,-3.3707 -2.546,-3.1612 -5.123,-2.9519 -1.115,0.0906 -2.231,0.1811 -3.134,-0.0185 -0.182,-0.0381 -0.375,-0.0316 -0.686,-0.0209 z" fill="currentColor" />
        <path d="m 55.1325,131.29447 c -1.0745,7.1515 1.6551,13.2715 12.8266,13.1915 h -0.0062 c 9.5413,-0.389 20.3365,-6.164 30.8838,-13.5492 6.9653,-4.8787 12.9873,-10.0236 16.8903,-17.6253 2.872,-5.5889 1.395,-10.0723 -2.933,-13.993799 -1.908,-1.7291 -3.73,-1.9205 -5.867,0.1667 -7.5842,7.423099 -17.0261,11.474299 -26.7218,15.550099 -2.4706,1.0393 -5.2847,1.5582 -8.1187,2.0809 -7.5511,1.3924 -15.2431,2.8103 -16.954,14.1791 z" fill="currentColor" />
      </svg>
    </span>
  )
}

export function PiMark({ size = 24 }: { size?: number }) {
  // A plain geometric π: overhanging crossbar with two inset legs, drawn in
  // currentColor so the tile styling matches the other harness marks.
  return (
    <span className="pi-mark" style={{ width: size, height: size }} role="img" aria-label="Pi">
      <svg viewBox="0 0 120 90" fill="none" focusable="false" aria-hidden="true">
        <rect x="12" y="12" width="96" height="13" rx="2.5" fill="currentColor" />
        <rect x="31" y="25" width="13" height="53" rx="2.5" fill="currentColor" />
        <rect x="76" y="25" width="13" height="43" rx="2.5" fill="currentColor" />
        <path d="M76 68 h13 v4 a6 6 0 0 1 -6 6 h-1 a6 6 0 0 1 -6 -6 z" fill="currentColor" />
      </svg>
    </span>
  )
}

export function GooeyPiMark({ size = 24 }: { size?: number }) {
  return (
    <span className="gooeypi-mark" style={{ width: size, height: size }} role="img" aria-label="GooeyPi">
      <img src={GOOEYPI_MASCOT_SRC} alt="" aria-hidden="true" />
    </span>
  )
}
