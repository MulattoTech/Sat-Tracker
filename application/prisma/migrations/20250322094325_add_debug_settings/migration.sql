-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "familyName" TEXT NOT NULL DEFAULT 'My Family',
    "securityPin" TEXT NOT NULL DEFAULT '111222',
    "defaultBottleUnit" TEXT NOT NULL DEFAULT 'OZ',
    "defaultSolidsUnit" TEXT NOT NULL DEFAULT 'TBSP',
    "defaultHeightUnit" TEXT NOT NULL DEFAULT 'IN',
    "defaultWeightUnit" TEXT NOT NULL DEFAULT 'LB',
    "defaultTempUnit" TEXT NOT NULL DEFAULT 'F',
    "activitySettings" TEXT,
    "enableDebugTimer" BOOLEAN NOT NULL DEFAULT false,
    "enableDebugTimezone" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Settings" ("activitySettings", "createdAt", "defaultBottleUnit", "defaultHeightUnit", "defaultSolidsUnit", "defaultTempUnit", "defaultWeightUnit", "familyName", "id", "securityPin", "updatedAt") SELECT "activitySettings", "createdAt", "defaultBottleUnit", "defaultHeightUnit", "defaultSolidsUnit", "defaultTempUnit", "defaultWeightUnit", "familyName", "id", "securityPin", "updatedAt" FROM "Settings";
DROP TABLE "Settings";
ALTER TABLE "new_Settings" RENAME TO "Settings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
