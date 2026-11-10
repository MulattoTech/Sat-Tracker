import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';

describe('startup unit seed preservation', () => {
  it('adds missing units and corrects changed mappings once, then preserves every Unit row on a later full seed', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'sat-seed-units-'));
    const databaseUrl = `file:${path.join(directory, 'isolated.db')}`;
    const env: NodeJS.ProcessEnv = {
      ...process.env, DATABASE_URL: databaseUrl, LOG_DATABASE_URL: `file:${path.join(directory, 'isolated-log.db')}`,
      ENC_HASH: 'cc'.repeat(32), NODE_ENV: 'test', ENABLE_NOTIFICATIONS: 'false', ENABLE_LOG: 'false',
    };
    let db: PrismaClient | undefined;
    try {
      execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
        cwd: process.cwd(), env, stdio: 'pipe', timeout: 60_000, maxBuffer: 1024 * 1024,
      });
      db = new PrismaClient({ adapter: createPrismaAdapter(databaseUrl) });
      const originalTime = new Date('2020-01-01T00:00:00.000Z');
      const matching = await db.unit.create({ data: {
        unitAbbr: 'ML', unitName: 'Synthetic custom milliliter label', activityTypes: 'medicine,feed',
        createdAt: originalTime, updatedAt: originalTime,
      } });
      const changed = await db.unit.create({ data: {
        unitAbbr: 'OZ', unitName: 'Synthetic custom ounce label', activityTypes: 'feed',
        createdAt: originalTime, updatedAt: originalTime,
      } });
      const missingMapping = await db.unit.create({ data: {
        unitAbbr: 'MG', unitName: 'Synthetic custom milligram label', activityTypes: null,
        createdAt: originalTime, updatedAt: originalTime,
      } });
      const custom = await db.unit.create({ data: {
        unitAbbr: 'SYNTHETIC_CUSTOM', unitName: 'Synthetic nonstandard unit', activityTypes: 'custom-care',
        createdAt: originalTime, updatedAt: originalTime,
      } });
      expect(await db.unit.findUnique({ where: { unitAbbr: 'TBSP' } })).toBeNull();

      // Observe real writes as well as timestamps. This catches unnecessary
      // updates even if a database/clock happens to reuse a timestamp value.
      await db.$executeRawUnsafe('CREATE TABLE "SeedUnitUpdateAudit" ("unitAbbr" TEXT NOT NULL)');
      await db.$executeRawUnsafe('CREATE TRIGGER "SeedUnitUpdateObserved" AFTER UPDATE ON "Unit" BEGIN INSERT INTO "SeedUnitUpdateAudit" ("unitAbbr") VALUES (NEW."unitAbbr"); END');
      const runSeed = () => execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'prisma/seed.ts'], {
        cwd: process.cwd(), env, stdio: 'pipe', timeout: 60_000, maxBuffer: 1024 * 1024,
      });

      // Execute the complete production seed entry point, not a mocked helper.
      runSeed();
      const first = await db.unit.findMany({ orderBy: { unitAbbr: 'asc' } });
      const byAbbreviation = new Map(first.map(unit => [unit.unitAbbr, unit]));
      expect(byAbbreviation.get('ML')).toEqual(matching);
      expect(byAbbreviation.get('SYNTHETIC_CUSTOM')).toEqual(custom);
      expect(byAbbreviation.get('TBSP')).toMatchObject({ unitName: 'Tablespoon', activityTypes: 'medicine,feed' });
      expect(byAbbreviation.get('OZ')).toMatchObject({
        id: changed.id, unitName: changed.unitName, createdAt: originalTime, activityTypes: 'weight,feed,medicine',
      });
      expect(byAbbreviation.get('MG')).toMatchObject({
        id: missingMapping.id, unitName: missingMapping.unitName, createdAt: originalTime, activityTypes: 'medicine',
      });
      expect(byAbbreviation.get('OZ')!.updatedAt.getTime()).toBeGreaterThan(originalTime.getTime());
      expect(byAbbreviation.get('MG')!.updatedAt.getTime()).toBeGreaterThan(originalTime.getTime());
      const firstUpdates = await db.$queryRawUnsafe<{ unitAbbr: string }[]>('SELECT "unitAbbr" FROM "SeedUnitUpdateAudit" ORDER BY "unitAbbr"');
      expect(firstUpdates).toEqual([{ unitAbbr: 'MG' }, { unitAbbr: 'OZ' }]);

      await new Promise(resolve => setTimeout(resolve, 25));
      expect(Date.now()).toBeGreaterThan(Math.max(...first.map(unit => unit.updatedAt.getTime())));
      runSeed();
      const second = await db.unit.findMany({ orderBy: { unitAbbr: 'asc' } });
      expect(second).toEqual(first); // Includes IDs, names, activityTypes and both timestamps.
      const secondUpdates = await db.$queryRawUnsafe<{ unitAbbr: string }[]>('SELECT "unitAbbr" FROM "SeedUnitUpdateAudit" ORDER BY "unitAbbr"');
      expect(secondUpdates).toEqual(firstUpdates);
    } finally {
      await db?.$disconnect();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
