'use client';

import { useLocalization } from '@/src/context/localization';
import { calculateChildAge } from '@/src/utils/childAge';
import { formatChildAgeSpan, formatDaysUntilDue } from './format';
import { childAgeDisplayStyles } from './child-age-display.styles';

interface ChildAgeDisplayProps {
  birthDate: Date | string;
  gestationalAgeDays?: number | null;
  timeZone: string;
  asOf?: Date | string;
  id?: string;
  className?: string;
}

/** Labels the two ages separately; missing gestation never implies a term birth. */
export default function ChildAgeDisplay({
  birthDate, gestationalAgeDays, timeZone, asOf = new Date(), id, className,
}: ChildAgeDisplayProps) {
  const { t, language } = useLocalization();
  const result = calculateChildAge({ birthDate, gestationalAgeDays, asOf, timeZone });
  let chronological = t('Age unavailable');
  let corrected = t('Age unavailable');

  if (result.status === 'valid') {
    chronological = formatChildAgeSpan(result.chronological, language);
    switch (result.correction.status) {
      case 'unknown':
        corrected = t('Not recorded');
        break;
      case 'not-applicable':
        corrected = t('Not applicable');
        break;
      case 'before-due-date':
        corrected = t('{age} before estimated due date').replace(
          '{age}', formatDaysUntilDue(result.correction.daysUntilDue, language),
        );
        break;
      case 'corrected':
        corrected = formatChildAgeSpan(result.correction.age, language);
        break;
    }
  }

  return (
    <span id={id} className={childAgeDisplayStyles(className)} data-testid="child-age-display">
      <span className="block" data-testid="chronological-age">
        <span className="font-medium">{t('Chronological age')}: </span>{chronological}
      </span>
      <span className="block" data-testid="corrected-age">
        <span className="font-medium">{t('Corrected age')}: </span>{corrected}
      </span>
    </span>
  );
}
