'use client'

import { useEffect, useId, useState } from 'react'
import useSWR from 'swr'
import { Avatar, Button, Icon } from '@/components/ui'
import { initialsFrom } from '@/lib/auth'
import {
  LogtoAccountError,
  accountErrorMessage,
  createSocialState,
  createSocialVerification,
  fetchSignInMethods,
  removeSocialIdentity,
  requestEmailVerification,
  socialIdentityDetails,
  verifyEmailCode,
  writeSocialLinkFlow,
  type AccountNotice,
  type LogtoAccountProfile,
  type SocialConnector
} from '@/lib/logto-account'

type PendingAction = {
  action: 'add' | 'replace' | 'remove'
  connector: SocialConnector
}

function ProviderMark({ connector }: { connector: SocialConnector }) {
  if (!connector.logo) {
    return (
      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-(--surface-active)">
        <Icon name="link-2" size={15} />
      </span>
    )
  }
  return (
    <span className="flex h-7 w-7 items-center justify-center rounded-md bg-white p-1">
      <img src={connector.logo} alt="" className="max-h-full max-w-full" referrerPolicy="no-referrer" />
    </span>
  )
}

function VerificationDialog({
  pending,
  account,
  onVerified,
  onClose
}: {
  pending: PendingAction
  account: LogtoAccountProfile
  onVerified: (verificationRecordId?: string) => Promise<void>
  onClose: () => void
}) {
  const titleId = useId()
  const [verificationId, setVerificationId] = useState<string>()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const requiresVerification = account.hasSecurityVerificationMethod
  const email = account.primaryEmail
  const isRemove = pending.action === 'remove'
  const actionLabel =
    pending.action === 'add'
      ? `Connect ${pending.connector.name}`
      : pending.action === 'replace'
        ? `Change ${pending.connector.name}`
        : `Remove ${pending.connector.name}`
  const confirmLabel = isRemove ? `Remove ${pending.connector.name}` : 'Continue'

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
      if (!requiresVerification) {
        await onVerified()
        return
      }
      if (!email) {
        throw new LogtoAccountError(
          'This account needs an email verification method before sign-in methods can change.',
          0
        )
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
      setError(
        accountErrorMessage(caught, {
          providerName: pending.connector.name,
          linking: pending.action !== 'remove'
        })
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="scrim">
      <div className="modal max-w-[480px]" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modalhead">
          <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
            <Icon name={isRemove ? 'unlink' : 'link-2'} size={16} color="var(--brand)" />
          </span>
          <span id={titleId} className="flex-1 font-sans text-[16px] font-semibold leading-normal">
            {actionLabel}
          </span>
          <button type="button" className="iconbtn" aria-label="Close" disabled={busy} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody">
          <p className="font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">
            {requiresVerification
              ? verificationId
                ? `Enter the code sent to ${email ?? 'your email'} to continue.`
                : `To protect your account, verify it's you with a code sent to ${email ?? 'your email'}.`
              : isRemove
                ? `${pending.connector.name} will no longer be available for signing in to this account.`
                : `Continue to ${pending.connector.name} to choose the account you want to connect.`}
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
          <Button
            variant={isRemove && (!requiresVerification || verificationId) ? 'danger' : 'primary'}
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? 'Working…' : requiresVerification && !verificationId ? 'Send code' : confirmLabel}
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
  const { data, error, isLoading, mutate } = useSWR('logto-account-sign-in-methods', fetchSignInMethods, {
    revalidateOnFocus: true
  })
  const [pending, setPending] = useState<PendingAction>()

  const finishAction = async (verificationRecordId?: string) => {
    if (!pending || !data) return
    if (pending.action === 'remove') {
      await removeSocialIdentity(pending.connector.target, verificationRecordId)
      await mutate()
      setPending(undefined)
      onNotice({ kind: 'success', message: `${pending.connector.name} was disconnected.` })
      return
    }

    const state = createSocialState()
    const redirectUri = `${window.location.origin}/auth/social/callback`
    const verification = await createSocialVerification(pending.connector.id, redirectUri, state)
    const stored = writeSocialLinkFlow({
      state,
      socialVerificationRecordId: verification.verificationRecordId,
      ...(verificationRecordId ? { currentVerificationRecordId: verificationRecordId } : {}),
      action: pending.action,
      providerName: pending.connector.name,
      redirectUri,
      returnTo: `${window.location.pathname}${window.location.search}`,
      createdAt: Date.now()
    })
    if (!stored) {
      throw new LogtoAccountError('This browser blocked the temporary account-linking state.', 0)
    }
    window.location.assign(verification.authorizationUri)
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
                Connect more than one social account to the same AgentConnect profile.
              </div>
            ) : null}
          </div>
        </div>

        {notice ? <Notice notice={notice} /> : null}

        {isLoading ? (
          <div className="px-4 py-5 font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
            Loading sign-in methods…
          </div>
        ) : error || !data ? (
          <div className="flex items-center justify-between gap-4 px-4 py-4">
            <span className="font-sans text-[13px] font-normal leading-normal text-(--status-error)">
              {accountErrorMessage(error)}
            </span>
            <Button variant="secondary" size="xs" onClick={() => void mutate()}>
              Retry
            </Button>
          </div>
        ) : data.connectors.length === 0 ? (
          <div className="px-4 py-5 font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
            No social sign-in methods are configured.
          </div>
        ) : (
          <div>
            {data.connectors.map((connector, index) => {
              const identity = data.account.identities[connector.target]
              const details = identity ? socialIdentityDetails(identity) : undefined
              return (
                <div
                  key={connector.id}
                  className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3.5 desktop:grid-cols-[170px_minmax(0,1fr)_auto] ${
                    index > 0 ? 'border-t border-(--border-subtle)' : ''
                  }`}
                >
                  <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-3">
                    <ProviderMark connector={connector} />
                    <span className="truncate font-sans text-[13.5px] font-semibold leading-normal">
                      {connector.name}
                    </span>
                  </div>
                  <div className="col-span-2 row-start-2 min-w-0 desktop:col-span-1 desktop:col-start-2 desktop:row-start-1">
                    {identity ? (
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Avatar
                          src={details?.avatar}
                          initials={initialsFrom(details?.name ?? connector.name, details?.email)}
                          size={32}
                          fontSize={11}
                        />
                        <div className="min-w-0">
                          <div className="truncate font-sans text-[13px] font-medium leading-normal">
                            {details?.name ?? 'Connected'}
                          </div>
                          {details?.email ? (
                            <div className="truncate font-mono text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                              {details.email}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ) : (
                      <span className="font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
                        Not connected
                      </span>
                    )}
                  </div>
                  <div className="col-start-2 row-start-1 flex items-center justify-end gap-1 desktop:col-start-3">
                    {identity ? (
                      <>
                        <Button variant="ghost" size="xs" onClick={() => setPending({ action: 'replace', connector })}>
                          Change
                        </Button>
                        <Button variant="ghost" size="xs" onClick={() => setPending({ action: 'remove', connector })}>
                          <span className="text-(--status-error)">Remove</span>
                        </Button>
                      </>
                    ) : (
                      <Button variant="secondary" size="xs" onClick={() => setPending({ action: 'add', connector })}>
                        <Icon name="plus" size={13} />
                        Connect
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {pending && data ? (
        <VerificationDialog
          key={`${pending.action}:${pending.connector.id}`}
          pending={pending}
          account={data.account}
          onVerified={finishAction}
          onClose={() => setPending(undefined)}
        />
      ) : null}
    </>
  )
}
