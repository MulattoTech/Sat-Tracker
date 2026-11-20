/**
 * SOLIDS feed -> FoodLog conversion runner.
 *
 * Shared by the startup CLI wrapper (scripts/convert-solids-feeds.js) and the
 * post-restore migration routes (/api/database/migrate and migrate-initial),
 * so a restored backup containing legacy SOLIDS feeds is converted the same
 * way as a live database at startup. Pure decision logic lives in
 * scripts/convert-solids-feeds-core.js (unit tested in
 * tests/convertSolidsFeeds.test.ts).
 *
 * Behavior:
 * - Idempotent: converted feeds are deleted, and a feed already linked from
 *   a FoodLog for the same family and child is skipped. Removed food tries
 *   still count so conversion cannot resurrect them.
 * - Per family, distinct food names become catalog Food entries (matched
 *   case-insensitively; blank names fall back to the reaction cause, then to
 *   a generic 'Solids' entry).
 * - Photo links move from ('feed', feedId) to ('foodLog', foodLogId).
 * - Each feed row converts inside a transaction; unexpected per-row errors
 *   are logged and skipped so callers never crash on partial data.
 */

const {
  foodNameKey,
  resolveCatalogFoodName,
  filterUnconverted,
  buildFoodLogData,
  placeFoodTile,
} = require('./convert-solids-feeds-core');
const { lockPhotoFamilyRow } = require('./photo-integrity-lock');

/**
 * Place the 'food' activity tile next to 'feed' in every caretaker's saved
 * activity settings (Settings.activitySettings JSON, keyed by caretaker).
 * Skips entries that already contain 'food', so later user re-orders stick.
 *
 * @returns {Promise<number>} number of caretaker entries updated
 */
async function placeFoodTiles(prisma) {
  const rows = await prisma.settings.findMany({
    where: { activitySettings: { not: null } },
    select: { id: true, activitySettings: true },
  });

  let updatedEntries = 0;
  for (const row of rows) {
    try {
      const all = JSON.parse(row.activitySettings);
      if (!all || typeof all !== 'object') continue;

      let rowChanged = false;
      for (const key of Object.keys(all)) {
        const entry = all[key];
        if (!entry || typeof entry !== 'object') continue;
        const placed = placeFoodTile(entry);
        if (placed.changed) {
          all[key] = { ...entry, order: placed.order, visible: placed.visible };
          rowChanged = true;
          updatedEntries++;
        }
      }

      if (rowChanged) {
        await prisma.settings.update({
          where: { id: row.id },
          data: { activitySettings: JSON.stringify(all) },
        });
      }
    } catch (error) {
      console.error(`Solids conversion: failed to place food tile for settings ${row.id}, skipping. ${error.message}`);
    }
  }
  return updatedEntries;
}

/**
 * Convert all remaining SOLIDS FeedLog rows into Food + FoodLog records.
 *
 * @param {import('@prisma/client').PrismaClient} prisma - connected client
 * @returns {Promise<{ total: number, converted: number, skipped: number, errors: number }>}
 */
