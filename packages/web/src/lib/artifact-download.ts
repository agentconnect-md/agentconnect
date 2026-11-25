// Artifact bytes in the browser (artifacts.md §5.5, §8.1): fetched through a signed GET, typed by the manifest, saved or zipped here.
import { getArtifactFileUrl, getArtifactRevision } from '@/lib/api'
import { artifactFileName, artifactZipName, type ArtifactManifestFile } from '@/lib/artifact'
import { saveBlob } from '@/lib/shared-file'

/** The store refused or dropped a signed read; the route's own refusals stay `ApiError`s. */
export class ArtifactFetchError extends Error {
  constructor(
    readonly path: string,
    readonly status: number
  ) {
    super(`artifact file ${path} could not be read (${status})`)
    this.name = 'ArtifactFetchError'
  }
}

/** One manifest file's bytes as a blob typed by its manifest media type, never by the store's attachment headers. */
export async function fetchArtifactFile(
  artifactId: string,
  revision: number,
  file: Pick<ArtifactManifestFile, 'path' | 'mediaType'>,
  signal?: AbortSignal
): Promise<Blob> {
  const signed = await getArtifactFileUrl(artifactId, revision, file.path)
  const response = await fetch(signed.url, { credentials: 'omit', cache: 'no-store', ...(signal ? { signal } : {}) })
  if (!response.ok) throw new ArtifactFetchError(file.path, response.status)
  return new Blob([await response.arrayBuffer()], { type: file.mediaType })
}

/** Every manifest file under its manifest path, zipped; stored without compression when the type is already compressed. */
export async function zipArtifactFiles(
  entries: { path: string; mediaType: string; bytes: Uint8Array }[]
): Promise<Blob> {
  const { zip } = await import('fflate')
  const input: Record<string, [Uint8Array, { level: 0 | 6 }]> = {}
  for (const entry of entries) input[entry.path] = [entry.bytes, { level: compressed(entry.mediaType) ? 0 : 6 }]
  const data = await new Promise<Uint8Array>((resolve, reject) =>
    zip(input, (error, out) => (error ? reject(error) : resolve(out)))
  )
  return new Blob([data as Uint8Array<ArrayBuffer>], { type: 'application/zip' })
}

const COMPRESSED_RE =
  /^(image\/(png|jpeg|gif|webp|avif)|video\/|audio\/|application\/(zip|gzip|pdf|x-7z-compressed|vnd\.openxmlformats))/

function compressed(mediaType: string): boolean {
  return COMPRESSED_RE.test(mediaType.toLowerCase())
}

/** Download one revision: a single file as itself under its manifest name, several as one zip named after the title. */
export async function downloadArtifactRevision(
  artifactId: string,
  revision: number,
  title: string,
  files?: ArtifactManifestFile[]
): Promise<void> {
  const manifest = files ?? (await getArtifactRevision(artifactId, revision)).manifest.files
  if (manifest.length === 1) {
    const only = manifest[0]!
    saveBlob(await fetchArtifactFile(artifactId, revision, only), artifactFileName(only.path))
    return
  }
  const entries = await mapLimited(manifest, FETCH_CONCURRENCY, async (file) => ({
    path: file.path,
    mediaType: file.mediaType,
    bytes: new Uint8Array(await (await fetchArtifactFile(artifactId, revision, file)).arrayBuffer())
  }))
  saveBlob(await zipArtifactFiles(entries), artifactZipName(title))
}

const FETCH_CONCURRENCY = 6

/** `Promise.all` over `items` with at most `limit` in flight, results in input order. */
async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
