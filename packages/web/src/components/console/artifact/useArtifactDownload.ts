'use client'

import { useCallback, useState } from 'react'
import { downloadArtifactRevision } from '@/lib/artifact-download'
import type { ArtifactManifestFile } from '@/lib/artifact'

/** One revision's Download: busy while its files are fetched (and zipped), failed until the next try. */
export function useArtifactDownload(
  artifactId: string,
  revision: number,
  title: string,
  files?: ArtifactManifestFile[]
) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const run = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    try {
      await downloadArtifactRevision(artifactId, revision, title, files)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }, [artifactId, revision, title, files, busy])
  return { busy, failed, run, zipping: busy && (files ? files.length > 1 : false) }
}
