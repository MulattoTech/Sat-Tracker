export const warningLabels: Record<string, string> = {
  'birth-time-unsupported': 'Birth time is not imported',
  'tags-unsupported': 'Tags are not supported and will be skipped',
  'bmi-unsupported': 'BMI records are not imported',
  'both-breasts-without-side': 'Breast feeds without an individual side use available session data',
  'wet-diaper-colour-unsupported': 'Colours on wet-only nappies are not imported',
  'breast-feed-amount-unsupported': 'Amounts on direct breast feeds are not imported',
  'diaper-amount-unsupported': 'Nappy amounts are not imported',
  'pumping-disposition-unknown': 'Baby Buddy does not record what happened to pumped milk. Imported sessions need review and do not add to stored milk. Open a pumping session to choose Stored, Fed or Discarded when known.',
  'medication-dosage-missing': 'Medication entries without an amount are preserved as notes with an unknown dose',
  'feeding-combination-unsupported': 'Feeds with an unrecognized method are skipped',
};
