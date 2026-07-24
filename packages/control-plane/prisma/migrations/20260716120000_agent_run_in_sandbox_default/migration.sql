-- New agents start with the optional OS sandbox off; daemon policy may still require it.
ALTER TABLE "agent" ALTER COLUMN "restrictFileAccess" SET DEFAULT false;
