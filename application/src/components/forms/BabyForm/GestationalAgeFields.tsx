'use client';

import { useId } from 'react';
import { Input } from '@/src/components/ui/input';
import { useLocalization } from '@/src/context/localization';
import { MAX_GESTATIONAL_AGE_DAYS } from '@/src/utils/childAge';
import { GestationalAgeInput, parseGestationalAgeInput } from './gestational-age-input';
import './baby-form.css';

interface GestationalAgeFieldsProps {
  value: GestationalAgeInput;
  onChange: (value: GestationalAgeInput) => void;
  disabled?: boolean;
  appearance?: 'default' | 'storybook';
}

export default function GestationalAgeFields({
  value, onChange, disabled, appearance = 'default',
}: GestationalAgeFieldsProps) {
  const { t } = useLocalization();
  const id = useId();
  const invalid = !parseGestationalAgeInput(value).valid;
  const labelClass = appearance === 'storybook' ? 'sb-fl' : 'form-label';
  const describedBy = `${id}-help${invalid ? ` ${id}-error` : ''}`;

  return (
    <fieldset className="min-w-0 space-y-2" disabled={disabled} data-testid="gestational-age-inputs">
      <legend className={labelClass}>{t('Gestational age at birth (optional)')}</legend>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-weeks`} className={labelClass}>{t('Gestational weeks at birth')}</label>
          <Input
            id={`${id}-weeks`} type="text" inputMode="numeric" autoComplete="off"
            value={value.weeks} aria-invalid={invalid} aria-describedby={describedBy}
            className={appearance === 'storybook' ? 'sb-fi' : 'w-full'}
            onChange={(event) => onChange({ ...value, weeks: event.target.value })}
            maxLength={String(MAX_GESTATIONAL_AGE_DAYS).length}
          />
        </div>
        <div>
          <label htmlFor={`${id}-days`} className={labelClass}>{t('Additional days at birth')}</label>
          <Input
            id={`${id}-days`} type="text" inputMode="numeric" autoComplete="off"
            value={value.days} aria-invalid={invalid} aria-describedby={describedBy}
            className={appearance === 'storybook' ? 'sb-fi' : 'w-full'}
            onChange={(event) => onChange({ ...value, days: event.target.value })}
            maxLength={2}
          />
        </div>
      </div>
      <p id={`${id}-help`} className="baby-form-help text-sm">
        {t('Leave both fields blank if unknown. Leave additional days blank for 0, or enter 0–6.')}
      </p>
      {invalid && (
        <p id={`${id}-error`} className="baby-form-error text-sm" role="alert">
          {t('Enter whole weeks and 0–6 additional days, from 1 day to 45 weeks.')}
        </p>
      )}
    </fieldset>
  );
}
