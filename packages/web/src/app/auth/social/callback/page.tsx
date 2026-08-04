'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui'
import { Spinner } from '@/components/marks'
import { linkMySocialIdentity, refreshMySocialIdentities } from '@/lib/api'
import { forgetOwnershipProof } from '@/lib/ownership-proof'
import {
  LogtoAccountError,
  accountErrorMessage,
  renewSocialIdentityToken,
  saveSocialIdentity,
  takeSocialLinkFlow,
  verifySocialVerification
} from '@/lib/logto-account'

export default function SocialAccountCallback() {
  const started = useRef(false)
  const [error, setError] = useState<string>()
  const [returnTo, setReturnTo] = useState('/')
  const [workingMessage, setWorkingMessage] = useState('Linking your sign-in account…')

  useEffect(() => {
    if (started.current) return
    started.current = true

    const flow = takeSocialLinkFlow()
    if (!flow) {
      setError('This account-linking request expired. Return to Profile and try again.')
      return
    }
    setReturnTo(flow.returnTo)
    if (flow.purpose === 'reauthorize') setWorkingMessage(`Updating ${flow.providerName} authorization…`)

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

    const providerResponse = Object.fromEntries(params.entries())

    // `direct`: the CP owns both legs, so hand it the provider's response and
    // let it finish. Nothing here needs an ownership proof.
    if (flow.mode === 'direct') {
      linkMySocialIdentity(flow.connectorId, providerResponse)
        .then(() => refreshMySocialIdentities().catch(() => undefined))
        .then(() => window.location.replace(flow.returnTo))
        .catch((caught) => {
          setError(accountErrorMessage(caught, { providerName: flow.providerName, operation: 'link' }))
        })
      return
    }

    // Logto exchanges the provider code against the exact URI it authorized
    // with, so echo it back alongside the provider's own response params.
    const connectorData = { ...providerResponse, redirectUri: flow.redirectUri! }
    verifySocialVerification(flow.verificationRecordId!, connectorData)
      .then((verified) =>
        (flow.purpose === 'reauthorize' && flow.target
          ? renewSocialIdentityToken(flow.target, verified)
          : saveSocialIdentity(verified, flow.currentVerificationRecordId)
        ).catch((caught: unknown) => {
          // Only saving a new identity implicates the ownership proof; token
          // renewal and provider verification do not consume that proof.
          if (
            flow.purpose !== 'reauthorize' &&
            caught instanceof LogtoAccountError &&
            (caught.status === 401 || caught.status === 403)
          ) {
            forgetOwnershipProof()
          }
          throw caught
        })
      )
      // Best-effort: the link already succeeded, so a failure here must not be
      // reported as one. It only costs a stale row until the cache expires.
      .then(() => refreshMySocialIdentities().catch(() => undefined))
      // Return to the initiating Profile view after either linking or renewing.
      .then(() => window.location.replace(flow.returnTo))
      .catch((caught) => {
        setError(
          accountErrorMessage(caught, {
            providerName: flow.providerName,
            operation: flow.purpose === 'reauthorize' ? 'reauthorize' : 'link'
          })
        )
      })
  }, [])

  return (
    <div className="authpage">
      <div className="m-auto flex max-w-[420px] flex-col items-center gap-[18px] px-6 text-center font-sans text-[14px] font-normal leading-[1.6] text-(--text-secondary)">
        {!error ? <Spinner size={48} /> : null}
        <div>{error ?? workingMessage}</div>
        {error ? (
          <Button variant="secondary" onClick={() => window.location.replace(returnTo)}>
            Back to Profile
          </Button>
        ) : null}
      </div>
    </div>
  )
}
