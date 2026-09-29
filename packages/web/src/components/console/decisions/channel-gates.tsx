'use client'

// A single-owner conversation's By decision gate, shared by the agent's Integrations tab and the org's bot roster.

import type { ReactNode } from 'react'
import { useConsoleData } from '@/lib/data-context'
import { isDirectConversation, type IntegrationChannelRow } from '@/lib/data'
import { useOptionalDecisionsPrototype } from '@/lib/decisions/provider'
import { gateStatus, savedGateOf, type SavedGate } from '@/lib/decisions/binding'
import type { ChannelDecisionGate } from '@agentconnect.md/protocol/decision'
import { channelListSemantics } from '@/components/console/platforms/registry'
import { DecisionBindingStrip, DecisionGateEntry } from './DecisionBindingStrip'

/** A row's trigger choice; `decision` saves only with its gate, through the rules modal. */
export type GateTrigger = IntegrationChannelRow['trigger'] | 'decision'

/** The row's label as the rules modal and Recent evaluations name it: a DM's stored "@" is dropped. */
const labelOf = (row: Pick<IntegrationChannelRow, 'kind' | 'name'>) =>
  row.kind === 'im' || row.kind === 'mpim' ? row.name.replace(/^@+/, '') : row.name

export function useChannelGates() {
  const decisions = useOptionalDecisionsPrototype()
  const { setChannelTrigger, setChannelDecision } = useConsoleData()
  const offered = decisions !== null
  const mode = decisions?.api.mode
  const drafts = decisions?.bindingDrafts ?? {}
  // The store composes the identity (organization + bot + conversation); without it a bare channel id is only a map key.
  const bindingKey = (botId: string | undefined, c: IntegrationChannelRow) =>
    decisions?.gateKeyFor(botId, c.channelId) ?? c.channelId
  const mockGate = (botId: string | undefined, c: IntegrationChannelRow) =>
    mode === 'mock' ? decisions?.gates[bindingKey(botId, c)] : undefined
  const savedGate = (botId: string | undefined, c: IntegrationChannelRow): SavedGate | null => {
    if (mode !== 'mock') return savedGateOf(c)
    const gate = mockGate(botId, c)
    if (!gate) return null
    const { channelName: _name, needsReview: _review, ...binding } = gate
    return binding
  }
  const rowTrigger = (botId: string | undefined, c: IntegrationChannelRow): GateTrigger =>
    (offered && drafts[bindingKey(botId, c)]) || mockGate(botId, c) ? 'decision' : c.trigger
  const busy = (botId: string | undefined, c: IntegrationChannelRow) => drafts[bindingKey(botId, c)]?.phase === 'saving'
  const pickTrigger = (
    botId: string | undefined,
    integrationId: string | undefined,
    c: IntegrationChannelRow,
    trigger: GateTrigger
  ) => {
    const key = bindingKey(botId, c)
    // Choosing By decision only opens a draft; nothing is written until the modal saves the gate with it.
    if (trigger === 'decision') {
      if (offered)
        decisions?.setBindingDraft(key, (current) => current ?? { decisionId: null, when: null, phase: 'editing' })
      return
    }
    decisions?.setBindingDraft(key, null)
    if (mode === 'mock') decisions?.clearGate(key)
    // A live saved gate is trigger 'decision', so leaving it PATCHes; the server clears the binding.
    if (trigger === c.trigger || !integrationId) return
    return setChannelTrigger(integrationId, c.channelId, trigger)
  }
  // Where the platform's rooms take By decision at all, and the plain trigger leaving it lands on (mention where it exists).
  const decisionTriggers = (platform?: string) => {
    const triggers = channelListSemantics(platform).triggers
    return !triggers || triggers.includes('decision')
  }
  const plainTrigger = (platform?: string) => {
    const triggers = channelListSemantics(platform).triggers
    return (['mention', 'any', 'off'] as const).find((trigger) => !triggers || triggers.includes(trigger))
  }
  /** A new gate starts in any room (never a 1:1 DM) whose platform offers By decision, an Off one included. */
  const offers = (platform: string | undefined, c: IntegrationChannelRow) =>
    offered && c.kind !== 'im' && decisionTriggers(platform)

  /** The row's in-line control: the saved gate's pill, or `+ Decision`. */
  const entry = ({
    botId,
    platform,
    integrationId,
    row
  }: {
    botId: string | undefined
    platform: string | undefined
    integrationId: string | undefined
    row: IntegrationChannelRow
  }): ReactNode => {
    if (!decisions) return null
    const plain = plainTrigger(platform)
    return (
      <DecisionGateEntry
        bindingKey={bindingKey(botId, row)}
        saved={savedGate(botId, row)}
        savedName={mode === 'live' ? (row.decision?.name ?? null) : undefined}
        canWrite={!!integrationId}
        offer={offers(platform, row)}
        disabled={!integrationId || busy(botId, row)}
        onStop={() => (plain ? pickTrigger(botId, integrationId, row, plain) : undefined)}
      />
    )
  }

  /** Beneath the row: the gate's status strip, and its rules modal while a draft is open. */
  const strip = ({
    botId,
    integrationId,
    row,
    agentName,
    padX,
    siblings
  }: {
    botId: string | undefined
    integrationId: string | undefined
    row: IntegrationChannelRow
    agentName: string
    padX: number
    /** Every conversation of the same bot, for Apply to all; each writes through its own integration. */
    siblings?: {
      platform: string | undefined
      rows: { integrationId: string | undefined; row: IntegrationChannelRow }[]
    }
  }): ReactNode => {
    if (!decisions) return null
    const key = bindingKey(botId, row)
    const saved = savedGate(botId, row)
    if (!drafts[key] && !saved) return null
    const gate = mockGate(botId, row)
    const write = (
      target: { integrationId: string | undefined; row: IntegrationChannelRow },
      next: ChannelDecisionGate
    ) =>
      mode === 'mock'
        ? Promise.resolve(
            decisions.setGate(bindingKey(botId, target.row), {
              ...next,
              channelName: labelOf(target.row),
              needsReview: false
            })
          )
        : setChannelDecision(target.integrationId!, target.row.channelId, next)
    // Every channel (not a DM) the platform offers By decision in and the viewer can write, each once.
    const targets = (siblings?.rows ?? []).filter(
      (target, at, all) =>
        !!target.integrationId &&
        !isDirectConversation(target.row.kind) &&
        offers(siblings!.platform, target.row) &&
        all.findIndex((other) => other.row.channelId === target.row.channelId) === at
    )
    // A DM's rules stay its own, so the bulk action starts only from a channel.
    const applyAll =
      integrationId &&
      !isDirectConversation(row.kind) &&
      targets.some((target) => target.row.channelId !== row.channelId)
        ? {
            count: targets.length + (targets.some((target) => target.row.channelId === row.channelId) ? 0 : 1),
            onApply: async (next: ChannelDecisionGate) => {
              const all = [
                { integrationId, row },
                ...targets.filter((target) => target.row.channelId !== row.channelId)
              ]
              // One at a time, so a refusal names what failed and the rest still land.
              const failed: string[] = []
              let cause: unknown = null
              for (const target of all) {
                try {
                  await write(target, next)
                } catch (error) {
                  failed.push(labelOf(target.row))
                  cause ??= error
                }
              }
              return { failed, cause }
            }
          }
        : undefined
    return (
      <DecisionBindingStrip
        bindingKey={key}
        conversation={integrationId ? { integrationId, channelId: row.channelId } : null}
        canWrite={!!integrationId}
        agentName={agentName}
        channelName={labelOf(row)}
        padX={padX}
        saved={saved}
        savedName={mode === 'live' ? (row.decision?.name ?? null) : undefined}
        status={
          !saved ? null : mode === 'live' ? gateStatus(row.decision) : gate?.needsReview ? 'needs_review' : 'ready'
        }
        {...(applyAll ? { applyAll } : {})}
        onSave={(next) => write({ integrationId, row }, next)}
      />
    )
  }

  return { decisions, offered, bindingKey, rowTrigger, busy, pickTrigger, decisionTriggers, offers, entry, strip }
}
