// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import { useRef, useState } from 'react'
import { PlatformMark } from '@/components/marks'
import { Icon } from '@/components/ui'
import type { Agent } from '@/lib/data'
import { discordApplicationIdFromToken, discordBotInviteUrl } from './invite'
import type { WizardHost } from '../contract'
import { usePublishedFooter } from '../publish'
import { TokenGuidePane } from '../wizard-chrome'
import { DISCORD_STEPS } from './steps'

/**
 * Discord's create-mode pane: the Developer Portal walkthrough and one bot
 * token. The invite is the fiddly part (right scopes + permissions), so once
 * the token decodes to an application id the pane hands over a ready-made
 * invite link instead of asking anyone to build the URL by hand.
 */
export function DiscordWizardBody({ agent, host }: { agent: Agent; host: WizardHost }) {
  const [botToken, setBotToken] = useState('')
  const [showErrors, setShowErrors] = useState(false)
  const [saving, setSaving] = useState(false)
  // Synchronous re-entry guard — `saving` only commits on the next render.
  const busyRef = useRef(false)

  const tokenTrim = botToken.trim()
  const valid = tokenTrim.length >= 24
  // The application (client) id is base64-encoded in the bot token's first segment.
  const appId = discordApplicationIdFromToken(tokenTrim)

  const submit = async () => {
    setShowErrors(true)
    if (busyRef.current || !valid) return
    busyRef.current = true
    setSaving(true)
    host.setError(null)
    try {
      await host.createIntegration({ platform: 'discord', agentId: agent.id, discord: { botToken: tokenTrim } })
      host.close()
    } catch (e) {
      host.setError(e instanceof Error ? e.message : String(e))
      setSaving(false)
      busyRef.current = false
    }
  }

  usePublishedFooter(host, {
    label: saving ? 'Connecting…' : 'Connect & authorize',
    enabled: valid && !saving,
    onSubmit: () => void submit()
  })

  if (host.mode !== 'create') return null

  return (
    <TokenGuidePane
      mark={<PlatformMark platform="discord" />}
      step1="Name and create the application. In Bot, reset and copy the token."
      linkHref="https://discord.com/developers/applications?new_application=true"
      linkLabel="Create Discord app"
      steps={DISCORD_STEPS}
      walkthroughLabel="Discord bot setup steps"
      tokenPlaceholder="Bot token from the Developer Portal"
      tokenValue={botToken}
      tokenInvalid={showErrors && !valid}
      onTokenChange={setBotToken}
    >
      {appId ? (
        <>
          <a
            href={discordBotInviteUrl(appId)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-[12px] flex h-[38px] items-center justify-center gap-2 rounded-md bg-(--surface-inverse) font-sans text-[13px] font-semibold leading-normal text-white no-underline"
          >
            <span className="imark h-[18px] w-[18px] border-0 bg-transparent">
              <PlatformMark platform="discord" />
            </span>
            Add to Discord
            <Icon name="external-link" size={14} />
          </a>
          <div className="mt-[8px] flex flex-wrap items-center gap-x-[6px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
            <Icon name="corner-down-right" size={12} className="flex-none" />
            App&nbsp;<span className="mono">{appId}</span>
            <span>— invites with the bot &amp; applications.commands scopes and the right permissions.</span>
          </div>
        </>
      ) : (
        <div className="mt-[8px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
          Paste the bot token and an “Add to Discord” button appears — no need to build the invite URL by hand.
        </div>
      )}
    </TokenGuidePane>
  )
}
