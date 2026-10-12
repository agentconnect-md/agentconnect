'use client'

import { useEffect, useRef, type MouseEventHandler, type ReactNode } from 'react'

type Layer = { dismiss: () => void }

// Open dialog layers, bottom to top; Escape dismisses only the topmost one.
const layers: Layer[] = []

function onKeyDown(event: KeyboardEvent) {
  // An open menu inside the dialog claims Escape by preventing it; an IME uses it to cancel composition.
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
  const top = layers.at(-1)
  if (!top) return
  event.preventDefault()
  top.dismiss()
}

/** Stacks a dialog layer while mounted; Escape calls `onEscape` when this layer is on top, or is swallowed without it (busy). */
export function useEscapeLayer(onEscape: (() => void) | undefined) {
  const handler = useRef(onEscape)
  useEffect(() => {
    handler.current = onEscape
  })
  useEffect(() => {
    const layer: Layer = { dismiss: () => handler.current?.() }
    layers.push(layer)
    if (layers.length === 1) window.addEventListener('keydown', onKeyDown)
    return () => {
      layers.splice(layers.indexOf(layer), 1)
      if (layers.length === 0) window.removeEventListener('keydown', onKeyDown)
    }
  }, [])
}

/** `useEscapeLayer` for an overlay that renders its own backdrop. */
export function EscapeLayer({ onEscape }: { onEscape: (() => void) | undefined }) {
  useEscapeLayer(onEscape)
  return null
}

/** The `.scrim` backdrop of a dialog, closing it on Escape; a click whose press began inside the dialog (a drag out) is ignored. */
export function Scrim({
  onEscape,
  onClick,
  children
}: {
  onEscape: (() => void) | undefined
  onClick?: MouseEventHandler<HTMLDivElement>
  children: ReactNode
}) {
  useEscapeLayer(onEscape)
  const pressedInside = useRef(false)
  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        pressedInside.current = event.target !== event.currentTarget
      }}
      onClick={(event) => {
        const dragged = pressedInside.current
        pressedInside.current = false
        if (!dragged) onClick?.(event)
      }}
    >
      {children}
    </div>
  )
}
