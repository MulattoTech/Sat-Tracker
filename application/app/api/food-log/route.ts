import { NextRequest, NextResponse } from 'next/server';
import type { Prisma, FoodEnjoyment } from '@prisma/client';
import prisma from '../db';
import { ApiResponse, FoodLogCreate, FoodLogItemInput, FoodLogResponse } from '../types';
import { withAuthContext, AuthResult } from '../utils/auth';
import { toUTC, formatForResponse } from '../utils/timezone';
import { checkWritePermission } from '../utils/writeProtection';
import { makeNurseryUndo, readNurseryCreateScope, readNurseryUndoRequest, NurseryUndoError } from '../utils/nursery-undo';
import { undoNurseryRows, updateNurseryFood } from '../utils/nursery-undo-mutations';
import { readNurseryUndo } from '@/src/utils/nursery/undo';
import { CareWriteError } from '../utils/care-write';
import { createNurseryQuickCare, readQuickCareRequest } from '../utils/nursery-quick-care';
import {
  buildFoodLogFoodFields,
  expandFoodItems,
  foodsJsonReferencesFoodId,
  isValidEnjoyment,
  type FoodLogItem,
} from '@/src/utils/foodLogUtils';

// Joined food fields returned with every food log
const foodInclude = {
  food: {
    select: { id: true, name: true, commonAllergen: true },
  },
} as const;

class FoodLogWriteError extends Error {
  constructor(message: string, readonly status: 400 | 404) {
    super(message);
  }
}

/** Omission preserves provenance; null and the legacy empty string clear it. */
function parseFeedLogId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new FoodLogWriteError('Feed log ID must be a string or null.', 400);
  }
  return value;
}

async function validateFeedLink(
  tx: Prisma.TransactionClient,
  feedLogId: string | null | undefined,
  familyId: string,
  babyId: string,
  previousFeedLogId?: string | null
) {
  // Converted sources are hard-deleted. An unchanged historical ID remains
  // provenance, but it must never authorize a new or replacement relationship.
  if (feedLogId == null || feedLogId === previousFeedLogId) return;
  const feed = await tx.feedLog.findFirst({
    where: { id: feedLogId, familyId, babyId, type: 'SOLIDS', deletedAt: null },
    select: { id: true },
  });
  if (!feed) throw new FoodLogWriteError('Solids feed not found for this child.', 404);
}

/** True when `value` is a usable amount (positive finite number) or empty (null/undefined). */
function isValidAmount(value: unknown): boolean {
  return value == null || (typeof value === 'number' && Number.isFinite(value) && value > 0);
}

