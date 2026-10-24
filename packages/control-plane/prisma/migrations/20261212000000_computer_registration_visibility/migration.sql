-- A registration carries the visibility its Computer takes at the exchange (computer-use.md §4.1).
ALTER TABLE "computer_registration"
  ADD COLUMN "visibility" "ResourceVisibility" NOT NULL DEFAULT 'restricted',
  ADD COLUMN "sharedWith" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
