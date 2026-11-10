import { NextRequest, NextResponse } from 'next/server';
import prisma from '../db';
import { ApiResponse, DiaperLogCreate, DiaperLogResponse } from '../types';
import { withAuthContext, AuthResult } from '../utils/auth';
import { toUTC, formatForResponse } from '../utils/timezone';
import { checkWritePermission } from '../utils/writeProtection';
import { careFields, readCareWrite, CareWriteError } from '../utils/care-write';
import { notifyActivityCreated, resetTimerNotificationState } from '@/src/lib/notifications/activityHook';
import { makeNurseryUndo, readNurseryCreateScope, readNurseryUndoRequest, NurseryUndoError } from '../utils/nursery-undo';
import { undoNurseryRows } from '../utils/nursery-undo-mutations';
import { createNurseryQuickCare, readQuickCareRequest } from '../utils/nursery-quick-care';

async function handlePost(req: NextRequest, authContext: AuthResult) {
  // Check write permissions for expired accounts
  const writeCheck = checkWritePermission(authContext);
  if (!writeCheck.allowed) {
    return writeCheck.response!;
  }

  try {
    const { familyId: userFamilyId, caretakerId } = authContext;
    if (!userFamilyId) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'User is not associated with a family.' }, { status: 403 });
    }

    const raw = await req.json().catch(() => null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CareWriteError();
    const quickRequest = readQuickCareRequest(raw, 'diaper', authContext);
    const nurseryScope = readNurseryCreateScope(raw, authContext, raw.babyId);
    const body = await readCareWrite<DiaperLogCreate>({ json: async () => raw }, careFields.diaper, ['babyId', 'time', 'type']);

    const baby = await prisma.baby.findFirst({
      where: { id: body.babyId, familyId: userFamilyId, deletedAt: null },
    });

    if (!baby) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'Baby not found in this family.' }, { status: 404 });
    }
    
    const timeUTC = toUTC(body.time);
    
    const saved = quickRequest ? await createNurseryQuickCare(prisma, authContext, quickRequest) : null;
    const diaperLog = saved?.row ?? await prisma.diaperLog.create({
      data: {
        ...body,
        time: timeUTC,
        caretakerId: caretakerId,
        familyId: userFamilyId,
      },
    });

    // Format dates as ISO strings for response
    const response: DiaperLogResponse = {
      ...diaperLog,
      time: formatForResponse(diaperLog.time) || '',
      createdAt: formatForResponse(diaperLog.createdAt) || '',
      updatedAt: formatForResponse(diaperLog.updatedAt) || '',
      deletedAt: formatForResponse(diaperLog.deletedAt),
    };

    // Notify subscribers about activity creation (non-blocking)
    if (saved?.created !== false) {
      notifyActivityCreated(diaperLog.babyId, 'diaper', { accountId: authContext.accountId, caretakerId: authContext.caretakerId }, { type: body.type }).catch(console.error);
      resetTimerNotificationState(diaperLog.babyId, 'diaper').catch(console.error);
    }

    return NextResponse.json({
      success: true,
      data: response,
      ...(saved ? { undo: saved.undo, replayed: !saved.created }
        : nurseryScope ? { undo: makeNurseryUndo('diaper', authContext, [diaperLog]) } : {}),
    });
  } catch (error) {
    if (error instanceof NurseryUndoError) return error.response();
    if (error instanceof CareWriteError) return error.response();
    console.error('Error creating diaper log:', error);
    return NextResponse.json<ApiResponse<DiaperLogResponse>>(
      {
        success: false,
        error: 'Failed to create diaper log',
      },
      { status: 500 }
    );
  }
}

async function handlePut(req: NextRequest, authContext: AuthResult) {
  // Check write permissions for expired accounts
  const writeCheck = checkWritePermission(authContext);
  if (!writeCheck.allowed) {
    return writeCheck.response!;
  }

  try {
    const { familyId: userFamilyId } = authContext;
    if (!userFamilyId) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'User is not associated with a family.' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    const body = await readCareWrite<Partial<DiaperLogCreate>>(req, careFields.diaper);

    if (!id) {
      return NextResponse.json<ApiResponse<DiaperLogResponse>>(
        {
          success: false,
          error: 'Diaper log ID is required',
        },
        { status: 400 }
      );
    }

    const existingDiaperLog = await prisma.diaperLog.findFirst({
      where: { id, familyId: userFamilyId },
    });

    if (!existingDiaperLog) {
      return NextResponse.json<ApiResponse<DiaperLogResponse>>(
        {
          success: false,
          error: 'Diaper log not found or access denied',
        },
        { status: 404 }
      );
    }

    // Convert time to UTC if provided and strip relation fields
    const data: any = { ...body };
    if (body.time) {
      data.time = toUTC(body.time);
    }
    delete data.babyId;

    const diaperLog = await prisma.diaperLog.update({
      where: { id, familyId: userFamilyId },
      data,
    });

    // Format dates as ISO strings for response
    const response: DiaperLogResponse = {
      ...diaperLog,
      time: formatForResponse(diaperLog.time) || '',
      createdAt: formatForResponse(diaperLog.createdAt) || '',
      updatedAt: formatForResponse(diaperLog.updatedAt) || '',
      deletedAt: formatForResponse(diaperLog.deletedAt),
    };

    return NextResponse.json<ApiResponse<DiaperLogResponse>>({
      success: true,
      data: response,
    });
  } catch (error) {
    if (error instanceof CareWriteError) return error.response();
    console.error('Error updating diaper log:', error);
    return NextResponse.json<ApiResponse<DiaperLogResponse>>(
      {
        success: false,
        error: 'Failed to update diaper log',
      },
      { status: 500 }
    );
  }
}

