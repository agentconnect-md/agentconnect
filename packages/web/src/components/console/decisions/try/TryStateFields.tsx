'use client'

// Each lane's Try state as its JSON, editable where a sample varies (decisions.md §9.3).

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type {
  ApiGateTryState,
  CodeHostTryState,
  ConversationTryState,
  RoutingTryState
} from '@agentconnect.md/protocol/decision'
import { TRY_BOUND_KEYS, type TryLane } from '@/lib/decisions/try-state'
import {
  JsonAgents,
  JsonArray,
  JsonBoolean,
  JsonFold,
  JsonLiteral,
  JsonObject,
  JsonRemove,
  JsonTag,
  JsonText
} from './StateJson'

type Entry = { sender: { id: string; association?: string }; text: string }

function Bound({ lane }: { lane: TryLane }) {
  const t = useTranslations('Decisions.tryState')
  return <JsonFold title={t('bound', { keys: TRY_BOUND_KEYS[lane].join(', ') })} />
}

function Sender({ value, onChange, label }: { value: string; onChange: (id: string) => void; label: string }) {
  return (
    <JsonObject name="sender" inline>
      <JsonTag name="id" value={value} onChange={onChange} label={label} />
    </JsonObject>
  )
}

function CurrentMessage<E extends { text: string; sender?: { id: string } }>({
  value,
  onChange
}: {
  value: E
  onChange: (next: E) => void
}) {
  const t = useTranslations('Decisions.tryState')
  return (
    <JsonObject name="currentMessage">
      {value.sender && (
        <Sender
          value={value.sender.id}
          label={t('currentSender')}
          onChange={(id) => onChange({ ...value, sender: { ...value.sender!, id } })}
        />
      )}
      <JsonText
        name="text"
        value={value.text}
        label={t('currentText')}
        placeholder={t('currentPlaceholder')}
        onChange={(text) => onChange({ ...value, text })}
      />
    </JsonObject>
  )
}

function History<E extends Entry>({
  value,
  onChange,
  blank
}: {
  value: readonly E[]
  onChange: (next: E[]) => void
  blank: () => E
}) {
  const t = useTranslations('Decisions.tryState')
  const update = (index: number, next: E) => onChange(value.map((entry, at) => (at === index ? next : entry)))
  return (
    <JsonArray
      name="history"
      count={value.length}
      addLabel={t('addHistory')}
      onAdd={() => onChange([...value, blank()])}
    >
      {value.map((entry, index) => (
        <JsonObject
          key={index}
          action={
            <JsonRemove
              label={t('removeHistory', { index: index + 1 })}
              onRemove={() => onChange(value.filter((_, at) => at !== index))}
            />
          }
        >
          <Sender
            value={entry.sender.id}
            label={t('historySender', { index: index + 1 })}
            onChange={(id) => update(index, { ...entry, sender: { ...entry.sender, id } })}
          />
          <JsonText
            name="text"
            value={entry.text}
            label={t('historyText', { index: index + 1 })}
            onChange={(text) => update(index, { ...entry, text })}
          />
        </JsonObject>
      ))}
    </JsonArray>
  )
}

export function ConversationStateFields({
  value,
  onChange
}: {
  value: ConversationTryState
  onChange: (next: ConversationTryState) => void
}) {
  return (
    <>
      <Bound lane="conversation" />
      <CurrentMessage
        value={value.currentMessage}
        onChange={(currentMessage) => onChange({ ...value, currentMessage })}
      />
      <History
        value={value.history}
        onChange={(history) => onChange({ ...value, history })}
        blank={() => ({ sender: { id: 'U0456EFGH' }, text: '' })}
      />
    </>
  )
}

