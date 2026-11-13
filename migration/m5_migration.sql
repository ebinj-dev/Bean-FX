-- M5 — GANGZII audio intelligence engine. ADDITIVE ONLY:
-- one new table + one nullable column + two indexes. No existing table or
-- column is modified, no DROP/ALTER-modify/DELETE appears in this file.
-- Legacy rows keep working (derivedFromId NULL = original or legacy asset).

CREATE TABLE IF NOT EXISTS "GangziiProcess" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceAssetId" TEXT NOT NULL,
    "name" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "paramsJson" TEXT,
    "analysisJson" TEXT,
    "resultAssetId" TEXT,
    "resultMetaJson" TEXT,
    "error" TEXT,
    "jobId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GangziiProcess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GangziiProcess_sourceAssetId_fkey" FOREIGN KEY ("sourceAssetId") REFERENCES "MediaAsset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "GangziiProcess_userId_sourceAssetId_idx" ON "GangziiProcess"("userId", "sourceAssetId");
CREATE INDEX IF NOT EXISTS "GangziiProcess_status_idx" ON "GangziiProcess"("status");

ALTER TABLE "MediaAsset" ADD COLUMN "derivedFromId" TEXT;
CREATE INDEX IF NOT EXISTS "MediaAsset_derivedFromId_idx" ON "MediaAsset"("derivedFromId");
