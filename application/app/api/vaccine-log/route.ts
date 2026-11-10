import { NextRequest, NextResponse } from 'next/server';
import prisma from '../db';
import { ApiResponse, VaccineLogCreate, VaccineLogResponse } from '../types';
import { withAuthContext, AuthResult } from '../utils/auth';
import { toUTC, formatForResponse } from '../utils/timezone';
import { checkWritePermission } from '../utils/writeProtection';
import { careFields, CareWriteError, readCareWrite, requireCareBaby, requireCareContacts } from '../utils/care-write';
import { notifyActivityCreated } from '@/src/lib/notifications/activityHook';
import { deleteEncryptedFile } from '@/src/lib/file-encryption';

/**
 * Format a vaccine log (with includes) into a VaccineLogResponse
 */
function formatVaccineLog(log: any): VaccineLogResponse {
  return {
    ...log,
    time: formatForResponse(log.time) || '',
    createdAt: formatForResponse(log.createdAt) || '',
    updatedAt: formatForResponse(log.updatedAt) || '',
    deletedAt: formatForResponse(log.deletedAt),
    ...(log.documents && {
      documents: log.documents.map((doc: any) => ({
        id: doc.id,
        originalName: doc.originalName,
        mimeType: doc.mimeType,
        fileSize: doc.fileSize,
        createdAt: formatForResponse(doc.createdAt) || '',
        updatedAt: formatForResponse(doc.updatedAt) || '',
      })),
    }),
    ...(log.contacts && {
      contacts: log.contacts.map((c: any) => ({
        contact: { id: c.contact.id, name: c.contact.name, role: c.contact.role },
      })),
    }),
  };
}

/**
 * Handle POST request to create a new vaccine log entry
 */
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

    const body = await readCareWrite<VaccineLogCreate>(req, careFields.vaccine, ['babyId', 'time', 'vaccineName']);

    const timeUTC = toUTC(body.time);
    const { contactIds, ...vaccineData } = body;

    const vaccineLog = await prisma.$transaction(async tx => {
      await requireCareBaby(tx, body.babyId, userFamilyId);
      await requireCareContacts(tx, contactIds, userFamilyId);
      const created = await tx.vaccineLog.create({
        data: { ...vaccineData, time: timeUTC, caretakerId, familyId: userFamilyId },
      });
      if (contactIds?.length) {
        await tx.contactVaccine.createMany({
          data: contactIds.map(contactId => ({ contactId, vaccineLogId: created.id })),
        });
      }
      return tx.vaccineLog.findUniqueOrThrow({
        where: { id: created.id },
        include: {
          documents: true,
          contacts: { where: { contact: { familyId: userFamilyId } }, include: { contact: true } },
        },
      });
    });

    const response = formatVaccineLog(vaccineLog);

    // Notify subscribers about activity creation (non-blocking)
    notifyActivityCreated(vaccineLog.babyId, 'vaccine', { accountId: authContext.accountId, caretakerId: authContext.caretakerId }, { vaccineName: body.vaccineName }).catch(console.error);

    return NextResponse.json<ApiResponse<VaccineLogResponse>>({
      success: true,
      data: response,
    });
  } catch (error) {
    if (error instanceof CareWriteError) return error.response();
    console.error('Error creating vaccine log:', error);
    return NextResponse.json<ApiResponse<VaccineLogResponse>>(
      {
        success: false,
        error: 'Failed to create vaccine log',
      },
      { status: 500 }
    );
  }
}

