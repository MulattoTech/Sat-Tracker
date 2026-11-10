import { NextRequest, NextResponse } from 'next/server';
import prisma from '../db';
import { ApiResponse, ActiveBreastFeedResponse } from '../types';
import { withAuthContext, AuthResult } from '../utils/auth';
import { formatForResponse } from '../utils/timezone';
import { checkWritePermission } from '../utils/writeProtection';
import { startBreastfeedSession, updateBreastfeedSession, endBreastfeedSession, SESSION_UPDATE_ACTIONS, SessionUpdateAction, resolveRequestedStartTime, BreastfeedSessionConflict, BreastfeedSessionInputError } from '../utils/activeBreastFeed';
import { journalScope } from '@/src/lib/bottle-journal/outbox-identity';
import { makeNurseryUndo } from '../utils/nursery-undo';
import type { NurseryUndo } from '@/src/utils/nursery/undo';

function formatActiveBreastFeed(record: any): ActiveBreastFeedResponse {
  return {
    ...record,
    currentSideStartTime: formatForResponse(record.currentSideStartTime) || null,
    sessionStartTime: formatForResponse(record.sessionStartTime) || '',
    createdAt: formatForResponse(record.createdAt) || '',
    updatedAt: formatForResponse(record.updatedAt) || '',
  };
}

async function optionalSessionBody(req: NextRequest): Promise<Record<string, any>> {
  const text = await req.text();
  if (!text.trim()) return {};
  let body: unknown;
  try { body = JSON.parse(text); } catch {
    throw new BreastfeedSessionInputError('Breastfeeding changes must be a valid JSON object.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BreastfeedSessionInputError('Breastfeeding changes must be a valid JSON object.');
  }
  return body as Record<string, unknown>;
}

function checkSessionScope(expected: unknown, babyId: string, auth: AuthResult) {
  if (expected === undefined) return;
  const actor = auth.isAccountAuth && auth.accountId ? `account:${auth.accountId}`
    : auth.caretakerId ? `caretaker:${auth.caretakerId}` : null;
  if (!actor || !auth.familyId || expected !== journalScope(auth.familyId, actor, babyId)) {
    throw new BreastfeedSessionConflict('The signed-in caregiver or child changed. Sign in as the original caregiver before retrying this action.');
  }
}

async function handleGet(req: NextRequest, authContext: AuthResult) {
  try {
    const { familyId: userFamilyId } = authContext;
    if (!userFamilyId) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'User is not associated with a family.' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const babyId = searchParams.get('babyId');

    if (!babyId) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'babyId is required' }, { status: 400 });
    }

    const activeSession = await prisma.activeBreastFeed.findUnique({
      where: { babyId },
    });

    if (!activeSession || activeSession.familyId !== userFamilyId) {
      return NextResponse.json<ApiResponse<null>>({
        success: true,
        data: null,
      });
    }

    return NextResponse.json<ApiResponse<ActiveBreastFeedResponse>>({
      success: true,
      data: formatActiveBreastFeed(activeSession),
    });
  } catch (error) {
    console.error('Error fetching active breastfeed:', error);
    return NextResponse.json<ApiResponse<null>>({ success: false, error: 'Failed to fetch active breastfeed' }, { status: 500 });
  }
}

async function handlePost(req: NextRequest, authContext: AuthResult) {
  const writeCheck = checkWritePermission(authContext);
  if (!writeCheck.allowed) return writeCheck.response!;

  try {
    const { familyId: userFamilyId, caretakerId } = authContext;
    if (!userFamilyId) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'User is not associated with a family.' }, { status: 403 });
    }

    const body = await req.json();
    const { babyId, side, startTime: requestedStartTime } = body;

    if (!babyId || !side) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'babyId and side are required' }, { status: 400 });
    }
    checkSessionScope(body.expectedScope, babyId, authContext);

    const startTimeResolution = resolveRequestedStartTime(requestedStartTime);
    if (!startTimeResolution.ok) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: startTimeResolution.error }, { status: 400 });
    }
    const startTime = startTimeResolution.startTime;

    // Verify baby belongs to family
    const baby = await prisma.baby.findFirst({
      where: { id: babyId, familyId: userFamilyId, deletedAt: null },
    });
    if (!baby) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'Baby not found in this family.' }, { status: 404 });
    }

    // Check if there's already an active session
    const existing = await prisma.activeBreastFeed.findUnique({ where: { babyId } });
    if (existing) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'An active breastfeed session already exists for this baby.' }, { status: 409 });
    }

    const session = await startBreastfeedSession({ babyId, side, familyId: userFamilyId, caretakerId, startTime });

    return NextResponse.json<ApiResponse<ActiveBreastFeedResponse>>({
      success: true,
      data: formatActiveBreastFeed(session),
    });
  } catch (error) {
    if (error instanceof BreastfeedSessionConflict) return NextResponse.json({ success: false, code: 'BREASTFEED_CONFLICT', error: error.message }, { status: 409 });
    console.error('Error creating active breastfeed:', error);
    return NextResponse.json<ApiResponse<null>>({ success: false, error: 'Failed to create active breastfeed session' }, { status: 500 });
  }
}

