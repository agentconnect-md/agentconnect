import { parentPort } from 'node:worker_threads'
import { runPreviewJob, type PreviewJobInput, type PreviewJobResult } from './job.js'

// Worker entry: one job at a time per worker; the parent enforces time and concurrency.

type Request = { id: number; input: PreviewJobInput; delayMs?: number }

parentPort?.on('message', async (request: Request) => {
  let result: PreviewJobResult
  try {
    // Test hook: hold the job so the parent's timeout path can be exercised deterministically.
    if (request.delayMs) await new Promise((resolve) => setTimeout(resolve, request.delayMs))
    result = await runPreviewJob(request.input)
  } catch (err) {
    result = { ok: false, reason: 'corrupt', detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) }
  }
  // A fresh copy owns its whole ArrayBuffer, so transferring it can never detach a shared Buffer pool slab.
  if (result.ok) result = { ...result, preview: { ...result.preview, data: result.preview.data.slice() } }
  const transfer = result.ok ? [result.preview.data.buffer as ArrayBuffer] : []
  parentPort!.postMessage({ id: request.id, result }, transfer)
})
