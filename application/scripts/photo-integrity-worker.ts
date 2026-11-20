/** Owned child process for actual driver contention; never a deployed endpoint. */
import assert from 'node:assert/strict';
import readline from 'node:readline';
import { PrismaClient } from '@prisma/client';
import { createPrismaAdapter } from '../prisma/prisma-adapter';
import { observePhotoLock, performPhotoRaceOperation, errorDetails } from './photo-integrity-concurrency';
import { withPhotoIntegrity } from '../app/api/utils/photo-integrity';

let db: PrismaClient | undefined, observed: PrismaClient | undefined;
const input = readline.createInterface({ input: process.stdin });
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
let queue = Promise.resolve();
input.on('line', line => { queue = queue.then(async () => {
  const request = JSON.parse(line);
  try {
    if (request.command === 'initialize') {
      assert.equal(process.env.SAT_TRACKER_SYNTHETIC_TEST, '1'); assert.equal(db, undefined);
      assert.match(request.familyId, /^synthetic-photo-/);
      let url = request.databaseUrl as string;
      if (url.startsWith('postgres')) {
        const parsed = new URL(url);
        assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname));
        assert.equal(parsed.pathname, '/sat_tracker_photo_test');
        assert.match(request.applicationName, /^sat-photo-race-[a-f\d-]+$/);
        parsed.searchParams.set('application_name', request.applicationName); url = parsed.toString();
      } else assert.match(url, /^file:\/.*\/sat-photo-concurrency-[^/]+\/synthetic\.db$/);
      db = new PrismaClient({ adapter: createPrismaAdapter(url) }); await db.$connect();
      if (url.startsWith('file:')) await db.$executeRawUnsafe('PRAGMA busy_timeout = 150');
      observed = observePhotoLock(db, (event, detail) => { send({ event, detail }); });
      send({ event: 'ready' }); send({ requestId: request.requestId, ok: true });
    } else if (request.command === 'operation') {
      assert.ok(observed); await performPhotoRaceOperation(observed, request.operation);
      send({ requestId: request.requestId, ok: true });
    } else if (request.command === 'health') {
      assert.ok(db); const row = await db.note.findUniqueOrThrow({ where: { id: request.readId } });
      assert.equal(row.familyId, request.familyId);
      await withPhotoIntegrity(db, request.familyId, tx => tx.note.create({ data: {
        id: request.writeId, familyId: request.familyId, babyId: request.babyId,
        time: new Date('2026-11-01T12:34:56.789Z'), content: 'Synthetic peer follow-up',
      } }));
      send({ requestId: request.requestId, ok: true, readId: row.id });
    } else if (request.command === 'close') {
      await db?.$disconnect(); send({ requestId: request.requestId, ok: true }); input.close(); process.exit(0);
    } else throw new Error('Unknown synthetic worker command');
  } catch (error) { send({ requestId: request.requestId, ok: false, ...errorDetails(error) }); }
}).catch(error => { send({ fatal: errorDetails(error) }); process.exitCode = 1; input.close(); }); });
