'use client'

import { useId, useState, type KeyboardEvent } from 'react'
import useSWR from 'swr'
import { Icon } from '@/components/ui'
import { addTrustedActor, fetchTrustedActors, removeTrustedActor, type TrustedActorDto } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import type { CodeHostProvider } from '@agentconnect.md/protocol/code-host'

const HOST_NAME: Record<CodeHostProvider, string> = { github: 'GitHub', gitlab: 'GitLab', gitea: 'Gitea' }

// "Trusted users" — the chip field a code-host row's settings dialog shows. Every chip is a user a
// maintainer vouched for on this REPOSITORY (the list is shared by every hook row on it): they fire
// its hooks as a role-holder would. Enter adds the typed login; the server resolves it to the host's
// numeric id, so an unknown login is refused inline rather than stored.
export function TrustedUsersField({ hookId, provider }: { hookId: string; provider: CodeHostProvider }) {
  const { activeOrg } = useOrgs()
  const inputId = useId()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = consoleKeys.hookTrustedActors(activeOrg?.id, hookId)
  const { data, mutate } = useSWR(key, ([, orgId, , id]) => fetchTrustedActors(id, orgId))
  const users: TrustedActorDto[] = data ?? []

  const add = async () => {
    const login = draft.trim().replace(/^@/, '')
    if (!login || busy) return
    setBusy(true)
    setError(null)
    try {
      const added = await addTrustedActor(hookId, login)
      // The same id re-added refreshes its login rather than growing the list.
      void mutate((rows) => [...(rows ?? []).filter((row) => row.id !== added.id), added], { revalidate: false })
      setDraft('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not add this user')
    } finally {
      setBusy(false)
    }
  }
  const remove = async (row: TrustedActorDto) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await removeTrustedActor(hookId, row.id)
      void mutate((rows) => (rows ?? []).filter((other) => other.id !== row.id), { revalidate: false })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not remove this user')
    } finally {
      setBusy(false)
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void add()
    }
  }

  return (
    <div data-trusted-users>
      <div className="mb-[6px] flex items-center">
        <label htmlFor={inputId} className="fldlbl">
          Trusted users
        </label>
      </div>
      <div className="inp flex-wrap justify-start gap-[6px] px-2 py-[5px]">
        {users.map((row) => (
          <span
            key={row.id}
            className="inline-flex items-center gap-[5px] rounded-xs border border-(--border-subtle) bg-(--surface-sunken) py-[3px] pr-[5px] pl-[7px] font-mono text-[11.5px] font-medium leading-normal whitespace-nowrap text-(--text-secondary)"
          >
            {row.login}
            <button
              type="button"
              aria-label={`Remove trusted user ${row.login}`}
              disabled={busy}
              className="flex text-(--text-tertiary) hover:text-(--text-primary) disabled:opacity-50"
              onClick={() => void remove(row)}
            >
              <Icon name="x" size={11} />
            </button>
          </span>
        ))}
        <input
          id={inputId}
          aria-label={`Add a trusted ${HOST_NAME[provider]} user`}
          value={draft}
          disabled={busy}
          placeholder={users.length > 0 ? 'add another…' : `${HOST_NAME[provider]} username, Enter adds them`}
          onChange={(event) => {
            setError(null)
            setDraft(event.target.value)
          }}
          onKeyDown={onKeyDown}
          className="min-w-[150px] flex-1 border-0 bg-transparent p-[2px] font-mono text-[12px] font-normal leading-normal text-(--text-primary) outline-none placeholder:text-(--text-disabled)"
        />
      </div>
      {error && (
        <div className="mt-[7px] flex items-center gap-[6px] font-sans text-[11.5px] font-medium leading-normal text-(--status-error)">
          <Icon name="triangle-alert" size={12} className="flex-none" />
          {error}
        </div>
      )}
    </div>
  )
}
