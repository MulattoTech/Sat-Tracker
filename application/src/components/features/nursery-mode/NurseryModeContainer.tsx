'use client';

import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef, CSSProperties } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useBaby } from '@/app/context/baby';
import { useTimezone } from '@/app/context/timezone';
import { useLocalization } from '@/src/context/localization';
import { useFamily } from '@/src/context/family';
import { useWakeLock } from '@/src/hooks/useWakeLock';
import { useFullscreen } from '@/src/hooks/useFullscreen';
import { useNurserySettings } from '@/src/hooks/useNurserySettings';
import { autoIconColor } from '@/src/utils/nursery/colorMath';
import { TileEntry, formatTileLogs } from '@/src/utils/nursery/tileLog';
import { isWithinTileWindow } from '@/src/utils/nursery/activityFreshness';
import { fetchPhotosEnabled } from '@/src/utils/photoClientApi';
import { isNativeApp } from '@/src/utils/native-app';
import { nurseryDisplayControls } from '@/src/utils/shell-chrome';
import { Baby } from '@prisma/client';
import { ClockBlock } from './ClockBlock';
import { SceneBackground } from './scenes/SceneBackground';
import { SettingsDrawer } from './SettingsDrawer';
import { useFeedActions } from './activities/useFeedActions';
import { usePumpActions } from './activities/usePumpActions';
import { useDiaperActions } from './activities/useDiaperActions';
import { useSleepActions } from './activities/useSleepActions';
import { useFoodActions } from './activities/useFoodActions';
import { ActivityCard } from './activities/ActivityCard';
import { BigTile } from './activities/BigTile';
import { UndoToast } from './activities/UndoToast';
import { UndoInfo } from './activities/types';
import { useNurseryOwner, type NurseryOwnerCapture } from './activities/useNurseryOwner';
import { NurseryUndoFailure, undoUnconfirmed } from '@/src/utils/nursery/undoRequest';
import './nursery.css';

