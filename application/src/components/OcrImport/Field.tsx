import React, { ReactNode, useId } from 'react';
import { Input } from '@/src/components/ui/input';
import { useLocalization } from '@/src/context/localization';

interface FieldProps {
  label: string;
  children: (id: string) => ReactNode;
  hint?: string;
}

export function Field({ label, children, hint }: FieldProps) {
  const id = useId();
  const { t } = useLocalization();
  return <div className="ocr-field"><label htmlFor={id}>{t(label)}</label>{children(id)}{hint && <p className="ocr-hint">{t(hint)}</p>}</div>;
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  disabled?: boolean;
  placeholder?: string;
  min?: string | number;
  max?: string | number;
  step?: string | number;
}

export function TextField({ label, value, onChange, ...props }: TextFieldProps) {
  const { t } = useLocalization();
  return <Field label={label}>{id => <Input {...props} id={id} value={value} onChange={event => onChange(event.target.value)} placeholder={props.placeholder ? t(props.placeholder) : undefined} />}</Field>;
}

interface ChoiceFieldProps {
  label: string;
  value: string;
  choices: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function ChoiceField({ label, value, choices, onChange, disabled }: ChoiceFieldProps) {
  const { t } = useLocalization();
  return <Field label={label}>{id => <select id={id} className="ocr-select" value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
    {choices.map(([key, name]) => <option key={key} value={key}>{t(name)}</option>)}
  </select>}</Field>;
}
