-- Membership gains its own join timestamp.
--
-- Until now the table carried no timestamps at all, so two surfaces borrowed
-- `app_user.createdAt` (account signup) as a stand-in: the console's "joined"
-- column, and — implicitly, through `ORDER BY "userId"` over timestamp-prefixed
-- cuids — the ownership-transfer recipient chosen when a member leaves. Both
-- read as "this org's history" while actually ranking global signup order.
ALTER TABLE "membership" ADD COLUMN "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now();

-- Backfill, coarse pass. A membership cannot predate its account or its
-- organization, so max(the two) is a sound lower bound for every row.
UPDATE "membership" AS m
SET "createdAt" = GREATEST(u."createdAt", o."createdAt")
FROM "app_user" AS u, "org" AS o
WHERE u."id" = m."userId"
  AND o."id" = m."orgId";

-- Backfill, exact pass. `id` is a cuid v1: the eight characters after the `c`
-- are the row's creation time as base36 milliseconds, which is precisely the
-- join time this column wants. Rows with any other id shape (seed fixtures use
-- readable literals) keep the coarse bound above, as does any value that
-- decodes to an implausible instant.
WITH decoded AS (
  SELECT
    m."id",
    to_timestamp(
      (
        SUM(
          (strpos('0123456789abcdefghijklmnopqrstuvwxyz', substr(m."id", 1 + pos, 1)) - 1) *
            power(36::numeric, 8 - pos)
        ) / 1000.0
      )::double precision
    ) AS "createdAt"
  FROM "membership" AS m, generate_series(1, 8) AS pos
  WHERE m."id" ~ '^c[0-9a-z]{24}$'
  GROUP BY m."id"
)
UPDATE "membership" AS m
SET "createdAt" = decoded."createdAt"
FROM decoded
WHERE decoded."id" = m."id"
  AND decoded."createdAt" > TIMESTAMPTZ '2020-01-01'
  AND decoded."createdAt" <= now();
