-- Org console avatar descriptor (protocol AgentIcon): {kind:'runtime'} |
-- {kind:'glyph',glyph,color} | {kind:'image'}. Null ⇒ generated default glyph.
-- An `image` icon's bytes live in the object store (docs/designs/icon-uploads.md),
-- served by GET /v1/orgs/:id/icon. Additive; existing rows read as null.
ALTER TABLE "org" ADD COLUMN "icon" JSONB;
