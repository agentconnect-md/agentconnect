'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui'
import { Spinner } from '@/components/marks'
import {
  createMyGithubRepoAccessAuthorization,
  fetchMySocialAccount,
  linkMyGithubRepoAccess,
  linkMySocialIdentity,
  refreshMySocialIdentities
} from '@/lib/api'
import { forgetOwnershipProof } from '@/lib/ownership-proof'
import {
  LogtoAccountError,
  accountErrorMessage,
  isGithubIdentityConflict,
  renewSocialIdentityToken,
  saveSocialIdentity,
  takeSocialLinkFlow,
  verifySocialVerification,
  writeSocialLinkFlow
} from '@/lib/logto-account'

export default function SocialAccountCallback() {
  const t = useTranslations('Auth.socialCallback')
  const started = useRef(false)
  const [error, setError] = useState<string>()
  const [returnTo, setReturnTo] = useState('/')
  const [workingMessage, setWorkingMessage] = useState(() => t('linking'))
  const [canConnectRepo, setCanConnectRepo] = useState(false)
  const [connectingRepo, setConnectingRepo] = useState(false)

  const continueForRepoAccess = async () => {
    setConnectingRepo(true)
    try {
      const { state, authorizationUri } = await createMyGithubRepoAccessAuthorization()
      if (
        !writeSocialLinkFlow({ purpose: 'repo-access', providerName: 'GitHub', state, returnTo, createdAt: Date.now() })
      ) {
        throw new Error('browser state unavailable')
      }
      window.location.assign(authorizationUri)
    } catch {
      setError(t('repoAuthorizationFailed'))
      setConnectingRepo(false)
    }
  }

  useEffect(() => {
    if (started.current) return
    started.current = true

    const flow = takeSocialLinkFlow()
    if (!flow) {
      setError(t('expired'))
      return
    }
    setReturnTo(flow.returnTo)
    if (flow.purpose === 'reauthorize') setWorkingMessage(t('updating', { provider: flow.providerName }))

    const params = new URLSearchParams(window.location.search)
    const providerError = params.get('error')
    if (providerError) {
      setError(
        providerError === 'access_denied'
          ? t('cancelled', { provider: flow.providerName })
          : t('authorizationFailed', { provider: flow.providerName })
      )
      return
    }
    if (params.get('state') !== flow.state) {
      setError(t('unverified'))
      return
    }

    const providerResponse = Object.fromEntries(params.entries())

    if (flow.purpose === 'repo-access') {
      setWorkingMessage(t('connectingRepo'))
      linkMyGithubRepoAccess(params.get('code') ?? '', flow.state)
        .then(() => window.location.replace(flow.returnTo))
        .catch(() => setError(t('repoAuthorizationFailed')))
      return
    }

    const reportFailure = (caught: unknown) => {
      setError(
        accountErrorMessage(caught, {
          providerName: flow.providerName,
          operation: flow.purpose === 'reauthorize' ? 'reauthorize' : 'link'
        })
      )
      if (isGithubIdentityConflict(caught, flow)) {
        void fetchMySocialAccount()
          .then((account) => {
            if (account.githubRepoAccessAvailable && !account.githubRepoIdentity) {
              setError(t('repoConflict'))
              setCanConnectRepo(true)
            }
          })
          .catch(() => undefined)
      }
    }

    // `direct`: the CP owns both legs, so hand it the provider's response and
    // let it finish. Nothing here needs an ownership proof.
    if (flow.mode === 'direct') {
      linkMySocialIdentity(flow.connectorId, providerResponse)
        .then(() => refreshMySocialIdentities().catch(() => undefined))
        .then(() => window.location.replace(flow.returnTo))
        .catch(reportFailure)
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
      .catch(reportFailure)
  }, [t])

  return (
    <div className="authpage">
      <div className="m-auto flex max-w-[420px] flex-col items-center gap-[18px] px-6 text-center font-sans text-[14px] font-normal leading-[1.6] text-(--text-secondary)">
        {!error ? <Spinner size={48} /> : null}
        <div>{error ?? workingMessage}</div>
        {canConnectRepo ? (
          <Button disabled={connectingRepo} onClick={() => void continueForRepoAccess()}>
            {connectingRepo ? t('connectingRepo') : t('continueForRepoAccess')}
          </Button>
        ) : null}
        {error ? (
          <Button variant="secondary" disabled={connectingRepo} onClick={() => window.location.replace(returnTo)}>
            {t('backToProfile')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
