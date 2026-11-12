-- P7 — M3 production media pipeline (uploads, probe, proxy, durable worker).
-- ADDITIVE ONLY: new columns on MediaAsset and Job, one new table + indexes —
-- no existing table, column, or row is touched.
-- Applied by scripts/apply_missing_migrations.py (backup, verify, integrity check).

ALTER TABLE "MediaAsset" ADD COLUMN "sha256" TEXT;
ALTER TABLE "MediaAsset" ADD COLUMN "probeStatus" TEXT;
ALTER TABLE "MediaAsset" ADD COLUMN "probeError" TEXT;
ALTER TABLE "MediaAsset" ADD COLUMN "probeMetaJson" TEXT;
ALTER TABLE "MediaAsset" ADD COLUMN "isVfr" BOOLEAN;
ALTER TABLE "MediaAsset" ADD COLUMN "rotation" INTEGER;
ALTER TABLE "MediaAsset" ADD COLUMN "aspectRatio" TEXT;
ALTER TABLE "MediaAsset" ADD COLUMN "timeBase" TEXT;
ALTER TABLE "MediaAsset" ADD COLUMN "formatName" TEXT;
ALTER TABLE "MediaAsset" ADD COLUMN "bitRate" INTEGER;
ALTER TABLE "MediaAsset" ADD COLUMN "proxyStatus" TEXT;
ALTER TABLE "MediaAsset" ADD COLUMN "proxyPath" TEXT;
ALTER TABLE "MediaAsset" ADD COLUMN "proxySizeBytes" INTEGER;
ALTER TABLE "MediaAsset" ADD COLUMN "proxyDurationSec" REAL;
ALTER TABLE "MediaAsset" ADD COLUMN "proxyError" TEXT;
CREATE INDEX "MediaAsset_userId_sha256_idx" ON "MediaAsset"("userId", "sha256");

ALTER TABLE "Job" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Job" ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "Job" ADD COLUMN "runAfter" DATETIME;
ALTER TABLE "Job" ADD COLUMN "lastHeartbeatAt" DATETIME;
ALTER TABLE "Job" ADD COLUMN "claimedAt" DATETIME;
ALTER TABLE "Job" ADD COLUMN "timeoutSec" INTEGER;

CREATE TABLE "UploadSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "ext" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "declaredSize" INTEGER NOT NULL,
    "chunkSize" INTEGER NOT NULL,
    "chunkTotal" INTEGER NOT NULL,
    "receivedCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "sha256" TEXT,
    "mediaAssetId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastChunkAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UploadSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "UploadSession_userId_status_idx" ON "UploadSession"("userId", "status");
CREATE INDEX "UploadSession_lastChunkAt_idx" ON "UploadSession"("lastChunkAt");
