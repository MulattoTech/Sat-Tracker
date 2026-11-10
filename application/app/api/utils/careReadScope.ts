import type { Prisma } from '@prisma/client';

// Historical rows retain their own deleted related records. Only the family
// boundary belongs here; live catalog selectors apply their own deletion rules.
export function caretakerNameRelation(familyId: string) {
  return { where: { familyId }, select: { name: true } } as const;
}

export function foodDisplayRelation(familyId: string) {
  return { where: { familyId }, select: { id: true, name: true, commonAllergen: true } } as const;
}

export const medicineNameRelation = { select: { familyId: true, name: true } } as const;

export function medicineNameForFamily(medicine: { familyId: string | null; name: string } | null, familyId: string): string | null {
  return medicine?.familyId === familyId ? medicine.name : null;
}

/**
 * A dose belongs to its care-row family independently of a legacy catalog join.
 * Only an owned catalog can classify it as a supplement. Otherwise preserve the
 * dose as generic medicine, without borrowing the foreign catalog's metadata.
 * Use this predicate before pagination, latest selection and aggregate counts.
 */
export function medicineCategoryWhere(familyId: string, isSupplement: boolean): Prisma.MedicineLogWhereInput {
  if (isSupplement) return { medicine: { familyId, isSupplement: true } };
  return {
    OR: [
      { medicine: { familyId, isSupplement: false } },
      { medicine: { familyId: { not: familyId } } },
      // SQL NOT-equal does not match null; legacy unresolved catalogs still
      // represent an owned dose and must appear in exactly one category.
      { medicine: { familyId: null } },
    ],
  };
}
