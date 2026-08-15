-- A pool member's rollout generation (RegisterReq.generation, the pod-template hash) and when this
-- row first reported it. Only the newest live generation of a member set may claim vacated duty
-- groups (docs/designs/k8s-daemon-pool.md §12); a null generation is never excluded by that rule.
ALTER TABLE "daemon" ADD COLUMN "generation" TEXT;
ALTER TABLE "daemon" ADD COLUMN "generationSince" TIMESTAMPTZ(6);
