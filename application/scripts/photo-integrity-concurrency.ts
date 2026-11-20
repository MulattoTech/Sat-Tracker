/** Real independent-process database overlap, shared by SQLite and PostgreSQL QA. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import type { Prisma, PrismaClient } from '@prisma/client';
import { withPhotoIntegrity } from '../app/api/utils/photo-integrity';
import { attachPhotoToTarget, setPhotoMilestone } from '../app/api/photos/photo-link-service';
import { assertPhotoTargetMove, detachPhotoTargetForDeletion } from '../app/api/utils/photo-target-mutations';
import { makeNurseryUndo } from '../app/api/utils/nursery-undo';
import { undoNurseryRows } from '../app/api/utils/nursery-undo-mutations';
import type { AuthResult } from '../app/api/utils/auth';
import type { NurseryUndo } from '../src/utils/nursery/undo';

export type PhotoRaceOperation = {
  kind: 'attach' | 'tag' | 'move' | 'delete' | 'undo' | 'rollback';
  familyId: string; babyId: string; caretakerId: string;
  targetId: string; photoId: string; siblingId: string;
  undo?: NurseryUndo;
};
export const PHOTO_RACE_CASES = ['attach-tag', 'tag-attach', 'attach-move', 'move-attach',
  'attach-delete', 'delete-attach', 'attach-undo', 'undo-attach', 'rollback-attach'] as const;
export type PhotoRaceCase = typeof PHOTO_RACE_CASES[number];

export async function performPhotoRaceOperation(db: PrismaClient, operation: PhotoRaceOperation) {
  const { kind, familyId, targetId, photoId, siblingId } = operation;
  if (kind === 'undo') {
    const auth = { authenticated: true, familyId, caretakerId: operation.caretakerId,
      caretakerRole: 'USER', caretakerType: 'parent', isAccountAuth: false } as AuthResult;
    return undoNurseryRows(db, auth, operation.undo!);
  }
  return withPhotoIntegrity(db, familyId, async tx => {
    const ref = { activityType: operation.undo ? 'feed' : 'milestone', activityId: targetId };
    if (kind === 'attach' || kind === 'rollback') {
      await attachPhotoToTarget(tx, familyId, { ...ref, photoId });
      if (kind === 'rollback') throw new Error('Synthetic photo rollback after the actual attachment write');
    } else if (kind === 'tag') await setPhotoMilestone(tx, familyId, photoId, targetId);
    else if (kind === 'move') {
      await assertPhotoTargetMove(tx, familyId, ref, siblingId);
      await tx.milestone.update({ where: { id: targetId }, data: { babyId: siblingId } });
    } else {
      await detachPhotoTargetForDeletion(tx, familyId, ref);
      await tx.milestone.delete({ where: { id: targetId } });
    }
  });
}

export function errorDetails(error: unknown): { message: string; status?: number; codes: string[] } {
  const codes = new Set<string>();
  const visit = (value: unknown, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 5) return;
    for (const [key, item] of Object.entries(value)) {
      if (['code', 'originalCode', 'sqlState'].includes(key) && ['string', 'number'].includes(typeof item)) codes.add(String(item));
      if (['cause', 'meta', 'driverAdapterError'].includes(key)) visit(item, depth + 1);
    }
  };
  visit(error);
  return { message: error instanceof Error ? error.message : String(error),
    ...((error as { status?: number })?.status ? { status: (error as { status: number }).status } : {}), codes: [...codes] };
}

/** Observe the real first SQL statement; the result/error is never replaced. */
export function observePhotoLock(db: PrismaClient, observed: (event: string, detail?: unknown) => Promise<void> | void): PrismaClient {
  return new Proxy(db, { get(target, property) {
    if (property === '$transaction') return (action: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) =>
      target.$transaction(async tx => action(new Proxy(tx, { get(transaction, member) {
        const method = Reflect.get(transaction, member);
        if (member === '$executeRaw') return async (...args: unknown[]) => {
          const sql = Array.isArray(args[0]) ? (args[0] as string[]).join('?') : '';
          if (!sql.includes('UPDATE "Family"')) return Reflect.apply(method, transaction, args);
          await observed('lock-attempted');
          try {
            const result = await Reflect.apply(method, transaction, args);
            await observed('lock-acquired');
            return result;
          } catch (error) { await observed('lock-error', errorDetails(error)); throw error; }
        };
        return typeof method === 'function' ? method.bind(transaction) : method;
      } })), options as { maxWait?: number; timeout?: number });
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' exceeded its bound')), ms); })]); }
  finally { clearTimeout(timer); }
}

