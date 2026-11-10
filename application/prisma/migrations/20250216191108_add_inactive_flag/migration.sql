-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Baby" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "birthDate" DATETIME NOT NULL,
    "gender" TEXT,
    "inactive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);
INSERT INTO "new_Baby" ("birthDate", "createdAt", "deletedAt", "firstName", "gender", "id", "lastName", "updatedAt") SELECT "birthDate", "createdAt", "deletedAt", "firstName", "gender", "id", "lastName", "updatedAt" FROM "Baby";
DROP TABLE "Baby";
ALTER TABLE "new_Baby" RENAME TO "Baby";
CREATE INDEX "Baby_birthDate_idx" ON "Baby"("birthDate");
CREATE INDEX "Baby_deletedAt_idx" ON "Baby"("deletedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
