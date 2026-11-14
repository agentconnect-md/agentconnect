import { z } from 'zod'
import { SLACK_CODE_MODEL_KEY, SLACK_CODE_CONTEXT_KEY } from '@agentconnect.md/protocol'
import { parseArgs } from '../../mcp/ops/args.js'
import type { SessionContext } from '../../mcp/ops/context.js'
import { buildAttributionBlocks } from '../../slack/render.js'
import { sessionKey } from '../../store/local-store.js'
import type { SlackConnection } from '../../slack/connection.js'
import type { ToolDescriptor } from '../../tool-schema/descriptor.js'
import type { PlatformSessionTools, PlatformSessionToolEnv } from '../read-ports.js'
import { createCodeChannel } from './code-channel.js'

const text = z.string().trim().min(1)
const chartLabel = text.max(20)
const chartPoint = z.object({ label: chartLabel, value: z.number().finite() }).strict()
const reportChart = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('pie'),
      segments: z
        .array(chartPoint.extend({ value: z.number().positive().finite() }))
        .min(1)
        .max(12)
    })
    .strict(),
  z
    .object({
      type: z.enum(['line', 'bar', 'area']),
      series: z
        .array(z.object({ name: chartLabel, data: z.array(chartPoint).min(1).max(20) }).strict())
        .min(1)
        .max(12),
      axis_config: z
        .object({
          categories: z.array(chartLabel).min(1).max(20),
          x_label: text.max(50).optional(),
          y_label: text.max(50).optional()
        })
        .strict()
    })
    .strict()
    .superRefine((chart, ctx) => {
      const categories = new Set(chart.axis_config.categories)
      if (categories.size !== chart.axis_config.categories.length)
        ctx.addIssue({ code: 'custom', message: 'Chart categories must be unique' })
      if (new Set(chart.series.map((series) => series.name)).size !== chart.series.length)
        ctx.addIssue({ code: 'custom', message: 'Chart series names must be unique' })
      for (const series of chart.series) {
        if (
          series.data.length !== categories.size ||
          new Set(series.data.map((point) => point.label)).size !== categories.size ||
          series.data.some((point) => !categories.has(point.label))
        )
          ctx.addIssue({ code: 'custom', message: 'Each series must contain exactly one point per category' })
      }
    })
])
const reportArgs = z
  .object({
    title: text.max(150),
    charts: z
      .array(z.object({ title: text.max(50), chart: reportChart }).strict())
      .min(1)
      .max(2)
      .optional(),
    summary: z.array(text.max(1000)).min(1).max(6).optional(),
    sections: z
      .array(z.object({ title: text.max(150), text: text.max(3000), collapsed: z.boolean().optional() }))
      .max(10)
      .optional(),
    table: z
      .object({
        caption: text.max(150),
        columns: z.array(text.max(100)).min(1).max(20),
        rows: z
          .array(
            z
              .array(z.union([z.string().min(1).max(3000), z.number().finite()]))
              .min(1)
              .max(20)
          )
          .min(1)
          .max(200),
        pageSize: z.number().int().min(1).max(100).optional()
      })
      .optional()
  })
  .strict()
  .refine(
    (a) => a.summary?.length || a.sections?.length || a.table || a.charts?.length,
    'Supply a summary, section, table or chart'
  )

