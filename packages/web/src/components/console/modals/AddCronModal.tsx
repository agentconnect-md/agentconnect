// No 'use client' here: rendered only by ModalProvider (the client boundary).
// Design "isScheduleModal": Name + Agent, a visual "Repeats" builder (Hourly /
// Daily / Weekdays / Weekly presets + a Custom raw-cron escape hatch, with the
// human reading + IANA timezone), Prompt, optional Target integration (where
// the run posts its output; empty ⇒ session only), and a fresh-session info note.
// Creator/created-at live on the schedule DETAIL page, not here.

import { useState } from 'react'
import { agentLabel, MOCK_PREFIX } from '@/lib/data'
import { chatRoomSigil } from '@/lib/platform-labels'
import type { CronDto } from '@/lib/api'
import {
  buildCron,
  cronHuman,
  cronTimezoneInput,
  cronTimezoneSelectModel,
  cronUpdateInput,
  type CronMode,
  parseCron
} from '@/lib/cron'
import { useConsoleData } from '@/lib/data-context'
import { useProfile } from '@/lib/profile'
import { randomUuid } from '@/lib/random-uuid'
import { AgentIconView, PlatformMark } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { VisibilityField, sameSharing, type SharingValue } from '@/components/console/VisibilityField'

// The visual "Repeats" builder: preset frequencies plus a Custom escape hatch.
const FREQS: { key: CronMode; label: string }[] = [
  { key: 'hourly', label: 'Hourly' },
  { key: 'daily', label: 'Daily' },
  { key: 'weekdays', label: 'Weekdays' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'custom', label: 'Custom' }
]
// Sunday-first, matching cron's weekday numbering (Sunday = 0).
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

// Native time / number inputs styled to match the modal's `.inp.mn` pill (the
// class sets display:flex which fights the browser's internal time UI).
const PILL_INPUT =
  'min-h-9 rounded-sm border border-(--border-default) bg-(--surface-card) px-[11px] py-0 font-mono text-[12.5px] text-(--text-primary)'

// "At <time>" field shared by the Daily / Weekdays / Weekly presets. The native
// picker speaks "HH:MM"; we surface it back to the builder as hour + minute.
function TimeField({
  hour,
  minute,
  onChange
}: {
  hour: number
  minute: number
  onChange: (hour: number, minute: number) => void
}) {
  return (
    <div className="fld">
      <span className="fldlbl">At</span>
      <input
        type="time"
        aria-label="Time of day"
        value={`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`}
        onChange={(e) => {
          const [h, m] = e.target.value.split(':')
          if (h !== undefined && m !== undefined) onChange(Number(h), Number(m))
        }}
        className={`${PILL_INPUT} w-[130px]`}
      />
    </div>
  )
}

// The semantic target: which integration's bot posts the anchor, and where.
// No channel ⇒ headless fire (the run stays in the session).
interface Target {
  integrationId?: string
  channel?: string
  // §6.8 open id — the anchor integration's REAL platform (the old two-value
  // union silently coerced Discord/Feishu anchors to 'slack').
  platform: string
}

// Headless fire: no channel; the platform is a legacy sentinel the CP defaults anyway.
const HEADLESS: Target = { platform: 'slack' }

