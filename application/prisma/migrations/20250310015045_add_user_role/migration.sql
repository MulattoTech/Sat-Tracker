-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Caretaker" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "loginId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "securityPin" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);
INSERT INTO "new_Caretaker" ("createdAt", "deletedAt", "id", "loginId", "name", "securityPin", "type", "updatedAt") SELECT "createdAt", "deletedAt", "id", "loginId", "name", "securityPin", "type", "updatedAt" FROM "Caretaker";
DROP TABLE "Caretaker";
ALTER TABLE "new_Caretaker" RENAME TO "Caretaker";
CREATE INDEX "Caretaker_deletedAt_idx" ON "Caretaker"("deletedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
