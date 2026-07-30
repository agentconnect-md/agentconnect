'use client'

import { useEffect, useId, useState } from 'react'
import useSWR from 'swr'
import { Avatar, Button, Icon } from '@/components/ui'
import { SocialLoginMark } from '@/components/marks'
import { initialsFrom } from '@/lib/auth'
import { fetchMySlackIdentity, resolveMySocialConnectorId, unlinkMySocialIdentity } from '@/lib/api'
import { slackWorkspaceLine } from '@/lib/slack-identity'
import {
  LogtoAccountError,
  accountErrorMessage,
  createSocialState,
  createSocialVerification,
  fetchAccountProfile,
  requestEmailVerification,
  verifyEmailCode,
  socialIdentityDetails,
  writeSocialLinkFlow,
  type AccountNotice
} from '@/lib/logto-account'
import { SOCIAL_LOGIN_PROVIDERS, type SocialLoginProvider } from '@/lib/social-login-providers'

function ProviderMark({ provider }: { provider: SocialLoginProvider }) {
  return (
    <span className="flex h-7 w-7 items-center justify-center rounded-md bg-(--surface-active)">
      <SocialLoginMark target={provider.target} size={19} />
    </span>
  )
}

function UnlinkDialog({
  provider,
  onConfirm,
  onClose
}: {
  provider: SocialLoginProvider
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const titleId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  const submit = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await onConfirm()
    } catch (caught) {
      setError(accountErrorMessage(caught, { providerName: provider.name }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="scrim">
      <div className="modal max-w-[480px]" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modalhead">
          <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
            <Icon name="unlink" size={16} color="var(--brand)" />
          </span>
          <span id={titleId} className="flex-1 font-sans text-[16px] font-semibold leading-normal">
            Unlink {provider.name}
          </span>
          <button type="button" className="iconbtn" aria-label="Close" disabled={busy} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody">
          <p className="font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">
            {provider.name} will no longer be available for signing in to this account.
          </p>
          {error ? (
            <div className="mt-3 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)" role="alert">
              {error}
            </div>
          ) : null}
        </div>
        <div className="modalfoot">
          <div className="flex-1" />
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Unlinking…' : `Unlink ${provider.name}`}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Proves the caller still owns THIS account before its sign-in methods change.
 * Logto requires that proof whenever the account has a security verification
 * method, and it must be collected BEFORE the provider round trip — on return
 * the identity is saved straight away, with no UI left to ask in.
 */
function VerifyAccountDialog({
  provider,
  email,
  onVerified,
  onClose
}: {
  provider: SocialLoginProvider
  email?: string
  onVerified: (currentVerificationRecordId: string) => Promise<void>
  onClose: () => void
}) {
  const titleId = useId()
  const [verificationId, setVerificationId] = useState<string>()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  const submit = async () => {
    setBusy(true)
    setError(undefined)
    try {
      if (!email) {
        throw new LogtoAccountError('This account needs a verified email before sign-in methods can change.', 0)
      }
      if (!verificationId) {
        setVerificationId(await requestEmailVerification(email))
        return
      }
      if (!code.trim()) {
        setError('Enter the verification code from your email.')
        return
      }
      await onVerified(await verifyEmailCode(email, verificationId, code.trim()))
    } catch (caught) {
      setError(accountErrorMessage(caught, { providerName: provider.name, linking: true }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="scrim">
      <div className="modal max-w-[480px]" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modalhead">
          <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
            <Icon name="shield-check" size={16} color="var(--brand)" />
          </span>
          <span id={titleId} className="flex-1 font-sans text-[16px] font-semibold leading-normal">
            Link {provider.name}
          </span>
          <button type="button" className="iconbtn" aria-label="Close" disabled={busy} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody">
          <p className="font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">
            {verificationId
              ? `Enter the code sent to ${email ?? 'your email'}, then continue to ${provider.name}.`
              : `To protect your account, verify it's you with a code sent to ${email ?? 'your email'}.`}
          </p>
          {verificationId ? (
            <label className="fld mt-4">
              <span className="fldlbl">Verification code</span>
              <input
                className="inp"
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                placeholder="Enter code"
                onChange={(event) => setCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submit()
                }}
              />
            </label>
          ) : null}
          {error ? (
            <div className="mt-3 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)" role="alert">
              {error}
            </div>
          ) : null}
        </div>
        <div className="modalfoot">
          <div className="flex-1" />
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Working…' : verificationId ? `Continue to ${provider.name}` : 'Send code'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Notice({ notice }: { notice: AccountNotice }) {
  return (
    <div
      className={`border-b border-(--border-subtle) px-4 py-2.5 font-sans text-[12.5px] font-normal leading-normal ${
        notice.kind === 'success' ? 'text-(--status-online)' : 'text-(--status-error)'
      }`}
      role="status"
    >
      {notice.message}
    </div>
  )
}

export default function SocialSignInCard({
  mobile = false,
  notice,
  onNotice
}: {
  mobile?: boolean
  notice?: AccountNotice
  onNotice: (notice: AccountNotice) => void
}) {
  const {
    data: account,
    error,
    isValidating,
    mutate
  } = useSWR('logto-account-sign-in-methods', fetchAccountProfile, {
    // Provider rows are static; linked identity details load once per mount
    // and refresh only after an explicit retry or mutation.
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    shouldRetryOnError: false
  })
  // The CP's server-side read of the Slack workspace. Deliberately its own key:
  // an error, or a deployment that cannot resolve identities, must cost nothing
  // but this one line — never the linking UI it sits in.
  const { data: slack } = useSWR('me-slack-identity', fetchMySlackIdentity, { shouldRetryOnError: false })
  const workspaceLine = slackWorkspaceLine(slack)
  const [pendingUnlink, setPendingUnlink] = useState<SocialLoginProvider>()
  const [pendingVerify, setPendingVerify] = useState<SocialLoginProvider>()
  const [busyProvider, setBusyProvider] = useState<SocialLoginProvider['target']>()
  const currentAccount = error ? undefined : account
  const linkedProviderCount = currentAccount
    ? SOCIAL_LOGIN_PROVIDERS.filter((provider) => currentAccount.identities[provider.target]).length
    : 0

  // Logto refuses an identity change the caller has not re-proven, so accounts
  // with a security verification method take the code detour first.
  const beginLink = (provider: SocialLoginProvider) => {
    if (currentAccount?.hasSecurityVerificationMethod) {
      setPendingVerify(provider)
      return
    }
    void startLink(provider)
  }

  const startLink = async (provider: SocialLoginProvider, currentVerificationRecordId?: string) => {
    setBusyProvider(provider.target)
    try {
      const state = createSocialState()
      // Two hops on purpose: only the CP can name the connector, and only the
      // browser can authorize it (the Account API is the side with a session).
      const { connectorId } = await resolveMySocialConnectorId(provider.target)
      const redirectUri = `${window.location.origin}/auth/social/callback`
      const { authorizationUri, verificationRecordId } = await createSocialVerification(connectorId, redirectUri, state)
      const stored = writeSocialLinkFlow({
        state,
        connectorId,
        verificationRecordId,
        redirectUri,
        ...(currentVerificationRecordId ? { currentVerificationRecordId } : {}),
        providerName: provider.name,
        returnTo: `${window.location.pathname}${window.location.search}`,
        createdAt: Date.now()
      })
      if (!stored) {
        throw new LogtoAccountError('This browser blocked the temporary account-linking state.', 0)
      }
      window.location.assign(authorizationUri)
    } catch (caught) {
      onNotice({
        kind: 'error',
        message: accountErrorMessage(caught, { providerName: provider.name, linking: true })
      })
      setBusyProvider(undefined)
    }
  }

  const unlink = async (provider: SocialLoginProvider) => {
    await unlinkMySocialIdentity(provider.target)
    await mutate()
    setPendingUnlink(undefined)
    onNotice({ kind: 'success', message: `${provider.name} was unlinked.` })
  }

  const shell = mobile
    ? 'overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xs)'
    : 'card mt-[22px]'
  const header = mobile ? 'border-b border-(--border-subtle) px-4 py-3' : 'cardhead'

  return (
    <>
      <section className={shell} aria-label="Sign-in methods">
        <div className={header}>
          <div className={mobile ? '' : 'flex flex-col gap-0.5'}>
            <div className={mobile ? 'font-sans text-[14px] font-semibold leading-normal' : 'cardtitle'}>
              Sign-in methods
            </div>
            {!mobile ? (
              <div className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                Link more than one social account to the same AgentConnect profile.
              </div>
            ) : null}
          </div>
        </div>

        {notice ? <Notice notice={notice} /> : null}

        {!isValidating && (error || !account) ? (
          <div className="flex items-center justify-between gap-4 px-4 py-4">
            <span className="font-sans text-[13px] font-normal leading-normal text-(--status-error)">
              {accountErrorMessage(error)}
            </span>
            <Button variant="secondary" size="xs" onClick={() => void mutate()}>
              Retry
            </Button>
          </div>
        ) : null}

        <div aria-busy={isValidating}>
          {SOCIAL_LOGIN_PROVIDERS.map((provider, index) => {
            const identity = currentAccount?.identities[provider.target]
            const details = identity ? socialIdentityDetails(identity) : undefined
            const canUnlink = linkedProviderCount > 1
            return (
              <div
                key={provider.target}
                className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3.5 desktop:grid-cols-[170px_minmax(0,1fr)_auto] ${
                  index > 0 ? 'border-t border-(--border-subtle)' : ''
                }`}
              >
                <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-3">
                  <ProviderMark provider={provider} />
                  <span className="truncate font-sans text-[13.5px] font-semibold leading-normal">{provider.name}</span>
                </div>
                <div className="col-span-2 row-start-2 min-w-0 desktop:col-span-1 desktop:col-start-2 desktop:row-start-1">
                  {currentAccount ? (
                    identity ? (
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Avatar
                          src={details?.avatar}
                          initials={initialsFrom(details?.name ?? provider.name, details?.email)}
                          size={32}
                          fontSize={11}
                        />
                        <div className="min-w-0">
                          <div className="truncate font-sans text-[13px] font-medium leading-normal">
                            {details?.name ?? 'Linked'}
                          </div>
                          {details?.email ? (
                            <div className="truncate font-mono text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                              {details.email}
                            </div>
                          ) : null}
                          {provider.target === 'slack' && workspaceLine ? (
                            <div className="truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                              {workspaceLine}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ) : (
                      <span className="font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
                        Not linked
                      </span>
                    )
                  ) : null}
                </div>
                <div className="col-start-2 row-start-1 flex items-center justify-end gap-1 desktop:col-start-3">
                  {currentAccount ? (
                    identity ? (
                      canUnlink ? (
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={busyProvider !== undefined}
                          onClick={() => setPendingUnlink(provider)}
                        >
                          <span className="text-(--status-error)">Unlink</span>
                        </Button>
                      ) : null
                    ) : (
                      <Button
                        variant="secondary"
                        size="xs"
                        disabled={busyProvider !== undefined}
                        onClick={() => beginLink(provider)}
                      >
                        <Icon name="link" size={14} />
                        {busyProvider === provider.target ? 'Linking…' : 'Link'}
                      </Button>
                    )
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {pendingUnlink ? (
        <UnlinkDialog
          key={pendingUnlink.target}
          provider={pendingUnlink}
          onConfirm={() => unlink(pendingUnlink)}
          onClose={() => setPendingUnlink(undefined)}
        />
      ) : null}

      {pendingVerify ? (
        <VerifyAccountDialog
          key={pendingVerify.target}
          provider={pendingVerify}
          email={currentAccount?.primaryEmail}
          onVerified={async (currentVerificationRecordId) => {
            setPendingVerify(undefined)
            await startLink(pendingVerify, currentVerificationRecordId)
          }}
          onClose={() => setPendingVerify(undefined)}
        />
      ) : null}
    </>
  )
}
