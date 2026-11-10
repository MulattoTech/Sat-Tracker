'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useLocalization } from '@/src/context/localization';
import { useFamily } from '@/src/context/family';
import { useTimezone } from '@/app/context/timezone';
import {
  FOOD_ENJOYMENT_DISPLAY_ORDER,
  FOOD_ENJOYMENT_ICON_SRC,
  FOOD_ENJOYMENT_LABELS,
  FoodEnjoymentValue,
} from '@/src/utils/foodLogUtils';
import { sortFoodsByName, filterFoodsByQuery, formatFoodLogNote, NurseryFoodItem } from '@/src/utils/nursery/foodActivity';
import { ActivityHookArgs, ActivityView, ActionButton } from './types';
import { readNurseryUndo, type NurseryUndo } from '@/src/utils/nursery/undo';
import { useNurseryOwner, type NurseryOwnerCapture } from './useNurseryOwner';
import { conditionalUndo } from './conditionalUndo';
import { useQuickCareRecovery, type QuickCareConfirmation } from './useQuickCareRecovery';
import { quickCareReview } from './quickCareReview';
import { requestQuickCareJSON } from '@/src/utils/nursery/quickCareRequest';

type FoodPhase = 'idle' | 'picking' | 'enjoyment';
interface LoggedFood { id: string; name: string; at: string; undo: NurseryUndo; owner: NurseryOwnerCapture }

/** How long the after-log enjoyment prompt lingers before falling back to idle. */
const ENJOYMENT_PROMPT_MS = 10000;

/**
 * Food activity state machine — one-tap logging against the family food
 * catalog (issue #203 models). Tap a food on the picker screen to POST a
 * food log at the current time; a transient enjoyment prompt then PUTs an
 * optional enjoyment onto the just-created entry. Amount/reactions/notes
 * stay in the full FoodForm.
 */
