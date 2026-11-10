-- CreateTable
CREATE TABLE "Milestone" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" DATETIME NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "ageInDays" INTEGER,
    "photo" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "babyId" TEXT NOT NULL,
    "caretakerId" TEXT,
    CONSTRAINT "Milestone_babyId_fkey" FOREIGN KEY ("babyId") REFERENCES "Baby" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Milestone_caretakerId_fkey" FOREIGN KEY ("caretakerId") REFERENCES "Caretaker" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PumpLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "startTime" DATETIME NOT NULL,
    "endTime" DATETIME,
    "duration" INTEGER,
    "leftAmount" REAL,
    "rightAmount" REAL,
    "totalAmount" REAL,
    "unitAbbr" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "babyId" TEXT NOT NULL,
    "caretakerId" TEXT,
    CONSTRAINT "PumpLog_unitAbbr_fkey" FOREIGN KEY ("unitAbbr") REFERENCES "Unit" ("unitAbbr") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PumpLog_babyId_fkey" FOREIGN KEY ("babyId") REFERENCES "Baby" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PumpLog_caretakerId_fkey" FOREIGN KEY ("caretakerId") REFERENCES "Caretaker" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlayLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "startTime" DATETIME NOT NULL,
    "endTime" DATETIME,
    "duration" INTEGER,
    "type" TEXT NOT NULL,
    "location" TEXT,
    "activities" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "babyId" TEXT NOT NULL,
    "caretakerId" TEXT,
    CONSTRAINT "PlayLog_babyId_fkey" FOREIGN KEY ("babyId") REFERENCES "Baby" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlayLog_caretakerId_fkey" FOREIGN KEY ("caretakerId") REFERENCES "Caretaker" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BathLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "time" DATETIME NOT NULL,
    "soapUsed" BOOLEAN NOT NULL DEFAULT true,
    "shampooUsed" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "babyId" TEXT NOT NULL,
    "caretakerId" TEXT,
    CONSTRAINT "BathLog_babyId_fkey" FOREIGN KEY ("babyId") REFERENCES "Baby" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BathLog_caretakerId_fkey" FOREIGN KEY ("caretakerId") REFERENCES "Caretaker" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Measurement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" DATETIME NOT NULL,
    "type" TEXT NOT NULL,
    "value" REAL NOT NULL,
    "unit" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "babyId" TEXT NOT NULL,
    "caretakerId" TEXT,
    CONSTRAINT "Measurement_babyId_fkey" FOREIGN KEY ("babyId") REFERENCES "Baby" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Measurement_caretakerId_fkey" FOREIGN KEY ("caretakerId") REFERENCES "Caretaker" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Milestone_date_idx" ON "Milestone"("date");

-- CreateIndex
CREATE INDEX "Milestone_babyId_idx" ON "Milestone"("babyId");

-- CreateIndex
CREATE INDEX "Milestone_caretakerId_idx" ON "Milestone"("caretakerId");

-- CreateIndex
CREATE INDEX "Milestone_deletedAt_idx" ON "Milestone"("deletedAt");

-- CreateIndex
CREATE INDEX "PumpLog_startTime_idx" ON "PumpLog"("startTime");

-- CreateIndex
CREATE INDEX "PumpLog_endTime_idx" ON "PumpLog"("endTime");

-- CreateIndex
CREATE INDEX "PumpLog_babyId_idx" ON "PumpLog"("babyId");

-- CreateIndex
CREATE INDEX "PumpLog_caretakerId_idx" ON "PumpLog"("caretakerId");

-- CreateIndex
CREATE INDEX "PumpLog_unitAbbr_idx" ON "PumpLog"("unitAbbr");

-- CreateIndex
CREATE INDEX "PumpLog_deletedAt_idx" ON "PumpLog"("deletedAt");

-- CreateIndex
CREATE INDEX "PlayLog_startTime_idx" ON "PlayLog"("startTime");

-- CreateIndex
CREATE INDEX "PlayLog_endTime_idx" ON "PlayLog"("endTime");

-- CreateIndex
CREATE INDEX "PlayLog_babyId_idx" ON "PlayLog"("babyId");

-- CreateIndex
CREATE INDEX "PlayLog_caretakerId_idx" ON "PlayLog"("caretakerId");

-- CreateIndex
CREATE INDEX "PlayLog_deletedAt_idx" ON "PlayLog"("deletedAt");

-- CreateIndex
CREATE INDEX "BathLog_time_idx" ON "BathLog"("time");

-- CreateIndex
CREATE INDEX "BathLog_babyId_idx" ON "BathLog"("babyId");

-- CreateIndex
CREATE INDEX "BathLog_caretakerId_idx" ON "BathLog"("caretakerId");

-- CreateIndex
CREATE INDEX "BathLog_deletedAt_idx" ON "BathLog"("deletedAt");

-- CreateIndex
CREATE INDEX "Measurement_date_idx" ON "Measurement"("date");

-- CreateIndex
CREATE INDEX "Measurement_type_idx" ON "Measurement"("type");

-- CreateIndex
CREATE INDEX "Measurement_babyId_idx" ON "Measurement"("babyId");

-- CreateIndex
CREATE INDEX "Measurement_caretakerId_idx" ON "Measurement"("caretakerId");

-- CreateIndex
CREATE INDEX "Measurement_deletedAt_idx" ON "Measurement"("deletedAt");