// Slack's table limit includes every cell, including column headings.
export function slackReport(args: z.infer<typeof reportArgs>): { blocks: unknown[]; text: string } {
  const blocks: unknown[] = [{ type: 'header', text: { type: 'plain_text', text: args.title } }]
  const fallback = [args.title]
  if (args.summary?.length) {
    const summary = args.summary.map((text) => ({ type: 'section', text: { type: 'mrkdwn', text } }))
    const rows = []
    for (let i = 0; i < summary.length; i += 3)
      rows.push({ items: summary.slice(i, i + 3).map((block) => ({ block })) })
    blocks.push({ type: 'layout', label: args.title, rows, fallback: summary })
    fallback.push(...args.summary)
  }
  for (const visualization of args.charts ?? []) {
    blocks.push({ type: 'data_visualization', ...visualization })
    const chart = visualization.chart
    const points = (data: { label: string; value: number }[]) =>
      data.map((point) => `${point.label}: ${point.value}`).join(', ')
    fallback.push(
      visualization.title,
      ...(chart.type === 'pie'
        ? [points(chart.segments)]
        : chart.series.map((series) => `${series.name}: ${points(series.data)}`))
    )
  }
  for (const section of args.sections ?? []) {
    blocks.push({
      type: 'container',
      title: { type: 'plain_text', text: section.title },
      is_collapsible: true,
      default_collapsed: section.collapsed ?? true,
      child_blocks: [{ type: 'section', text: { type: 'mrkdwn', text: section.text } }]
    })
    fallback.push(section.title, section.text)
  }
  if (args.table) {
    const table = args.table
    if (table.rows.some((row) => row.length !== table.columns.length))
      throw new Error('Every row must match the column count')
    if ([...table.columns, ...table.rows.flat().map(String)].join('').length > 20000)
      throw new Error('Table cells must total at most 20000 characters')
    blocks.push({
      type: 'data_table',
      caption: table.caption,
      page_size: table.pageSize ?? 5,
      rows: [
        table.columns.map((value) => ({ type: 'raw_text', text: value })),
        ...table.rows.map((row) =>
          row.map((value) =>
            typeof value === 'number'
              ? { type: 'raw_number', text: String(value), value }
              : { type: 'raw_text', text: value }
          )
        )
      ]
    })
    fallback.push(table.caption, table.columns.join(' | '), ...table.rows.map((row) => row.join(' | ')))
  }
  const body = fallback.join('\n\n')
  if (body.length > 39000) throw new Error('Report is too long for one Slack message; split it into separate reports')
  return { blocks, text: body }
}

const descriptor: ToolDescriptor = {
  name: 'presentSlackReport',
  description:
    'Publish findings in this Slack conversation with summary metrics, native charts, collapsible sections and a sortable table. Use charts for trends and comparisons: up to two {title, chart} entries; pie uses positive-valued segments, line/bar/area use named series and axis_config.categories with one point per category. Summary (up to six facts) and sections accept Slack mrkdwn; table strings are plain text, numbers sort numerically. Choose this when the content benefits, without waiting for a format request. Keep short answers in ordinary replies. Posts immediately; do not repeat it in your final reply.',
  inputSchema: z.toJSONSchema(reportArgs, { unrepresentable: 'any' }) as ToolDescriptor['inputSchema']
}

const createArgs = z
  .object({
    name: text.max(255),
    invite: z
      .array(text.max(64))
      .min(1)
      .max(20)
      .optional()
      .describe('Scheduled runs only: Slack user ids of the people to add, at least one.'),
    task: text
      .max(12000)
      .optional()
      .describe('Scheduled runs only: the full task to start in the new channel, with everything needed to do it.')
  })
  .strict()
const viewArgs = z
  .object({
    channelId: text.optional(),
    type: z.enum(['html', 'diff', 'pull_request', 'canvas']),
    viewKey: text.max(255).optional(),
    name: text.max(150).optional(),
    content: z.string().min(1).max(1000000).optional(),
    prUrl: z.url({ protocol: /^https$/ }).optional(),
    canvasId: text.optional(),
    baseBranch: text.max(255).optional(),
    headBranch: text.max(255).optional()
  })
  .strict()
  .superRefine((a, ctx) => {
    const required = a.type === 'canvas' ? 'canvasId' : a.type === 'pull_request' ? 'prUrl' : 'content'
    if (!a[required]) ctx.addIssue({ code: 'custom', message: `${required} is required` })
    if ((a.type === 'html' || a.type === 'canvas') && !a.viewKey)
      ctx.addIssue({ code: 'custom', message: `${a.type} needs a stable viewKey` })
    if (a.content && Buffer.byteLength(a.content) > 1000000)
      ctx.addIssue({ code: 'custom', message: 'content exceeds 1000000 UTF-8 bytes' })
  })
