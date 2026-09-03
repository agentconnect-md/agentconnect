-- Caller-keyed webhook session affinity (webhook-triggers-and-github-events.md,
-- General Webhook `sessionMode`): deliveries sharing an X-AC-Session-Key header
-- value reuse one session; the delivery key remains the idempotency identity.
ALTER TYPE "HookSessionMode" ADD VALUE IF NOT EXISTS 'perSubject';
