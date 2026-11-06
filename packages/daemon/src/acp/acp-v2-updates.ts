import * as V2 from '@agentclientprotocol/sdk/experimental/v2/unstable'
import type * as V1 from '@agentclientprotocol/sdk/unstable'
import { parsePatch } from 'diff'
import { StringDecoder } from 'node:string_decoder'

export function configOptionsFromV2(options: V2.SessionConfigOption[]): V1.SessionConfigOption[] {
  return options.flatMap((option): V1.SessionConfigOption[] => {
    const { configId: id, ...fields } = option
    if (V2.SessionConfigOption.isBoolean(option))
      return [
        {
          ...fields,
          id,
          type: 'select',
          currentValue: option.currentValue ? 'on' : 'off',
          options: [
            { value: 'on', name: 'On' },
            { value: 'off', name: 'Off' }
          ]
        }
      ]
    if (!V2.SessionConfigOption.isSelect(option)) return []
    return [
      {
        ...option,
        id,
        options: option.options.map((item) =>
          'groupId' in item ? { ...item, group: item.groupId } : item
        ) as V1.SessionConfigSelectOptions
      }
    ]
  })
}

// Permissions still reach the same policy resolver and immutable observation stream.
export function permissionFromV2(params: V2.RequestPermissionRequest): V1.RequestPermissionRequest {
  const subject = params.subject
  let toolCall: V1.ToolCallUpdate = { toolCallId: '', title: params.title }
  if (subject && V2.RequestPermissionSubject.isToolCall(subject)) toolCall = toolFromV2(subject.toolCall)
  else if (subject && V2.RequestPermissionSubject.isCommand(subject))
    toolCall = {
      toolCallId: subject.toolCallId ?? subject.terminalId ?? '',
      title: params.title,
      kind: 'execute',
      rawInput: { command: subject.command, cwd: subject.cwd }
    }
  return {
    ...params,
    options: params.options.filter((option): option is V1.PermissionOption =>
      ['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(option.kind)
    ),
    toolCall: { ...toolCall, title: toolCall.title ?? params.title }
  }
}

function toolFromV2(tool: V2.ToolCallUpdate): V1.ToolCallUpdate {
  const kind =
    tool.kind &&
    ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'].includes(
      tool.kind
    )
      ? (tool.kind as V1.ToolKind)
      : undefined
  const status =
    tool.status && ['pending', 'in_progress', 'completed', 'failed'].includes(tool.status)
      ? (tool.status as V1.ToolCallStatus)
      : undefined
  return { ...tool, kind, status, content: tool.content?.flatMap(contentFromV2) }
}

function contentFromV2(content: V2.ToolCallContent): V1.ToolCallContent[] {
  if (V2.ToolCallContent.isContent(content) || V2.ToolCallContent.isTerminal(content))
    return [content as V1.ToolCallContent]
  if (!V2.ToolCallContent.isDiff(content)) return []
  if (content.patch?.format !== 'git_patch') return []
  const patches = parsePatch(content.patch.text)
  return content.changes.flatMap((change, index): V1.ToolCallContent[] => {
    if (typeof change.path !== 'string') return []
    const patch = patches[index]
    if (!patch) return []
    // Match the daemon's existing per-hunk diff representation without reading runtime files.
    const hunks = patch.hunks.length ? patch.hunks : [{ lines: [] }]
    return hunks.map((hunk) => {
      let before = '',
        after = '',
        previous = ' '
      for (const line of hunk.lines) {
        const sign = line[0]
        if (sign === '\\') {
          if (previous !== '+') before = before.replace(/\n$/, '')
          if (previous !== '-') after = after.replace(/\n$/, '')
        } else {
          if (sign !== '+') before += line.slice(1) + '\n'
          if (sign !== '-') after += line.slice(1) + '\n'
          previous = sign ?? ' '
        }
      }
      return {
        type: 'diff',
        path: change.path as string,
        oldText: change.operation === 'add' ? null : before,
        newText: after,
        _meta: content._meta
      }
    })
  })
}

// Entity snapshots persist across updates; terminal buffers are bounded independently of transcript retention.
export class V2SessionUpdates {
  private tools = new Map<string, V2.ToolCallUpdate>()
  private terminalTools = new Map<string, Set<string>>()
  private terminals = new Map<string, { text: string; decoder: StringDecoder }>()
  private plans = new Map<string, string>()

  // Markdown plans replace snapshots; publish the final text once to append-only chat consumers.
  finish(): V1.SessionUpdate[] {
    const updates: V1.SessionUpdate[] = [...this.plans].map(([messageId, text]) => ({
      sessionUpdate: 'agent_message_chunk',
      messageId,
      content: { type: 'text', text }
    }))
    this.plans.clear()
    return updates
  }

