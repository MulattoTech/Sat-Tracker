import { NextRequest, NextResponse } from 'next/server';
import prisma from '../db';
import { ApiResponse, MedicineLogCreate, MedicineLogResponse } from '../types';
import { withAuthContext, AuthResult } from '../utils/auth';
import { toUTC, formatForResponse } from '../utils/timezone';
import { checkWritePermission } from '../utils/writeProtection';
import { careFields, careIdentifier, readCareWrite, CareWriteError } from '../utils/care-write';
import { createMedicineDose, type MedicineDoseCreate } from './request';
import { notifyActivityCreated, resetTimerNotificationState } from '@/src/lib/notifications/activityHook';

// Keep the owned dose visible when a legacy relationship needs review, without
// returning another family's related records or any caregiver login PIN.
function scopeMedicineLogRelations<T extends {
  medicine: { familyId: string | null };
  baby: { familyId: string | null };
  caretaker: { familyId: string | null; securityPin: string } | null;
}>(log: T, familyId: string) {
  let caretaker;
  if (log.caretaker?.familyId === familyId) {
    const { securityPin: _securityPin, ...publicCaretaker } = log.caretaker;
    caretaker = publicCaretaker;
  }
  return {
    ...log,
    medicine: log.medicine.familyId === familyId ? log.medicine : undefined,
    baby: log.baby.familyId === familyId ? log.baby : undefined,
    caretaker,
  };
}

/**
 * Handle POST request to create a new medicine log entry
 */
async function handlePost(req: NextRequest, authContext: AuthResult) {
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

    const body = await readCareWrite<MedicineDoseCreate>(req, {
      ...careFields.medicineLog, requestId: careIdentifier, expectedScope: careIdentifier,
    }, ['babyId', 'medicineId', 'time', 'doseAmount']);
    const { medicineLog, medicine, created } = await createMedicineDose(prisma, authContext, body);

    // Format dates for response
    const response: MedicineLogResponse = {
      ...medicineLog,
      time: formatForResponse(medicineLog.time) || '',
      createdAt: formatForResponse(medicineLog.createdAt) || '',
      updatedAt: formatForResponse(medicineLog.updatedAt) || '',
      deletedAt: formatForResponse(medicineLog.deletedAt),
    };

    // Notify subscribers about activity creation (non-blocking)
    const activityType = medicine?.isSupplement ? 'supplement' : 'medicine';
    if (created) {
      notifyActivityCreated(medicineLog.babyId, activityType, { accountId: authContext.accountId, caretakerId: authContext.caretakerId }, { medicineId: body.medicineId, medicineName: medicine?.name }).catch(console.error);
      resetTimerNotificationState(medicineLog.babyId, 'medicine').catch(console.error);
    }

    return NextResponse.json({
      success: true,
      data: response,
      ...(body.requestId ? { requestId: body.requestId } : {}),
    });
  } catch (error) {
    if (error instanceof CareWriteError) return error.response();
    console.error('Error creating medicine log:', error);
    return NextResponse.json<ApiResponse<MedicineLogResponse>>(
      {
        success: false,
        error: 'Failed to create medicine log',
      },
      { status: 500 }
    );
  }
}

/**
 * Handle PUT request to update a medicine log entry
 */
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
    const body = await readCareWrite<Partial<MedicineLogCreate>>(req, careFields.medicineLog);

    if (!id) {
      return NextResponse.json<ApiResponse<MedicineLogResponse>>(
        {
          success: false,
          error: 'Medicine log ID is required',
        },
        { status: 400 }
      );
    }

    const existingLog = await prisma.medicineLog.findFirst({
      where: { id, familyId: userFamilyId },
    });

    if (!existingLog) {
      return NextResponse.json<ApiResponse<MedicineLogResponse>>(
        {
          success: false,
          error: 'Medicine log not found or access denied',
        },
        { status: 404 }
      );
    }

    const data: any = { ...body };
    if (body.time) {
      data.time = toUTC(body.time);
    }
    delete data.babyId;
    delete data.medicineId;

    const medicineLog = await prisma.medicineLog.update({
      where: { id, familyId: userFamilyId },
      data,
    });

    // Format dates for response
    const response: MedicineLogResponse = {
      ...medicineLog,
      time: formatForResponse(medicineLog.time) || '',
      createdAt: formatForResponse(medicineLog.createdAt) || '',
      updatedAt: formatForResponse(medicineLog.updatedAt) || '',
      deletedAt: formatForResponse(medicineLog.deletedAt),
    };

    return NextResponse.json<ApiResponse<MedicineLogResponse>>({
      success: true,
      data: response,
    });
  } catch (error) {
    if (error instanceof CareWriteError) return error.response();
    console.error('Error updating medicine log:', error);
    return NextResponse.json<ApiResponse<MedicineLogResponse>>(
      {
        success: false,
        error: 'Failed to update medicine log',
      },
      { status: 500 }
    );
  }
}