export async function runPhotoRace(db: PrismaClient, input: {
  databaseUrl: string; familyId: string; babyId: string; siblingId: string; caretakerId: string; scenario: PhotoRaceCase;
}) {
  const suffix = randomUUID(), pg = input.databaseUrl.startsWith('postgres');
  const applicationName = 'sat-photo-race-' + suffix;
  const { familyId, babyId, siblingId, caretakerId, scenario } = input;
  const targetId = 'photo-race-target-' + suffix;
  const ids = Array.from({ length: 5 }, (_, index) => `photo-race-${suffix}-${index}`);
  const originalFamily = await db.family.findUniqueOrThrow({ where: { id: familyId } });
  const at = new Date('2026-11-01T12:34:56.789Z');
  const isUndo = scenario.includes('undo');
  const row = isUndo
    ? await db.feedLog.create({ data: { id: targetId, familyId, babyId, caretakerId, time: at, type: 'BOTTLE', amount: 30, unitAbbr: 'ML' } })
    : await db.milestone.create({ data: { id: targetId, familyId, babyId, caretakerId, date: at, title: 'Synthetic photo race', category: 'MOTOR' } });
  const undo = isUndo ? makeNurseryUndo('bottle', { authenticated: true, familyId, caretakerId,
    caretakerRole: 'USER', caretakerType: 'parent', isAccountAuth: false } as AuthResult, [row])! : undefined;
  const ref = { activityType: isUndo ? 'feed' : 'milestone', activityId: targetId };
  await db.photo.createMany({ data: ids.map(id => ({ id, familyId, babyId, caretakerId, originalName: 'synthetic-race.png',
    storedName: id + '.enc', thumbStoredName: id + '-thumb.enc', mimeType: 'image/png', fileSize: 1, thumbSize: 1, takenAt: at })) });
  if (scenario === 'attach-tag' || scenario === 'tag-attach') {
    await db.photoLink.createMany({ data: ids.slice(0, 3).map(photoId => ({ photoId, ...ref })) });
  }
  const [firstKind, secondKind] = scenario.split('-') as [PhotoRaceOperation['kind'], PhotoRaceOperation['kind']];
  const operation = (kind: PhotoRaceOperation['kind'], photoId: string): PhotoRaceOperation => ({ kind, familyId, babyId,
    siblingId, caretakerId, targetId, photoId, ...(undo ? { undo } : {}) });
  const ownerOperation = operation(firstKind, ids[3]), peerOperation = operation(secondKind, ids[4]);
  const ready = deferred<void>(), acquired = deferred<void>(), peerAttempted = deferred<void>(), peerBusy = deferred<unknown>();
  const release = deferred<void>(), events: { event: string; at: number; detail?: unknown }[] = [];
  const responses = new Map<number, ReturnType<typeof deferred<any>>>();
  let sequence = 0, stderr = '', owner: Promise<any> | undefined, peerResult: Promise<any> | undefined;
  const worker = spawn(process.execPath, ['--import', 'tsx', path.join(process.cwd(), 'scripts/photo-integrity-worker.ts')], {
    cwd: process.cwd(), env: { ...process.env, SAT_TRACKER_SYNTHETIC_TEST: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exit = new Promise<number | null>(resolve => worker.once('exit', resolve));
  worker.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
  const lines = readline.createInterface({ input: worker.stdout });
  lines.on('line', line => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (message.event) {
      events.push({ event: message.event, at: Date.now(), detail: message.detail });
      if (message.event === 'ready') ready.resolve();
      if (message.event === 'lock-attempted') peerAttempted.resolve();
      if (message.event === 'lock-error') peerBusy.resolve(message.detail);
    }
    if (message.requestId) responses.get(message.requestId)?.resolve(message);
  });
  const call = (body: object) => {
    const requestId = ++sequence, response = deferred<any>(); responses.set(requestId, response);
    worker.stdin.write(JSON.stringify({ requestId, ...body }) + '\n');
    return bounded(response.promise, 25_000, `Photo worker request ${requestId}`).finally(() => responses.delete(requestId));
  };
  let succeeded = false;
  try {
    void call({ command: 'initialize', databaseUrl: input.databaseUrl, applicationName, familyId }).catch(() => {});
    await bounded(ready.promise, 15_000, 'Independent photo worker startup');
    const ownerDb = observePhotoLock(db, async event => {
      if (event === 'lock-acquired') { acquired.resolve(); await release.promise; }
    });
    owner = performPhotoRaceOperation(ownerDb, ownerOperation).then(() => ({ ok: true }), error => ({ ok: false, ...errorDetails(error) }));
    await bounded(acquired.promise, 5000, 'Owner first-write lock');
    peerResult = call({ command: 'operation', operation: peerOperation });
    await bounded(peerAttempted.promise, 5000, 'Independent writer actual SQL attempt');
    let overlap: unknown;
    if (pg) {
      const deadline = Date.now() + 5000;
      for (;;) {
        const waiting = await db.$queryRaw<{ pid: number; wait_event_type: string; query: string }[]>`
          SELECT pid, wait_event_type, query FROM pg_stat_activity WHERE application_name = ${applicationName}
          AND wait_event_type = 'Lock' AND query LIKE 'UPDATE "Family"%'`;
        if (waiting.length) { overlap = { waitEvent: 'Lock', backendPid: waiting[0].pid }; break; }
        assert.ok(Date.now() < deadline, 'PostgreSQL must expose the independent backend waiting on the held Family lock');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } else {
      overlap = await bounded(peerBusy.promise, 3000, 'Actual SQLite BUSY on the held Family writer');
      assert.ok((overlap as { codes: string[] }).codes.some(code => ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', '5', '517'].includes(code)));
    }
    assert.equal(events.filter(event => event.event === 'lock-acquired').length, 0, 'Peer callback must not enter before owner releases its lock');
    release.resolve();
    const [first, second] = await Promise.all([bounded(owner, 20_000, 'Owner photo operation'), peerResult]);
    assert.equal(first.ok, firstKind !== 'rollback', JSON.stringify(first));
    const expectedPeer = secondKind === 'delete' || firstKind === 'rollback';
    assert.equal(second.ok, expectedPeer, JSON.stringify(second));
    if (!expectedPeer) assert.equal(second.status, firstKind === 'move' || firstKind === 'delete' || firstKind === 'undo' ? 404
      : secondKind === 'tag' || secondKind === 'attach' ? 400 : 409, JSON.stringify(second));
    const links = await db.photoLink.findMany({ where: ref, orderBy: { photoId: 'asc' } });
    const photos = await db.photo.findMany({ where: { id: { in: ids } } });
    assert.equal(photos.length, ids.length, 'Lifecycle operations must preserve every photo row');
    if (scenario === 'attach-tag' || scenario === 'tag-attach') {
      assert.equal(links.length, 4); assert.ok(links.some(link => link.photoId === ids[3]));
      assert.equal(photos.find(photo => photo.id === ids[4])!.milestoneId, null);
      await withPhotoIntegrity(db, familyId, tx => attachPhotoToTarget(tx, familyId, { ...ref, photoId: ids[3] }));
      assert.deepEqual(await db.photoLink.findMany({ where: ref, orderBy: { photoId: 'asc' } }), links, 'Retry at the cap must retain exact edge identities/timestamps');
    } else if (scenario === 'attach-move' || scenario === 'attach-undo') {
      assert.equal(links.length, 1); assert.equal(links[0].photoId, ids[3]);
      const target = isUndo ? await db.feedLog.findUnique({ where: { id: targetId } }) : await db.milestone.findUnique({ where: { id: targetId } });
      assert.equal(target?.babyId, babyId);
    } else if (scenario === 'move-attach') {
      assert.equal(links.length, 0); assert.equal((await db.milestone.findUniqueOrThrow({ where: { id: targetId } })).babyId, siblingId);
    } else if (scenario === 'rollback-attach') {
      assert.match(first.message, /Synthetic photo rollback/); assert.equal(links.length, 1); assert.equal(links[0].photoId, ids[4]);
    } else {
      assert.equal(links.length, 0);
      assert.equal(isUndo ? await db.feedLog.findUnique({ where: { id: targetId } }) : await db.milestone.findUnique({ where: { id: targetId } }), null);
    }
    // A readable but poisoned SQLite adapter is insufficient: both processes must commit again.
    const localNote = 'photo-race-local-' + suffix, peerNote = 'photo-race-peer-' + suffix;
    await withPhotoIntegrity(db, familyId, tx => tx.note.create({ data: { id: localNote, familyId, babyId, time: at, content: 'Synthetic local follow-up' } }));
    const health = await call({ command: 'health', familyId, babyId, readId: localNote, writeId: peerNote });
    assert.equal(health.ok, true); assert.equal(health.readId, localNote);
    assert.equal((await db.note.findUniqueOrThrow({ where: { id: peerNote } })).content, 'Synthetic peer follow-up');
    assert.deepEqual(await db.family.findUniqueOrThrow({ where: { id: familyId } }), originalFamily, 'Family lock must preserve every scalar');
    succeeded = true;
    return { scenario, provider: pg ? 'postgresql' : 'sqlite', actualOverlap: overlap,
      owner: first, peer: second, lockAttempts: events.filter(event => event.event === 'lock-attempted').length,
      bothClientsCommittedAfterContention: true, familyScalarsPreserved: true };
  } finally {
    release.resolve();
    if (owner || peerResult) await bounded(Promise.allSettled([owner, peerResult].filter(Boolean) as Promise<unknown>[]), 25_000, 'Pending photo writers cleanup').catch(() => {});
    if (worker.exitCode === null && worker.signalCode === null) {
      try { await call({ command: 'close' }); await bounded(exit, 5000, 'Photo worker closure'); }
      catch { worker.kill('SIGKILL'); await bounded(exit, 5000, 'Forced photo worker closure'); if (succeeded) throw new Error('Photo worker required forced cleanup: ' + stderr); }
    }
    lines.close();
    if (succeeded) assert.equal(worker.exitCode, 0, stderr);
  }
}