export function RoutingStateFields({
  value,
  onChange,
  agents
}: {
  value: RoutingTryState
  onChange: (next: RoutingTryState) => void
  /** The bot's member agents, by name; addressing keeps their ids. */
  agents: ReadonlyArray<{ id: string; name: string }>
}) {
  const t = useTranslations('Decisions.tryState')
  const addressing = value.addressing ?? {
    mentions: [],
    constraint: { eligibleAgentIds: [], participantAgentIds: [] }
  }
  const setAddressing = (next: typeof addressing) => onChange({ ...value, addressing: next })
  const agentsField = (name: string, ids: readonly string[], set: (ids: string[]) => void) => (
    <JsonAgents
      name={name}
      ids={ids}
      agents={agents}
      onChange={set}
      addLabel={t('addAgent', { field: name })}
      addText={t('addAgentShort')}
      removeLabel={(agent) => t('removeAgent', { agent })}
    />
  )
  return (
    <>
      <Bound lane="routing" />
      <CurrentMessage
        value={value.currentMessage}
        onChange={(currentMessage) => onChange({ ...value, currentMessage })}
      />
      <History
        value={value.history}
        onChange={(history) => onChange({ ...value, history })}
        blank={() => ({ sender: { id: 'U0456EFGH' }, text: '' })}
      />
      <JsonObject name="addressing">
        {agentsField('mentions', addressing.mentions, (mentions) => setAddressing({ ...addressing, mentions }))}
        <JsonObject name="constraint">
          {agentsField('eligibleAgentIds', addressing.constraint.eligibleAgentIds, (eligibleAgentIds) =>
            setAddressing({ ...addressing, constraint: { ...addressing.constraint, eligibleAgentIds } })
          )}
          {agentsField('participantAgentIds', addressing.constraint.participantAgentIds, (participantAgentIds) =>
            setAddressing({ ...addressing, constraint: { ...addressing.constraint, participantAgentIds } })
          )}
        </JsonObject>
      </JsonObject>
    </>
  )
}

export function ApiStateFields({
  value,
  onChange
}: {
  value: ApiGateTryState
  onChange: (next: ApiGateTryState) => void
}) {
  return (
    <>
      <Bound lane="api" />
      <CurrentMessage
        value={value.currentMessage}
        onChange={(currentMessage) => onChange({ ...value, currentMessage })}
      />
      <JsonLiteral name="history" value={[]} />
    </>
  )
}

// The typed text stays as typed, so a trailing comma survives until the next label.
function LabelsTag({ value, onChange }: { value: readonly string[]; onChange: (next: string[]) => void }) {
  const t = useTranslations('Decisions.tryState')
  const [text, setText] = useState(value.join(', '))
  return (
    <JsonTag
      name="labels"
      value={text}
      placeholder="bug, docs"
      label={t('subjectLabels')}
      onChange={(next) => {
        setText(next)
        onChange(
          next
            .split(',')
            .map((label) => label.trim())
            .filter(Boolean)
        )
      }}
    />
  )
}

function Diff({ value, onChange, label }: { value: string; onChange: (next: string) => void; label: string }) {
  const t = useTranslations('Decisions.tryState')
  const [open, setOpen] = useState(false)
  if (open) return <JsonText name="diff" value={value} onChange={onChange} label={label} maxRows={12} />
  return (
    <div className="flex items-center gap-[6px]">
      <span className="text-(--text-secondary)">&quot;diff&quot;:</span>
      <button type="button" className="lnk font-sans text-[11.5px] font-medium" onClick={() => setOpen(true)}>
        {value ? t('showDiff', { lines: value.split('\n').length }) : t('addDiff')}
      </button>
    </div>
  )
}

