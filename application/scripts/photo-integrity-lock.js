/** Shared first-write lock for the web API and the startup solids converter.
 * This raw non-key update preserves every Family scalar, including updatedAt.
 * PostgreSQL serializes this family's writers; SQLite acquires its writer before
 * any ownership/count reads. Call only inside the owning DB transaction. */
async function lockPhotoFamilyRow(tx, familyId) {
  return tx.$executeRaw`UPDATE "Family" SET "updatedAt" = "updatedAt" WHERE "id" = ${familyId}`;
}

module.exports = { lockPhotoFamilyRow };
