'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui'
import { Spinner } from '@/components/marks'
import { refreshMySocialIdentities } from '@/lib/api'
import {
  LogtoAccountError,
  accountErrorMessage,
  forgetOwnershipProof,
  saveSocialIdentity,
  takeSocialLinkFlow,
  verifySocialVerification
} from '@/lib/logto-account'

export default function SocialAccountCallback() {
  const started = useRef(false)
  const [error, setError] = useState<string>()
  const [returnTo, setReturnTo] = useState('/')

  useEffect(() => {
    if (started.current) return
    started.current = true

    const flow = takeSocialLinkFlow()
    if (!flow) {
      setError('This account-linking request expired. Return to Profile and try again.')
      return
    }
    setReturnTo(flow.returnTo)

    const params = new URLSearchParams(window.location.search)
    const providerError = params.get('error')
    if (providerError) {
      setError(
        providerError === 'access_denied'
          ? `${flow.providerName} authorization was cancelled.`
          : `${flow.providerName} could not authorize this account.`
      )
      return
    }
    if (params.get('state') !== flow.state) {
      setError('The account-linking response could not be verified. Return to Profile and try again.')
      return
    }

    // Logto exchanges the provider code against the exact URI it authorized
    // with, so echo it back alongside the provider's own response params.
    const connectorData = { ...Object.fromEntries(params.entries()), redirectUri: flow.redirectUri }
    verifySocialVerification(flow.verificationRecordId, connectorData)
      .then((verified) => saveSocialIdentity(verified, flow.currentVerificationRecordId))
      // Best-effort: the link already succeeded, so a failure here must not be
      // reported as one. It only costs a stale row until the cache expires.
      .then(() => refreshMySocialIdentities().catch(() => undefined))
      // Straight back to Profile: the row now shows the linked account, which
      // says it better than a banner that outlives the action.
      .then(() => window.location.replace(flow.returnTo))
      .catch((caught) => {
        // A refused ownership proof must not be reused: it would fail the same
        // way every time. Dropping it makes the next attempt ask for a code.
        if (caught instanceof LogtoAccountError && (caught.status === 403 || caught.status === 401)) {
          forgetOwnershipProof()
        }
        setError(accountErrorMessage(caught, { providerName: flow.providerName, linking: true }))
      })
  }, [])

  return (
    <div className="authpage">
      <div className="m-auto flex max-w-[420px] flex-col items-center gap-[18px] px-6 text-center font-sans text-[14px] font-normal leading-[1.6] text-(--text-secondary)">
        {!error ? <Spinner size={48} /> : null}
        <div>{error ?? 'Linking your sign-in account…'}</div>
        {error ? (
          <Button variant="secondary" onClick={() => window.location.replace(returnTo)}>
            Back to Profile
          </Button>
        ) : null}
      </div>
    </div>
  )
}
