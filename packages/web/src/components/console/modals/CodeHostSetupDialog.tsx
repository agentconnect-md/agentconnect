'use client'

// The Integrations page's "Code hosts" section, opened as a native MCP App from webchat
// (webchat-native-integration-ui.md). Every action here either redirects to the provider
// (the GitHub App install, GitLab's OAuth hop) or takes a bot token, so none of it can be an
// admin-MCP write: the dialog runs the SAME cards the page runs, under the human's own Console
// JWT, and the tool only asks for them to be shown.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { CODE_HOST_SETUP_URI, type NativeMcpUi } from '@agentconnect.md/protocol/mcp-app'
import { Button } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import { fetchGiteaConnections, fetchGithubInstallations, fetchGitlabConnections } from '@/lib/api'
import GithubCard from '@/components/console/GithubCard'
import GitlabCard from '@/components/console/GitlabCard'
import GiteaCard from '@/components/console/GiteaCard'
import { NativeDialogNotice } from './NativeDialogNotice'
import type { NativeDialogReport } from './native-dialog-report'

type CodeHostUi = Extract<NativeMcpUi, { resourceUri: typeof CODE_HOST_SETUP_URI }>
type Provider = NonNullable<CodeHostUi['intent']['provider']>

const LABEL: Record<Provider, string> = { github: 'GitHub', gitlab: 'GitLab', gitea: 'Gitea' }

/** What Done reports back: counts only — never an account, a project path or a token. */
async function connectionSummary(provider: Provider | undefined): Promise<string> {
  const wanted = (id: Provider) => !provider || provider === id
  const parts: string[] = []
  if (wanted('github')) {
    const { enabled, installations } = await fetchGithubInstallations()
    parts.push(enabled ? `GitHub: ${installations.length} installation(s)` : 'GitHub: not configured')
  }
  if (wanted('gitlab')) {
    const { enabled, connections } = await fetchGitlabConnections()
    parts.push(enabled ? `GitLab: ${connections.length} connection(s)` : 'GitLab: not configured')
  }
  if (wanted('gitea')) {
    const { enabled, connections } = await fetchGiteaConnections()
    parts.push(enabled ? `Gitea: ${connections.length} connection(s)` : 'Gitea: not configured')
  }
  return `Reviewed the organization’s code host connections — ${parts.join(' · ')}.`
}

export default function CodeHostSetupDialog({
  ui,
  onClose,
  onCompleted
}: {
  ui: CodeHostUi
  onClose: () => void
  onCompleted: NativeDialogReport
}) {
  const t = useTranslations('Integrations.dialog.codeHostSetup')
  const { activeOrg, myRole } = useOrgs()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const provider = ui.intent.provider
  const shows = (id: Provider) => !provider || provider === id
  // Same gating as the page: viewers get no controls, and uninstalling the App is owner-only.
  const canWrite = myRole !== 'viewer'
  const isOwner = myRole === 'owner'

  if (activeOrg?.id !== ui.orgId)
    return <NativeDialogNotice heading={t('title')} text={t('wrongOrganization')} onClose={onClose} />

  // Done reports the surface was reviewed; closing says nothing, because nothing here is a save
  // the dialog performs — each card applied its own action the moment it was taken.
  const done = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      onCompleted(await connectionSummary(provider))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modalhead">{provider ? t('providerTitle', { provider: LABEL[provider] }) : t('title')}</div>
      <div className="modalbody flex flex-col gap-4">
        <p className="text-[13px] text-(--text-secondary)">{t('description')}</p>
        {shows('github') && <GithubCard canWrite={canWrite} isOwner={isOwner} />}
        {shows('gitlab') && <GitlabCard canWrite={canWrite} />}
        {shows('gitea') && <GiteaCard canWrite={canWrite} />}
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="modalfoot">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          {t('close')}
        </Button>
        <Button disabled={busy} onClick={() => void done()}>
          {t('done')}
        </Button>
      </div>
    </>
  )
}
