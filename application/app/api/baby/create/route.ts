import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/app/api/db';
import { z } from 'zod';
import { ApiResponse, AuthResult, withAuthContext } from '@/app/api/utils/auth';
import { checkWritePermission } from '@/app/api/utils/writeProtection';
import { resolveFamilyScope } from '@/app/api/utils/family-scope';
import { Baby, Gender } from '@prisma/client';
import { isValidFeedTimerTypes } from '@/src/utils/feedTimerConfig';

const CreateBabySchema = z.object({
  familyId: z.string(),
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
  birthDate: z.string().datetime(),
  gender: z.nativeEnum(Gender),
  feedWarningTime: z.string().regex(/^\d{2}:\d{2}$/, 'Invalid time format'),
  diaperWarningTime: z.string().regex(/^\d{2}:\d{2}$/, 'Invalid time format'),
  feedTimerFrom: z.enum(['start', 'end']).optional(),
  feedTimerTypes: z
    .string()
    .nullable()
    .optional()
    .refine(isValidFeedTimerTypes, 'Invalid feed timer types'),
});

async function handlePost(req: NextRequest, authContext: AuthResult): Promise<NextResponse<ApiResponse<Baby>>> {
  // Check write permissions for expired accounts
  const writeCheck = checkWritePermission(authContext);
  if (!writeCheck.allowed) {
    return writeCheck.response!;
  }

  try {
    const body = await req.json();
    const validation = CreateBabySchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid input', details: validation.error.format() },
        { status: 400 }
      );
    }

    const { familyId: requestedFamilyId, ...babyData } = validation.data;
    const scope = resolveFamilyScope(authContext, requestedFamilyId);
    if (!scope.ok) {
      return NextResponse.json({ success: false, error: scope.error }, { status: scope.status });
    }
    const familyId = scope.familyId;
    
    // Verify family exists
    const family = await prisma.family.findUnique({
        where: { id: familyId }
    });

    if (!family) {
        return NextResponse.json({ success: false, error: 'Family not found' }, { status: 404 });
    }

    const newBaby = await prisma.baby.create({
      data: {
        ...babyData,
        birthDate: new Date(babyData.birthDate),
        family: {
            connect: { id: familyId }
        }
      },
    });

    // Mark setup as complete if still in progress
    if (family.setupStage < 3) {
      await prisma.family.update({
        where: { id: familyId },
        data: { setupStage: 3 },
      });
    }

    return NextResponse.json({ success: true, data: newBaby }, { status: 201 });
  } catch (error) {
    console.error('Error creating baby:', error);
    // Add type guard for ZodError if you want to return specific validation errors
    if (error instanceof z.ZodError) {
        return NextResponse.json({ success: false, error: 'Validation failed', details: error.issues }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: 'Error creating baby' }, { status: 500 });
  }
}

export const POST = withAuthContext(handlePost);
