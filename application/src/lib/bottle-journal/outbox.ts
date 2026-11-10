import type { BottlePayload } from '@/src/components/BottleJournal/types';
import { bottleInput } from './validation';

const DATABASE = 'sat-tracker-journal-outbox-v1';
const STORE = 'bottles';
const LIMIT = 100;
const LEASE_MS = 30_000;
export interface PendingBottle {
  scope: string; requestId: string; babyId: string; bottle: BottlePayload;
  createdAt: number; state: 'pending' | 'blocked'; attempts: number;
  nextAttemptAt: number; status: number | null; lease: string | null; leaseUntil: number;
}
let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('Local saving is unavailable. Keep this form open and reconnect.'));
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: ['scope', 'requestId'] }).createIndex('scope', 'scope');
    request.onerror = () => reject(new Error('Local saving is unavailable. Keep this form open and reconnect.'));
    request.onblocked = () => reject(new Error('Local saving is unavailable. Close other journal tabs and retry.'));
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
  }).catch(error => { database = undefined; throw error; });
  return database;
}
async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, result: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode); let value: T, failure: Error | undefined;
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(failure || new Error('Local saving failed. Keep this form open and retry.'));
    tx.onerror = () => { /* onabort supplies one non-sensitive error */ };
    const fail = (error: Error) => { failure = error; tx.abort(); };
    try { action(tx.objectStore(STORE), result => { value = result; }, fail); }
    catch (error) { fail(error instanceof Error ? error : new Error('Local saving failed.')); }
  });
}
export function listPendingBottles(scope: string): Promise<PendingBottle[]> {
  return transaction('readonly', (store, done) => {
    const request = store.index('scope').getAll(scope);
    request.onsuccess = () => done((request.result as PendingBottle[]).sort((a, b) => a.createdAt - b.createdAt));
  });
}
export async function enqueueBottle(scope: string, babyId: string, input: BottlePayload, requestId: string): Promise<void> {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(requestId)) throw new Error('Invalid request ID.');
  const { time, type: _type, ...fields } = bottleInput(input);
  const bottle: BottlePayload = { ...fields, time: time.toISOString() };
  await transaction<void>('readwrite', (store, done, fail) => {
    const existing = store.get([scope, requestId]);
    existing.onsuccess = () => {
      if (existing.result) {
        if (JSON.stringify(existing.result.bottle) !== JSON.stringify(bottle) || existing.result.babyId !== babyId) {
          fail(new Error('This pending bottle already has different values. Review pending entries before trying again.'));
        } else done();
        return;
      }
      const count = store.count();
      count.onsuccess = () => {
        if (count.result >= LIMIT) return fail(new Error('This browser has 100 pending bottles. Sync or review them before adding more.'));
        store.add({ scope, requestId, babyId, bottle, createdAt: Date.now(), state: 'pending', attempts: 0,
          nextAttemptAt: 0, status: null, lease: null, leaseUntil: 0 } satisfies PendingBottle);
        done();
      };
    };
  });
}
export function claimBottle(scope: string): Promise<PendingBottle | null> {
  return transaction('readwrite', (store, done) => {
    const request = store.index('scope').getAll(scope);
    request.onsuccess = () => {
      const now = Date.now();
      const row = (request.result as PendingBottle[]).sort((a, b) => a.createdAt - b.createdAt)
        .find(row => row.state === 'pending' && row.nextAttemptAt <= now && row.leaseUntil <= now);
      if (!row) return done(null);
      row.lease = crypto.randomUUID(); row.leaseUntil = now + LEASE_MS;
      store.put(row); done(row);
    };
  });
}
export function retryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}
export function settleBottle(row: PendingBottle, success: boolean, status = 0): Promise<void> {
  return transaction('readwrite', (store, done) => {
    const request = store.get([row.scope, row.requestId]);
    request.onsuccess = () => {
      const current = request.result as PendingBottle | undefined;
      if (!current || current.lease !== row.lease) return done();
      if (success) store.delete([row.scope, row.requestId]);
      else store.put({ ...current, lease: null, leaseUntil: 0, attempts: current.attempts + 1,
        state: retryableStatus(status) ? 'pending' : 'blocked', status: status || null,
        nextAttemptAt: Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(current.attempts, 5)) });
      done();
    };
  });
}
export function changePendingBottle(scope: string, requestId: string, action: 'retry' | 'discard'): Promise<void> {
  return transaction('readwrite', (store, done, fail) => {
    const request = store.get([scope, requestId]);
    request.onsuccess = () => {
      const row = request.result as PendingBottle | undefined;
      if (!row) return done();
      if (row.leaseUntil > Date.now()) return fail(new Error('This bottle is syncing. Wait before changing it.'));
      if (action === 'discard') store.delete([scope, requestId]);
      else store.put({ ...row, state: 'pending', status: null, nextAttemptAt: 0, lease: null, leaseUntil: 0 });
      done();
    };
  });
}
