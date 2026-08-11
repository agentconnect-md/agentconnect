/**
 * The one translation of a Kubernetes API rejection into an HTTP reply, shared
 * by every route that drives the cluster provisioner. A cluster refusal is an
 * upstream failure rather than the caller's mistake, and the API server's own
 * message is what an operator needs to act on, so it is passed through.
 */
import { K8sApiError } from '@agentconnect.md/k8s-client'
import type { FastifyReply } from 'fastify'

export const CLUSTER_API_ERROR_CODE = 'CLUSTER_API_ERROR'

/** Reply 502 for a cluster rejection; anything else is rethrown for the error handler. */
export function sendClusterFailure(reply: FastifyReply, error: unknown, context: string): FastifyReply {
  if (!(error instanceof K8sApiError)) throw error
  return reply.code(502).send({
    error: 'Bad Gateway',
    statusCode: 502,
    message: `${context}: ${error.message}`,
    code: CLUSTER_API_ERROR_CODE
  })
}