export function useFoodActions({ babyId, toUTCString, onLog, onUndoable }: ActivityHookArgs): ActivityView {
  const { t, language } = useLocalization();
  const { userTimezone } = useTimezone();
  const { family } = useFamily();
  const owner = useNurseryOwner(babyId);
  const recovery = useQuickCareRecovery('food', babyId, owner);
  const [phase, setPhase] = useState<FoodPhase>('idle');
  const [catalog, setCatalog] = useState<NurseryFoodItem[]>([]);
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [lastLogged, setLastLogged] = useState<LoggedFood | null>(null);
  const [error, setError] = useState('');
  const last = useRef(lastLogged), busy = useRef(false), requestId = useRef(0), catalogRequest = useRef(0);
  const remember = (entry: LoggedFood | null) => { last.current = entry; setLastLogged(entry); };
  const announceUndo = (undo: NurseryUndo, captured: NurseryOwnerCapture) => {
    onUndoable(conditionalUndo(undo, t('Food logged'), owner.scopeNow, () => owner.isCurrent(captured), () => {
      if (last.current?.id === undo.records[0].id) { remember(null); setPhase('idle'); setError(''); }
    }));
  };

  const getAuthHeaders = () => {
    const authToken = localStorage.getItem('authToken');
    return {
      'Content-Type': 'application/json',
      Authorization: authToken ? `Bearer ${authToken}` : '',
    };
  };

  const refreshCatalog = useCallback(async () => {
    const captured = owner.capture(), request = ++catalogRequest.current;
    try {
      const authToken = localStorage.getItem('authToken');
      const { data } = await requestQuickCareJSON(fetch, '/api/food', {
        headers: { Authorization: authToken ? `Bearer ${authToken}` : '' },
      });
      if (owner.isCurrent(captured) && request === catalogRequest.current && data.success && Array.isArray(data.data)) {
        setCatalog(sortFoodsByName(data.data));
      }
    } catch { /* keep the current catalog */ }
  }, [owner.capture, owner.isCurrent]);

  // Fetch the family catalog on mount; re-read when the app becomes active
  // again (Android can resume a warm PWA without remounting its React tree).
  useEffect(() => {
    setCatalog([]);
    refreshCatalog();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshCatalog();
    };
    window.addEventListener('focus', refreshCatalog);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('focus', refreshCatalog);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshCatalog, owner.scope]);

  // Reset any in-flight interaction when the selected baby changes.
  useEffect(() => {
    requestId.current++; busy.current = false; setSubmitting(false);
    setPhase('idle'); remember(null); setError('');
  }, [owner.scope, owner.epoch]);

  // A saved quick action owns the interaction until it is resolved. Do not
  // reopen its old picker or enjoyment prompt after a later local dismissal.
  useEffect(() => {
    if (recovery.reviewing) { setPhase('idle'); remember(null); }
  }, [recovery.reviewing]);

  // A stale search query shouldn't greet the next visit to the picker.
  useEffect(() => {
    if (phase !== 'picking') setQuery('');
  }, [phase]);

  // The enjoyment prompt is transient — fall back to idle if ignored.
  useEffect(() => {
    if (phase !== 'enjoyment' || submitting || error) return;
    const timeout = setTimeout(() => {
      setPhase('idle');
      remember(null);
    }, ENJOYMENT_PROMPT_MS);
    return () => clearTimeout(timeout);
  }, [phase, submitting, error]);

  function confirmFood(saved: QuickCareConfirmation | null) {
    if (!saved || saved.intent.kind !== 'food' || !owner.isCurrent(saved.owner)) return;
    const name = saved.intent.foodName;
    onLog('food', formatFoodLogNote({ foodName: name }), saved.time);
    remember({ id: saved.id, name, at: saved.time, undo: saved.undo, owner: saved.owner });
    announceUndo(saved.undo, saved.owner); setError(''); setPhase('enjoyment');
  }
  const submitFood = async (food: NurseryFoodItem) => {
    if (busy.current) return;
    confirmFood(await recovery.create({ foodId: food.id, foodName: food.name, time: toUTCString(new Date()) }));
  };

  const submitEnjoyment = async (value: FoodEnjoymentValue) => {
    const entry = last.current;
    if (!entry || busy.current || !owner.isCurrent(entry.owner)) return;
    const request = ++requestId.current;
    busy.current = true; setSubmitting(true);
    try {
      const { response: res, data } = await requestQuickCareJSON(fetch, `/api/food-log?id=${encodeURIComponent(entry.id)}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ enjoyment: value, nurseryUndo: entry.undo }),
      });
      if (!owner.isCurrent(entry.owner) || request !== requestId.current || last.current?.id !== entry.id) return;
      const undo = readNurseryUndo(data.undo);
      if (res.ok && data.success && undo?.kind === 'food' && undo.scope === entry.owner.scope && undo.records[0].id === entry.id) {
        onLog('food', formatFoodLogNote({ foodName: entry.name, enjoymentLabel: t(FOOD_ENJOYMENT_LABELS[value]) }), entry.at);
        announceUndo(undo, entry.owner);
      } else {
        setError('This food entry changed or its enjoyment update was not confirmed. Review the care log.');
      }
    } catch (err) {
      console.error('Error saving enjoyment:', err);
      if (owner.isCurrent(entry.owner) && request === requestId.current && last.current?.id === entry.id) {
        setError('This food entry changed or its enjoyment update was not confirmed. Review the care log.');
      }
    } finally {
      if (owner.isCurrent(entry.owner) && request === requestId.current) {
        busy.current = false; setSubmitting(false); remember(null); setPhase('idle');
      }
    }
  };

  let statusText: string | null = null;
  let buttons: ActionButton[];
  let searchPrompt: ActivityView['searchPrompt'] = null;

  if (error) {
    buttons = [
      { key: 'review', label: t('Review care log'), onClick: () => { if (family?.slug) window.open(`/${encodeURIComponent(family.slug)}/full-log`, '_blank', 'noopener,noreferrer'); } },
      { key: 'dismiss', label: t('Dismiss review'), onClick: () => setError(''), keepOpen: true },
    ];
  } else if (phase === 'picking') {
    statusText = t('Select Food');
    searchPrompt = { value: query, onChange: setQuery, placeholder: t('Search foods') };
    buttons = [
      ...filterFoodsByQuery(catalog, query).map(food => ({
        key: food.id,
        label: food.name, // user data, not localized
        onClick: () => submitFood(food),
        disabled: submitting,
        // Tiles layout: keep the modal open so the enjoyment prompt that follows is visible.
        keepOpen: true,
      })),
      { key: 'cancel', label: t('Cancel'), onClick: () => setPhase('idle'), cancel: true },
    ];
  } else if (phase === 'enjoyment') {
    statusText = t('Enjoyed it?');
    buttons = [
      ...FOOD_ENJOYMENT_DISPLAY_ORDER.map(value => ({
        key: value,
        label: t(FOOD_ENJOYMENT_LABELS[value]),
        ariaLabel: t(FOOD_ENJOYMENT_LABELS[value]),
        // Same Fluent Emoji SVGs the FoodForm's enjoyment picker uses.
        iconSrc: FOOD_ENJOYMENT_ICON_SRC[value],
        onClick: () => submitEnjoyment(value),
        disabled: submitting,
      })),
      { key: 'skip', label: t('Skip'), onClick: () => { remember(null); setPhase('idle'); }, disabled: submitting },
    ];
  } else {
    const empty = catalog.length === 0;
    if (empty) statusText = t('Add foods from Log Entry first');
    buttons = [
      // BigTile auto-fires a lone keepOpen button without checking disabled — guard the empty case in onClick too.
      { key: 'log', label: t('Log Food'), onClick: () => { if (!empty) setPhase('picking'); }, wide: true, keepOpen: true, disabled: empty || submitting },
    ];
  }

  return {
    id: 'food',
    icon: 'food',
    label: t('Food'),
    statusText,
    errorText: error ? t(error) : null,
    active: false,
    question: phase === 'picking',
    buttonsWrap: phase === 'picking',
    searchPrompt,
    buttons,
    ...(recovery.reviewing ? { ...quickCareReview(recovery, t, language, userTimezone, confirmFood), searchPrompt: null, question: false } : {}),
  };
}
