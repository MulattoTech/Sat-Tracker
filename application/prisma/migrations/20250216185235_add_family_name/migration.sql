-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "familyName" TEXT NOT NULL DEFAULT 'My Family',
    "timezone" TEXT NOT NULL DEFAULT 'America/Chicago',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Settings" ("createdAt", "id", "timezone", "updatedAt") SELECT "createdAt", "id", "timezone", "updatedAt" FROM "Settings";
DROP TABLE "Settings";
ALTER TABLE "new_Settings" RENAME TO "Settings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