async function handlePut(req: NextRequest, authContext: AuthResult) {
  const writeCheck = checkWritePermission(authContext);
  if (!writeCheck.allowed) return writeCheck.response!;

  try {
    const { familyId: userFamilyId } = authContext;
    if (!userFamilyId) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'User is not associated with a family.' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    const action = searchParams.get('action'); // switch, pause, resume, swap

    if (!id || !action) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'id and action are required' }, { status: 400 });
    }

    if (!SESSION_UPDATE_ACTIONS.includes(action as SessionUpdateAction)) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'Invalid action. Use switch, pause, resume, or swap.' }, { status: 400 });
    }

    const session = await prisma.activeBreastFeed.findFirst({
      where: { id, familyId: userFamilyId },
    });
    if (!session) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'Active breastfeed session not found' }, { status: 404 });
    }

    // resume optionally accepts a side to resume on
    const body = await optionalSessionBody(req);
    checkSessionScope(body.expectedScope, session.babyId, authContext);

    const updated = await updateBreastfeedSession(session, action as SessionUpdateAction, action === 'resume' ? body?.side : undefined, body?.expectedUpdatedAt);
    if (!updated) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'Invalid action. Use switch, pause, resume, or swap.' }, { status: 400 });
    }

    return NextResponse.json<ApiResponse<ActiveBreastFeedResponse>>({
      success: true,
      data: formatActiveBreastFeed(updated),
    });
  } catch (error) {
    if (error instanceof BreastfeedSessionConflict) return NextResponse.json({ success: false, code: 'BREASTFEED_CONFLICT', error: error.message }, { status: 409 });
    if (error instanceof BreastfeedSessionInputError) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    console.error('Error updating active breastfeed:', error);
    return NextResponse.json<ApiResponse<null>>({ success: false, error: 'Failed to update active breastfeed session' }, { status: 500 });
  }
}

async function handleDelete(req: NextRequest, authContext: AuthResult) {
  const writeCheck = checkWritePermission(authContext);
  if (!writeCheck.allowed) return writeCheck.response!;

  try {
    const { familyId: userFamilyId, caretakerId } = authContext;
    if (!userFamilyId) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'User is not associated with a family.' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'id is required' }, { status: 400 });
    }

    const session = await prisma.activeBreastFeed.findFirst({
      where: { id, familyId: userFamilyId },
    });
    if (!session) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'Active breastfeed session not found' }, { status: 404 });
    }

    // Check if caller wants to override durations (from form adjustments)
    const body = await optionalSessionBody(req);
    checkSessionScope(body.expectedScope, session.babyId, authContext);

    let undo: NurseryUndo | null = null;
    const { feedLogs } = await endBreastfeedSession(session, {
      familyId: userFamilyId,
      caretakerId,
      accountId: authContext.accountId,
      leftDuration: body.leftDuration,
      rightDuration: body.rightDuration,
      pauseDuration: body.pauseDuration,
      expectedUpdatedAt: body.expectedUpdatedAt,
      onCreated: (rows, sessionId) => { if (body.expectedScope !== undefined && rows.length) undo = makeNurseryUndo('breast', authContext, rows, { sessionId }); },
    });

    return NextResponse.json({
      success: true,
      data: { feedLogsCreated: feedLogs.length, feedLogIds: feedLogs.map(log => log.id) },
      ...(undo ? { undo } : {}),
    });
  } catch (error) {
    if (error instanceof BreastfeedSessionConflict) return NextResponse.json({ success: false, code: 'BREASTFEED_CONFLICT', error: error.message }, { status: 409 });
    if (error instanceof BreastfeedSessionInputError) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    console.error('Error ending active breastfeed:', error);
    return NextResponse.json<ApiResponse<null>>({ success: false, error: 'Failed to end active breastfeed session' }, { status: 500 });
  }
}

export const GET = withAuthContext(handleGet as any);
export const POST = withAuthContext(handlePost as any);
export const PUT = withAuthContext(handlePut as any);
export const DELETE = withAuthContext(handleDelete as any);
