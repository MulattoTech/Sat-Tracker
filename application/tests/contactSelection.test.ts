import { describe, expect, it } from 'vitest';
import { hydrateContactSelection, omitUnchangedContactIds } from '@/src/utils/contactSelection';

describe('contact selection in medicine and vaccine edit payloads', () => {
  it.each([
    { initial: ['active-own'], selected: ['active-own'] },
    { initial: ['deleted-own', 'legacy-hidden-id'], selected: ['deleted-own', 'legacy-hidden-id'] },
    { initial: [], selected: [] },
    { initial: ['first', 'second'], selected: ['second', 'first'] },
    { initial: ['first', 'first', 'second'], selected: ['second', 'first', 'second'] },
  ])('omits unchanged contacts for $initial without altering other fields', ({ initial, selected }) => {
    const payload = { id: 'existing-record', notes: 'Edited notes', contactIds: selected };
    const result = omitUnchangedContactIds(payload, initial);
    expect(result).toEqual({ id: 'existing-record', notes: 'Edited notes' });
    expect(Object.hasOwn(result, 'contactIds')).toBe(false);
    expect(JSON.parse(JSON.stringify(result))).not.toHaveProperty('contactIds');
    expect(payload.contactIds).toEqual(selected);
  });

  it.each([
    { initial: ['retained'], selected: ['retained', 'added'], expected: ['retained', 'added'] },
    { initial: ['removed', 'retained'], selected: ['retained'], expected: ['retained'] },
    { initial: ['removed'], selected: [], expected: [] },
    { initial: [], selected: ['added'], expected: ['added'] },
    { initial: ['old'], selected: ['Contact-A', 'contact-a', '00-id', 'Contact-A'], expected: ['Contact-A', 'contact-a', '00-id'] },
  ])('sends a changed selection, including an explicit empty clear', ({ initial, selected, expected }) => {
    expect(omitUnchangedContactIds({ notes: null, contactIds: selected }, initial))
      .toEqual({ notes: null, contactIds: expected });
  });

  it('omits a selection reverted to the original set', () => {
    const original = ['first', 'second'];
    expect(omitUnchangedContactIds({ contactIds: ['first'] }, original)).toEqual({ contactIds: ['first'] });
    expect(omitUnchangedContactIds({ contactIds: ['second', 'first'] }, original)).toEqual({});
  });

  it('sends an empty array for a new record with no selected contacts', () => {
    expect(omitUnchangedContactIds({ name: 'New medicine', contactIds: [] }, undefined))
      .toEqual({ name: 'New medicine', contactIds: [] });
    expect(omitUnchangedContactIds({ contactIds: undefined }, undefined)).toEqual({ contactIds: [] });
  });

  it('sends a new record selection while preserving all vaccine payload fields', () => {
    const fields = {
      babyId: 'child', time: '2026-11-02T12:00:00.000Z', vaccineName: 'Synthetic vaccine',
      doseNumber: 2, notes: null,
    };
    expect(omitUnchangedContactIds({ ...fields, contactIds: ['provider', 'provider'] }, undefined))
      .toEqual({ ...fields, contactIds: ['provider'] });
  });

  it('preserves the complete medicine payload and does not mutate frozen selections', () => {
    const initial = Object.freeze(['deleted-provider']);
    const selected = Object.freeze(['deleted-provider']);
    const fields = {
      id: 'medicine', name: 'Synthetic medicine', typicalDoseSize: undefined,
      unitAbbr: '', doseMinTime: '00:04:00', notes: 'New notes', active: false, isSupplement: true,
    };
    const payload = Object.freeze({ ...fields, contactIds: selected });
    expect(omitUnchangedContactIds(payload, initial)).toEqual(fields);
    expect(payload.contactIds).toBe(selected);
    const changed = omitUnchangedContactIds({ contactIds: selected }, []);
    expect(changed.contactIds).toEqual(['deleted-provider']);
    expect(changed.contactIds).not.toBe(selected);
  });
});

describe('contact selection hydration and record changes', () => {
  it('hydrates an asynchronously arriving record and its unchanged payload baseline together', () => {
    const initial = hydrateContactSelection(undefined, undefined);
    const hydrated = hydrateContactSelection(initial, 'vaccine', ['deleted-own']);
    expect(hydrated).toEqual({ recordId: 'vaccine', initialIds: ['deleted-own'], selectedIds: ['deleted-own'] });
    expect(omitUnchangedContactIds({ contactIds: hydrated.selectedIds }, hydrated.initialIds)).toEqual({});
  });

  it('hydrates late contacts for the same record while the selection is unchanged', () => {
    const initial = hydrateContactSelection(undefined, 'vaccine');
    const hydrated = hydrateContactSelection(initial, 'vaccine', ['arrived-later']);
    expect(hydrated.selectedIds).toEqual(['arrived-later']);
    expect(omitUnchangedContactIds({ contactIds: hydrated.selectedIds }, hydrated.initialIds)).toEqual({});
  });

  it('preserves a user edit and its original baseline during same-record hydration', () => {
    const original = hydrateContactSelection(undefined, 'vaccine', ['initial']);
    const edited = { ...original, selectedIds: ['chosen'] };
    const hydrated = hydrateContactSelection(edited, 'vaccine', ['arrived-later']);
    expect(hydrated).toBe(edited);
    expect(omitUnchangedContactIds({ contactIds: hydrated.selectedIds }, hydrated.initialIds))
      .toEqual({ contactIds: ['chosen'] });
  });

  it('resets a dirty selection and baseline when switching records', () => {
    const previous = { ...hydrateContactSelection(undefined, 'first', ['first-provider']), selectedIds: [] };
    const next = hydrateContactSelection(previous, 'second', ['second-provider']);
    expect(next).toEqual({ recordId: 'second', initialIds: ['second-provider'], selectedIds: ['second-provider'] });
    expect(omitUnchangedContactIds({ contactIds: next.selectedIds }, next.initialIds)).toEqual({});
  });

  it('resets editing contacts to a new-record empty array', () => {
    const previous = hydrateContactSelection(undefined, 'previous', ['previous-provider']);
    const next = hydrateContactSelection(previous, undefined);
    expect(next).toEqual({ recordId: undefined, initialIds: undefined, selectedIds: [] });
    expect(omitUnchangedContactIds({ contactIds: next.selectedIds }, next.initialIds)).toEqual({ contactIds: [] });
  });
});
