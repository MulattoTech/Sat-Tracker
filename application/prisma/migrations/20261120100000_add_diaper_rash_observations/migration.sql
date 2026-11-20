-- Optional caregiver observations only. Existing rows remain unknown; no backfill.
ALTER TABLE "DiaperLog" ADD COLUMN "rashObserved" BOOLEAN;
ALTER TABLE "DiaperLog" ADD COLUMN "rashLocation" TEXT;
ALTER TABLE "DiaperLog" ADD COLUMN "rashDescription" TEXT;
ALTER TABLE "DiaperLog" ADD COLUMN "rashProductsApplied" TEXT;
ALTER TABLE "DiaperLog" ADD COLUMN "rashFollowUpNotes" TEXT;