export function NurseryModeContainer() {
  const router = useRouter();
  const params = useParams();
  const slug = params?.slug as string;
  const { selectedBaby, setSelectedBaby } = useBaby();
  const { family } = useFamily();
  const owner = useNurseryOwner(selectedBaby?.id ?? '');
  const callbackOwner = owner.capture();
  const selectedBabyRef = useRef(selectedBaby);
  selectedBabyRef.current = selectedBaby;
  const { toUTCString, timeFormat } = useTimezone();
  const { t } = useLocalization();
  const wakeLock = useWakeLock();
  const fullscreen = useFullscreen();
  const { settings, isLoading, updateSettings } = useNurserySettings();

  const [entries, setEntries] = useState<Record<string, TileEntry>>({});
  const [babies, setBabies] = useState<Baby[]>([]);
  const [undo, setUndo] = useState<UndoInfo | null>(null);
  const undoRef = useRef(undo), undoOwner = useRef<NurseryOwnerCapture | null>(null), undoBusy = useRef<UndoInfo | null>(null);
  const undoNeedsReview = useRef(false);
  const [undoState, setUndoState] = useState({ busy: false, error: '', retryable: false });
  const tileVersions = useRef<Record<string, number>>({});
  const pollRequest = useRef(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [enableBreastMilkTracking, setEnableBreastMilkTracking] = useState(true);
  const [photosEnabled, setPhotosEnabled] = useState(false);
  const [photoTint, setPhotoTint] = useState<string | null>(null);
  const [isLandscape, setIsLandscape] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(orientation: landscape) and (max-height: 500px)').matches
  );
  // Matches nursery.css's mobile breakpoint — on narrow screens, active cards
  // (a timer running) sort to the top of the single-column cards layout.
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 680px)').matches
  );
  const [inShell, setInShell] = useState(false);
  useEffect(() => setInShell(isNativeApp()), []);
  const displayControls = nurseryDisplayControls(inShell);

  const lastSeenRef = useRef<Record<string, string>>({});
  const lastSeenDayRef = useRef<string>('');
  const fetchActivityRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    undoRef.current = null; undoOwner.current = null; undoBusy.current = null; undoNeedsReview.current = false;
    setUndo(null); setUndoState({ busy: false, error: '', retryable: false });
    setEntries({}); lastSeenRef.current = {}; tileVersions.current = {}; pollRequest.current++;
  }, [owner.scope, owner.epoch]);

  // Listen for orientation changes
  useLayoutEffect(() => {
    const mql = window.matchMedia('(orientation: landscape) and (max-height: 500px)');
    setIsLandscape(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setIsLandscape(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  // Listen for the mobile breakpoint
  useLayoutEffect(() => {
    const mql = window.matchMedia('(max-width: 680px)');
    setIsMobile(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  // Fetch family settings for breast milk tracking flag
  useEffect(() => {
    const fetchFamilySettings = async () => {
      try {
        const authToken = localStorage.getItem('authToken');
        const res = await fetch('/api/settings', {
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
        });
        if (res.ok) {
          const data = await res.json();
          if (data.success) {
            setEnableBreastMilkTracking(data.data?.enableBreastMilkTracking ?? true);
          }
        }
      } catch (err) {
        // Default to enabled on error
      }
    };
    fetchFamilySettings();
  }, []);

  // Deployment-wide photos feature flag (Task 13 wires the actual picker)
  useEffect(() => {
    fetchPhotosEnabled().then(setPhotosEnabled);
  }, []);

  // Fetch babies list and auto-select if needed
  useEffect(() => {
    const fetchBabies = async () => {
      try {
        const authToken = localStorage.getItem('authToken');
        const res = await fetch('/api/baby', {
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
        });
        if (res.ok) {
          const data = await res.json();
          if (data.success) {
            const activeBabies = data.data.filter((b: Baby) => !b.inactive);
            setBabies(activeBabies);
            // BabyProvider may restore the last child while this request is in
            // flight. The mount-time null closure must not replace that child
            // and hide their saved activity drafts after a reload.
            if (!selectedBabyRef.current && activeBabies.length > 0) {
              setSelectedBaby(activeBabies[0]);
            }
          }
        }
      } catch (err) {
        console.error('Failed to fetch babies:', err);
      }
    };
    fetchBabies();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll for recent activity updates every 10 seconds
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!selectedBaby) return;
    let active = true;
    const capturedOwner = owner.capture();

    // A switched baby (or a newly enabled activity) must repopulate every tile,
    // so drop the dedup cache and let the immediate refetch rebuild the entries.
    lastSeenRef.current = {};

    const fetchRecentActivity = async () => {
      const request = ++pollRequest.current, versions = { ...tileVersions.current };
      try {
        const authToken = localStorage.getItem('authToken');
        const headers: Record<string, string> = authToken ? { Authorization: `Bearer ${authToken}` } : {};
        const babyId = selectedBaby.id;

        const [feedRes, diaperRes, sleepRes, pumpRes, foodRes] = await Promise.all([
          fetch(`/api/feed-log?babyId=${babyId}`, { headers }),
          fetch(`/api/diaper-log?babyId=${babyId}`, { headers }),
          fetch(`/api/sleep-log?babyId=${babyId}`, { headers }),
          fetch(`/api/pump-log?babyId=${babyId}`, { headers }),
          settings.acts.food ? fetch(`/api/food-log?babyId=${babyId}`, { headers }) : Promise.resolve(null),
        ]);

        const [feedData, diaperData, sleepData, pumpData, foodData] = await Promise.all([
          feedRes.ok ? feedRes.json() : null,
          diaperRes.ok ? diaperRes.json() : null,
          sleepRes.ok ? sleepRes.json() : null,
          pumpRes.ok ? pumpRes.json() : null,
          foodRes && foodRes.ok ? foodRes.json() : null,
        ]);
        if (!active || request !== pollRequest.current || !owner.isCurrent(capturedOwner)
          || Object.keys(tileVersions.current).some(tile => tileVersions.current[tile] !== versions[tile])) return;

        // A tile's meta line shows a clock time with no date, so an entry from days
        // ago reads like a recent one — null means "hide this tile's line" (#250).
        const now = Date.now();
        // Nursery mode stays open across midnight (wake lock) — when the day
        // rolls over, drop the dedup cache so "Today" prefixes become "Yesterday".
        const day = new Date(now).toDateString();
        if (lastSeenDayRef.current !== day) {
          lastSeenDayRef.current = day;
          lastSeenRef.current = {};
        }
        const newEntries: Record<string, TileEntry | null> = {};
        for (const [tileId, data] of Object.entries({ feed: feedData, diaper: diaperData, sleep: sleepData, pump: pumpData, food: foodData })) {
          if (data?.success && Array.isArray(data.data) && data.data.length === 0) newEntries[tileId] = null;
        }

        // Latest feed
        if (feedData?.success && feedData.data?.length > 0) {
          const latest = feedData.data[0];
          const id = latest.id;
          if (!isWithinTileWindow(latest.time || latest.startTime, now)) {
            newEntries.feed = null;
          } else if (id !== lastSeenRef.current.feed) {
            lastSeenRef.current.feed = id;
            const breastSides = latest.type === 'BREAST' && latest.sessionId
              ? feedData.data
                  .filter((f: any) => f.sessionId === latest.sessionId && f.type === 'BREAST')
                  .map((f: any) => ({ side: f.side, seconds: f.feedDuration || 0 }))
              : null;
            newEntries.feed = {
              kind: 'feed',
              at: latest.time || latest.startTime,
              feed: { type: latest.type, amount: latest.amount, unitAbbr: latest.unitAbbr, food: latest.food, breastSides },
            };
          }
        }

        // Latest diaper
        if (diaperData?.success && diaperData.data?.length > 0) {
          const latest = diaperData.data[0];
          const id = latest.id;
          if (!isWithinTileWindow(latest.time, now)) {
            newEntries.diaper = null;
          } else if (id !== lastSeenRef.current.diaper) {
            lastSeenRef.current.diaper = id;
            newEntries.diaper = { kind: 'diaper', at: latest.time, diaperType: latest.type };
          }
        }

        // Latest sleep (completed only)
        if (sleepData?.success && sleepData.data?.length > 0) {
          const latest = sleepData.data.find((s: any) => s.endTime);
          if (latest) {
            const id = latest.id;
            if (!isWithinTileWindow(latest.endTime, now)) {
              newEntries.sleep = null;
            } else if (id !== lastSeenRef.current.sleep) {
              lastSeenRef.current.sleep = id;
              newEntries.sleep = {
                kind: 'sleep',
                at: latest.endTime,
                location: latest.location ?? null,
                durationMinutes: latest.duration ?? null,
              };
            }
          }
        }

        // Latest pump
        if (pumpData?.success && pumpData.data?.length > 0) {
          const latest = pumpData.data[0];
          const id = latest.id;
          if (!isWithinTileWindow(latest.startTime, now)) {
            newEntries.pump = null;
          } else if (id !== lastSeenRef.current.pump) {
            lastSeenRef.current.pump = id;
            newEntries.pump = {
              kind: 'pump',
              at: latest.startTime,
              pump: {
                leftAmount: latest.leftAmount, rightAmount: latest.rightAmount, totalAmount: latest.totalAmount,
                unitAbbr: latest.unitAbbr, durationMinutes: latest.duration, action: latest.pumpAction,
              },
            };
          }
        }

        // Latest food try
        if (foodData?.success && foodData.data?.length > 0) {
          const latest = foodData.data[0];
          const id = latest.id;
          if (!isWithinTileWindow(latest.time, now)) {
            newEntries.food = null;
          } else if (id !== lastSeenRef.current.food) {
            lastSeenRef.current.food = id;
            newEntries.food = {
              kind: 'food',
              at: latest.time,
              foodName: latest.food?.name ?? null,
              enjoyment: latest.enjoyment,
            };
          }
        }

        if (Object.keys(newEntries).length > 0) {
          for (const tileId of Object.keys(newEntries)) tileVersions.current[tileId] = (tileVersions.current[tileId] || 0) + 1;
          setEntries(prev => {
            const next = { ...prev };
            let changed = false;
            for (const [tileId, entry] of Object.entries(newEntries)) {
              if (entry) {
                next[tileId] = entry;
                changed = true;
              } else if (tileId in next) {
                // Aged out of the window; drop it. Returning `prev` when nothing
                // moved keeps a permanently stale tile from re-rendering the
                // container on every 10s poll.
                delete next[tileId];
                changed = true;
              }
            }
            return changed ? next : prev;
          });
        }
      } catch (err) {
        console.error('Failed to poll activities:', err);
      }
    };

    fetchActivityRef.current = fetchRecentActivity;
    fetchRecentActivity();
    pollRef.current = setInterval(fetchRecentActivity, 10000);

    return () => {
      active = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [selectedBaby?.id, settings.acts.food, owner.scope, owner.epoch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Localized here rather than in the poller: non-English bundles lazy-load, so
  // strings frozen at poll time stayed English for the life of the entry.
  const logs = useMemo(() => formatTileLogs(entries, timeFormat, t), [entries, timeFormat, t]);

  const handleLog = useCallback((tileId: string, note: string, at?: string) => {
    if (!owner.isCurrent(callbackOwner)) return;
    tileVersions.current[tileId] = (tileVersions.current[tileId] || 0) + 1;
    // A queued bottle keeps its actual feeding time. A later delivery must not
    // make an older bottle look new or replace a more recent activity summary.
    setEntries(prev => {
      if (at && (!isWithinTileWindow(at, Date.now()) || Date.parse(prev[tileId]?.at || '') > Date.parse(at))) return prev;
      return { ...prev, [tileId]: { kind: 'note', at: at || new Date().toISOString(), note } };
    });
  }, [owner.scope, owner.epoch, owner.isCurrent]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stable identity: the container re-renders every second while an activity
  // timer runs, and UndoToast's auto-dismiss effect depends on this callback —
  // an inline arrow would re-arm the 6s timeout on every tick.
  const dismissUndo = useCallback((target: UndoInfo) => {
    if (undoRef.current !== target || undoBusy.current === target) return;
    undoRef.current = null; undoOwner.current = null; undoNeedsReview.current = false;
    setUndo(null); setUndoState({ busy: false, error: '', retryable: false });
  }, []);

  const handleUndoable = useCallback((next: UndoInfo) => {
    if (!owner.isCurrent(callbackOwner) || (next.scope && next.scope !== callbackOwner?.scope)) return;
    // A later save may update its tile, but must not discard the original
    // descriptor while its Undo is in flight or still needs review.
    if (undoBusy.current || undoNeedsReview.current) return;
    undoRef.current = next; undoOwner.current = callbackOwner; undoBusy.current = null;
    setUndo(next); setUndoState({ busy: false, error: '', retryable: false });
  }, [owner.scope, owner.epoch, owner.isCurrent]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sleep's explicit retry uses this same callback after its original toast
  // expires. Its own closure checks owner/epoch; this also guards the view.
  const handleUndoConfirmed = useCallback((tileId: string, expectedVersion?: number) => {
    if (!owner.isCurrent(callbackOwner)) return;
    if (expectedVersion === undefined || (tileVersions.current[tileId] || 0) === expectedVersion) {
      tileVersions.current[tileId] = (tileVersions.current[tileId] || 0) + 1;
      setEntries(prev => { const next = { ...prev }; delete next[tileId]; return next; });
    }
    lastSeenRef.current[tileId] = '';
    if (fetchActivityRef.current) fetchActivityRef.current();
  }, [owner.scope, owner.epoch, owner.isCurrent]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUndo = useCallback(async () => {
    const action = undoRef.current, captured = undoOwner.current;
    if (!action || undoBusy.current === action || !owner.isCurrent(captured)) return;
    const version = tileVersions.current[action.tileId] || 0;
    undoBusy.current = action; setUndoState({ busy: true, error: '', retryable: false });
    try {
      const ok = await action.undo();
      if (undoRef.current !== action || !owner.isCurrent(captured)) return;
      if (ok) handleUndoConfirmed(action.tileId, version);
      // Sleep owns its retained review UI and keeps its boolean callback.
      if (ok || !action.scope) { undoBusy.current = null; dismissUndo(action); }
      else { undoNeedsReview.current = true; setUndoState({ busy: false, error: undoUnconfirmed, retryable: true }); }
    } catch (failure) {
      if (undoRef.current === action && owner.isCurrent(captured)) {
        undoNeedsReview.current = true;
        setUndoState({ busy: false, error: failure instanceof NurseryUndoFailure ? failure.message : undoUnconfirmed,
          retryable: failure instanceof NurseryUndoFailure ? failure.retryable : true });
      }
    } finally {
      if (undoBusy.current === action) undoBusy.current = null;
    }
  }, [owner.isCurrent, handleUndoConfirmed, dismissUndo]);

  const reviewUndo = useCallback(() => {
    if (owner.isCurrent(undoOwner.current) && family?.slug) window.open(`/${encodeURIComponent(family.slug)}/full-log`, '_blank', 'noopener,noreferrer');
  }, [owner.isCurrent, family?.slug]);

  const handleExit = useCallback(() => {
    wakeLock.release();
    if (fullscreen.isFullscreen) fullscreen.exit();
    router.push(`/${slug}/log-entry`);
  }, [wakeLock, fullscreen, router, slug]);

  const handleSelectBaby = useCallback((id: string) => {
    const baby = babies.find(b => b.id === id);
    if (!baby) return;
    setSelectedBaby(baby);
    setEntries({});
    lastSeenRef.current = {};
  }, [babies, setSelectedBaby]);

  // Activity hooks — always called unconditionally (rules of hooks)
  const hookArgs = { babyId: selectedBaby?.id ?? '', toUTCString, onLog: handleLog, onUndoable: handleUndoable,
    onUndoConfirmed: handleUndoConfirmed, enableBreastMilkTracking, sleepLocations: settings.sleep.locations };
  const feedView = useFeedActions(hookArgs);
  const pumpView = usePumpActions(hookArgs);
  const diaperView = useDiaperActions(hookArgs);
  const sleepView = useSleepActions(hookArgs);
  const foodView = useFoodActions(hookArgs);

  if (isLoading) {
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center" style={{ background: '#0a0a1a' }}>
        <div className="text-white/50 text-sm font-sans">{t('Loading')}...</div>
      </div>
    );
  }

  const trans = settings.trans;
  const cardBg = (0.16 - (trans / 100) * 0.15).toFixed(3);
  const btnBg = (0.2 - (trans / 100) * 0.16).toFixed(3);
  const line = (0.24 - (trans / 100) * 0.16).toFixed(3);
  const stageVars = { '--cardbg': cardBg, '--btnbg': btnBg, '--cardline': line, '--btnline': line } as CSSProperties;

  const iconColor = settings.iconColor ?? (settings.scene === 'photo' && photoTint ? photoTint : autoIconColor(settings.hue));
  const shape = settings.iconShape;
  const clockBabies = babies.map(b => ({ id: b.id, firstName: b.firstName }));
  const babyName = selectedBaby?.firstName ?? t('Sprout Track');

  const views = [feedView, pumpView, diaperView, sleepView, foodView];
  const visible = views.filter(v => settings.acts[v.id]);
  const anyQuestion = visible.some(v => v.question);
  // Single-column mobile layout: surface running timers first instead of a fixed
  // feed/pump/diaper/sleep order, so an active card isn't buried below a scroll.
  const cardOrder = isMobile
    ? [...visible].sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0))
    : visible;

  const activityArea = settings.layout === 'tiles' ? (
    <div className={`nursery-tilegrid${visible.length <= 2 ? ' two' : ''}`}>
      {visible.map(v => (
        <BigTile key={v.id} view={v} log={logs[v.id] || null} iconColor={iconColor} iconShape={shape} />
      ))}
    </div>
  ) : (
    <div className="nursery-grid">
      {cardOrder.map(v => (
        <ActivityCard key={v.id} view={v} log={logs[v.id] || null} iconColor={iconColor} iconShape={shape} dimmed={anyQuestion && !v.question} />
      ))}
    </div>
  );

  const wakeStatus = wakeLock.isActive
    ? t('Screen lock active')
    : wakeLock.isSupported
      ? t('Requesting wake lock...')
      : t('Wake lock not supported');

  return (
    <div className="nursery-stage" style={stageVars}>
      <style>{`* { -webkit-tap-highlight-color: transparent; }
        .nursery-stage input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 28px; height: 28px; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.25); cursor: pointer; }`}</style>

      <SceneBackground settings={settings} onPhotoTint={setPhotoTint} />

      <div className="nursery-fg">
        <div className="nursery-topbar" style={isLandscape ? { justifyContent: 'space-between' } : undefined}>
          {isLandscape && (
            <ClockBlock babyName={babyName} babies={clockBabies} selectedBabyId={selectedBaby?.id} onSelectBaby={handleSelectBaby} compact />
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 'clamp(20px, 2.5vw, 40px)' }}>
            <button type="button" className="nursery-ghost" onClick={() => setSettingsOpen(true)}>{t('Settings')}</button>
            <button type="button" className="nursery-ghost" onClick={handleExit}>{t('Exit')}</button>
          </div>
        </div>

        <div className="nursery-center">
          {!isLandscape && (
            <ClockBlock babyName={babyName} babies={clockBabies} selectedBabyId={selectedBaby?.id} onSelectBaby={handleSelectBaby} />
          )}
          {selectedBaby && <div className="nursery-actscroll">{activityArea}</div>}
        </div>
      </div>

      {!isLandscape && (
        <div className="nursery-footer">
          <div className="m" style={{ textTransform: 'uppercase' }}>{t('Nursery Mode')}</div>
          {displayControls.showWakeLock && (
            <div className="l" style={{ textTransform: 'uppercase' }}>
              {wakeLock.isActive && <span className="nursery-dotlock" />}
              {wakeStatus}
            </div>
          )}
        </div>
      )}

      <UndoToast undo={owner.isCurrent(undoOwner.current) ? undo : null} onUndo={handleUndo} onDismiss={dismissUndo}
        busy={undoState.busy} error={undoState.error} retryable={undoState.retryable} onReview={reviewUndo} />
      {feedView.overlay}

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        updateSettings={updateSettings}
        wakeLockActive={wakeLock.isActive}
        wakeLockSupported={wakeLock.isSupported}
        onToggleWakeLock={() => (wakeLock.isActive ? wakeLock.release() : wakeLock.request())}
        fullscreenActive={fullscreen.isFullscreen}
        fullscreenSupported={fullscreen.isSupported}
        onToggleFullscreen={() => fullscreen.toggle()}
        photosEnabled={photosEnabled}
        showWakeLock={displayControls.showWakeLock}
        showFullscreen={displayControls.showFullscreen}
      />
    </div>
  );
}
