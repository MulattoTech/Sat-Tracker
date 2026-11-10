import { NextResponse } from 'next/server';
import prisma from '../../db';
import { journalRoute, readJournalJson } from '@/src/lib/bottle-journal/http';
import { previewLegacyJournal, commitLegacyJournal } from '@/src/lib/bottle-journal/legacy-service';
import { JournalError, text } from '@/src/lib/bottle-journal/validation';

export const POST = journalRoute(async (request, actor) => {
  const body = await readJournalJson(request), babyId = text(body.babyId, 100, 'child ID')!;
  if (body.action === 'preview') return NextResponse.json({ success: true, data: await previewLegacyJournal(prisma, actor, babyId,
    text(body.content, 1_500_000, 'journal export')!, text(body.format, 4, 'export format')!, text(body.timeZone, 100, 'time zone')!) });
  if (body.action === 'commit') return NextResponse.json({ success: true, data: await commitLegacyJournal(prisma, actor, babyId, body.rows, body.confirmed) });
  throw new JournalError('Choose preview or confirmed import.');
});