/** Normalize a client-sent unitAbbr to a trimmed string or null. */
function normalizeUnitAbbr(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeItemInputs(body: Partial<FoodLogCreate>): FoodLogItem[] | null {
  if (Array.isArray(body.foods) && body.foods.length > 0) {
    const items: FoodLogItem[] = [];
    for (const entry of body.foods as FoodLogItemInput[]) {
      if (!entry || typeof entry.foodId !== 'string' || entry.foodId === '') continue;
      items.push({
        foodId: entry.foodId,
        hadReaction: entry.hadReaction === true,
        reactionDescription:
          entry.reactionDescription && entry.reactionDescription.trim()
            ? entry.reactionDescription.trim()
            : null,
      });
    }
    return items.length > 0 ? items : null;
  }
  if (typeof body.foodId === 'string' && body.foodId !== '') {
    return [
      {
        foodId: body.foodId,
        hadReaction: body.hadReaction === true,
        reactionDescription:
          body.reactionDescription && body.reactionDescription.trim()
            ? body.reactionDescription.trim()
            : null,
      },
    ];
  }
  return null;
}

/**
 * Format a food log into a FoodLogResponse, attaching parsed foodItems with names.
 */
function formatFoodLog(
  log: any,
  catalogById?: Map<string, { id: string; name: string; commonAllergen: boolean }>
): FoodLogResponse {
  const items = expandFoodItems(log);
  const foodItems = items.map(item => {
    const meta =
      catalogById?.get(item.foodId) ||
      (log.food?.id === item.foodId ? log.food : undefined);
    return {
      foodId: item.foodId,
      hadReaction: item.hadReaction === true,
      reactionDescription: item.reactionDescription ?? null,
      ...(meta
        ? { name: meta.name, commonAllergen: meta.commonAllergen === true }
        : {}),
    };
  });

  return {
    ...log,
    time: formatForResponse(log.time) || '',
    createdAt: formatForResponse(log.createdAt) || '',
    updatedAt: formatForResponse(log.updatedAt) || '',
    deletedAt: formatForResponse(log.deletedAt),
    foodItems,
  };
}

async function loadCatalogMap(
  familyId: string,
  foodIds: string[]
): Promise<Map<string, { id: string; name: string; commonAllergen: boolean }>> {
  const unique = Array.from(new Set(foodIds.filter(Boolean)));
  if (unique.length === 0) return new Map();
  const foods = await prisma.food.findMany({
    where: { id: { in: unique }, familyId },
    select: { id: true, name: true, commonAllergen: true },
  });
  return new Map(foods.map(f => [f.id, f]));
}

async function validateFoodIdsInFamily(
  foodIds: string[],
  familyId: string
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const unique = Array.from(new Set(foodIds));
  const foods = await prisma.food.findMany({
    where: { id: { in: unique }, familyId, deletedAt: null },
    select: { id: true },
  });
  if (foods.length !== unique.length) {
    return {
      ok: false,
      response: NextResponse.json<ApiResponse<null>>(
        { success: false, error: 'Food not found in this family.' },
        { status: 404 }
      ),
    };
  }
  return { ok: true };
}

/**
 * Handle POST request to create a new food log entry
 */
async function handlePost(req: NextRequest, authContext: AuthResult) {
  const writeCheck = checkWritePermission(authContext);
  if (!writeCheck.allowed) {
    return writeCheck.response!;
  }

  try {
    const { familyId: userFamilyId, caretakerId } = authContext;
    if (!userFamilyId) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'User is not associated with a family.' }, { status: 403 });
    }

    const raw = await req.json();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new FoodLogWriteError('Invalid food log fields.', 400);
    const quickRequest = readQuickCareRequest(raw, 'food', authContext);
    const nurseryScope = readNurseryCreateScope(raw, authContext, raw.babyId);
    if (quickRequest) {
      const saved = await createNurseryQuickCare(prisma, authContext, quickRequest);
      const catalog = await loadCatalogMap(userFamilyId, [quickRequest.foodId]);
      return NextResponse.json({ success: true, data: formatFoodLog(saved.row, catalog), undo: saved.undo, replayed: !saved.created });
    }
    const body: FoodLogCreate = raw;
    const feedLogId = parseFeedLogId(body.feedLogId);

    const baby = await prisma.baby.findFirst({
      where: { id: body.babyId, familyId: userFamilyId },
    });

    if (!baby) {
      return NextResponse.json<ApiResponse<null>>({ success: false, error: 'Baby not found in this family.' }, { status: 404 });
    }

    const items = normalizeItemInputs(body);
    if (!items) {
      return NextResponse.json<ApiResponse<null>>(
        { success: false, error: 'At least one food is required' },
        { status: 400 }
      );
    }

    const foodCheck = await validateFoodIdsInFamily(
      items.map(i => i.foodId),
      userFamilyId
    );
    if (!foodCheck.ok) return foodCheck.response;

    if (body.enjoyment != null && !isValidEnjoyment(body.enjoyment)) {
      return NextResponse.json<ApiResponse<null>>(
        { success: false, error: 'Invalid enjoyment value' },
        { status: 400 }
      );
    }

    if (!isValidAmount(body.amount)) {
      return NextResponse.json<ApiResponse<null>>(
        { success: false, error: 'Amount must be a positive number' },
        { status: 400 }
      );
    }

    const foodFields = buildFoodLogFoodFields(items);

    const foodLog = await prisma.$transaction(async tx => {
      await validateFeedLink(tx, feedLogId, userFamilyId, baby.id);
      return tx.foodLog.create({
        data: {
          babyId: body.babyId,
          foodId: foodFields.foodId,
          foods: foodFields.foods,
          time: toUTC(body.time),
          amount: body.amount ?? null,
          unitAbbr: body.amount != null ? normalizeUnitAbbr(body.unitAbbr) : null,
          enjoyment: body.enjoyment ?? null,
          hadReaction: foodFields.hadReaction,
          reactionDescription: foodFields.reactionDescription,
          notes: body.notes && body.notes.trim() ? body.notes : null,
          feedLogId: feedLogId ?? null,
          caretakerId,
          familyId: userFamilyId,
        },
        include: foodInclude,
      });
    });

    const catalog = await loadCatalogMap(
      userFamilyId,
      items.map(i => i.foodId)
    );

    return NextResponse.json({
      success: true,
      data: formatFoodLog(foodLog, catalog),
      ...(nurseryScope ? { undo: makeNurseryUndo('food', authContext, [foodLog]) } : {}),
    });
  } catch (error) {
    if (error instanceof CareWriteError) return error.response();
    if (error instanceof NurseryUndoError) return error.response();
    if (error instanceof FoodLogWriteError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error('Error creating food log:', error);
    return NextResponse.json<ApiResponse<FoodLogResponse>>(
      {
        success: false,
        error: 'Failed to create food log',
      },
      { status: 500 }
    );
  }
}

