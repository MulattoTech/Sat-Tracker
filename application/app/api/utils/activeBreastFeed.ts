import { randomUUID } from 'crypto';
import { ActiveBreastFeed, BreastSide, type FeedLog } from '@prisma/client';
import prisma from '../db';
import { notifyActivityCreated, resetTimerNotificationState } from '@/src/lib/notifications/activityHook';
import { layoutBreastFeedSession } from '@/src/utils/feedSessionLayout';
import { applySessionAction as pureApply, ActiveBreastFeedState } from '@/src/utils/feedSessionActions';

/**
 * Shared active breastfeed session logic used by both the internal
 * /api/active-breastfeed route (JWT auth) and the external hooks API
 * (/api/hooks/v1, API-key auth) so timer behavior is identical
 * regardless of which surface starts, updates, or ends a session.
 */

export type SessionUpdateAction = 'switch' | 'pause' | 'resume' | 'swap';

export const SESSION_UPDATE_ACTIONS: SessionUpdateAction[] = ['switch', 'pause', 'resume', 'swap'];

export class BreastfeedSessionConflict extends Error {
  constructor(message = 'This breastfeeding session changed. Reload the current session and review it before trying again.') { super(message); }
}

export class BreastfeedSessionInputError extends Error {}

const validDuration = (value: unknown): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
const invalidDuration = () => new BreastfeedSessionInputError('Breastfeeding durations must be non-negative whole seconds within the supported range.');

/** Optional for older callers. New controls retain the revision they displayed. */
function checkSessionRevision(expected: unknown, session: ActiveBreastFeed) {
  if (expected === undefined) return;
  if (typeof expected !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expected)
    || !Number.isFinite(Date.parse(expected)) || new Date(expected).toISOString() !== expected) {
    throw new BreastfeedSessionInputError('Invalid breastfeeding revision. Reload the current session before changing it.');
  }
  if (expected !== session.updatedAt.toISOString()) throw new BreastfeedSessionConflict();
}

export interface StartSessionParams {
  babyId: string;
  side: BreastSide;
  familyId: string;
  caretakerId?: string | null;
  startTime?: Date;
}

/** Client clocks drift; treat timestamps up to this far in the future as "now". */
export const START_TIME_CLOCK_SKEW_MS = 2 * 60 * 1000;

export type StartTimeResolution =
  | { ok: true; startTime?: Date }
  | { ok: false; error: string };

/**
 * Validate a client-requested session start time. Omitted input is fine
 * (caller defaults to now); malformed input is rejected; timestamps within
 * START_TIME_CLOCK_SKEW_MS of the future are clamped to server now, and
 * anything further ahead is rejected.
 */
export function resolveRequestedStartTime(
  requested: unknown,
  now: Date = new Date()
): StartTimeResolution {
  if (requested === undefined) return { ok: true };
  if (typeof requested !== 'string' || !requested.trim()) {
    return { ok: false, error: 'Start time must be a valid date' };
  }
  const parsed = new Date(requested);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, error: 'Start time must be a valid date' };
  }
  const aheadMs = parsed.getTime() - now.getTime();
  if (aheadMs > START_TIME_CLOCK_SKEW_MS) {
    return { ok: false, error: 'Start time cannot be in the future' };
  }
  return { ok: true, startTime: aheadMs > 0 ? now : parsed };
}

/**
 * Creates a new active session. Callers should check for an existing session
 * first; a concurrent start still races on the babyId unique constraint, so
 * catch Prisma P2002 and treat it as "already active".
 */
export async function startBreastfeedSession({ babyId, side, familyId, caretakerId, startTime }: StartSessionParams): Promise<ActiveBreastFeed> {
  const sessionStartTime = startTime ?? new Date();
  return prisma.activeBreastFeed.create({
    data: {
      babyId,
      activeSide: side,
      isPaused: false,
      leftDuration: 0,
      rightDuration: 0,
      pauseDuration: 0,
      pausedAt: null,
      firstSide: side,
      currentSideStartTime: sessionStartTime,
      sessionStartTime,
      familyId,
      caretakerId,
    },
  });
}

