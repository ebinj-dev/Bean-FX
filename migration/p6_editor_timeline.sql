-- P6 — Editor timeline persistence (Milestone 1, shared editing core).
-- ADDITIVE ONLY: two new tables + one nullable column + indexes. No existing
-- table, row or column is touched (no DROP/DELETE/UPDATE — the single ALTER
-- adds a nullable column with no default rewrite).
-- Applied by scripts/apply_p6_migration.py (backup, verify, integrity check).

-- CreateTable
CREATE TABLE "TimelineVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "sequenceJson" TEXT NOT NULL,
    "isAutosave" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TimelineVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TimelineEdit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "versionId" TEXT NOT NULL,
    "opIndex" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "inverseJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TimelineEdit_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "TimelineVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AddColumn (additive: nullable, no data rewrite)
ALTER TABLE "Project" ADD COLUMN "settingsJson" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "TimelineVersion_projectId_versionNumber_key" ON "TimelineVersion"("projectId", "versionNumber");

-- CreateIndex
CREATE INDEX "TimelineVersion_projectId_createdAt_idx" ON "TimelineVersion"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "TimelineEdit_versionId_opIndex_idx" ON "TimelineEdit"("versionId", "opIndex");
