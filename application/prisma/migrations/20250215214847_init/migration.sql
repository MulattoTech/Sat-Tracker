-- CreateTable
CREATE TABLE "Baby" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "birthDate" DATETIME NOT NULL,
    "gender" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

-- CreateTable
CREATE TABLE "SleepLog" (
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
    CONSTRAINT "SleepLog_babyId_fkey" FOREIGN KEY ("babyId") REFERENCES "Baby" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FeedLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "time" DATETIME NOT NULL,
    "type" TEXT NOT NULL,
    "amount" REAL,
    "side" TEXT,
    "food" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "babyId" TEXT NOT NULL,
    CONSTRAINT "FeedLog_babyId_fkey" FOREIGN KEY ("babyId") REFERENCES "Baby" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DiaperLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "time" DATETIME NOT NULL,
    "type" TEXT NOT NULL,
    "condition" TEXT,
    "color" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "babyId" TEXT NOT NULL,
    CONSTRAINT "DiaperLog_babyId_fkey" FOREIGN KEY ("babyId") REFERENCES "Baby" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MoodLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "time" DATETIME NOT NULL,
    "mood" TEXT NOT NULL,
    "intensity" INTEGER DEFAULT 3,
    "duration" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "babyId" TEXT NOT NULL,
    CONSTRAINT "MoodLog_babyId_fkey" FOREIGN KEY ("babyId") REFERENCES "Baby" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "time" DATETIME NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "babyId" TEXT NOT NULL,
    CONSTRAINT "Note_babyId_fkey" FOREIGN KEY ("babyId") REFERENCES "Baby" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Baby_birthDate_idx" ON "Baby"("birthDate");

-- CreateIndex
CREATE INDEX "Baby_deletedAt_idx" ON "Baby"("deletedAt");

-- CreateIndex
CREATE INDEX "SleepLog_startTime_idx" ON "SleepLog"("startTime");

-- CreateIndex
CREATE INDEX "SleepLog_endTime_idx" ON "SleepLog"("endTime");

-- CreateIndex
CREATE INDEX "SleepLog_babyId_idx" ON "SleepLog"("babyId");

-- CreateIndex
CREATE INDEX "SleepLog_deletedAt_idx" ON "SleepLog"("deletedAt");

-- CreateIndex
CREATE INDEX "FeedLog_time_idx" ON "FeedLog"("time");

-- CreateIndex
CREATE INDEX "FeedLog_babyId_idx" ON "FeedLog"("babyId");

-- CreateIndex
CREATE INDEX "FeedLog_deletedAt_idx" ON "FeedLog"("deletedAt");

-- CreateIndex
CREATE INDEX "DiaperLog_time_idx" ON "DiaperLog"("time");

-- CreateIndex
CREATE INDEX "DiaperLog_babyId_idx" ON "DiaperLog"("babyId");

-- CreateIndex
CREATE INDEX "DiaperLog_deletedAt_idx" ON "DiaperLog"("deletedAt");

-- CreateIndex
CREATE INDEX "MoodLog_time_idx" ON "MoodLog"("time");

-- CreateIndex
CREATE INDEX "MoodLog_babyId_idx" ON "MoodLog"("babyId");

-- CreateIndex
CREATE INDEX "MoodLog_deletedAt_idx" ON "MoodLog"("deletedAt");

-- CreateIndex
CREATE INDEX "Note_time_idx" ON "Note"("time");

-- CreateIndex
CREATE INDEX "Note_babyId_idx" ON "Note"("babyId");

-- CreateIndex
CREATE INDEX "Note_deletedAt_idx" ON "Note"("deletedAt");