export default function AddCronModal({ cron, onClose }: { cron?: CronDto | null; onClose: () => void }) {
  const { agents, integrations, saveCron, saveSharing } = useConsoleData()
  const { me } = useProfile()
  // Only real agents can own a cron (a mock agent isn't on any daemon).
  const realAgents = agents.filter((a) => !a.name.startsWith(MOCK_PREFIX))

  const [name, setName] = useState(cron?.name ?? '')
  const [agentId, setAgentId] = useState(cron?.agentId ?? realAgents[0]?.id ?? '')
  const selectedAgent = realAgents.find((a) => a.id === agentId)
  // Cron state lives as builder parts. A new schedule defaults to Weekly · Mon
  // 9:00; editing parses the stored expression back to the matching preset (or
  // Custom). `customExpr` holds the raw text while Custom is active.
  const initial = cron?.schedule
    ? parseCron(cron.schedule)
    : { mode: 'weekly' as CronMode, minute: 0, hour: 9, weekday: 1 }
  const [mode, setMode] = useState<CronMode>(initial.mode)
  const [hour, setHour] = useState(initial.hour)
  const [minute, setMinute] = useState(initial.minute)
  const [weekday, setWeekday] = useState(initial.weekday)
  const [customExpr, setCustomExpr] = useState(cron?.schedule ?? '')
  const [timezoneModel] = useState(() => {
    const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const supportedTimezones =
      (Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] }).supportedValuesOf?.('timeZone') ??
      []
    return cronTimezoneSelectModel(cron?.timezone, browserTimezone, supportedTimezones)
  })
  const [timezone, setTimezone] = useState(timezoneModel.initialValue)
  const [target, setTarget] = useState<Target>(
    cron?.targetChannel
      ? {
          channel: cron.targetChannel,
          platform: cron.targetPlatform,
          ...(cron.targetIntegrationId ? { integrationId: cron.targetIntegrationId } : {})
        }
      : HEADLESS
  )
  const [trigger, setTrigger] = useState(cron?.trigger ?? '')
  const [sharing, setSharing] = useState<SharingValue>({
    visibility: cron?.visibility ?? 'org',
    sharedWith: cron?.sharedWith ?? []
  })
  const initialSharing: SharingValue = { visibility: cron?.visibility ?? 'org', sharedWith: cron?.sharedWith ?? [] }
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // A shared-bot channel belongs to its configured default agent. Collapse the
  // same platform channel across integrations, preferring that explicit owner
  // over a direct-bot duplicate; the cron's agentId still chooses the runtime.
  const targetCandidates = integrations
    .filter((i) => i.id && i.agentId === agentId)
    .flatMap((i) =>
      i.channels
        .filter((ch) => !i.shareable || ch.agentId === agentId)
        .map((ch) => ({
          value: `${i.id}|${ch.channelId}`,
          // The room sigil is the integration's platform's own — a Linear team has none.
          label: `${chatRoomSigil(i.platform)}${ch.name}`,
          integrationId: i.id!,
          channelId: ch.channelId,
          channelName: ch.name,
          platform: i.platform, // §6.8: the integration's real platform — no coercion
          sharedOwner: !!i.shareable
        }))
    )
  const channelOpts = [
    ...targetCandidates
      .reduce((byChannel, option) => {
        const key = `${option.platform}:${option.channelId}`
        const existing = byChannel.get(key)
        if (!existing || (option.sharedOwner && !existing.sharedOwner)) byChannel.set(key, option)
        return byChannel
      }, new Map<string, (typeof targetCandidates)[number]>())
      .values()
  ]
  // Resolve the current target to an option: exact integration+channel first,
  // then the preferred owner for that channel (legacy rows and collapsed
  // duplicates adopt it on save). A channel the bot no longer reports keeps a
  // "(current)" fallback so editing another field doesn't silently drop it.
  const selectedOpt = target.channel
    ? (channelOpts.find((o) => o.channelId === target.channel && o.integrationId === target.integrationId) ??
      channelOpts.find((o) => o.channelId === target.channel && o.platform === target.platform))
    : undefined
  const selectValue = target.channel ? (selectedOpt?.value ?? 'current') : ''

  const pickTarget = (value: string) => {
    if (value === '') return setTarget(HEADLESS)
    if (value === 'current') return // the preserved legacy/stale target — unchanged
    const opt = channelOpts.find((o) => o.value === value)
    if (opt) setTarget({ integrationId: opt.integrationId, channel: opt.channelId, platform: opt.platform })
  }

  const editing = !!cron
  // The effective expression: Custom drives the raw field, presets compose it.
  const schedule = mode === 'custom' ? customExpr.trim() : buildCron(mode, hour, minute, weekday)
  const human = schedule ? cronHuman(schedule) : null
  const timezoneValue = timezone.trim()
  const timezoneInput = cronTimezoneInput(cron, timezone)
  const timezoneValid = timezoneInput !== null
  // A cron drives one agent — name + agent + schedule + prompt are required;
  // the target is optional output routing (empty ⇒ session only). Presets always
  // yield a valid expression; a Custom one must parse before we let it save.
  const valid = !!(
    name.trim() &&
    agentId &&
    schedule &&
    trigger.trim() &&
    (mode !== 'custom' || human) &&
    timezoneValid
  )

  const save = async () => {
    if (!valid || saving) return
    setSaving(true)
    setErr(null)
    try {
      // Channel-only legacy match: adopt the option's integration on save.
      const eff = selectedOpt
        ? { integrationId: selectedOpt.integrationId, channel: selectedOpt.channelId, platform: selectedOpt.platform }
        : target
      const creating = !cron
      const cronId = cron?.id ?? randomUuid()
      const existingInput = cron ? cronUpdateInput(cron) : null
      await saveCron(cronId, {
        ...(existingInput ?? {}),
        agentId,
        name: name.trim(),
        schedule: schedule.trim(),
        ...(timezoneInput ?? {}),
        targetPlatform: eff.platform,
        targetChannel: eff.channel,
        targetIntegrationId: eff.channel ? eff.integrationId : undefined,
        trigger: trigger.trim(),
        // No enabled toggle in this modal — new crons start enabled; edits keep
        // the current state (managed from the crons list / schedule detail page).
        enabled: cron?.enabled ?? true,
        // Atomic restricted-create: the visibility rides the create body (the CP
        // honors it only on create). On EDIT it goes through the dedicated /sharing
        // endpoint below, since the content upsert never touches sharing.
        ...(creating && sharing.visibility === 'restricted'
          ? { visibility: 'restricted' as const, sharedWith: sharing.sharedWith }
          : {})
      })
      if (!creating && !sameSharing(sharing, initialSharing)) await saveSharing('crons', cronId, sharing)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
          <Icon name="calendar-clock" size={17} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">
          {editing ? 'Edit schedule' : 'New schedule'}
        </span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <div className="grid grid-cols-2 gap-[12px] min-[440px]:gap-[14px]">
          <div className="fld">
            <span className="fldlbl">Name</span>
            <input
              className="inp mn"
              placeholder="weekly-deploy-report"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="fld">
            <span className="fldlbl">Agent</span>
            <div className="inp relative">
              <span className="inline-flex min-w-0 items-center gap-[7px]">
                {selectedAgent ? (
                  <span className="av h-[14px] w-[14px] rounded-[3px]">
                    <AgentIconView icon={selectedAgent.icon} runtime={selectedAgent.runtime} size={14} />
                  </span>
                ) : (
                  <Icon name="bot" size={14} color="var(--text-tertiary)" />
                )}
                <span
                  className={`mono truncate text-[12.5px] ${agentId ? 'text-(--text-primary)' : 'text-(--text-tertiary)'}`}
                >
                  {selectedAgent ? agentLabel(selectedAgent) : 'No agent'}
                </span>
              </span>
              <Icon name="chevron-down" size={15} color="var(--text-tertiary)" />
              <select
                value={agentId}
                onChange={(e) => {
                  if (e.target.value === agentId) return
                  setAgentId(e.target.value)
                  setTarget(HEADLESS) // channels belong to the previous agent's integrations
                }}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="Agent"
              >
                {realAgents.length === 0 && <option value="">No agents</option>}
                {realAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {agentLabel(a)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="fld mt-[14px]">
          <span className="fldlbl">Repeats</span>
          <div className="flex flex-wrap gap-[5px] desktop:gap-[6px]">
            {FREQS.map((f) => {
              const on = mode === f.key
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => {
                    // Seed Custom with the preset it's leaving so the raw field
                    // isn't empty on first switch.
                    if (f.key === 'custom' && !customExpr.trim() && schedule) setCustomExpr(schedule)
                    setMode(f.key)
                  }}
                  className={`h-[30px] cursor-pointer rounded-sm border px-[7px] py-0 font-sans text-[12.5px] font-medium leading-normal desktop:px-[13px] ${
                    on
                      ? 'border-(--brand) bg-(--brand-soft) text-(--brand)'
                      : 'border-(--border-default) bg-(--surface-card) text-(--text-secondary)'
                  }`}
                >
                  {f.label}
                </button>
              )
            })}
          </div>
        </div>

        {mode === 'weekly' && (
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-3">
            <div className="fld">
              <span className="fldlbl">On</span>
              <div className="flex gap-[5px]">
                {DAY_INITIALS.map((label, i) => {
                  const on = weekday === i
                  return (
                    <button
                      key={i}
                      type="button"
                      title={DAYS[i]}
                      onClick={() => setWeekday(i)}
                      className={`h-[30px] min-w-0 max-w-[34px] flex-1 basis-0 cursor-pointer rounded-sm border font-sans text-[12px] font-medium leading-normal ${
                        on
                          ? 'border-(--brand) bg-(--brand) text-white'
                          : 'border-(--border-default) bg-(--surface-card) text-(--text-secondary)'
                      }`}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>
            <TimeField
              hour={hour}
              minute={minute}
              onChange={(h, m) => {
                setHour(h)
                setMinute(m)
              }}
            />
          </div>
        )}

        {(mode === 'daily' || mode === 'weekdays') && (
          <div className="mt-3">
            <TimeField
              hour={hour}
              minute={minute}
              onChange={(h, m) => {
                setHour(h)
                setMinute(m)
              }}
            />
          </div>
        )}

        {mode === 'hourly' && (
          <div className="fld mt-3">
            <span className="fldlbl">At minute</span>
            <input
              type="number"
              min={0}
              max={59}
              aria-label="Minute of the hour"
              value={minute}
              onChange={(e) => setMinute(Math.max(0, Math.min(59, Math.floor(Number(e.target.value) || 0))))}
              className={`${PILL_INPUT} w-[110px]`}
            />
          </div>
        )}

        {mode === 'custom' && (
          <div className="fld mt-3">
            <span className="fldlbl">Cron expression</span>
            <input
              className="inp mn"
              placeholder="0 9 * * 1"
              value={customExpr}
              onChange={(e) => setCustomExpr(e.target.value)}
            />
          </div>
        )}

        <div className="mt-[9px] flex items-center gap-[7px]">
          <Icon name="calendar-clock" size={13} color="var(--text-tertiary)" className="flex-none" />
          <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            {schedule ? (
              human ? (
                <>
                  {human} · {timezoneValue} · <span className="mono text-[11px]">{schedule}</span>
                </>
              ) : (
                'Not a valid cron expression.'
              )
            ) : (
              'Five fields: minute hour day month weekday.'
            )}
          </span>
        </div>

        <div className="fld mt-3">
          <span className="fldlbl">Timezone</span>
          <select
            className="inp mn"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            aria-invalid={!timezoneValid}
          >
            {timezoneModel.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="mt-1 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            {timezoneValid
              ? 'The selected IANA timezone is used to calculate each UTC fire time.'
              : 'Select a valid IANA timezone.'}
          </span>
        </div>

        <div className="fld mt-[14px]">
          <span className="fldlbl">Prompt</span>
          <textarea
            className="inp min-h-15 resize-y px-3 py-2 leading-[1.5]"
            placeholder="Summarize last week's deploys and rollbacks, and post the report to #deploys."
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
          />
        </div>

        <div className="fld mt-[14px]">
          <span className="fldlbl">
            Target integration{' '}
            <span className="font-normal tracking-normal normal-case text-(--text-tertiary)">— optional</span>
          </span>
          <div className="inp relative">
            <span className="inline-flex min-w-0 items-center gap-[7px]">
              {target.channel ? (
                <>
                  <span className="imark h-[14px] w-[14px]">
                    <PlatformMark platform={target.platform} />
                  </span>
                  <span className="mono text-[12.5px]">
                    {selectedOpt
                      ? `${chatRoomSigil(selectedOpt.platform)}${selectedOpt.channelName}`
                      : `${target.channel} (current)`}
                  </span>
                </>
              ) : (
                <span className="font-sans text-[12.5px] font-normal leading-normal text-(--text-disabled)">
                  None — session only
                </span>
              )}
            </span>
            <Icon name="chevron-down" size={15} color="var(--text-tertiary)" />
            <select
              value={selectValue}
              onChange={(e) => pickTarget(e.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="Target integration"
            >
              <option value="">None — session only</option>
              {selectValue === 'current' && <option value="current">{`${target.channel} (current)`}</option>}
              {channelOpts.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <span className="mt-1 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            Where the run posts its output. Leave empty to keep it in the session only.
          </span>
        </div>

        <div className="mt-[14px] flex items-start gap-2 rounded-md bg-(--surface-sunken) px-3 py-[11px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          <Icon name="info" size={14} className="mt-[1px] flex-none" />
          <span>Each run starts a fresh session for the agent — you&rsquo;ll see it under Sessions.</span>
        </div>

        <VisibilityField value={sharing} onChange={setSharing} disabled={!!cron && !cron.canManageSharing} />

        {err && (
          <div className="mt-[14px] flex items-start gap-2 rounded-md border border-(--status-error) bg-(--status-error-soft) px-3 py-[11px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--status-error)">
            <Icon name="triangle-alert" size={15} />
            {err}
          </div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void save()} className={valid && !saving ? undefined : 'cursor-default opacity-50'}>
          <Icon name="calendar-clock" size={15} />
          {saving ? 'Saving…' : editing ? 'Save' : 'Create'}
        </Button>
      </div>
    </>
  )
}
