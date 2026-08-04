// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import { useLayoutEffect } from 'react'
import type { WizardFooterState, WizardHost, WizardIdentityChromeState } from './contract'

// The two publication channels a wizard Body drives on the host chassis. Both
// run as layout effects with NO dependency array on purpose:
//
//  - no array ⇒ the publication is re-stated on every commit, so the footer can
//    never lag a keystroke behind the pane that owns it and no Body has to
//    hand-maintain a dependency list of its own state;
//  - layout, not passive ⇒ the host re-renders before paint, so the modal never
//    shows one frame of a stale (or missing) primary;
//  - safe from looping ONLY because the host stores the rendered PROJECTION of a
//    publication ({@link footerView} / {@link identityChromeView}) and keeps the
//    previous object when it is unchanged ({@link sameFooterView} /
//    {@link sameIdentityChromeView}). Publishing a fresh object with identical
//    fields — which every Body does on every render, since `onSubmit` is a new
//    closure each time — must NOT re-render the host, or the two would ping-pong
//    forever.
//
// Bodies never clear on unmount: the chassis resets both channels when the
// picked platform changes, which is the only moment a Body goes away.

/** What the footer bar actually renders; the callbacks stay in the host's ref. */
export type FooterView = { label: string; enabled: boolean; hidden: boolean }
/** What the identity chassis actually renders. */
export type IdentityChromeView = { hidden: boolean; actionLabel: string | null }

export function footerView(state: WizardFooterState | null): FooterView | null {
  // `hidden` is optional on the wire and false by default — normalise here so
  // the comparison never sees `undefined` vs `false` as a change.
  return state ? { label: state.label, enabled: state.enabled, hidden: state.hidden === true } : null
}

export function identityChromeView(state: WizardIdentityChromeState | null): IdentityChromeView | null {
  return state ? { hidden: state.hidden, actionLabel: state.headerAction?.label ?? null } : null
}

export function sameFooterView(a: FooterView | null, b: FooterView | null): boolean {
  if (a === null || b === null) return a === b
  return a.label === b.label && a.enabled === b.enabled && a.hidden === b.hidden
}

export function sameIdentityChromeView(a: IdentityChromeView | null, b: IdentityChromeView | null): boolean {
  if (a === null || b === null) return a === b
  return a.hidden === b.hidden && a.actionLabel === b.actionLabel
}

export function usePublishedFooter(host: WizardHost, state: WizardFooterState | null): void {
  useLayoutEffect(() => {
    host.setFooter(state)
  })
}

export function usePublishedIdentityChrome(host: WizardHost, state: WizardIdentityChromeState | null): void {
  useLayoutEffect(() => {
    host.setIdentityChrome(state)
  })
}
