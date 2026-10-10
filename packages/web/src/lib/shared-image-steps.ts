// Live-step folding for shared images: one card per canonical post, whichever of its copies lands first.
import type { SessionStep } from '@/lib/data'
import { applyImageUpdate, newerImageState, type WebchatImageUpdate } from '@/lib/shared-image'

/** Add an image step, or fold it into the card its post already has (a post can precede its live event). */
export function upsertImageStep(steps: SessionStep[], step: SessionStep): SessionStep[] {
  if (!step.postId || !step.sharedImage) return [...steps, step]
  const at = steps.findIndex((s) => s.postId === step.postId && s.sharedImage)
  if (at < 0) return [...steps, step]
  const held = steps[at]!
  const merged = newerImageState(held.sharedImage!, step.sharedImage)
  if (merged === held.sharedImage) return steps
  return [...steps.slice(0, at), { ...held, sharedImage: merged }, ...steps.slice(at + 1)]
}

/** Apply an original-state update to the card of its post; an older revision changes nothing. */
export function applyImageUpdateToSteps(steps: SessionStep[], update: WebchatImageUpdate): SessionStep[] {
  let changed = false
  const next = steps.map((step) => {
    if (step.postId !== update.postId || !step.sharedImage) return step
    const state = applyImageUpdate(step.sharedImage, update)
    if (state === step.sharedImage) return step
    changed = true
    return { ...step, sharedImage: state }
  })
  return changed ? next : steps
}
