'use client';

import { useId, type ChangeEvent } from 'react';
import { Button } from '@/src/components/ui/button';
import { Input } from '@/src/components/ui/input';
import { Textarea } from '@/src/components/ui/textarea';
import { useLocalization } from '@/src/context/localization';
import { DIAPER_RASH_TEXT_FIELDS, getDiaperRashStatus } from '@/src/utils/diaperRash';
import type { DiaperRashDraft } from './diaper-form-data';
import './diaper-form.css';

interface DiaperRashFieldsProps {
  value: DiaperRashDraft;
  onChange: <K extends keyof DiaperRashDraft>(key: K, value: DiaperRashDraft[K]) => void;
  disabled?: boolean;
}

export default function DiaperRashFields({ value, onChange, disabled }: DiaperRashFieldsProps) {
  const { t } = useLocalization();
  const id = useId();
  return (
    <fieldset className="min-w-0 space-y-3 rounded-xl border-2 border-rose-200 bg-rose-50/50 p-3 diaper-rash-fields"
      data-testid="diaper-rash-observation" aria-describedby={`${id}-help`} disabled={disabled}>
      <legend className="form-label px-1">{t('Rash observation')}</legend>
      <p id={`${id}-help`} className="text-sm text-slate-600 diaper-rash-help">
        {t('Optional. Record what you observed; leave unknown observations unrecorded.')}
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button type="button" variant={value.rashObserved === true ? 'secondary' : 'outline'}
          className="h-auto min-h-11 whitespace-normal break-words px-3 sm:col-span-2"
          aria-pressed={value.rashObserved === true} disabled={disabled}
          onClick={() => onChange('rashObserved', true)}>{t('Rash observed')}</Button>
        <Button type="button" variant={value.rashObserved === false ? 'secondary' : 'outline'}
          className="h-auto min-h-11 whitespace-normal break-words px-3"
          aria-pressed={value.rashObserved === false} disabled={disabled}
          onClick={() => onChange('rashObserved', false)}>{t('No rash observed')}</Button>
        <Button type="button" variant={value.rashObserved === null ? 'secondary' : 'outline'}
          className="h-auto min-h-11 whitespace-normal break-words px-3"
          aria-pressed={value.rashObserved === null} disabled={disabled}
          onClick={() => onChange('rashObserved', null)}>{t('Clear rash observation')}</Button>
      </div>
      <p className="text-sm text-slate-700 diaper-rash-status" aria-live="polite" data-testid="diaper-rash-status">
        {t('Rash observation')}: {getDiaperRashStatus(value, t)}
      </p>
      {DIAPER_RASH_TEXT_FIELDS.map(({ key, label, maxLength }) => {
        const fieldId = `${id}-${key}`;
        const invalid = value[key].length > maxLength;
        const props = {
          id: fieldId, name: key, value: value[key], maxLength, disabled,
          'aria-describedby': `${fieldId}-limit`, 'aria-invalid': invalid || undefined,
          onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(key, event.target.value),
        };
        return (
          <div key={key} className="min-w-0">
            <label htmlFor={fieldId} className="form-label">{t(label)}</label>
            {key === 'rashLocation' ? <Input {...props} /> : <Textarea {...props} rows={2} />}
            <p id={`${fieldId}-limit`} className="mt-1 text-xs text-slate-600 diaper-rash-help" role={invalid ? 'alert' : undefined}>
              {t('Maximum {count} characters.').replace('{count}', String(maxLength))}
            </p>
          </div>
        );
      })}
    </fieldset>
  );
}
