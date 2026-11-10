// UNKNOWN is an unresolved destination, not available stock or a feeding event.
// The database field is a string; no migration or historical rewrite is needed.
export const PUMP_ACTIONS = ['STORED', 'FED', 'DISCARDED', 'UNKNOWN'] as const;
export type PumpAction = typeof PUMP_ACTIONS[number];

export function isPumpAction(value: unknown): value is PumpAction {
  return typeof value === 'string' && (PUMP_ACTIONS as readonly string[]).includes(value);
}

export function pumpActionLabel(action: string): string {
  const labels: Record<PumpAction, string> = {
    STORED: 'Stored', FED: 'Fed', DISCARDED: 'Discarded', UNKNOWN: 'Needs review',
  };
  return isPumpAction(action) ? labels[action] : action;
}
