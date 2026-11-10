import { describe, expect, it } from 'vitest';
import { parseOcrPages } from '@/src/lib/ocr/parser';

describe('explicit PDF date headings', () => {
  it('propagates an ISO heading within its page without parsing the year as military time', () => {
    const rows = parseOcrPages([{ page: 1, text: '2026-10-20\n08:15 bottle formula 90 mL\n14:00 bottle breast milk 3 oz' }], { timeFormat: '24h' });
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.localDate)).toEqual(['2026-10-20', '2026-10-20']);
    expect(rows.map(row => row.localTime)).toEqual(['08:15', '14:00']);
    expect(rows.every(row => row.fieldSources.localDate === 'context')).toBe(true);
  });

  it('never carries a page heading to an undated next page', () => {
    const rows = parseOcrPages([
      { page: 1, text: '2026-10-20\n08:15 bottle 90 mL' },
      { page: 2, text: '14:00 bottle 3 oz' },
    ], { timeFormat: '24h' });
    expect(rows.find(row => row.source.page === 1)?.localDate).toBe('2026-10-20');
    expect(rows.find(row => row.source.page === 2)?.localDate).toBeNull();
  });

  it.each(['10/20', '10/20/2026', '2026-02-30'])('keeps ambiguous, missing-year or invalid heading %s unresolved', date => {
    const rows = parseOcrPages([{ page: 1, text: date + '\n08:15 bottle 90 mL' }], { timeFormat: '24h' });
    expect(rows.find(row => row.eventType === 'feed')?.localDate).toBeNull();
  });

  it.each(['21.10.2026', '10.21.2026', '2026/10/21', '2026.10.21', '21/10/2026'])('clears the supplied default for unsupported full numeric heading %s', date => {
    const rows = parseOcrPages([{ page: 1, text: date + '\n08:15 bottle 90 mL' }], {
      defaultDate: '2026-10-20', timeFormat: '24h',
    });
    expect(rows.find(row => row.eventType === 'feed')).toMatchObject({ localDate: null, localTime: '08:15' });
    expect(rows.find(row => row.eventType === 'unknown')?.localTime).toBeNull();
  });

  it('does not treat an explicit dotted clock as a numeric date heading', () => {
    const rows = parseOcrPages([{ page: 1, text: '2026-10-20\n14.15 bottle 90 mL' }], { timeFormat: '24h' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ localDate: '2026-10-20', localTime: '14:15' });
  });

  it('does not reinterpret recorded quantities or labelled identifiers as clocks or dates', () => {
    const rows = parseOcrPages([{ page: 1, text: '2026-10-20\n08:15 bottle 1200 mL; bottle id: 01-02; caregiver: 14:00' }], { timeFormat: '24h' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ localDate: '2026-10-20', localTime: '08:15', amount: 1200 });
  });
});