/**
 * Handle PUT request to update a food log entry
 */
async function handlePut(req: NextRequest, authContext: AuthResult) {
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
    const body: Partial<FoodLogCreate> & { nurseryUndo?: unknown } = await req.json();
    const feedLogId = parseFeedLogId(body.feedLogId);

    if (!id) {
      return NextResponse.json<ApiResponse<FoodLogResponse>>(
        {
          success: false,
          error: 'Food log ID is required',
        },
        { status: 400 }
      );
    }

    if (Object.hasOwn(body, 'nurseryUndo')) {
      const undo = readNurseryUndo(body.nurseryUndo);
      if (!undo || undo.kind !== 'food' || undo.records[0].id !== id || Object.keys(body).length !== 2
        || !Object.hasOwn(body, 'enjoyment') || !isValidEnjoyment(body.enjoyment)) {
        throw new NurseryUndoError('Invalid Undo request. Review the care log.', 400, 'NURSERY_UNDO_INVALID');
      }
      const row = await updateNurseryFood(prisma, authContext, undo, body.enjoyment as FoodEnjoyment);
      const catalog = await loadCatalogMap(userFamilyId, expandFoodItems(row).map(item => item.foodId));
      return NextResponse.json({ success: true, data: formatFoodLog(row, catalog), undo: makeNurseryUndo('food', authContext, [row]) });
    }

    const items = normalizeItemInputs(body);
    let foodFields: ReturnType<typeof buildFoodLogFoodFields> | null = null;
    if (items) {
      const foodCheck = await validateFoodIdsInFamily(
        items.map(i => i.foodId),
        userFamilyId
      );
      if (!foodCheck.ok) return foodCheck.response;
      foodFields = buildFoodLogFoodFields(items);
    }

    if (body.enjoyment != null && !isValidEnjoyment(body.enjoyment)) {
      return NextResponse.json<ApiResponse<null>>(
        { success: false, error: 'Invalid enjoyment value' },
        { status: 400 }
      );
    }

    if (body.amount !== undefined && !isValidAmount(body.amount)) {
      return NextResponse.json<ApiResponse<null>>(
        { success: false, error: 'Amount must be a positive number' },
        { status: 400 }
      );
    }

    const foodLog = await prisma.$transaction(async tx => {
      const existingFoodLog = await tx.foodLog.findFirst({
        where: { id, familyId: userFamilyId },
      });
      if (!existingFoodLog) throw new FoodLogWriteError('Food log not found or access denied', 404);
      await validateFeedLink(tx, feedLogId, userFamilyId, existingFoodLog.babyId, existingFoodLog.feedLogId);
      return tx.foodLog.update({
        where: { id, familyId: userFamilyId },
        data: {
          ...(body.time && { time: toUTC(body.time) }),
          ...(foodFields && {
            foodId: foodFields.foodId,
            foods: foodFields.foods,
            hadReaction: foodFields.hadReaction,
            reactionDescription: foodFields.reactionDescription,
          }),
          ...(body.amount !== undefined && { amount: body.amount }),
          ...((body.amount !== undefined || body.unitAbbr !== undefined) && {
            unitAbbr: (body.amount !== undefined ? body.amount : existingFoodLog.amount) != null
              ? normalizeUnitAbbr(body.unitAbbr)
              : null,
          }),
          ...(body.enjoyment !== undefined && { enjoyment: body.enjoyment }),
          // Legacy single-field reaction updates only when foods[] was not sent
          ...(!foodFields && body.hadReaction !== undefined && { hadReaction: body.hadReaction === true }),
          ...(!foodFields && body.reactionDescription !== undefined && {
            reactionDescription: body.reactionDescription && body.reactionDescription.trim() ? body.reactionDescription : null,
          }),
          ...(body.notes !== undefined && { notes: body.notes && body.notes.trim() ? body.notes : null }),
          ...(feedLogId !== undefined && { feedLogId }),
        },
        include: foodInclude,
      });
    });

    const catalog = await loadCatalogMap(
      userFamilyId,
      expandFoodItems(foodLog).map(i => i.foodId)
    );

    return NextResponse.json<ApiResponse<FoodLogResponse>>({
      success: true,
      data: formatFoodLog(foodLog, catalog),
    });
  } catch (error) {
    if (error instanceof NurseryUndoError) return error.response();
    if (error instanceof FoodLogWriteError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error('Error updating food log:', error);
    return NextResponse.json<ApiResponse<FoodLogResponse>>(
      {
        success: false,
        error: 'Failed to update food log',
      },
      { status: 500 }
    );
  }
}