/**
 * Handle GET request to fetch medicine logs
 */
async function handleGet(req: NextRequest, authContext: AuthResult) {
  try {
    const { familyId: userFamilyId } = authContext;
    if (!userFamilyId) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'User is not associated with a family.' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    const babyId = searchParams.get('babyId');
    const medicineId = searchParams.get('medicineId');
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    const limit = searchParams.get('limit') ? parseInt(searchParams.get('limit') || '10', 10) : undefined;
    
    // Build where clause
    const where: any = {
      familyId: userFamilyId,
      ...(babyId && { babyId }),
      ...(medicineId && { medicineId }),
      ...(startDate && endDate && {
        time: {
          gte: toUTC(startDate),
          lte: toUTC(endDate),
        },
      }),
    };

    // If ID is provided, fetch a single log
    if (id) {
      const medicineLog = await prisma.medicineLog.findFirst({
        where: { 
          id,
          ...where,
        },
        include: {
          medicine: {
            include: {
              contacts: {
                where: { contact: { familyId: userFamilyId } },
                include: {
                  contact: true
                }
              }
            }
          },
          baby: true,
          caretaker: true,
          unit: true,
        },
      });

      if (!medicineLog) {
        return NextResponse.json<ApiResponse<MedicineLogResponse>>(
          {
            success: false,
            error: 'Medicine log not found or access denied',
          },
          { status: 404 }
        );
      }

      // Format dates for response
      const response: MedicineLogResponse = {
        ...scopeMedicineLogRelations(medicineLog, userFamilyId),
        time: formatForResponse(medicineLog.time) || '',
        createdAt: formatForResponse(medicineLog.createdAt) || '',
        updatedAt: formatForResponse(medicineLog.updatedAt) || '',
        deletedAt: formatForResponse(medicineLog.deletedAt),
      };

      return NextResponse.json<ApiResponse<MedicineLogResponse>>({
        success: true,
        data: response,
      });
    }

    // Otherwise, fetch logs based on filters
    const medicineLogs = await prisma.medicineLog.findMany({
      where,
      include: {
        medicine: {
          include: {
            contacts: {
              where: { contact: { familyId: userFamilyId } },
              include: {
                contact: true
              }
            }
          }
        },
        baby: true,
        caretaker: true,
        unit: true,
      },
      orderBy: { time: 'desc' },
      take: limit,
    });

    // Format dates for response
    const response = medicineLogs.map(log => ({
      ...scopeMedicineLogRelations(log, userFamilyId),
      time: formatForResponse(log.time) || '',
      createdAt: formatForResponse(log.createdAt) || '',
      updatedAt: formatForResponse(log.updatedAt) || '',
      deletedAt: formatForResponse(log.deletedAt),
    }));

    return NextResponse.json<ApiResponse<MedicineLogResponse[]>>({
      success: true,
      data: response,
    });
  } catch (error) {
    console.error('Error fetching medicine logs:', error);
    return NextResponse.json<ApiResponse<MedicineLogResponse[]>>(
      {
        success: false,
        error: 'Failed to fetch medicine logs',
      },
      { status: 500 }
    );
  }
}

/**
 * Handle DELETE request to hard delete a medicine log
 */
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
          error: 'Medicine log ID is required',
        },
        { status: 400 }
      );
    }

    const existingLog = await prisma.medicineLog.findFirst({
      where: { id, familyId: userFamilyId },
    });

    if (!existingLog) {
      return NextResponse.json<ApiResponse<void>>(
        {
          success: false,
          error: 'Medicine log not found or access denied',
        },
        { status: 404 }
      );
    }

    await prisma.medicineLog.delete({
      where: { id },
    });

    return NextResponse.json<ApiResponse>({
      success: true,
    });
  } catch (error) {
    console.error('Error deleting medicine log:', error);
    return NextResponse.json<ApiResponse>(
      {
        success: false,
        error: 'Failed to delete medicine log',
      },
      { status: 500 }
    );
  }
}

// Apply authentication middleware to all handlers
export const GET = withAuthContext(handleGet as any);
export const POST = withAuthContext(handlePost as any);
export const PUT = withAuthContext(handlePut as any);
export const DELETE = withAuthContext(handleDelete as any);
