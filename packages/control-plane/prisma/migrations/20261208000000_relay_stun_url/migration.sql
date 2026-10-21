-- Each relay's public STUN address for viewer hole punching (computer-use.md §7.2); null when it serves none.
ALTER TABLE "relay" ADD COLUMN "stunUrl" TEXT;
