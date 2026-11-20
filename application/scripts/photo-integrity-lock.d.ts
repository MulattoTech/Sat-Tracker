import type { Prisma } from '@prisma/client';

export function lockPhotoFamilyRow(tx: Prisma.TransactionClient, familyId: string): Promise<number>;
