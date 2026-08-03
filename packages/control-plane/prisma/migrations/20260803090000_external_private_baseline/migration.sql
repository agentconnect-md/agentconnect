-- A provider-bound p2p conversation may retain its direct private baseline
-- while external-audience sync is disabled. Enabling the provider policy moves
-- the same immutable source binding to `external` atomically.

ALTER TABLE "session_meta"
  DROP CONSTRAINT "session_meta_external_shape_check";

ALTER TABLE "session_meta" ADD CONSTRAINT "session_meta_external_shape_check" CHECK (
  (
    "externalProvider" IS NULL
    AND "externalScopeId" IS NULL
    AND "externalResolution" IS NULL
    AND "classifiedPolicyRev" IS NULL
    AND "visibility" <> 'external'::"SessionVisibility"
  )
  OR
  (
    "externalProvider" IS NOT NULL
    AND "externalResolution" IS NOT NULL
    AND "classifiedPolicyRev" IS NOT NULL
    AND ("externalResolution" <> 'settled'::"ExternalResolution" OR "externalScopeId" IS NOT NULL)
  )
);
