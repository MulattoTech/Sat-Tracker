import { IconName } from '../icons';
import type { ReactNode } from 'react';

/** Latest logged activity summary shown in a card/tile meta line. */
export interface TileLog {
  last: string;
  note: string;
}

export interface ActionButton {
  key: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  emphasized?: boolean;
  wide?: boolean;
  /** True when this button only advances to another decision screen (not a final log/action) — BigTile's modal stays open instead of closing. */
  keepOpen?: boolean;
  /** Accessible name when the visible label isn't descriptive text (e.g. emoji-only enjoyment buttons). */
  ariaLabel?: string;
  /** Rendered as an image (at ~2x text size) in place of the label text; set ariaLabel too. */
  iconSrc?: string;
  /** Backs out of the current decision screen. Pickers with a search field render it beside the search input instead of in the button list. */
  cancel?: boolean;
}

export interface AmountPromptField {
  key: string;
  label: string; // localized, e.g. "Left"
  value: string;
  onChange: (value: string) => void;
  unit: string; // e.g. "oz", shown next to the input
  disabled?: boolean;
}

/** Optional amount entry (e.g. pump volume) shown above the action buttons. */
export interface AmountPrompt {
  fields: AmountPromptField[];
}

/** Optional search field shown above a long picker's button list (e.g. the food catalog). */
export interface SearchPrompt {
  value: string;
  onChange: (value: string) => void;
  placeholder: string; // localized
}

export interface ActivityView {
  id: 'feed' | 'pump' | 'diaper' | 'sleep' | 'food';
  icon: IconName; // bottle | pump | diaper | moon
  label: string; // localized
  statusText: string | null; // active timer line, e.g. "Left Side — 4:12 · L: 4:12 R: 0:00"
  /** Keep review facts visible inside Big Tiles' action dialog for active timers. */
  showStatusInDialog?: boolean;
  /** Allow long review facts to wrap within the Cards header at narrow widths. */
  wrapStatus?: boolean;
  errorText?: string | null;
  active: boolean; // a timer/session is running
  /** True while a decision screen is showing (e.g. pump's amount/action step, sleep's location picker) — the card expands to fill the grid in cards layout. */
  question: boolean;
  amountPrompt?: AmountPrompt | null;
  searchPrompt?: SearchPrompt | null;
  buttons: ActionButton[];
  /** When true, buttons keep their intrinsic size and wrap to new rows instead of shrinking to fit one row (e.g. sleep's location picker, which can have many options). */
  buttonsWrap?: boolean;
  /** Activity-specific dialog, rendered once outside the cards/tiles layouts. */
  overlay?: ReactNode;
}

export interface UndoInfo {
  tileId: 'feed' | 'pump' | 'diaper' | 'sleep' | 'food';
  message: string;
  /** Conditional Nursery actions are bound to their original owner and record. */
  scope?: string;
  actionId?: string;
  /** Reverts the just-logged action (delete the entry, or resume a session); resolves true on success. */
  undo: () => Promise<boolean>;
}

export interface ActivityHookArgs {
  babyId: string;
  toUTCString: (d: Date | null | undefined) => string | null;
  onLog: (tileId: string, note: string, at?: string) => void;
  onUndoable: (u: UndoInfo) => void; // instant logs only (bottle, diaper)
  /** Clear a local summary after a previously unconfirmed Undo is explicitly retried. */
  onUndoConfirmed?: (tileId: string) => void;
  enableBreastMilkTracking?: boolean;
  /** Locations offered by useSleepActions' location picker; defaults to ['Crib', 'Contact']. */
  sleepLocations?: string[];
}

/** m:ss — replaces the FeedTile/PumpTile local formatDuration. */
export function formatMMSS(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** h:mm:ss when >= 1h, else m:ss — replaces the SleepTile local formatDuration. */
export function formatHMMSS(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
