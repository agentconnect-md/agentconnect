// No 'use client' here: rendered from ProfileView, which is already a client
// component; the cards themselves declare their own boundary.

import { platformRegistry } from './registry'

/**
 * Every platform module's Profile-page credential card
 * ({@link WebPlatformModule.ProfileCredentialCard}), in registry order.
 *
 * Slack's App Configuration token is the only one today, and a platform that
 * declares none contributes nothing — no heading, no empty card, no separator —
 * which is exactly what the Profile page rendered before this list existed.
 *
 * Reading the registry from a Profile-page component costs no bundle: the
 * console shell mounts `ModalProvider` on every route, and it already pulls
 * `registry.ts` in through `AddIntegrationModal`. That is why this lookup can
 * go through the registry while `platforms/marks.ts` and `lib/platform-labels.ts`
 * deliberately cannot — those are reached from the signed-out routes, which
 * have no modal tree.
 */
export function PlatformCredentialCards() {
  return (
    <>
      {platformRegistry
        .all()
        .map(({ platformId, ProfileCredentialCard: Card }) => (Card ? <Card key={platformId} /> : null))}
    </>
  )
}
