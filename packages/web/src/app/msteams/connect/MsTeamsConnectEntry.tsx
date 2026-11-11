'use client'

// One page, two arrivals: a Store install's Connect card names a tenant, and Microsoft returns here with a code after consent.

import { useEffect, useState } from 'react'
import MsTeamsConnect from './MsTeamsConnect'
import MsTeamsStoreConnect from './MsTeamsStoreConnect'
import MsTeamsRecovery from './MsTeamsRecovery'

/** Whether this landing starts a Store connect rather than finishing a sign-in. */
export function isMsTeamsStoreStart(search: string): boolean {
  const params = new URLSearchParams(search)
  return params.has('tenant') && !params.has('code') && !params.has('error')
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
