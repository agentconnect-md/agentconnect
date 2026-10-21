-- Each relay's public TURN addresses for viewer media without a punched path (computer-use.md §7.2); empty when it serves none.
ALTER TABLE "relay" ADD COLUMN "turnUrls" TEXT[] NOT NULL DEFAULT '{}';
