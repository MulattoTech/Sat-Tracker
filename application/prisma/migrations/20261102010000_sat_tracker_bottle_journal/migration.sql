-- Additive only: existing feed values, identifiers and relationships stay intact.
ALTER TABLE "Baby" ADD COLUMN "dailyIntakeTargetMl" REAL;
ALTER TABLE "FeedLog" ADD COLUMN "offeredAmount" REAL;
ALTER TABLE "FeedLog" ADD COLUMN "formulaKcalOz" REAL;
ALTER TABLE "FeedLog" ADD COLUMN "formulaName" TEXT;
ALTER TABLE "FeedLog" ADD COLUMN "bottleLabel" TEXT;
ALTER TABLE "FeedLog" ADD COLUMN "sourceCaregiverName" TEXT;