/**
 * Adapts a DB session row to the pure, unit-tested state machine in
 * src/utils/feedSessionActions.
 */
export function applySessionAction(
  session: ActiveBreastFeed,
  action: SessionUpdateAction,
  now: Date,
  resumeSide?: BreastSide
) {
  const state: ActiveBreastFeedState = {
    activeSide: session.activeSide,
    isPaused: session.isPaused,
    leftDuration: session.leftDuration,
    rightDuration: session.rightDuration,
    pauseDuration: session.pauseDuration,
    pausedAt: session.pausedAt,
    firstSide: session.firstSide,
    currentSideStartTime: session.currentSideStartTime,
  };
  return pureApply(state, action, now, resumeSide);
}

/**
 * Applies a timer action to a session and returns the updated record.
 * - switch: accumulate time on current side, start timing the other side
 * - pause: accumulate time on current side, stop timing
 * - resume: start timing again (optionally on a given side)
 * - swap: reassign all accrued time to the opposite side (corrects starting
 *   the timer on the wrong side); running/paused state is preserved
 * Returns null for an unknown action.
 */
export async function updateBreastfeedSession(
  session: ActiveBreastFeed,
  action: SessionUpdateAction,
  side?: BreastSide,
  expectedUpdatedAt?: unknown,
): Promise<ActiveBreastFeed | null> {
  checkSessionRevision(expectedUpdatedAt, session);
  if (side !== undefined && side !== 'LEFT' && side !== 'RIGHT') {
    throw new BreastfeedSessionInputError('Breastfeeding side must be LEFT or RIGHT.');
  }
  const now = new Date();
  if ((!session.isPaused && session.currentSideStartTime && session.currentSideStartTime > now)
    || (session.isPaused && session.pausedAt && session.pausedAt > now)) throw invalidDuration();
  const updateData = applySessionAction(session, action, now, side);
  if (!updateData) return null;
  for (const duration of [updateData.leftDuration, updateData.rightDuration, updateData.pauseDuration]) {
    if (duration !== undefined && !validDuration(duration)) throw invalidDuration();
  }

  return prisma.$transaction(async tx => {
    // Durations were calculated from this exact authenticated snapshot. Claim
    // every scalar, including the family/child, before changing the timer.
    const claimed = await tx.activeBreastFeed.updateMany({
      where: { ...session },
      data: { ...updateData, updatedAt: new Date(Math.max(Date.now(), session.updatedAt.getTime() + 1)) },
    });
    if (claimed.count !== 1) throw new BreastfeedSessionConflict();
    return tx.activeBreastFeed.findUniqueOrThrow({ where: { id: session.id } });
  });
}

export interface EndSessionOptions {
  familyId: string;
  caretakerId?: string | null;
  accountId?: string | null;
  /** Optional duration overrides (seconds), e.g. from form adjustments */
  leftDuration?: number;
  rightDuration?: number;
  pauseDuration?: number;
  expectedUpdatedAt?: unknown;
  /** Capture the original side revisions before this transaction commits. */
  onCreated?: (rows: FeedLog[], sessionId: string) => void;
}

export interface EndSessionResult {
  feedLogs: { id: string; side: BreastSide | null; feedDuration: number | null }[];
  leftDuration: number;
  rightDuration: number;
}

/**
 * Finalizes a session: creates one FeedLog per side with real per-side
 * start/end spans (first-use order, pause gap between sides, shared
 * sessionId), deletes the session, and fires the same notifications as the
 * in-app end-feed flow.
 */
