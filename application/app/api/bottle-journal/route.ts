import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import prisma from '../db';
import { journalRoute, readJournalJson } from '@/src/lib/bottle-journal/http';
import { getJournal, saveBottle, setJournalTarget } from '@/src/lib/bottle-journal/service';
import { JournalError, text } from '@/src/lib/bottle-journal/validation';
import { journalScope } from '@/src/lib/bottle-journal/outbox-identity';
import { notifyActivityCreated, resetTimerNotificationState } from '@/src/lib/notifications/activityHook';

export const GET = journalRoute(async (request, actor) => {
  const query = request.nextUrl.searchParams;
  const data = await getJournal(prisma, actor, text(query.get('babyId'), 100, 'child ID')!, text(query.get('day'), 10, 'date')!, text(query.get('timeZone'), 100, 'time zone')!);
  const etag = '"' + createHash('sha256').update(JSON.stringify(data)).digest('hex') + '"';
  if (request.headers.get('if-none-match') === etag) return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  return NextResponse.json({ success: true, data }, { headers: { ETag: etag } });
});
export const POST = journalRoute(async (request, actor) => {
  const body = await readJournalJson(request), babyId = text(body.babyId, 100, 'child ID')!;
  // A fetch interceptor may refresh a session while a queued request is in
  // flight. Never replay a previous caregiver's draft under a new identity.
  if (body.expectedScope !== undefined && body.expectedScope !== journalScope(actor.familyId, actor.actorKey!, babyId)) {
    throw new JournalError('The signed-in caregiver or child changed. Review this pending bottle after signing in again.', 409);
  }
  const data = await saveBottle(prisma, actor, babyId, body.bottle, body.requestId, body.expectedUpdatedAt);
  if (data.created) {
    void notifyActivityCreated(babyId, 'feed', { caretakerId: actor.caretakerId || undefined }, { type: 'BOTTLE' }).catch(() => undefined);
    void resetTimerNotificationState(babyId, 'feed').catch(() => undefined);
  }
  return NextResponse.json({ success: true, data });
});
export const PATCH = journalRoute(async (request, actor) => {
  const body = await readJournalJson(request);
  const data = await setJournalTarget(prisma, actor, text(body.babyId, 100, 'child ID')!, body.targetMl);
  return NextResponse.json({ success: true, data });
});
