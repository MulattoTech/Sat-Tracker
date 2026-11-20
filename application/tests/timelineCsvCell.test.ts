import { describe, expect, it } from 'vitest';
import { literalCsvCell } from '@/app/api/timeline/export/csv-cell';

describe('selected report CSV literal cells', () => {
  it.each(['=1+1', '+SUM(1,2)', '-1+2', '@SUM(A1)', ' \t=HYPERLINK("x")', '\r\n+1', '\u0000=1', '\ufeff@value'])
    ('keeps a spreadsheet formula prefix literal: %j', value => expect(literalCsvCell(value)).toBe(`'${value}`));
  it.each(['', 'Caregiver observation', 'Rash location: =literal', 'café\n@note', "'=already literal", '12:00 PM'])
    ('preserves ordinary or labeled caregiver text: %j', value => expect(literalCsvCell(value)).toBe(value));
});