async function handleGet(req: NextRequest, authContext: AuthResult) {
  try {
    const { familyId: userFamilyId } = authContext;
    if (!userFamilyId) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'User is not associated with a family.' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    const babyId = searchParams.get('babyId');
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');

    if (id) {
      const diaperLog = await prisma.diaperLog.findFirst({
        where: { id, familyId: userFamilyId },
      });

      if (!diaperLog) {
        return NextResponse.json<ApiResponse<DiaperLogResponse>>(
          {
            success: false,
            error: 'Diaper log not found or access denied',
          },
          { status: 404 }
        );
      }

      // Format dates as ISO strings for response
      const response: DiaperLogResponse = {
        ...diaperLog,
        time: formatForResponse(diaperLog.time) || '',
        createdAt: formatForResponse(diaperLog.createdAt) || '',
        updatedAt: formatForResponse(diaperLog.updatedAt) || '',
        deletedAt: formatForResponse(diaperLog.deletedAt),
      };

      return NextResponse.json<ApiResponse<DiaperLogResponse>>({
        success: true,
        data: response,
      });
    }

    const diaperLogs = await prisma.diaperLog.findMany({
      where: {
        familyId: userFamilyId,
        ...(babyId && { babyId }),
        ...(startDate && endDate && {
          time: {
            gte: toUTC(startDate),
            lte: toUTC(endDate),
          },
        }),
      },
      orderBy: {
        time: 'desc',
      },
    });

    // Format dates as ISO strings for response
    const response: DiaperLogResponse[] = diaperLogs.map(diaperLog => ({
      ...diaperLog,
      time: formatForResponse(diaperLog.time) || '',
      createdAt: formatForResponse(diaperLog.createdAt) || '',
      updatedAt: formatForResponse(diaperLog.updatedAt) || '',
      deletedAt: formatForResponse(diaperLog.deletedAt),
    }));

    return NextResponse.json<ApiResponse<DiaperLogResponse[]>>({
      success: true,
      data: response,
    });
  } catch (error) {
    console.error('Error fetching diaper logs:', error);
    return NextResponse.json<ApiResponse<DiaperLogResponse[]>>(
      {
        success: false,
        error: 'Failed to fetch diaper logs',
      },
      { status: 500 }
    );
  }
}

async function handleDelete(req: NextRequest, authContext: AuthResult) {
  // Check write permissions for expired accounts
  const writeCheck = checkWritePermission(authContext);
  if (!writeCheck.allowed) {
    return writeCheck.response!;
  }

  try {
    const { familyId: userFamilyId } = authContext;
    if (!userFamilyId) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'User is not associated with a family.' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json<ApiResponse<void>>(
        {
          success: false,
          error: 'Diaper log ID is required',
        },
        { status: 400 }
      );
    }

    const undo = await readNurseryUndoRequest(req, 'diaper', id);
    if (undo) {
      await undoNurseryRows(prisma, authContext, undo);
      return NextResponse.json({ success: true });
    }

    const existingDiaperLog = await prisma.diaperLog.findFirst({
      where: { id, familyId: userFamilyId },
    });

    if (!existingDiaperLog) {
      return NextResponse.json<ApiResponse<void>>(
        {
          success: false,
          error: 'Diaper log not found or access denied',
        },
        { status: 404 }
      );
    }

    await prisma.diaperLog.delete({
      where: { id },
    });

    return NextResponse.json<ApiResponse<void>>({
      success: true,
    });
  } catch (error) {
    if (error instanceof NurseryUndoError) return error.response();
    console.error('Error deleting diaper log:', error);
    return NextResponse.json<ApiResponse<void>>(
      {
        success: false,
        error: 'Failed to delete diaper log',
      },
      { status: 500 }
    );
  }
}

// Apply authentication middleware to all handlers
// Use type assertions to handle the multiple return types
export const GET = withAuthContext(handleGet as (req: NextRequest, authContext: AuthResult) => Promise<NextResponse<ApiResponse<any>>>);
export const POST = withAuthContext(handlePost as (req: NextRequest, authContext: AuthResult) => Promise<NextResponse<ApiResponse<any>>>);
export const PUT = withAuthContext(handlePut as (req: NextRequest, authContext: AuthResult) => Promise<NextResponse<ApiResponse<any>>>);
export const DELETE = withAuthContext(handleDelete as (req: NextRequest, authContext: AuthResult) => Promise<NextResponse<ApiResponse<any>>>);
