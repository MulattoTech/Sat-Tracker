-- Unknown gestation stays NULL; preserve existing birth dates and care records.
ALTER TABLE "Baby" ADD COLUMN "gestationalAgeDays" INTEGER;
