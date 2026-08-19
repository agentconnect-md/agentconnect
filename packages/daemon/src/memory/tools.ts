import type { MemoryPluginOperation } from '@agentconnect.md/protocol'
import { obj, type ToolDescriptor } from '../mcp/tool-descriptor.js'

/** Refusal surfaced to the model when an isolated session tries to access agent memory shared with other users. */
export const MEMORY_ACCESS_BLOCKED =
  'Shared agent memory is unavailable in this session. Keep the information in this conversation instead; do not retry.'

/** The agent's long-term memory tools, for EVERY agent: `<agent-root>/memory/` with a `MEMORY.md` index plus topic files. */
export const MEMORY_TOOLS: ToolDescriptor[] = [
  {
    name: 'readMemory',
    description:
      'Read one of your memory files. Omit `path` (or pass "MEMORY.md") to read the index; pass a topic file name ' +
      '(e.g. "deploys.md") to read that topic. The index is already shown to you at the start of each session (you ' +
      'do NOT need to read it first) — use this to pull the detail behind an index entry, or the current contents of ' +
      'a file before editing it. Also accepts a `[[name]]` link exactly as it appears in a memory body. The result ' +
      'carries `links` (memories this one points to) and `backlinks` (memories pointing at it), each with its ' +
      'description — follow one by reading it. Those fields are NOT part of the file: never write them back.',
    inputSchema: obj({
      path: {
        type: 'string',
        description: 'Memory file name (e.g. "deploys.md"), or a "[[name]]" link. Defaults to the MEMORY.md index.'
      }
    })
  },
  {
    name: 'writeMemory',
    description:
      'Save durable facts across sessions (conventions, decisions, who to ask, things you had to re-learn). Omit ' +
      '`path` to target the MEMORY.md index; pass a topic file name (e.g. "deploys.md") for a topic. Keep the INDEX ' +
      'short — a scannable list linking to topic files (e.g. "- [deploys](deploys.md) — how we ship"); put the detail ' +
      'in the topic files. Flat directory — no subfolders in the path.\n' +
      'Two modes:\n' +
      '• `content` — create a file or fully replace it.\n' +
      '• `oldString` + `newString` — targeted edit. Copy `oldString` verbatim from a fresh `readMemory` result, or ' +
      "decode exactly one layer of the injected boundary's documented XML character references first. Never source " +
      'it from surrounding session context (for example workspace or git status). It must occur exactly once; include ' +
      'enough file context to make it unique. If unsure, or retrying after a write or failed replace, call `readMemory` ' +
      'first. Pass `newString: ""` to delete. Prefer this mode for existing files so you do not resend the whole file. ' +
      'Provide exactly one mode.',
    inputSchema: obj({
      path: {
        type: 'string',
        description: 'Memory file name (e.g. "deploys.md"). Defaults to the MEMORY.md index. No subdirectories.'
      },
      content: {
        type: 'string',
        description: 'Full-write mode: the entire new file contents (Markdown). Replaces the file.'
      },
      oldString: {
        type: 'string',
        description: 'Edit mode: exact text to replace; must occur exactly once in the target memory file.'
      },
      newString: { type: 'string', description: 'Edit mode: the replacement text ("" to delete the matched text).' }
    })
  }
]

/** The memory tool names — used to strip them for a `native`-memory agent, which uses the runtime's own memory. */
export const MEMORY_TOOL_NAMES = new Set(MEMORY_TOOLS.map((t) => t.name))
/** Core-owned record tools for an external-memory provider: raw plugin tools are never copied into a model session, and optional actions are projected only when the reviewed manifest declares the capability. */
const EXTERNAL_MEMORY_TOOLS: Readonly<Record<'recall' | 'create' | 'get' | 'update' | 'delete', ToolDescriptor>> = {
  recall: {
    name: 'searchMemory',
    description:
      'Search your durable external memory for records relevant to a query. The daemon supplies your trusted agent scope automatically; do not put an agent or user id in the query.',
    inputSchema: obj(
      {
        query: { type: 'string', minLength: 1, description: 'What durable information to search for.' },
        topK: { type: 'integer', minimum: 1, maximum: 20, description: 'Optional maximum result count.' },
        maxBytes: {
          type: 'integer',
          minimum: 1,
          maximum: 32768,
          description: 'Optional total text budget for results.'
        }
      },
      ['query']
    )
  },
  create: {
    name: 'saveMemory',
    description:
      'Save one durable memory record for future sessions. Store a concise, self-contained fact or decision; the daemon supplies your trusted agent scope automatically.',
    inputSchema: obj(
      {
        text: {
          type: 'string',
          minLength: 1,
          maxLength: 131072,
          description: 'The durable fact or decision to save.'
        },
        metadata: {
          type: 'object',
          description: 'Optional small JSON metadata object. Do not copy credentials or large payloads here.',
          additionalProperties: true
        }
      },
      ['text']
    )
  },
  get: {
    name: 'getMemory',
    description: 'Get one durable memory record by the opaque record id returned by searchMemory or saveMemory.',
    inputSchema: obj(
      { id: { type: 'string', minLength: 1, maxLength: 512, description: 'Opaque memory record id.' } },
      ['id']
    )
  },
  update: {
    name: 'updateMemory',
    description:
      'Replace one durable memory record by id. Pass the version returned by searchMemory/getMemory when present so a concurrent edit fails instead of being overwritten.',
    inputSchema: obj(
      {
        id: { type: 'string', minLength: 1, maxLength: 512, description: 'Opaque memory record id.' },
        text: {
          type: 'string',
          minLength: 1,
          maxLength: 131072,
          description: 'Complete replacement text for the record.'
        },
        metadata: { type: 'object', description: 'Optional replacement JSON metadata.', additionalProperties: true },
        version: {
          type: 'string',
          minLength: 1,
          maxLength: 512,
          description: 'Optional backend version/ETag from the record being edited.'
        }
      },
      ['id', 'text']
    )
  },
  delete: {
    name: 'deleteMemory',
    description:
      'Delete one durable memory record by id. Pass the version returned by searchMemory/getMemory when present so a backend that supports conditional delete can reject a stale request.',
    inputSchema: obj(
      {
        id: { type: 'string', minLength: 1, maxLength: 512, description: 'Opaque memory record id.' },
        version: {
          type: 'string',
          minLength: 1,
          maxLength: 512,
          description: 'Optional backend version/ETag from the record being deleted.'
        }
      },
      ['id']
    )
  }
}

const EXTERNAL_MEMORY_TOOL_OPERATIONS = ['recall', 'create', 'get', 'update', 'delete'] as const

export function externalMemoryTools(capabilities: ReadonlySet<MemoryPluginOperation>): ToolDescriptor[] {
  return EXTERNAL_MEMORY_TOOL_OPERATIONS.filter((operation) => capabilities.has(operation)).map(
    (operation) => EXTERNAL_MEMORY_TOOLS[operation]
  )
}

export const EXTERNAL_MEMORY_TOOL_NAMES = new Set(
  EXTERNAL_MEMORY_TOOL_OPERATIONS.map((operation) => EXTERNAL_MEMORY_TOOLS[operation].name)
)
