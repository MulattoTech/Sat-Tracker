/*
  Warnings:

  - Added the required column `loginId` to the `Caretaker` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Caretaker" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "loginId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "securityPin" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);
INSERT INTO "new_Caretaker" ("loginId", "createdAt", "deletedAt", "id", "name", "securityPin", "type", "updatedAt") SELECT '01', "createdAt", "deletedAt", "id", "name", "securityPin", "type", "updatedAt" FROM "Caretaker";
DROP TABLE "Caretaker";
ALTER TABLE "new_Caretaker" RENAME TO "Caretaker";
CREATE INDEX "Caretaker_deletedAt_idx" ON "Caretaker"("deletedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
