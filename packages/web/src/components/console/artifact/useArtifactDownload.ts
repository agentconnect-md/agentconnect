'use client'

import { useCallback, useState } from 'react'
import { downloadArtifactFiles, downloadArtifactRevision, type ArtifactFileUrl } from '@/lib/artifact-download'
import type { ArtifactManifestFile } from '@/lib/artifact'

/** What a Download saves: a member's revision by id, its manifest read on demand, or the listed files through a resolver. */
export type ArtifactDownloadSource =
  | { artifactId: string; revision: number; files?: ArtifactManifestFile[] }
  | { fileUrl: ArtifactFileUrl; files: ArtifactManifestFile[] }

/** One revision's Download: busy while its files are fetched (and zipped), failed until the next try. */
export function useArtifactDownload(source: ArtifactDownloadSource, title: string) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const run = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    try {
      if ('fileUrl' in source) await downloadArtifactFiles(source.fileUrl, title, source.files)
      else await downloadArtifactRevision(source.artifactId, source.revision, title, source.files)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }, [source, title, busy])
  const files = source.files
  return { busy, failed, run, zipping: busy && (files ? files.length > 1 : false) }
}
