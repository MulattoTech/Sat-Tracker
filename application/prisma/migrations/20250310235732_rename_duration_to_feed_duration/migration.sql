/*
  Warnings:

  - You are about to drop the column `duration` on the `FeedLog` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_FeedLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "time" DATETIME NOT NULL,
    "startTime" DATETIME,
    "endTime" DATETIME,
    "feedDuration" INTEGER,
    "type" TEXT NOT NULL,
    "amount" REAL,
    "unitAbbr" TEXT,
    "side" TEXT,
    "food" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "babyId" TEXT NOT NULL,
    "caretakerId" TEXT,
    CONSTRAINT "FeedLog_unitAbbr_fkey" FOREIGN KEY ("unitAbbr") REFERENCES "Unit" ("unitAbbr") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FeedLog_babyId_fkey" FOREIGN KEY ("babyId") REFERENCES "Baby" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FeedLog_caretakerId_fkey" FOREIGN KEY ("caretakerId") REFERENCES "Caretaker" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_FeedLog" ("amount", "babyId", "caretakerId", "createdAt", "deletedAt", "endTime", "food", "id", "side", "startTime", "time", "type", "unitAbbr", "updatedAt") SELECT "amount", "babyId", "caretakerId", "createdAt", "deletedAt", "endTime", "food", "id", "side", "startTime", "time", "type", "unitAbbr", "updatedAt" FROM "FeedLog";
DROP TABLE "FeedLog";
ALTER TABLE "new_FeedLog" RENAME TO "FeedLog";
CREATE INDEX "FeedLog_time_idx" ON "FeedLog"("time");
CREATE INDEX "FeedLog_startTime_idx" ON "FeedLog"("startTime");
CREATE INDEX "FeedLog_endTime_idx" ON "FeedLog"("endTime");
CREATE INDEX "FeedLog_babyId_idx" ON "FeedLog"("babyId");
CREATE INDEX "FeedLog_caretakerId_idx" ON "FeedLog"("caretakerId");
CREATE INDEX "FeedLog_unitAbbr_idx" ON "FeedLog"("unitAbbr");
CREATE INDEX "FeedLog_deletedAt_idx" ON "FeedLog"("deletedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
