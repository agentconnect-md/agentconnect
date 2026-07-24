-- Historical workspace URLs could persist HTTP(S) userinfo or SSH passwords and
-- query/fragment secrets before clone-target validation was introduced.
-- Keep this cleanup deliberately narrow: sanitize only hierarchical HTTP(S)/SSH
-- gitRepo values, preserve well-formed hosts and paths, and leave workspace mode
-- plus every other transport unchanged. Ambiguous malformed authorities are
-- cleared rather than risk retaining a secret or rewriting to an attacker host.
WITH sanitized AS (
  SELECT
    "id",
    regexp_replace(
      CASE
        -- Greedy authority match removes through the LAST @, including malformed
        -- historical passwords that contained an unescaped @. Ambiguous
        -- `password?metadata@host` / `#metadata@host` rows are cleared instead
        -- of guessing whether text after the delimiter is a host or query data.
        WHEN "gitRepo" ~* '^https?://[^/?#]+:[^/?#]*[?#].*@'
          THEN NULL
        WHEN "gitRepo" ~* '^https?://'
          THEN regexp_replace("gitRepo", '^(https?://)[^/?#]*@', '\1', 'i')
        WHEN "gitRepo" ~* '^ssh://[^:/@?#]+:[^/?#]*[?#].*@'
          THEN NULL
        ELSE regexp_replace("gitRepo", '^(ssh://[^:/@?#]+):[^/?#]*@', '\1@', 'i')
      END,
      '[?#].*$',
      ''
    ) AS "gitRepo"
  FROM "agent"
  WHERE "gitRepo" ~* '^(https?|ssh)://'
)
UPDATE "agent" a
SET "gitRepo" = s."gitRepo"
FROM sanitized s
WHERE a."id" = s."id"
  AND a."gitRepo" IS DISTINCT FROM s."gitRepo";