  update(update: V2.SessionUpdate): V1.SessionUpdate[] {
    if (V2.SessionUpdate.isPlanUpdate(update) && V2.PlanUpdateContent.isMarkdown(update.plan)) {
      this.plans.set(update.plan.planId, update.plan.content)
      return []
    }
    if (V2.SessionUpdate.isPlanRemoved(update)) this.plans.delete(update.planId)
    if (V2.SessionUpdate.isToolCallUpdate(update)) {
      const old = this.tools.get(update.toolCallId)
      const merged = {
        ...old,
        ...Object.fromEntries(Object.entries(update).filter(([, value]) => value != null))
      } as V2.ToolCallUpdate
      const meta = { ...old?._meta }
      if (update._meta === null) merged._meta = null
      else if (update._meta) {
        for (const [key, value] of Object.entries(update._meta)) {
          if (value === null) delete meta[key]
          else meta[key] = value
        }
        merged._meta = meta
      }
      this.tools.set(update.toolCallId, merged)
      if (update.content) {
        for (const content of old?.content ?? []) {
          if (V2.ToolCallContent.isTerminal(content))
            this.terminalTools.get(content.terminalId)?.delete(update.toolCallId)
        }
      }
      for (const content of update.content ?? []) {
        if (!V2.ToolCallContent.isTerminal(content)) continue
        let ids = this.terminalTools.get(content.terminalId)
        if (!ids) this.terminalTools.set(content.terminalId, (ids = new Set()))
        ids.add(update.toolCallId)
      }
      const output = this.outputFor(update.toolCallId)
      const tool = {
        ...toolFromV2(merged),
        ...(output ? { rawOutput: this.withOutput(merged.rawOutput, output) } : {})
      }
      return [
        old
          ? { ...tool, sessionUpdate: 'tool_call_update' }
          : {
              ...tool,
              sessionUpdate: 'tool_call',
              title: tool.title ?? tool.toolCallId,
              kind: tool.kind ?? undefined,
              status: tool.status ?? undefined,
              content: tool.content ?? undefined,
              locations: tool.locations ?? undefined,
              name: tool.name ?? undefined
            }
      ]
    }
    if (V2.SessionUpdate.isToolCallContentChunk(update)) {
      const old = this.tools.get(update.toolCallId)
      return this.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: update.toolCallId,
        content: [...(old?.content ?? []), update.content]
      })
    }
    if (V2.SessionUpdate.isTerminalUpdate(update) || V2.SessionUpdate.isTerminalOutputChunk(update)) {
      let terminal = this.terminals.get(update.terminalId)
      if (!terminal)
        this.terminals.set(update.terminalId, (terminal = { text: '', decoder: new StringDecoder('utf8') }))
      if (V2.SessionUpdate.isTerminalOutputChunk(update)) {
        const text = terminal.decoder.write(Buffer.from(update.data, 'base64'))
        terminal.text = (terminal.text + text).slice(0, 256 * 1024)
      } else if (update.output) {
        terminal.decoder = new StringDecoder('utf8')
        terminal.text = terminal.decoder.write(Buffer.from(update.output.data, 'base64')).slice(0, 256 * 1024)
      }
      return [...(this.terminalTools.get(update.terminalId) ?? [])].map((id) => ({
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        rawOutput: this.withOutput(this.tools.get(id)?.rawOutput, this.outputFor(id))
      }))
    }
    if (V2.SessionUpdate.isPlanUpdate(update) && V2.PlanUpdateContent.isItems(update.plan)) {
      return [
        {
          sessionUpdate: 'plan',
          entries: update.plan.entries.map((entry) => ({
            ...entry,
            priority: ['high', 'medium', 'low'].includes(entry.priority)
              ? (entry.priority as V1.PlanEntryPriority)
              : 'medium',
            status: ['pending', 'in_progress', 'completed'].includes(entry.status)
              ? (entry.status as V1.PlanEntryStatus)
              : 'pending'
          })),
          _meta: update._meta
        }
      ]
    }
    if (V2.SessionUpdate.isAvailableCommandsUpdate(update))
      return [
        {
          ...update,
          availableCommands: update.availableCommands.flatMap((command): V1.AvailableCommand[] => {
            if (!V2.AvailableCommand.isCommand(command)) return []
            return [
              {
                ...command,
                input: command.input && V2.AvailableCommandInput.isText(command.input) ? command.input : undefined
              }
            ]
          })
        }
      ]
    // Codex sends append-only message chunks; v1 and v2 share their content and message identity.
    if (
      V2.SessionUpdate.isAgentMessageChunk(update) ||
      V2.SessionUpdate.isAgentThoughtChunk(update) ||
      V2.SessionUpdate.isUserMessageChunk(update) ||
      V2.SessionUpdate.isSessionInfoUpdate(update) ||
      V2.SessionUpdate.isUsageUpdate(update) ||
      V2.SessionUpdate.isPlanUpdate(update) ||
      V2.SessionUpdate.isPlanRemoved(update) ||
      V2.SessionUpdate.isNotice(update) ||
      V2.SessionUpdate.isCompactionUpdate(update) ||
      V2.SessionUpdate.isCompactionSummaryChunk(update)
    )
      return [update as V1.SessionUpdate]
    return []
  }

  private outputFor(toolId: string): string {
    return (this.tools.get(toolId)?.content ?? [])
      .flatMap((item) => (V2.ToolCallContent.isTerminal(item) ? [this.terminals.get(item.terminalId)?.text ?? ''] : []))
      .join('\n')
  }

  private withOutput(raw: unknown, output: string): unknown {
    if (raw && typeof raw === 'object') {
      if ('formatted_output' in raw && raw.formatted_output) return raw
      return { ...raw, formatted_output: output }
    }
    return raw || { formatted_output: output }
  }
}