/**
 * Handle PUT request to update a vaccine log entry
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
    const body = await readCareWrite<Partial<VaccineLogCreate>>(req, careFields.vaccine);

    if (!id) {
      return NextResponse.json<ApiResponse<VaccineLogResponse>>(
        {
          success: false,
          error: 'Vaccine log ID is required',
        },
        { status: 400 }
      );
    }

    // Existing forms echo the child; this endpoint has never reassigned it.
    // readCareWrite validates its scalar shape before it is discarded here.
    const { contactIds, babyId: _ignoredBabyId, ...updateData } = body;
    const vaccineLog = await prisma.$transaction(async tx => {
      const existingLog = await tx.vaccineLog.findFirst({
        where: { id, familyId: userFamilyId },
        include: { contacts: { select: { contactId: true } } },
      });
      if (!existingLog) throw new CareWriteError('Vaccine log not found or access denied', 404);
      await requireCareContacts(tx, contactIds, userFamilyId, existingLog.contacts.map(link => link.contactId));

      await tx.vaccineLog.update({
        where: { id, familyId: userFamilyId },
        data: { ...updateData, ...(body.time !== undefined && { time: toUTC(body.time) }) },
      });
      if (contactIds !== undefined) {
        await tx.contactVaccine.deleteMany({ where: { vaccineLogId: id } });
        if (contactIds.length) {
          await tx.contactVaccine.createMany({ data: contactIds.map(contactId => ({ contactId, vaccineLogId: id })) });
        }
      }
      return tx.vaccineLog.findUniqueOrThrow({
        where: { id },
        include: {
          documents: true,
          contacts: { where: { contact: { familyId: userFamilyId } }, include: { contact: true } },
        },
      });
    });

    const response = formatVaccineLog(vaccineLog);

    return NextResponse.json<ApiResponse<VaccineLogResponse>>({
      success: true,
      data: response,
    });
  } catch (error) {
    if (error instanceof CareWriteError) return error.response();
    console.error('Error updating vaccine log:', error);
    return NextResponse.json<ApiResponse<VaccineLogResponse>>(
      {
        success: false,
        error: 'Failed to update vaccine log',
      },
      { status: 500 }
    );
  }
}

/**
 * Handle GET request to fetch vaccine logs
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
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    const vaccines = searchParams.get('vaccines');

    // If vaccines flag is present, return unique vaccine names
    if (vaccines === 'true') {
      const vaccineLogs = await prisma.vaccineLog.findMany({
        where: {
          familyId: userFamilyId,
          vaccineName: {
            not: '',
          },
        },
        distinct: ['vaccineName'],
        select: {
          vaccineName: true,
        },
      });

      const uniqueVaccines = vaccineLogs.map(log => log.vaccineName);

      return NextResponse.json<ApiResponse<string[]>>({
        success: true,
        data: uniqueVaccines,
      });
    }

    // Build where clause
    const where: any = {
      familyId: userFamilyId,
      ...(babyId && { babyId }),
      ...(startDate && endDate && {
        time: {
          gte: toUTC(startDate),
          lte: toUTC(endDate),
        },
      }),
    };

    // If ID is provided, fetch a single log
    if (id) {
      const vaccineLog = await prisma.vaccineLog.findFirst({
        where: {
          id,
          ...where,
        },
        include: {
          documents: true,
          contacts: {
            where: { contact: { familyId: userFamilyId } },
            include: {
              contact: true,
            },
          },
        },
      });

      if (!vaccineLog) {
        return NextResponse.json<ApiResponse<VaccineLogResponse>>(
          {
            success: false,
            error: 'Vaccine log not found or access denied',
          },
          { status: 404 }
        );
      }

      const response = formatVaccineLog(vaccineLog);

      return NextResponse.json<ApiResponse<VaccineLogResponse>>({
        success: true,
        data: response,
      });
    }

    // Otherwise, fetch logs based on filters
    const vaccineLogs = await prisma.vaccineLog.findMany({
      where,
      include: {
        documents: true,
        contacts: {
          where: { contact: { familyId: userFamilyId } },
          include: {
            contact: true,
          },
        },
      },
      orderBy: { time: 'desc' },
    });

    const response = vaccineLogs.map(formatVaccineLog);

    return NextResponse.json<ApiResponse<VaccineLogResponse[]>>({
      success: true,
      data: response,
    });
  } catch (error) {
    console.error('Error fetching vaccine logs:', error);
    return NextResponse.json<ApiResponse<VaccineLogResponse[]>>(
      {
        success: false,
        error: 'Failed to fetch vaccine logs',
      },
      { status: 500 }
    );
  }
}

/**
 * Handle DELETE request to hard delete a vaccine log
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
          error: 'Vaccine log ID is required',
        },
        { status: 400 }
      );
    }

    const existingLog = await prisma.vaccineLog.findFirst({
      where: { id, familyId: userFamilyId },
      include: { documents: true },
    });

    if (!existingLog) {
      return NextResponse.json<ApiResponse<void>>(
        {
          success: false,
          error: 'Vaccine log not found or access denied',
        },
        { status: 404 }
      );
    }

    // Delete encrypted files from disk
    for (const doc of existingLog.documents) {
      deleteEncryptedFile(doc.storedName);
    }

    await prisma.vaccineLog.delete({
      where: { id },
    });

    return NextResponse.json<ApiResponse>({
      success: true,
    });
  } catch (error) {
    console.error('Error deleting vaccine log:', error);
    return NextResponse.json<ApiResponse>(
      {
        success: false,
        error: 'Failed to delete vaccine log',
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
