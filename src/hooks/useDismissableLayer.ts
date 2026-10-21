import { useEffect, useLayoutEffect, useRef } from 'react'

export interface DismissableLayerOptions {
  /** Dismiss on Escape as well as on an outside pointerdown. Defaults to true. */
  escape?: boolean
}

/**
 * Close a popover or menu while `open`: a capture-phase `pointerdown` whose
 * target `isInside` rejects dismisses it, and so does Escape unless disabled.
 * Escape is handled in the capture phase and default-prevented, so the window
 * shortcut handler (which skips prevented events) does not also act on it.
 * The latest `isInside`/`onDismiss` are read through refs, so listeners only
 * re-register when `open` or the Escape option changes.
 */
export function useDismissableLayer(
  open: boolean,
  isInside: (target: EventTarget | null) => boolean,
  onDismiss: () => void,
  options: DismissableLayerOptions = {},
): void {
  const isInsideRef = useRef(isInside)
  const onDismissRef = useRef(onDismiss)
  useLayoutEffect(() => {
    isInsideRef.current = isInside
    onDismissRef.current = onDismiss
  })
  const dismissOnEscapeKey = options.escape !== false
  useEffect(() => {
    if (!open) return
    const dismissOutside = (event: PointerEvent) => { if (!isInsideRef.current(event.target)) onDismissRef.current() }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onDismissRef.current()
    }
    document.addEventListener('pointerdown', dismissOutside, true)
    if (dismissOnEscapeKey) document.addEventListener('keydown', dismissOnEscape, true)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true)
      document.removeEventListener('keydown', dismissOnEscape, true)
    }
  }, [open, dismissOnEscapeKey])
}
