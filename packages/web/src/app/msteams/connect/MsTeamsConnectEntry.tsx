'use client'

// One page, two arrivals: a Store install's Connect card names a tenant, and Microsoft returns here with a code after consent.

import { useEffect, useState } from 'react'
import MsTeamsConnect from './MsTeamsConnect'
import MsTeamsStoreConnect from './MsTeamsStoreConnect'

/** Whether this landing starts a Store connect rather than finishing a sign-in. */
export function isMsTeamsStoreStart(search: string): boolean {
  const params = new URLSearchParams(search)
  return params.has('tenant') && !params.has('code') && !params.has('error')
}

export default function MsTeamsConnectEntry() {
  const [store, setStore] = useState<boolean | null>(null)
  useEffect(() => setStore(isMsTeamsStoreStart(window.location.search)), [])
  if (store === null) return null
  return store ? <MsTeamsStoreConnect /> : <MsTeamsConnect />
}
