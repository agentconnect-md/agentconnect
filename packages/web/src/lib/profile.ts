'use client'

// The signed-in user's DISPLAY identity = id-token claims (lib/auth) with the
// CP `/me` record overlaid on top. Profile edits (name, avatar) land on the CP
// user row, and the cached id token stays stale until the next sign-in — so the
// header, the profile page and the edit dialog all read the merged view from
// here. Module-level cache + tiny pub/sub so a save repaints every consumer
// immediately (`applyMe`), without threading callbacks through the modal host.

import { useEffect, useState } from 'react'
import { FALLBACK_USER, getUser, initialsFrom, isAuthConfigured, type AuthUser } from '@/lib/auth'
import { fetchMe, type MeDto } from '@/lib/api'

let me: MeDto | null = null
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((fn) => fn())
}

/** Install a fresh /me record (returned by a profile save) and repaint consumers. */
export function applyMe(next: MeDto): void {
  me = next
  notify()
}

// One fetch per page load; both auth modes have a /me (OIDC user or the devAuth
// principal). Failure (CP down, older CP without the surface) just leaves the
// overlay absent — the token identity/fallback keeps rendering. Mock mode fetches
// too: it usually runs against a reachable CP (real crons/bots load), so this is
// what lets "Created by" resolve to "You"; a truly offline demo just gets a failed
// request and keeps `me` null, same as before.
function load(): Promise<void> {
  if (!inflight) {
    inflight = fetchMe().then(
      (dto) => {
        me = dto
        notify()
      },
      () => {}
    )
  }
  return inflight
}

/** The CP profile merged over the token identity (CP name/picture/email win). */
function overlay(base: AuthUser | null): AuthUser {
  const user = base ?? FALLBACK_USER
  if (!me) return user
  const name = me.name ?? user.name
  const email = me.email ?? user.email
  return {
    ...user,
    name,
    ...(email ? { email } : {}),
    initials: initialsFrom(name, email),
    ...(me.picture ? { picture: me.picture } : {})
  }
}

/**
 * The merged display identity + the raw CP record (null while unknown). Live:
 * re-renders when a profile save lands (`applyMe`) or the /me fetch resolves.
 */
export function useProfile(): { user: AuthUser; me: MeDto | null } {
  const [, force] = useState(0)
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)

  useEffect(() => {
    let active = true
    if (isAuthConfigured()) {
      void getUser().then((u) => {
        if (active) setAuthUser(u)
      })
    }
    void load()
    const repaint = () => force((n) => n + 1)
    listeners.add(repaint)
    return () => {
      active = false
      listeners.delete(repaint)
    }
  }, [])

  return { user: overlay(authUser), me }
}
