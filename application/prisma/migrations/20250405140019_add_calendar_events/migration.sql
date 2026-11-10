-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

-- CreateTable
CREATE TABLE "CalendarEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startTime" DATETIME NOT NULL,
    "endTime" DATETIME,
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "type" TEXT NOT NULL,
    "location" TEXT,
    "color" TEXT,
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "recurrencePattern" TEXT,
    "recurrenceEnd" DATETIME,
    "customRecurrence" TEXT,
    "reminderTime" INTEGER,
    "notificationSent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

-- CreateTable
CREATE TABLE "BabyEvent" (
    "babyId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,

    PRIMARY KEY ("babyId", "eventId"),
    CONSTRAINT "BabyEvent_babyId_fkey" FOREIGN KEY ("babyId") REFERENCES "Baby" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BabyEvent_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "CalendarEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CaretakerEvent" (
    "caretakerId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,

    PRIMARY KEY ("caretakerId", "eventId"),
    CONSTRAINT "CaretakerEvent_caretakerId_fkey" FOREIGN KEY ("caretakerId") REFERENCES "Caretaker" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CaretakerEvent_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "CalendarEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ContactEvent" (
    "contactId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,

    PRIMARY KEY ("contactId", "eventId"),
    CONSTRAINT "ContactEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ContactEvent_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "CalendarEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Contact_role_idx" ON "Contact"("role");

-- CreateIndex
CREATE INDEX "Contact_deletedAt_idx" ON "Contact"("deletedAt");

-- CreateIndex
CREATE INDEX "CalendarEvent_startTime_idx" ON "CalendarEvent"("startTime");

-- CreateIndex
CREATE INDEX "CalendarEvent_endTime_idx" ON "CalendarEvent"("endTime");

-- CreateIndex
CREATE INDEX "CalendarEvent_type_idx" ON "CalendarEvent"("type");

-- CreateIndex
CREATE INDEX "CalendarEvent_recurring_idx" ON "CalendarEvent"("recurring");

-- CreateIndex
CREATE INDEX "CalendarEvent_deletedAt_idx" ON "CalendarEvent"("deletedAt");

-- CreateIndex
CREATE INDEX "BabyEvent_babyId_idx" ON "BabyEvent"("babyId");

-- CreateIndex
CREATE INDEX "BabyEvent_eventId_idx" ON "BabyEvent"("eventId");

-- CreateIndex
CREATE INDEX "CaretakerEvent_caretakerId_idx" ON "CaretakerEvent"("caretakerId");

-- CreateIndex
CREATE INDEX "CaretakerEvent_eventId_idx" ON "CaretakerEvent"("eventId");

-- CreateIndex
CREATE INDEX "ContactEvent_contactId_idx" ON "ContactEvent"("contactId");

-- CreateIndex
CREATE INDEX "ContactEvent_eventId_idx" ON "ContactEvent"("eventId");
