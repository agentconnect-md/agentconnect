-- The owner attempt's per-attempt marker key material, kept with the publication lease so the
-- daemon a later `ambiguous_locked` refusal reaches can verify that attempt's markers itself
-- (gitea-integration.md §10.3). Hex key material only; never a review body or provider text.
ALTER TABLE "code_host_review_lease" ADD COLUMN "markerSeed" TEXT;
