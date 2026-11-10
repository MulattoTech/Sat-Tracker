/**
 * Omit an unchanged contact selection from an edit so hidden or historical
 * associations are retained. An undefined baseline denotes a new record.
 */
export function omitUnchangedContactIds<T extends { contactIds?: readonly string[] }>(
  payload: T,
  initialContactIds: readonly string[] | undefined,
): Omit<T, 'contactIds'> & { contactIds?: string[] } {
  const { contactIds, ...fields } = payload;
  const selectedIds = [...new Set(contactIds ?? [])];
  if (initialContactIds !== undefined) {
    const initialIds = new Set(initialContactIds);
    if (initialIds.size === selectedIds.length && selectedIds.every(id => initialIds.has(id))) {
      return fields;
    }
  }
  return { ...fields, contactIds: selectedIds };
}

export interface ContactSelection {
  recordId: string | undefined;
  initialIds: readonly string[] | undefined;
  selectedIds: string[];
}

/** Hydrate a record's contacts without overwriting a same-record user edit. */
export function hydrateContactSelection(
  current: ContactSelection | undefined,
  recordId: string | undefined,
  contactIds: readonly string[] = [],
): ContactSelection {
  if (current && recordId !== undefined && current.recordId === recordId &&
      omitUnchangedContactIds({ contactIds: current.selectedIds }, current.initialIds).contactIds !== undefined) {
    return current;
  }
  return {
    recordId,
    initialIds: recordId === undefined ? undefined : [...contactIds],
    selectedIds: [...contactIds],
  };
}