const manageArgs = z
  .object({
    channelId: text.optional(),
    action: z.enum(['context', 'listViews', 'getCanvas', 'removeView', 'archive']),
    canvasId: text.optional(),
    includeResolved: z.boolean().optional(),
    items: z
      .array(
        z
          .object({
            key: text
              .max(64)
              .refine(
                (key) => key !== SLACK_CODE_MODEL_KEY && key !== SLACK_CODE_CONTEXT_KEY,
                'Reserved session control key'
              ),
            label: text.max(128),
            icon: z
              .enum([
                'branch',
                'folder',
                'hierarchy',
                'life-ring',
                'link',
                'globe',
                'terminal',
                'code',
                'search',
                'lock'
              ])
              .optional(),
            status: z
              .enum(['pending', 'passed', 'failed'])
              .optional()
              .describe(
                'Current check result; overrides icon with a monochrome status symbol. Omit when unknown or no checks exist.'
              ),
            url: z
              .url({ protocol: /^https$/ })
              .max(2048)
              .optional()
          })
          .strict()
      )
      .max(3)
      .optional(),
    viewId: text.optional(),
    summaryMessageTs: z
      .string()
      .regex(/^\d+\.\d+$/)
      .optional()
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.action === 'context' && !a.items)
      ctx.addIssue({ code: 'custom', message: 'context needs items (an empty array clears informational items)' })
    if (a.action === 'removeView' && !a.viewId) ctx.addIssue({ code: 'custom', message: 'removeView needs viewId' })
    if (a.action === 'getCanvas' && !a.canvasId) ctx.addIssue({ code: 'custom', message: 'getCanvas needs canvasId' })
  })

const codeTools: ToolDescriptor[] = [
  {
    name: 'createSlackCodeChannel',
    description:
      'Start requested coding work needing several steps, edits, tests or a PR in a dedicated Slack channel, unless the user asks to stay here or the task needs earlier discussion that would be lost. Quick questions stay here. Slack preserves origin privacy, invites its author and copies only the originating message into the new channel. Repeating the same trigger returns the same channel; inside a code channel this reuses the current channel. After creating one, link it and end this turn without duplicating work or asking the user to repeat the task. Follow-ups there share one channel session. A scheduled run posted into a channel may create one from its own post: pass `invite`, the people its instructions name, and `task`, which is delivered there to start the work, then link the channel and end this turn. If creation is unavailable, use the ordinary task workflow here.',
    inputSchema: z.toJSONSchema(createArgs) as ToolDescriptor['inputSchema']
  },
  {
    name: 'setSlackCodeView',
    description:
      'Publish a PR tab when a PR opens or a self-contained HTML preview when it helps review the result. The platform maintains the task diff when automatic updates are active; do not overwrite that Code view. Otherwise this tool can publish an authorized unified diff with diff --git headers and baseBranch/headBranch labels. channelId defaults to this conversation. HTML needs a stable viewKey. Content is limited to 1000000 UTF-8 bytes. No external HTML resources are enabled.',
    inputSchema: z.toJSONSchema(viewArgs) as ToolDescriptor['inputSchema']
  },
  {
    name: 'manageSlackCodeChannel',
    description:
      'Keep a code channel oriented as you work: set its context bar when repository, branch, PR or test status becomes known, and update it as they change. context replaces informational items (max 3), preserving the platform-managed model/effort and context controls. Retain links still relevant. Use icon: branch for repositories; for PRs, set status from checks on the current head: failed if any failed, otherwise pending if any are unfinished, passed only when all checks pass. Omit status when unknown or no checks exist. Labels omit leading icons. Also list/remove view tabs or archive a completed task. channelId defaults to this conversation. Archive only when requested: post the wrap-up first and pass its ts as summaryMessageTs so Slack echoes it to the origin; an archived channel accepts no further posts, so end the turn without another reply there. Native Working, Stop and titles follow the normal turn lifecycle.',
    inputSchema: z.toJSONSchema(manageArgs) as ToolDescriptor['inputSchema']
  }
]

const SLACK_TS = /^\d+\.\d+$/
const SCHEDULED_NEEDS =
  'A scheduled run opens a code channel with `invite`, the Slack user ids of at least one person to add, and ' +
  '`task`, the full task to start there. Nothing was created.'
