import type { NurseryUndo } from '@/src/utils/nursery/undo';
import { requestNurseryUndo } from '@/src/utils/nursery/undoRequest';
import type { UndoInfo } from './types';

export function conditionalUndo(undo: NurseryUndo, message: string, scopeNow: () => string | null,
  isCurrent: () => boolean = () => true, onConfirmed?: () => void): UndoInfo {
  return {
    tileId: undo.kind === 'bottle' || undo.kind === 'breast' ? 'feed' : undo.kind,
    message, scope: undo.scope, actionId: `${undo.kind}:${undo.records.map(row => row.id).join(':')}`,
    undo: async () => {
      if (!isCurrent()) return false;
      const confirmed = await requestNurseryUndo(undo, scopeNow);
      if (!confirmed || !isCurrent()) return false;
      onConfirmed?.();
      return true;
    },
  };
}