/**
 * Handle GET request to fetch food logs
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
    const foodId = searchParams.get('foodId');
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');

    if (id) {
      const foodLog = await prisma.foodLog.findFirst({
        where: { id, familyId: userFamilyId },
        include: foodInclude,
      });

      if (!foodLog) {
        return NextResponse.json<ApiResponse<FoodLogResponse>>(
          {
            success: false,
            error: 'Food log not found or access denied',
          },
          { status: 404 }
        );
      }

      const catalog = await loadCatalogMap(
        userFamilyId,
        expandFoodItems(foodLog).map(i => i.foodId)
      );

      return NextResponse.json<ApiResponse<FoodLogResponse>>({
        success: true,
        data: formatFoodLog(foodLog, catalog),
      });
    }

    const foodLogs = await prisma.foodLog.findMany({
      where: {
        familyId: userFamilyId,
        deletedAt: null,
        ...(babyId && { babyId }),
        ...(startDate && endDate && {
          time: {
            gte: toUTC(startDate),
            lte: toUTC(endDate),
          },
        }),
        // Narrow by FK when possible; multi-food JSON refs filtered below
        ...(foodId && {
          OR: [
            { foodId },
            { foods: { contains: foodId } },
          ],
        }),
      },
      include: foodInclude,
      orderBy: { time: 'desc' },
    });

    const filtered = foodId
      ? foodLogs.filter(
          log =>
            log.foodId === foodId || foodsJsonReferencesFoodId(log.foods, foodId)
        )
      : foodLogs;

    const allIds = filtered.flatMap(log => expandFoodItems(log).map(i => i.foodId));
    const catalog = await loadCatalogMap(userFamilyId, allIds);

    return NextResponse.json<ApiResponse<FoodLogResponse[]>>({
      success: true,
      data: filtered.map(log => formatFoodLog(log, catalog)),
    });
  } catch (error) {
    console.error('Error fetching food logs:', error);
    return NextResponse.json<ApiResponse<FoodLogResponse[]>>(
      {
        success: false,
        error: 'Failed to fetch food logs',
      },
      { status: 500 }
    );
  }
}

/**
 * Handle DELETE request to soft delete a food log
 */
async function handleDelete(req: NextRequest, authContext: AuthResult) {
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
          error: 'Food log ID is required',
        },
        { status: 400 }
      );
    }

    const undo = await readNurseryUndoRequest(req, 'food', id);
    if (undo) {
      await undoNurseryRows(prisma, authContext, undo);
      return NextResponse.json({ success: true });
    }

    const existingFoodLog = await prisma.foodLog.findFirst({
      where: { id, familyId: userFamilyId },
    });

    if (!existingFoodLog) {
      return NextResponse.json<ApiResponse<void>>(
        {
          success: false,
          error: 'Food log not found or access denied',
        },
        { status: 404 }
      );
    }

    await prisma.foodLog.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return NextResponse.json<ApiResponse>({
      success: true,
    });
  } catch (error) {
    if (error instanceof NurseryUndoError) return error.response();
    console.error('Error deleting food log:', error);
    return NextResponse.json<ApiResponse>(
      {
        success: false,
        error: 'Failed to delete food log',
      },
      { status: 500 }
    );
  }
}

export const GET = withAuthContext(handleGet as any);
export const POST = withAuthContext(handlePost as any);
export const PUT = withAuthContext(handlePut as any);
export const DELETE = withAuthContext(handleDelete as any);
