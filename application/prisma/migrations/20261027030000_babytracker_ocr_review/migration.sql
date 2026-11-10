-- Additive only: no existing care table, record ID or timestamp is changed.
CREATE TABLE "OcrDocument" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "familyId" TEXT NOT NULL,
  "babyId" TEXT NOT NULL,
  "sourceHash" TEXT NOT NULL,
  "originalName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "sourceFile" TEXT,
  "previewFiles" TEXT NOT NULL,
  "pageCount" INTEGER NOT NULL,
  "parserVersion" TEXT NOT NULL,
  "sourceTimezone" TEXT NOT NULL,
  "originalState" TEXT NOT NULL,
  "reviewState" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "commitHash" TEXT,
  "resultJson" TEXT,
  "committedAt" DATETIME,
  "sourceExpiresAt" DATETIME NOT NULL,
  "purgedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "OcrDocument_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OcrDocument_familyId_babyId_sourceHash_key" ON "OcrDocument"("familyId", "babyId", "sourceHash");
CREATE INDEX "OcrDocument_familyId_babyId_createdAt_idx" ON "OcrDocument"("familyId", "babyId", "createdAt");
CREATE INDEX "OcrDocument_sourceExpiresAt_idx" ON "OcrDocument"("sourceExpiresAt");
CREATE TABLE "OcrAudit" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "documentId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "actorId" TEXT,
  "snapshot" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OcrAudit_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "OcrDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "OcrAudit_documentId_createdAt_idx" ON "OcrAudit"("documentId", "createdAt");