async function convertSolidsFeeds(prisma) {
  // Place the food tile next to feed in saved tile orders. Runs on every
  // startup/restore (independently of whether any feeds remain to convert)
  // but only touches entries that don't have the food tile yet.
  const tileEntriesUpdated = await placeFoodTiles(prisma);

  // All SOLIDS feeds (soft-deleted ones convert to soft-deleted food logs)
  const feeds = await prisma.feedLog.findMany({
    where: { type: 'SOLIDS' },
    orderBy: { time: 'asc' },
  });

  if (feeds.length === 0) {
    return { total: 0, converted: 0, skipped: 0, errors: 0, tileEntriesUpdated };
  }

  // Legacy soft links may name another family's or child's feed. Those links
  // are not conversion evidence; leave them untouched and convert the source.
  const convertedLinks = await prisma.foodLog.findMany({
    where: { feedLogId: { not: null } },
    select: { feedLogId: true, familyId: true, babyId: true },
  });
  const pending = filterUnconverted(feeds, convertedLinks);

  let converted = 0;
  let errors = 0;

  let concurrentlySkipped = 0;
  for (const feed of pending) {
    try {
      const didConvert = await prisma.$transaction(async (tx) => {
        // Share the first-write ordering used by live attachment/lifecycle APIs.
        // Unscoped historical feeds cannot receive new authorized attachments;
        // claim their exact row first and refuse any ambiguous retained links.
        if (feed.familyId) {
          if (await lockPhotoFamilyRow(tx, feed.familyId) !== 1) throw new Error('Source family is unavailable');
        } else {
          const claimed = await tx.feedLog.updateMany({ where: { ...feed }, data: { updatedAt: feed.updatedAt } });
          if (claimed.count !== 1) throw new Error('Source feed changed before conversion');
        }
        const current = await tx.feedLog.findUnique({ where: { id: feed.id } });
        if (!current) return false;
        if (JSON.stringify(current) !== JSON.stringify(feed)) throw new Error('Source feed changed before conversion');
        const alreadyConverted = await tx.foodLog.findFirst({
          where: { feedLogId: feed.id, familyId: feed.familyId, babyId: feed.babyId }, select: { id: true },
        });
        if (alreadyConverted) return false;

        const links = await tx.photoLink.findMany({
          where: { activityType: 'feed', activityId: feed.id },
          include: { photo: { select: { id: true, familyId: true, babyId: true } } },
        });
        if (links.length) {
          const baby = feed.familyId && await tx.baby.findFirst({
            where: { id: feed.babyId, familyId: feed.familyId }, select: { id: true },
          });
          if (!baby || links.some(link => !link.photo || link.photo.familyId !== feed.familyId || link.photo.babyId !== feed.babyId)) {
            throw new Error('Source has an attachment that requires explicit review');
          }
          if (new Set(links.map(link => link.photoId)).size > 4) throw new Error('Source exceeds the retained attachment limit');
        }

        // Catalog creation belongs to this transaction too: a failed transfer
        // must not leave a new food or poison a cache with a rolled-back ID.
        const { name } = resolveCatalogFoodName(feed);
        const foods = await tx.food.findMany({
          where: { familyId: feed.familyId || null, deletedAt: null }, select: { id: true, name: true },
        });
        let foodId = foods.find(food => foodNameKey(food.name) === foodNameKey(name))?.id;
        if (!foodId) {
          foodId = (await tx.food.create({ data: { name, commonAllergen: false, familyId: feed.familyId || null } })).id;
        }
        const foodLog = await tx.foodLog.create({ data: { ...buildFoodLogData(feed), foodId } });
        if (links.length) {
          const moved = await tx.photoLink.updateMany({
            where: { id: { in: links.map(link => link.id) }, activityType: 'feed', activityId: feed.id },
            data: { activityType: 'foodLog', activityId: foodLog.id },
          });
          if (moved.count !== links.length) throw new Error('Source attachments changed during conversion');
        }
        // A scalar-only writer that does not use the family lock still cannot
        // have its newer care values silently removed by this conversion.
        const removed = await tx.feedLog.deleteMany({ where: { ...feed } });
        if (removed.count !== 1) throw new Error('Source feed changed during conversion');
        return true;
      }, { maxWait: 5_000, timeout: 15_000 });
      if (didConvert) converted++;
      else concurrentlySkipped++;
    } catch (error) {
      errors++;
      console.error(`Solids conversion: failed to convert feed ${feed.id}, skipping. ${error.message}`);
    }
  }

  return {
    total: feeds.length,
    converted,
    skipped: feeds.length - pending.length + concurrentlySkipped,
    errors,
    tileEntriesUpdated,
  };
}

/** One-line human-readable summary of a conversion result. */
function summarizeConversion(result) {
  const tileSuffix = result.tileEntriesUpdated > 0
    ? ` Food tile placed for ${result.tileEntriesUpdated} caretaker setting(s).`
    : '';
  if (result.total === 0) {
    return `Solids conversion: no SOLIDS feeds found, nothing to do.${tileSuffix}`;
  }
  return (
    `Solids conversion: ${result.converted} feed(s) converted, ${result.skipped} skipped (already converted)` +
    (result.errors > 0 ? `, ${result.errors} error(s)` : '') + `.${tileSuffix}`
  );
}

module.exports = { convertSolidsFeeds, summarizeConversion };