export function CodeHostStateFields({
  value,
  onChange
}: {
  value: CodeHostTryState
  onChange: (next: CodeHostTryState) => void
}) {
  const t = useTranslations('Decisions.tryState')
  const subject = value.subject
  const setSubject = (patch: Partial<CodeHostTryState['subject']>) =>
    onChange({ ...value, subject: { ...subject, ...patch } })
  const optional = (text: string) => (text ? text : undefined)
  const pull = value.pullRequest
  const setPull = (patch: Partial<NonNullable<CodeHostTryState['pullRequest']>>) =>
    pull && onChange({ ...value, pullRequest: { ...pull, ...patch } })
  const setFile = (index: number, patch: Partial<NonNullable<CodeHostTryState['pullRequest']>['files'][number]>) =>
    pull && setPull({ files: pull.files.map((file, at) => (at === index ? { ...file, ...patch } : file)) })
  const count = (text: string) => (/^\d+$/.test(text) ? Number(text) : undefined)
  return (
    <>
      <Bound lane="code_host" />
      <JsonObject name="event" inline>
        <JsonTag
          name="name"
          value={value.event.name}
          label={t('eventName')}
          onChange={(name) => onChange({ ...value, event: { ...value.event, name } })}
        />
        <JsonTag
          name="action"
          value={value.event.action ?? ''}
          label={t('eventAction')}
          onChange={(action) => onChange({ ...value, event: { ...value.event, action: optional(action) } })}
        />
      </JsonObject>
      <JsonObject name="subject">
        <div className="flex flex-wrap items-center gap-x-[12px]">
          <JsonTag
            name="kind"
            value={subject.kind ?? ''}
            label={t('subjectKind')}
            onChange={(kind) => setSubject({ kind: optional(kind) as typeof subject.kind })}
          />
          <JsonTag
            name="number"
            numeric
            value={subject.number === undefined ? '' : String(subject.number)}
            label={t('subjectNumber')}
            onChange={(number) => setSubject({ number: count(number) })}
          />
          <JsonTag
            name="state"
            value={subject.state ?? ''}
            label={t('subjectState')}
            onChange={(state) => setSubject({ state: optional(state) })}
          />
        </div>
        <JsonText
          name="title"
          value={subject.title ?? ''}
          label={t('subjectTitle')}
          onChange={(title) => setSubject({ title })}
        />
        <JsonObject name="author" inline>
          <JsonTag
            name="login"
            value={subject.author?.login ?? ''}
            label={t('subjectAuthor')}
            onChange={(login) => setSubject({ author: { ...subject.author, login: optional(login) } })}
          />
        </JsonObject>
        <LabelsTag value={subject.labels} onChange={(labels) => setSubject({ labels })} />
        {subject.draft !== undefined && (
          <JsonBoolean
            name="draft"
            value={subject.draft}
            label={t('subjectDraft')}
            onChange={(draft) => setSubject({ draft })}
          />
        )}
        <JsonText
          name="body"
          value={subject.body ?? ''}
          label={t('subjectBody')}
          onChange={(body) => setSubject({ body })}
        />
      </JsonObject>
      <CurrentMessage
        value={value.currentMessage}
        onChange={(currentMessage) => onChange({ ...value, currentMessage })}
      />
      <History
        value={value.history}
        onChange={(history) => onChange({ ...value, history })}
        blank={() => ({ sender: { id: 'maintainer' }, text: '' })}
      />
      {pull && (
        <JsonObject name="pullRequest">
          <JsonText
            name="commitMessages"
            value={pull.commitMessages}
            label={t('commitMessages')}
            onChange={(commitMessages) => setPull({ commitMessages })}
          />
          <JsonArray
            name="files"
            count={pull.files.length}
            addLabel={t('addFile')}
            onAdd={() =>
              setPull({
                files: [...pull.files, { path: 'src/index.ts', status: 'modified', diff: '', diffTruncated: false }]
              })
            }
          >
            {pull.files.map((file, index) => (
              <JsonObject
                key={index}
                action={
                  <JsonRemove
                    label={t('removeFile', { path: file.path })}
                    onRemove={() => setPull({ files: pull.files.filter((_, at) => at !== index) })}
                  />
                }
              >
                <div className="flex flex-wrap items-center gap-x-[12px]">
                  <JsonTag
                    name="path"
                    value={file.path}
                    label={t('filePath', { index: index + 1 })}
                    onChange={(path) => setFile(index, { path })}
                  />
                  <JsonTag
                    name="status"
                    value={file.status}
                    label={t('fileStatus', { index: index + 1 })}
                    onChange={(status) => setFile(index, { status })}
                  />
                  <JsonTag
                    name="additions"
                    numeric
                    value={file.additions === undefined ? '' : String(file.additions)}
                    label={t('fileAdditions', { index: index + 1 })}
                    onChange={(additions) => setFile(index, { additions: count(additions) })}
                  />
                  <JsonTag
                    name="deletions"
                    numeric
                    value={file.deletions === undefined ? '' : String(file.deletions)}
                    label={t('fileDeletions', { index: index + 1 })}
                    onChange={(deletions) => setFile(index, { deletions: count(deletions) })}
                  />
                </div>
                <Diff
                  value={file.diff}
                  label={t('fileDiff', { index: index + 1 })}
                  onChange={(diff) => setFile(index, { diff })}
                />
              </JsonObject>
            ))}
          </JsonArray>
          <JsonLiteral name="filesTruncated" value={pull.filesTruncated} />
        </JsonObject>
      )}
    </>
  )
}
