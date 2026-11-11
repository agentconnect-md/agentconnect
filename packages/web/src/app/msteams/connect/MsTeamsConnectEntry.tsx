'use client'

// One page, three arrivals: a Store install's Connect card names a tenant, and Microsoft returns here after the tenant-wide consent and again with a code after the sign-in.

import { useEffect, useState } from 'react'
import MsTeamsConnect from './MsTeamsConnect'
import MsTeamsStoreConnect from './MsTeamsStoreConnect'
import MsTeamsRecovery from './MsTeamsRecovery'

/** Whether this landing starts a Store connect rather than finishing a sign-in. */
export function isMsTeamsStoreStart(search: string): boolean {
  const params = new URLSearchParams(search)
  // Microsoft's return from the tenant-wide consent names the tenant too, with the state it was sent.
  return params.has('tenant') && !params.has('code') && !params.has('error') && !params.has('state')
}

export default function MsTeamsConnectEntry() {
  const [kind, setKind] = useState<'store' | 'recovery' | 'connect' | null>(null)
  useEffect(() => {
    const query = new URLSearchParams(window.location.search)
    setKind(
      isMsTeamsStoreStart(window.location.search)
        ? 'store'
        : query.get('state')?.split('.').length === 3
          ? 'recovery'
          : 'connect'
    )
  }, [])
  if (kind === null) return null
  return kind === 'store' ? <MsTeamsStoreConnect /> : kind === 'recovery' ? <MsTeamsRecovery /> : <MsTeamsConnect />
}
