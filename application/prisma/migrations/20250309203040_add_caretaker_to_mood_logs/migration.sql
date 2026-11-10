-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MoodLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "time" DATETIME NOT NULL,
    "mood" TEXT NOT NULL,
    "intensity" INTEGER DEFAULT 3,
    "duration" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "babyId" TEXT NOT NULL,
    "caretakerId" TEXT,
    CONSTRAINT "MoodLog_babyId_fkey" FOREIGN KEY ("babyId") REFERENCES "Baby" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MoodLog_caretakerId_fkey" FOREIGN KEY ("caretakerId") REFERENCES "Caretaker" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_MoodLog" ("babyId", "createdAt", "deletedAt", "duration", "id", "intensity", "mood", "time", "updatedAt") SELECT "babyId", "createdAt", "deletedAt", "duration", "id", "intensity", "mood", "time", "updatedAt" FROM "MoodLog";
DROP TABLE "MoodLog";
ALTER TABLE "new_MoodLog" RENAME TO "MoodLog";
CREATE INDEX "MoodLog_time_idx" ON "MoodLog"("time");
CREATE INDEX "MoodLog_babyId_idx" ON "MoodLog"("babyId");
CREATE INDEX "MoodLog_caretakerId_idx" ON "MoodLog"("caretakerId");
CREATE INDEX "MoodLog_deletedAt_idx" ON "MoodLog"("deletedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
