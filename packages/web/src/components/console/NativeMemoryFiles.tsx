'use client'

// The runtime's own memory files (Claude auto-memory / Codex memories), browsed and edited as files: the runtime
// owns their format, so they have no entry projection and keep the file browser the workspace tab uses.
import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { ApiError, fetchAgentMemoryFull, listAgentMemory, updateAgentMemory, type MemoryFileEntry } from '@/lib/api'
import { Spinner } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { resolveMemoryMarkdownLink } from '@/components/console/memory-links'
import {
  FileBrowserBreadcrumb,
  FileBrowserEditor,
  FileBrowserEditorActions,
  FileBrowserLayout,
  FileBrowserPreviewSummary,
  FileBrowserRow,
  FileBrowserShell,
  formatFileMtime,
  formatFileSize,
  type FileBrowserEditorDraft
} from '@/components/console/FileBrowser'
import { useIsMobile } from '@/lib/use-is-mobile'

const MarkdownView = dynamic(() => import('@/components/console/MarkdownView'), {
  ssr: false,
  loading: () => <p className="text-(--text-tertiary)">Rendering…</p>
})

const INDEX = 'MEMORY.md'
const TOPIC_RE = /^[A-Za-z0-9._-]+\.md$/ // flat file name, .md

export function NativeMemoryFiles({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const isMobile = useIsMobile()
  const [files, setFiles] = useState<MemoryFileEntry[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [selected, setSelected] = useState(INDEX)
  const [content, setContent] = useState('')
  const [loadedMtime, setLoadedMtime] = useState<string | null>(null)
  const [fileExists, setFileExists] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editor, setEditor] = useState<FileBrowserEditorDraft | null>(null)
  const [mobileListSignal, setMobileListSignal] = useState(0)
  const loadRequest = useRef(0)
  const listRequest = useRef(0)

  const loadList = useCallback(async () => {
    const request = ++listRequest.current
    setListLoading(true)
    setListError(null)
    try {
      const { files } = await listAgentMemory(agentId)
      if (request !== listRequest.current) return
      setFiles(files)
    } catch (e) {
      if (request !== listRequest.current) return
      setListError(
        e instanceof ApiError && e.status === 503
          ? "Couldn't list memory — the owning daemon may be offline."
          : e instanceof Error
            ? e.message
            : String(e)
      )
    } finally {
      if (request === listRequest.current) setListLoading(false)
    }
  }, [agentId])

  // The whole file, every slice, so Save can never clobber an unread tail.
  const loadFile = useCallback(
    async (name: string) => {
      const request = ++loadRequest.current
      setLoading(true)
      setError(null)
      setEditor(null)
      setContent('')
      setLoadedMtime(null)
      setFileExists(null)
      try {
        const mem = await fetchAgentMemoryFull(agentId, name === INDEX ? undefined : name)
        if (request !== loadRequest.current) return
        setContent(mem.content)
        setLoadedMtime(mem.mtime)
        setFileExists(mem.exists)
      } catch (e) {
        if (request !== loadRequest.current) return
        setError(
          e instanceof ApiError && e.status === 503
            ? "Couldn't read the file — the owning daemon may be offline."
            : e instanceof Error
              ? e.message
              : String(e)
        )
      } finally {
        if (request === loadRequest.current) setLoading(false)
      }
    },
    [agentId]
  )

  useEffect(() => {
    setSelected(INDEX)
    void loadList()
    void loadFile(INDEX)
    return () => {
      loadRequest.current += 1
      listRequest.current += 1
    }
  }, [loadList, loadFile])

  const select = (name: string) => {
    if (name === selected) {
      if (error) void loadFile(name)
      return
    }
    setSelected(name)
    void loadFile(name)
  }
  const resolveMemoryLink = (href: string) => resolveMemoryMarkdownLink(href, select)

  const startCreate = () =>
    setEditor({
      target: '',
      directory: '',
      name: '',
      content: '',
      mtime: null,
      loading: false,
      saving: false,
      error: null
    })
  const startEdit = () =>
    setEditor({
      target: selected,
      directory: '',
      name: selected,
      content,
      mtime: loadedMtime,
      loading: false,
      saving: false,
      error: null
    })
  const closeEditor = () => {
    if (!editor?.saving) setEditor(null)
  }
  const backFromEditor = () => {
    if (editor?.saving) return
    setEditor(null)
    setMobileListSignal((signal) => signal + 1)
  }

  const save = async () => {
    if (!editor || editor.saving || editor.loading) return
    const creating = editor.target === ''
    const target = creating ? editor.name.trim() : editor.target
    if (creating && (!TOPIC_RE.test(target) || target === INDEX)) {
      setEditor({ ...editor, error: 'Use a flat .md file name, e.g. "deploys.md".' })
      return
    }
    const savingEditor = { ...editor, saving: true, error: null }
    setEditor(savingEditor)
    try {
      const res = await updateAgentMemory(
        agentId,
        savingEditor.content,
        target === INDEX ? undefined : target,
        creating ? undefined : savingEditor.mtime
      )
      setSelected(target)
      setContent(savingEditor.content)
      setLoadedMtime(res.mtime)
      setFileExists(true)
      setEditor(null)
      await loadList()
    } catch (e) {
      setEditor((current) =>
        current?.target === savingEditor.target
          ? {
              ...current,
              saving: false,
              error:
                e instanceof ApiError && e.status === 409
                  ? 'This file changed since you opened it (the agent may have updated it). Reload before saving.'
                  : e instanceof Error
                    ? e.message
                    : String(e)
            }
          : current
      )
    }
  }

  const renderFileTree = (openPreview: () => void) => (
    <>
      {listLoading ? (
        <div className="flex justify-center py-4">
          <Spinner size={18} />
        </div>
      ) : null}
      {!listLoading && listError ? (
        <div className="flex flex-col items-start gap-2 px-4 py-3 font-sans text-[12px] font-normal leading-normal text-(--red-600)">
          <span>{listError}</span>
          <button type="button" className="lnk text-[12px]" onClick={() => void loadList()}>
            Retry
          </button>
        </div>
      ) : null}
      {!listLoading && !listError && files.length === 0 ? (
        <div className="px-4 py-3 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          No memory yet.
        </div>
      ) : null}
      {!listLoading
        ? files.map((file) => (
            <FileBrowserRow
              key={file.name}
              icon={file.name === INDEX ? 'book-bookmark' : 'file-text'}
              name={file.name}
              selected={selected === file.name}
              onClick={() => {
                select(file.name)
                openPreview()
              }}
            />
          ))
        : null}
      {!listLoading && !files.some((file) => file.name === selected) ? (
        <FileBrowserRow
          icon={selected === INDEX ? 'book-bookmark' : fileExists === false ? 'file-plus' : 'file-text'}
          name={selected}
          selected
          onClick={() => {
            select(selected)
            openPreview()
          }}
        />
      ) : null}
    </>
  )

  const selectedFile = files.find((file) => file.name === selected)
  const previewMeta = [
    formatFileSize(selectedFile?.size ?? null),
    selectedFile?.mtime ? `edited ${formatFileMtime(selectedFile.mtime)}` : ''
  ]
    .filter(Boolean)
    .join(' · ')

  const renderPreview = (onBack?: () => void) => (
    <>
      <FileBrowserPreviewSummary meta={previewMeta} onBack={onBack} />
      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Spinner />
        </div>
      ) : error ? (
        <div className="flex flex-col items-start gap-3 px-4 py-6 font-sans text-[13px] font-normal leading-normal text-(--red-600)">
          <span>{error}</span>
          <Button variant="secondary" size="xs" onClick={() => void loadFile(selected)}>
            Retry
          </Button>
        </div>
      ) : content.trim() ? (
        <div className="max-h-[520px] overflow-auto px-[18px] py-4">
          <MarkdownView content={content} resolveLink={resolveMemoryLink} />
        </div>
      ) : (
        <div className="px-4 py-6 font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
          {fileExists === false
            ? canEdit
              ? 'This file does not exist. You can create it here.'
              : 'This file does not exist.'
            : `${
                selected === INDEX
                  ? 'No memory index yet. The runtime maintains its memory itself as it works'
                  : 'This file is empty'
              }${canEdit ? ', or you can edit it here.' : '.'}`}
        </div>
      )}
    </>
  )

  return (
    <FileBrowserShell
      title={
        <FileBrowserBreadcrumb
          root="Memory"
          path={editor?.target ?? selected}
          creating={editor?.target === ''}
          draftName={editor?.name ?? ''}
          onDraftNameChange={(name) =>
            setEditor((current) => (current?.target === '' ? { ...current, name, error: null } : current))
          }
          onBack={isMobile && editor ? backFromEditor : undefined}
          disabled={editor?.saving}
          nested={false}
          ariaLabel="Memory file path"
          inputAriaLabel="New memory file name"
        />
      }
      headerEnd={
        editor ? (
          <FileBrowserEditorActions
            saving={editor.saving}
            onCancel={closeEditor}
            onSave={() => void save()}
            disabled={editor.loading || (!editor.target && !editor.name.trim())}
          />
        ) : canEdit ? (
          <div className="flex flex-none items-center gap-2">
            <Button variant="secondary" size="xs" className="flex-none" onClick={startCreate}>
              <Icon name="file-plus" size={13} />
              Add file
            </Button>
            {!loading && !error && fileExists !== null ? (
              <Button variant="secondary" size="xs" className="flex-none" onClick={startEdit}>
                <Icon name="pencil" size={13} />
                Edit
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      <FileBrowserLayout
        resetKey={`${agentId}:${mobileListSignal}`}
        previewOpen={editor !== null}
        tree={renderFileTree}
        preview={
          editor
            ? () => (
                <FileBrowserEditor
                  draft={editor}
                  onContentChange={(content) =>
                    setEditor((current) => (current ? { ...current, content, error: null } : current))
                  }
                  onCancel={closeEditor}
                  onSubmit={() => void save()}
                />
              )
            : renderPreview
        }
      />
    </FileBrowserShell>
  )
}
