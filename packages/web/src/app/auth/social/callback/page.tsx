'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui'
import { Spinner } from '@/components/marks'
import { linkMySocialIdentity } from '@/lib/api'
import { accountErrorMessage, takeSocialLinkFlow, writeAccountNotice } from '@/lib/logto-account'

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

    const connectorData = Object.fromEntries(params.entries())
    linkMySocialIdentity(flow.connectorId, connectorData)
      .then(() => {
        writeAccountNotice({
          kind: 'success',
          message: `${flow.providerName} was linked.`
        })
        window.location.replace(flow.returnTo)
      })
      .catch((caught) => {
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
