import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import prisma from '../db';
import { ApiResponse, PumpLogCreate, PumpLogResponse, PumpLogUpdate } from '../types';
import { withAuthContext, AuthResult } from '../utils/auth';
import { toUTC, formatForResponse } from '../utils/timezone';
import { checkWritePermission } from '../utils/writeProtection';
import { notifyActivityCreated } from '@/src/lib/notifications/activityHook';
import {
  autoPumpFeedNotes,
  shouldHaveAutoPumpFeed,
} from '@/src/utils/breastMilkInventory';
import { normalizeVolumeUnit } from '@/src/utils/unit-conversion';
import { isPumpAction } from '@/src/utils/pumpAction';
import { preparePumpFields } from './fields';
import { createPumpOnce, pumpRequestIdentity, PumpRequestError } from './request';
import { checkPumpRevision } from '@/src/utils/pumpRevision';
import { deletePumpWithFeed, PumpReconciliationConflict, updatePumpWithFeed } from '../utils/pumpReconciliation';
import { makeNurseryUndo, readNurseryUndoRequest, NurseryUndoError } from '../utils/nursery-undo';
import { undoNurseryRows } from '../utils/nursery-undo-mutations';
import type { NurseryUndo } from '@/src/utils/nursery/undo';

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

    const body: PumpLogCreate & { requestId?: unknown; expectedScope?: unknown } = await req.json().catch(() => null);
    const prepared = preparePumpFields(body);
    if ('error' in prepared) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: prepared.error }, { status: 400 });
    }

    const baby = await prisma.baby.findFirst({
      where: { id: body.babyId, familyId: userFamilyId, deletedAt: null },
    });

    if (!baby) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'Baby not found in this family.' }, { status: 404 });
    }
    
    const { startTime: startTimeUTC, totalAmount } = prepared;
    
    // Validate pumpAction
    const pumpAction = body.pumpAction === undefined ? 'STORED' : body.pumpAction;
    if (!isPumpAction(pumpAction)) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'Invalid pump action. Must be STORED, FED, DISCARDED, or UNKNOWN.' }, { status: 400 });
    }

    // Validate/normalize the volume unit — an unknown unit silently corrupts
    // breast-milk balances (convertVolume no-ops on units it can't convert).
    let unitAbbr = body.unitAbbr;
    if (unitAbbr !== undefined) {
      const normalizedUnit = normalizeVolumeUnit(unitAbbr);
      if (!normalizedUnit) {
        return NextResponse.json<ApiResponse<null>>({ success: false, error: 'Invalid unit. Supported units are OZ and ML.' }, { status: 400 });
      }
      unitAbbr = normalizedUnit;
    }

    const familySettings = await prisma.settings.findFirst({
      where: { familyId: userFamilyId },
      select: { enableBreastMilkTracking: true },
    });
    const trackingEnabled = familySettings?.enableBreastMilkTracking !== false;

    const identity = pumpRequestIdentity(body, authContext);
    const createData: Prisma.PumpLogUncheckedCreateInput = {
      ...prepared.data,
      ...(identity ? { id: identity.pumpId } : {}),
      babyId: body.babyId,
      startTime: startTimeUTC,
      unitAbbr,
      pumpAction,
      notes: body.notes,
      caretakerId,
      familyId: userFamilyId,
    };
    let undo: NurseryUndo | null = null;
    const { pumpLog, created } = await createPumpOnce(prisma, identity, createData, trackingEnabled, async (tx) => {
      const createdPumpLog = await tx.pumpLog.create({
        data: createData,
      });

      // Keep the feeding record for reports, but link it to the pump so it can
      // be synchronized and excluded from stored-inventory consumption.
      let feed = null;
      if (shouldHaveAutoPumpFeed({ trackingEnabled, pumpAction, totalAmount })) {
        feed = await tx.feedLog.create({
          data: {
            time: startTimeUTC,
            type: 'BOTTLE',
            amount: totalAmount,
            unitAbbr: unitAbbr || 'OZ',
            bottleType: 'Breast Milk',
            notes: autoPumpFeedNotes(body.notes),
            sourcePumpId: createdPumpLog.id,
            babyId: body.babyId,
            caretakerId: caretakerId,
            familyId: userFamilyId,
          },
        });
      }

      if (identity) undo = makeNurseryUndo('pump', authContext, [createdPumpLog], { feed });
      return createdPumpLog;
    });

    // Format dates as ISO strings for response
    const response: PumpLogResponse = {
      ...pumpLog,
      startTime: formatForResponse(pumpLog.startTime) || '',
      endTime: formatForResponse(pumpLog.endTime) || null,
      createdAt: formatForResponse(pumpLog.createdAt) || '',
      updatedAt: formatForResponse(pumpLog.updatedAt) || '',
      deletedAt: formatForResponse(pumpLog.deletedAt),
    };

    // Notify subscribers about activity creation (non-blocking)
    if (created) notifyActivityCreated(pumpLog.babyId, 'pump', { accountId: authContext.accountId, caretakerId: authContext.caretakerId }, { totalAmount, unitAbbr }).catch(console.error);

    return NextResponse.json({
      success: true,
      data: response,
      ...(identity ? { requestId: identity.requestId } : {}),
      ...(created && undo ? { undo } : {}),
    });
  } catch (error) {
    if (error instanceof PumpRequestError) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: error.message }, { status: error.status });
    }
    console.error('Error creating pump log:', error);
    return NextResponse.json<ApiResponse<PumpLogResponse>>(
      {
        success: false,
        error: 'Failed to create pump log',
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
    const body: PumpLogUpdate = await req.json().catch(() => null);

    if (!id) {
      return NextResponse.json<ApiResponse<PumpLogResponse>>(
        {
          success: false,
          error: 'Pump log ID is required',
        },
        { status: 400 }
      );
    }

    const existingPumpLog = await prisma.pumpLog.findFirst({
      where: { id, familyId: userFamilyId },
    });

    if (!existingPumpLog) {
      return NextResponse.json<ApiResponse<PumpLogResponse>>(
        {
          success: false,
          error: 'Pump log not found or access denied',
        },
        { status: 404 }
      );
    }
    // A client may have opened its form before a different caregiver's edit
    // completed. Check that original revision separately from the atomic
    // server snapshot claim below, after family-scoped resource lookup.
    const revisionError = checkPumpRevision(body?.expectedUpdatedAt, existingPumpLog.updatedAt);
    if (revisionError) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: revisionError.error }, { status: revisionError.status });
    }
    const prepared = preparePumpFields(body, existingPumpLog);
    if ('error' in prepared) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: prepared.error }, { status: 400 });
    }

    // If the caller is reassigning the pump to a baby, that baby must belong to
    // their family — never trust a client-sent babyId across families.
    if (body.babyId !== undefined && body.babyId !== existingPumpLog.babyId) {
      const targetBaby = await prisma.baby.findFirst({
        where: { id: body.babyId, familyId: userFamilyId, deletedAt: null },
      });
      if (!targetBaby) {
        return NextResponse.json<ApiResponse<null>>({ success: false, error: 'Baby not found in this family.' }, { status: 404 });
      }
    }

    // Validate/normalize the volume unit before it reaches the balance math.
    if (body.unitAbbr !== undefined) {
      const normalizedUnit = normalizeVolumeUnit(body.unitAbbr);
      if (!normalizedUnit) {
        return NextResponse.json<ApiResponse<null>>({ success: false, error: 'Invalid unit. Supported units are OZ and ML.' }, { status: 400 });
      }
      body.unitAbbr = normalizedUnit;
    }

    const data: Prisma.PumpLogUncheckedUpdateManyInput = { ...prepared.data };
    
    // Add other fields
    if (body.unitAbbr !== undefined) data.unitAbbr = body.unitAbbr;
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.babyId !== undefined) data.babyId = body.babyId;
    if (body.pumpAction !== undefined) {
      if (!isPumpAction(body.pumpAction)) {
        return NextResponse.json<ApiResponse<null>>({ success: false, error: 'Invalid pump action. Must be STORED, FED, DISCARDED, or UNKNOWN.' }, { status: 400 });
      }
      data.pumpAction = body.pumpAction;
    }

    const pumpLog = await updatePumpWithFeed(prisma, existingPumpLog, data);

    // Format dates as ISO strings for response
    const response: PumpLogResponse = {
      ...pumpLog,
      startTime: formatForResponse(pumpLog.startTime) || '',
      endTime: formatForResponse(pumpLog.endTime) || null,
      createdAt: formatForResponse(pumpLog.createdAt) || '',
      updatedAt: formatForResponse(pumpLog.updatedAt) || '',
      deletedAt: formatForResponse(pumpLog.deletedAt),
    };

    return NextResponse.json<ApiResponse<PumpLogResponse>>({
      success: true,
      data: response,
    });
  } catch (error) {
    if (error instanceof PumpReconciliationConflict) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: 409 });
    }
    console.error('Error updating pump log:', error);
    return NextResponse.json<ApiResponse<PumpLogResponse>>(
      {
        success: false,
        error: 'Failed to update pump log',
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
    
    const queryParams: any = {
      familyId: userFamilyId,
      ...(babyId && { babyId }),
    };
    
    // Add date range filter if both start and end dates are provided
    if (startDate && endDate) {
      queryParams.startTime = {
        gte: toUTC(startDate),
        lte: toUTC(endDate),
      };
    }

    // If ID is provided, fetch a single pump log
    if (id) {
      const pumpLog = await prisma.pumpLog.findFirst({
        where: { 
          id,
          familyId: userFamilyId,
        },
      });

      if (!pumpLog) {
        return NextResponse.json<ApiResponse<PumpLogResponse>>(
          {
            success: false,
            error: 'Pump log not found or access denied',
          },
          { status: 404 }
        );
      }

      // Format dates as ISO strings for response
      const response: PumpLogResponse = {
        ...pumpLog,
        startTime: formatForResponse(pumpLog.startTime) || '',
        endTime: formatForResponse(pumpLog.endTime) || null,
        createdAt: formatForResponse(pumpLog.createdAt) || '',
        updatedAt: formatForResponse(pumpLog.updatedAt) || '',
        deletedAt: formatForResponse(pumpLog.deletedAt),
      };

      return NextResponse.json<ApiResponse<PumpLogResponse>>({
        success: true,
        data: response,
      });
    }

    // Otherwise, fetch multiple pump logs based on query parameters
    const pumpLogs = await prisma.pumpLog.findMany({
      where: queryParams,
      orderBy: {
        startTime: 'desc',
      },
    });

    // Format dates as ISO strings for response
    const response: PumpLogResponse[] = pumpLogs.map(pumpLog => ({
      ...pumpLog,
      startTime: formatForResponse(pumpLog.startTime) || '',
      endTime: formatForResponse(pumpLog.endTime) || null,
      createdAt: formatForResponse(pumpLog.createdAt) || '',
      updatedAt: formatForResponse(pumpLog.updatedAt) || '',
      deletedAt: formatForResponse(pumpLog.deletedAt),
    }));

    return NextResponse.json<ApiResponse<PumpLogResponse[]>>({
      success: true,
      data: response,
    });
  } catch (error) {
    console.error('Error fetching pump logs:', error);
    return NextResponse.json<ApiResponse<PumpLogResponse[]>>(
      {
        success: false,
        error: 'Failed to fetch pump logs',
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
          error: 'Pump log ID is required',
        },
        { status: 400 }
      );
    }

    const undo = await readNurseryUndoRequest(req, 'pump', id);
    if (undo) {
      await undoNurseryRows(prisma, authContext, undo);
      return NextResponse.json({ success: true });
    }

    const existingPumpLog = await prisma.pumpLog.findFirst({
      where: { id, familyId: userFamilyId },
    });

    if (!existingPumpLog) {
      return NextResponse.json<ApiResponse<void>>(
        {
          success: false,
          error: 'Pump log not found or access denied',
        },
        { status: 404 }
      );
    }

    await deletePumpWithFeed(prisma, existingPumpLog);

    return NextResponse.json<ApiResponse<void>>({
      success: true,
    });
  } catch (error) {
    if (error instanceof NurseryUndoError) return error.response();
    if (error instanceof PumpReconciliationConflict) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: 409 });
    }
    console.error('Error deleting pump log:', error);
    return NextResponse.json<ApiResponse<void>>(
      {
        success: false,
        error: 'Failed to delete pump log',
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
