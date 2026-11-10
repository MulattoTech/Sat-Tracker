-- CreateTable
CREATE TABLE "Caretaker" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "securityPin" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DiaperLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "time" DATETIME NOT NULL,
    "type" TEXT NOT NULL,
    "condition" TEXT,
    "color" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "babyId" TEXT NOT NULL,
    "caretakerId" TEXT,
    CONSTRAINT "DiaperLog_babyId_fkey" FOREIGN KEY ("babyId") REFERENCES "Baby" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DiaperLog_caretakerId_fkey" FOREIGN KEY ("caretakerId") REFERENCES "Caretaker" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_DiaperLog" ("babyId", "color", "condition", "createdAt", "deletedAt", "id", "time", "type", "updatedAt") SELECT "babyId", "color", "condition", "createdAt", "deletedAt", "id", "time", "type", "updatedAt" FROM "DiaperLog";
DROP TABLE "DiaperLog";
ALTER TABLE "new_DiaperLog" RENAME TO "DiaperLog";
CREATE INDEX "DiaperLog_time_idx" ON "DiaperLog"("time");
CREATE INDEX "DiaperLog_babyId_idx" ON "DiaperLog"("babyId");
CREATE INDEX "DiaperLog_caretakerId_idx" ON "DiaperLog"("caretakerId");
CREATE INDEX "DiaperLog_deletedAt_idx" ON "DiaperLog"("deletedAt");
CREATE TABLE "new_FeedLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "time" DATETIME NOT NULL,
    "startTime" DATETIME,
    "endTime" DATETIME,
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
INSERT INTO "new_FeedLog" ("amount", "babyId", "createdAt", "deletedAt", "endTime", "food", "id", "side", "startTime", "time", "type", "unitAbbr", "updatedAt") SELECT "amount", "babyId", "createdAt", "deletedAt", "endTime", "food", "id", "side", "startTime", "time", "type", "unitAbbr", "updatedAt" FROM "FeedLog";
DROP TABLE "FeedLog";
ALTER TABLE "new_FeedLog" RENAME TO "FeedLog";
CREATE INDEX "FeedLog_time_idx" ON "FeedLog"("time");
CREATE INDEX "FeedLog_startTime_idx" ON "FeedLog"("startTime");
CREATE INDEX "FeedLog_endTime_idx" ON "FeedLog"("endTime");
CREATE INDEX "FeedLog_babyId_idx" ON "FeedLog"("babyId");
CREATE INDEX "FeedLog_caretakerId_idx" ON "FeedLog"("caretakerId");
CREATE INDEX "FeedLog_unitAbbr_idx" ON "FeedLog"("unitAbbr");
CREATE INDEX "FeedLog_deletedAt_idx" ON "FeedLog"("deletedAt");
CREATE TABLE "new_Note" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "time" DATETIME NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "babyId" TEXT NOT NULL,
    "caretakerId" TEXT,
    CONSTRAINT "Note_babyId_fkey" FOREIGN KEY ("babyId") REFERENCES "Baby" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Note_caretakerId_fkey" FOREIGN KEY ("caretakerId") REFERENCES "Caretaker" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Note" ("babyId", "category", "content", "createdAt", "deletedAt", "id", "time", "updatedAt") SELECT "babyId", "category", "content", "createdAt", "deletedAt", "id", "time", "updatedAt" FROM "Note";
DROP TABLE "Note";
ALTER TABLE "new_Note" RENAME TO "Note";
CREATE INDEX "Note_time_idx" ON "Note"("time");
CREATE INDEX "Note_babyId_idx" ON "Note"("babyId");
CREATE INDEX "Note_caretakerId_idx" ON "Note"("caretakerId");
CREATE INDEX "Note_deletedAt_idx" ON "Note"("deletedAt");
CREATE TABLE "new_SleepLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "startTime" DATETIME NOT NULL,
    "endTime" DATETIME,
    "duration" INTEGER,
    "type" TEXT NOT NULL,
    "location" TEXT,
    "quality" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "babyId" TEXT NOT NULL,
    "caretakerId" TEXT,
    CONSTRAINT "SleepLog_babyId_fkey" FOREIGN KEY ("babyId") REFERENCES "Baby" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SleepLog_caretakerId_fkey" FOREIGN KEY ("caretakerId") REFERENCES "Caretaker" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_SleepLog" ("babyId", "createdAt", "deletedAt", "duration", "endTime", "id", "location", "quality", "startTime", "type", "updatedAt") SELECT "babyId", "createdAt", "deletedAt", "duration", "endTime", "id", "location", "quality", "startTime", "type", "updatedAt" FROM "SleepLog";
DROP TABLE "SleepLog";
ALTER TABLE "new_SleepLog" RENAME TO "SleepLog";
CREATE INDEX "SleepLog_startTime_idx" ON "SleepLog"("startTime");
CREATE INDEX "SleepLog_endTime_idx" ON "SleepLog"("endTime");
CREATE INDEX "SleepLog_babyId_idx" ON "SleepLog"("babyId");
CREATE INDEX "SleepLog_caretakerId_idx" ON "SleepLog"("caretakerId");
CREATE INDEX "SleepLog_deletedAt_idx" ON "SleepLog"("deletedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Caretaker_deletedAt_idx" ON "Caretaker"("deletedAt");
