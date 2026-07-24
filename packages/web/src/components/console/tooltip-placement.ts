/**
 * Geometry + eligibility for the console's hover tooltips, kept free of the DOM
 * so it stays unit-testable (the web suite runs in vitest's `node` environment).
 *
 * The console annotates ~150 controls with a plain `title` attribute. The browser
 * renders those after a ~1s delay in OS chrome that ignores the design tokens;
 * `Tooltip.tsx` intercepts them and re-renders them on the design system's own
 * timing. The numbers below are that timing.
 */

/** Hover dwell before a tooltip appears — the design system's `--duration-fast`. */
export const TOOLTIP_SHOW_DELAY_MS = 120

/**
 * After one tooltip closes, the next opens with no dwell at all. Sweeping a row
 * of icon buttons should read as one tooltip re-labelling itself, not as five
 * separate 120ms waits.
 */
export const TOOLTIP_WARM_MS = 320

/** Gap between the anchor and the tooltip, and the minimum inset from the viewport edge. */
export const TOOLTIP_GAP = 6
export const TOOLTIP_EDGE = 8

export interface Box {
  top: number
  left: number
  width: number
  height: number
}
export interface Size {
  width: number
  height: number
}

export type TooltipPlacement = 'top' | 'bottom'

export interface TooltipPosition {
  left: number
  top: number
  placement: TooltipPlacement
}

function clamp(value: number, min: number, max: number): number {
  // `max < min` when the tooltip is wider/taller than the viewport allows —
  // pin to the near edge rather than inverting the clamp.
  return Math.max(min, Math.min(value, Math.max(min, max)))
}

/**
 * Position a tooltip against its anchor in viewport coordinates (the layer is
 * `position: fixed`, so these are the final `left`/`top`).
 *
 * Prefers above — that is where the design's tooltips sit and it keeps the
 * pointer from covering the label — and flips below only when above would clip.
 */
export function placeTooltip(anchor: Box, tip: Size, viewport: Size): TooltipPosition {
  const above = anchor.top - tip.height - TOOLTIP_GAP
  const below = anchor.top + anchor.height + TOOLTIP_GAP

  const fitsAbove = above >= TOOLTIP_EDGE
  const fitsBelow = below + tip.height <= viewport.height - TOOLTIP_EDGE
  const roomAbove = anchor.top
  const roomBelow = viewport.height - (anchor.top + anchor.height)
  const placement: TooltipPlacement = fitsAbove
    ? 'top'
    : fitsBelow
      ? 'bottom'
      : // Neither side fits: take the roomier one and let the clamp do the rest.
        roomAbove >= roomBelow
        ? 'top'
        : 'bottom'

  return {
    left: clamp(
      anchor.left + anchor.width / 2 - tip.width / 2,
      TOOLTIP_EDGE,
      viewport.width - tip.width - TOOLTIP_EDGE
    ),
    top: clamp(placement === 'top' ? above : below, TOOLTIP_EDGE, viewport.height - tip.height - TOOLTIP_EDGE),
    placement
  }
}

/**
 * Tags whose `title` is machine metadata rather than a hover hint — an
 * `<iframe title>` is its accessible name, and `<svg><title>` is an element,
 * not an attribute. Surfacing either as a floating label would be noise.
 */
const NON_HINT_TAGS = new Set(['IFRAME', 'SVG', 'TITLE', 'LINK', 'STYLE', 'HEAD', 'META'])

/** Whether an element's `title` should be re-rendered as a console tooltip. */
export function isTooltipSource(tagName: string, title: string): boolean {
  return title.trim().length > 0 && !NON_HINT_TAGS.has(tagName.toUpperCase())
}