const NOBODY_JOINED =
  'Nobody named in `invite` could be added, so the code channel was archived rather than left without an owner. ' +
  'Do the work in this conversation instead.'
const nobodyJoinedUnarchived = (channel: string): string =>
  `Nobody named in \`invite\` could be added to the code channel ${channel}, and archiving it failed, so it still ` +
  `exists without an owner. Archive it with manageSlackCodeChannel {"channelId":"${channel}","action":"archive"}; ` +
  'if that fails too, say in this conversation that it needs archiving. Do the work here instead.'

/** Rooms a scheduled run already handed its task to, so a retried creation does not start the work twice. */
const handedOff = new Set<string>()

/** Add the people a scheduled run named and start its task there; a channel nobody joined is archived, never left ownerless. */
async function ownAndStart(
  conn: SlackConnection,
  env: PlatformSessionToolEnv,
  agentId: string,
  channel: string,
  invite: readonly string[],
  task: string
): Promise<Record<string, unknown>> {
  const invited = await conn.inviteToCodeChannel(channel, invite)
  if (invited.length === 0) {
    // Archived is claimed only once Slack has said so; otherwise the channel is named so that it can still be closed.
    const archived = await conn.codeChannelApi('archive', { channel_id: channel }).then(
      () => true,
      () => false
    )
    throw new Error(archived ? NOBODY_JOINED : nobodyJoinedUnarchived(channel))
  }
  const notInvited = invite.filter((user) => !invited.includes(user))
  const outcome = { invited, ...(notInvited.length ? { notInvited } : {}) }
  const key = `${agentId}:${channel}`
  if (handedOff.has(key)) return { ...outcome, handedOff: true }
  try {
    await env.handOff!(channel, task)
  } catch (err) {
    const why = (err as Error).message
    return {
      ...outcome,
      handedOff: false,
      next: `The task could not be started in ${channel} (${why}). Do the work in this conversation instead, and say so in ${channel}.`
    }
  }
  if (handedOff.size >= 1000) handedOff.delete(handedOff.keys().next().value!)
  handedOff.add(key)
  return { ...outcome, handedOff: true }
}