export async function endBreastfeedSession(session: ActiveBreastFeed, opts: EndSessionOptions): Promise<EndSessionResult> {
  if (session.familyId !== opts.familyId) throw new BreastfeedSessionConflict();
  checkSessionRevision(opts.expectedUpdatedAt, session);
  for (const duration of [opts.leftDuration, opts.rightDuration, opts.pauseDuration]) {
    if (duration !== undefined && !validDuration(duration)) throw invalidDuration();
  }
  const now = new Date();

  const elapsed = (session.currentSideStartTime && !session.isPaused)
    ? Math.floor((now.getTime() - session.currentSideStartTime.getTime()) / 1000)
    : 0;

  // Ending while paused counts the trailing gap as pause time
  const trailingPause = session.isPaused && session.pausedAt
    ? Math.floor((now.getTime() - session.pausedAt.getTime()) / 1000)
    : 0;
  if (elapsed < 0 || trailingPause < 0) throw invalidDuration();
  const finalPauseDuration = opts.pauseDuration !== undefined ? opts.pauseDuration : session.pauseDuration + trailingPause;

  const finalLeftDuration = session.activeSide === 'LEFT'
    ? session.leftDuration + elapsed
    : session.leftDuration;
  const finalRightDuration = session.activeSide === 'RIGHT'
    ? session.rightDuration + elapsed
    : session.rightDuration;

  const leftDur = opts.leftDuration !== undefined ? opts.leftDuration : finalLeftDuration;
  const rightDur = opts.rightDuration !== undefined ? opts.rightDuration : finalRightDuration;
  if (![leftDur, rightDur, finalPauseDuration].every(validDuration)) throw invalidDuration();

  // Legacy in-flight sessions (null firstSide) fall back to the opposite of
  // activeSide to preserve the previous sort order.
  const firstSide: BreastSide | null = session.firstSide ?? (session.activeSide === 'LEFT' ? 'RIGHT' : 'LEFT');
  const blocks = layoutBreastFeedSession({
    sessionStartTime: session.sessionStartTime,
    firstSide,
    leftDuration: leftDur,
    rightDuration: rightDur,
    pauseDuration: finalPauseDuration,
  });
  if (!Number.isFinite(session.sessionStartTime.getTime())
    || blocks.some(block => !Number.isFinite(block.startTime.getTime()) || !Number.isFinite(block.endTime.getTime()))) {
    throw invalidDuration();
  }

  // Both rows share a sessionId so they always count as one nursing session
  const sessionId = randomUUID();
  const feedLogs = await prisma.$transaction(async tx => {
    // Claim the active snapshot before creating either side. A failed feed
    // write restores the session; a later ending or timer action cannot create
    // duplicate rows or erase a completed caregiver correction.
    const claimed = await tx.activeBreastFeed.deleteMany({ where: { ...session } });
    if (claimed.count !== 1) throw new BreastfeedSessionConflict();
    const logs: FeedLog[] = [];
    for (const block of blocks) {
      const log = await tx.feedLog.create({
        data: {
          babyId: session.babyId,
          // Keep each side's actual start, including the existing pause layout.
          time: block.startTime,
          type: 'BREAST',
          side: block.side,
          startTime: block.startTime,
          endTime: block.endTime,
          feedDuration: block.duration,
          pauseDuration: finalPauseDuration,
          sessionId,
          caretakerId: opts.caretakerId,
          familyId: opts.familyId,
        },
      });
      logs.push(log);
    }
    opts.onCreated?.(logs, sessionId);
    return logs;
  });

  // Notify subscribers about completed breastfeed and reset feed timer (non-blocking)
  notifyActivityCreated(session.babyId, 'feed', { accountId: opts.accountId, caretakerId: opts.caretakerId }, { type: 'BREAST' }).catch(console.error);
  resetTimerNotificationState(session.babyId, 'feed').catch(console.error);

  return {
    feedLogs: feedLogs.map(log => ({ id: log.id, side: log.side, feedDuration: log.feedDuration })),
    leftDuration: leftDur,
    rightDuration: rightDur,
  };
}