async function execute(
  name: string,
  ctx: SessionContext,
  args: Record<string, unknown>,
  env: PlatformSessionToolEnv
): Promise<unknown> {
  const conn = env.connection as SlackConnection
  if (name === 'createSlackCodeChannel') {
    const a = parseArgs(createArgs, args)
    const here = env.deliveryChannel
    const origin = env.originMsgId?.split(':')
    const asked =
      origin?.length === 3 && origin[0] === 'slack' && origin[1] === here && SLACK_TS.test(origin[2]!)
        ? origin[2]!
        : undefined
    // A schedule's own post stands in for a person's message only in the channel it was anchored to.
    const anchor = env.scheduleAnchor
    const anchored =
      asked === undefined && !ctx.isDm && anchor?.channel === here && SLACK_TS.test(anchor.ts) ? anchor.ts : undefined
    const ts = asked ?? anchored
    if (ts === undefined) throw new Error('A code channel requires a live Slack message as its origin')
    const invite = [...new Set((a.invite ?? []).map((user) => /^<@([^>]+)>$/.exec(user)?.[1] ?? user))]
    if (anchored === undefined && (a.invite !== undefined || a.task !== undefined))
      throw new Error(
        '`invite` and `task` are for a scheduled run; Slack already adds the person who asked. Omit them.'
      )
    if (anchored !== undefined && (invite.length === 0 || a.task === undefined || !env.handOff))
      throw new Error(SCHEDULED_NEEDS)
    const make = async () => {
      const created = await createCodeChannel(
        conn,
        { agentId: ctx.agentId, channel: here, ts, isDm: ctx.isDm && here === ctx.channel },
        a.name,
        () =>
          env.judgeWrite({
            kind: 'new',
            platform: ctx.platform,
            integrationId: ctx.integrationId,
            users: invite,
            ...(anchored !== undefined ? { anchoredIn: here } : {})
          })
      )
      // A code channel's one session keys on the channel itself (slack-code-channels.md), the coordinate a task holds it by.
      const id = created.existing ? undefined : created.channelId
      return { result: { response: created.response, id }, ...(id ? { room: { channel: id, thread: id } } : {}) }
    }
    const made = env.makeRoom ? await env.makeRoom(make) : (await make()).result
    if (anchored === undefined || !made.id) return made.response
    // Slack adds a message's author and its copy starts the work; a schedule's post has neither. Done once the room is attached, so the task's turn does not wait on it.
    return { ...(made.response as object), ...(await ownAndStart(conn, env, ctx.agentId, made.id, invite, a.task!)) }
  }
  if (name === 'setSlackCodeView' || name === 'manageSlackCodeChannel') {
    const a = name === 'setSlackCodeView' ? parseArgs(viewArgs, args) : parseArgs(manageArgs, args)
    const channel = a.channelId ?? env.deliveryChannel
    await env.judgeWrite({ kind: 'conversation', platform: ctx.platform, integrationId: ctx.integrationId, channel })
    const info = await conn.codeChannel(channel)
    if (!info.code || !info.owners.includes(conn.botUserId))
      throw new Error('This bot does not own that Slack code channel')
    if ('type' in a) {
      if (a.type === 'canvas')
        await env.judgeWrite({
          kind: 'document',
          platform: ctx.platform,
          integrationId: ctx.integrationId,
          documentId: a.canvasId!
        })
      return conn.codeChannelApi('setView', {
        channel_id: channel,
        type: a.type,
        view_key: a.viewKey,
        name: a.name,
        content: a.content,
        pr_url: a.prUrl,
        ...(a.type === 'canvas' ? { canvas_id: a.canvasId, access_level: 'comment' as const } : {}),
        base_branch: a.baseBranch,
        head_branch: a.headBranch
      })
    }
    if (a.action === 'getCanvas')
      return conn.codeChannelApi('getCanvas', {
        channel,
        canvas_id: a.canvasId!,
        content_format: 'markdown',
        include_resolved: a.includeResolved ?? false
      })
    if (a.action === 'context') {
      const symbols = { pending: '◷', passed: '✓', failed: '✕' }
      const updated = await conn.updateCodeContext(channel, {
        items: a.items!.map(({ status, icon, label, ...item }) => ({
          ...item,
          label: status ? `${symbols[status]} ${label}`.slice(0, 128) : label,
          ...(status ? {} : { icon: icon ?? 'link' })
        }))
      })
      if (!updated) throw new Error('This bot does not own that Slack code channel')
      return { ok: true }
    }
    if (a.action === 'archive')
      return conn.archiveCodeChannel(
        channel,
        a.summaryMessageTs,
        sessionKey(ctx.platform, ctx.channel, ctx.thread, ctx.agentId, ctx.transportScope)
      )
    if (a.action === 'removeView') return conn.codeChannelApi('removeView', { channel_id: channel, view_id: a.viewId! })
    return conn.codeChannelApi('listViews', { channel_id: channel })
  }
  if (name !== descriptor.name) throw new Error(`Unknown Slack tool: ${name}`)
  const report = slackReport(parseArgs(reportArgs, args))
  await env.judgeWrite({
    kind: 'conversation',
    platform: ctx.platform,
    integrationId: ctx.integrationId,
    channel: env.deliveryChannel
  })
  const attribution = await env.attribution?.()
  const ts = await (env.connection as SlackConnection).postBlocks(
    env.deliveryChannel,
    [...report.blocks, ...(attribution ? buildAttributionBlocks(attribution).blocks : [])],
    report.text,
    env.deliveryThread,
    env.postIdentity()
  )
  if (!ts) throw new Error('Slack did not post the report; its originating thread may have been deleted')
  await env.recordPost(report.text, ts)
  return { channel: env.deliveryChannel, ts }
}

export const SLACK_SESSION_TOOLS: PlatformSessionTools = {
  descriptors: [descriptor, ...codeTools],
  argSchemas: new Map<string, z.ZodType>([
    [descriptor.name, reportArgs],
    ['createSlackCodeChannel', createArgs],
    ['setSlackCodeView', viewArgs],
    ['manageSlackCodeChannel', manageArgs]
  ]),
  execute
}
