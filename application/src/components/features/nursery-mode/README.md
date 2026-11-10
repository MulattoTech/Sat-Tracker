# Nursery Mode

A full-screen, kiosk-style view for a bedside tablet: a live clock, quick-log
tiles for feed/pump/diaper/sleep/food, and a customizable animated backdrop (scene).
Ported from the `nursery.jsx` prototype in `documentation/Implementation/`,
split into an engine/scenes/activities/drawer architecture so each concern is
independently testable.

## Entry point

`NurseryModeContainer.tsx` is the only export the route (`app/(nursery)/[slug]/nursery-mode/page.tsx`)
should render. It orchestrates:

- **Settings** via `useNurserySettings()` (see below).
- **Scene rendering** via `SceneBackground` (scenes/).
- **Foreground layout**: clock (`ClockBlock.tsx`), the activity grid or big-tile
  grid built from `activities/`, and the settings drawer (`SettingsDrawer.tsx`).
- **Cross-cutting device concerns**: wake lock (`useWakeLock`), fullscreen
  (`useFullscreen`), orientation (landscape phone layout), baby switching, and
  polling the latest feed/pump/diaper/sleep log for each tile's meta line. That
  line shows a clock time with no date, so entries older than 24 h are hidden
  rather than shown as if they were recent (`isWithinTileWindow`). The poller
  stores each entry **unlocalized** (`TileEntry` in `src/utils/nursery/tileLog.ts`);
  `formatTileLogs()` turns it into the displayed `Today/Yesterday, 4:39 pm` line
  and its note during render. Formatting inside the poller instead froze the
  strings at whatever `t` held when the entry arrived — non-English bundles
  lazy-load, so tiles kept rendering English on an otherwise translated screen.
- **Undo**: instant logs (bottle feed, diaper change) surface an `UndoToast`
  that deletes the just-created record via the `UndoInfo.endpoint`.

## Settings model (v1)

`src/utils/nursery/settings.ts` is the single source of truth for the
`NurserySettings` shape (`v: 1`), `NURSERY_DEFAULTS`, palettes
(`PALETTES`, `BASE_CHIPS`), and `normalizeNurserySettings()` — a defensive
parser that clamps/coerces any stored or API-returned value back to a valid
`NurserySettings`, so a corrupt localStorage blob or a future schema change
never crashes the container. `CSS_BACKDROPS` (the flat-pattern tapestry
backdrops) also lives here since it's settings-shaped data, not markup.

Persistence (`src/hooks/useNurserySettings.ts`):

- **Read**: on mount and on every window `focus`, `GET /api/nursery-mode-settings?caretakerId=`.
  The route (`app/api/nursery-mode-settings/route.ts`) cascades
  caretaker-specific → family-global → defaults, stored as one JSON blob
  (`Settings.nurseryModeSettings`, keyed by caretaker id or `'global'`) so a
  single migration column serves every caretaker in a family.
- **Write**: `updateSettings(patch)` merges + normalizes locally, updates
  React state and a `localStorage` mirror (`nurseryModeSettingsV1`)
  immediately for a responsive UI, then debounces the `POST` by 500ms. A
  focus-triggered refetch is skipped while a save is pending or in flight
  (last-write-wins) so it can't clobber an unsaved edit; an unmount flushes
  any pending save immediately.
- The localStorage mirror lets the drawer render instantly on next load
  before the network round-trip resolves.

## Scenes (`scenes/`)

`SceneBackground` is the only entry point the container uses; it applies the
shared `brightness`/`saturate` filter (from `dim`/`sat`) and dispatches to one
of four scenes by `settings.scene`:

- **Ambient** (`AmbientScene.tsx`) — aurora blobs, rocking waves, or rising
  bubbles (CSS pattern layers), *or* a field of floating sprite outlines when
  `ambient.pattern` is `sprite:<setId>`. Outlines come from
  `useOutlineSprites` (engine/) and are placed with
  `src/utils/nursery/placement.ts::placeOutlineField` (seeded RNG so a
  re-render doesn't reshuffle the field; pure function, unit tested).
- **Starlit** (`StarlitScene.tsx`) — a seeded star field (some twinkle with a
  cross-flare "spark") over a radial night-sky gradient, plus optional aurora
  curtains or a plain scrim.
- **Tapestry** (`TapestryScene.tsx`) — a CSS-pattern or recolored-rug backdrop
  (`scenes/backdropStyle.ts`) plus a `ScatterLayer` of recolored sprite poses
  (primary + accent sets) dart-thrown across it. Recoloring runs through the
  engine's recolor pipeline (below) with the palette's `base`/`colors`.
- **Photo** (`PhotoScene.tsx`) — the selected photo (`useAuthedImage`,
  cover-fit) with a hue-tinted scrim, or the ambient base gradient when no
  photo is set. When `autoTint` is on, it downsamples the loaded image onto a
  64px canvas and calls `dominantTintFromPixels`
  (`src/utils/nursery/dominantColor.ts`, pure/tested) to report a dominant
  tint up to the container for auto icon coloring.

## Recolor engine (`engine/`)

`recolorCache.ts` is the shared caching layer both scenes and the drawer's
sprite/rug pickers use:

- `fetchSvgText(url)` — memoizes raw SVG fetches per URL.
- `recoloredSvgUrl(url, palette)` — recolors via
  `src/utils/nursery/recolorSvg.ts::recolorSvgText` (pure, tested; maps a
  source SVG's grayscale colors verbatim onto `palette`, ranked darkest→lightest
  on both sides — no hue/lightness blending) and caches the resulting blob URL
  per `url|palette` key. Backdrops (rugs) pass `[base, ...colors]` so the base
  color tints the background; scattered sprites pass `colors` only, so the
  base color never bleeds into the "stencil" artwork.
- `outlineSpriteUrl(url, hue)` — rasterizes a transparent-background SVG to a
  canvas, edge-detects + dilates twice, tints the outline to the hue, and
  caches the result per `url|hue`. Used for ambient sprite-outline mode.

Both caches are session-lifetime (never revoked) and self-evict a key on
failure so a later retry can succeed. `useRecoloredAsset` and
`useOutlineSprites` are the React-side wrappers (return `null` until
resolved); `drawer/SpriteThumb.tsx` and `drawer/RugThumb.tsx` use the same
hooks to render live-recolored picker thumbnails.

## Activities (`activities/`)

Each activity returns a shared `ActivityView`
(`id`, `icon`, `label`, `statusText`, `active`, `buttons: ActionButton[]`) so
the container can render either a `ActivityCard` (cards layout) or `BigTile`
(tiles layout) without knowing the activity's internals:

- `useFeedActions` — explicit bottle review and shared breastfeeding timer
  controls, including retained failed-stop review.
- `usePumpActions` — left/right/both timers with resume support.
- `useDiaperActions` — wet/dirty/both instant log.
- `useSleepActions` — location picker → sleeping timer → wake.
- `useFoodActions` — one-tap food-try logging against the family food catalog
  (alphabetical picker with a search field), with a transient after-log
  enjoyment prompt (the FoodForm's Fluent Emoji SVGs) that
  PUTs onto the just-created entry. Off by default (`acts.food`); pure helpers
  live in `src/utils/nursery/foodActivity.ts`.

Bottle, diaper, food, and confirmed sleep Start/Wake actions are undoable
(`onUndoable` → `UndoInfo`). Sleep Undo checks the exact confirmed record
revision before deleting a start or reopening a completed sleep.
`activities/types.ts` also holds `formatMMSS`/`formatHMMSS`
duration formatters shared by the timer-driven activities.

### Sleep failure and retry recovery

`useSleepSession` keeps loading, unknown, active, and pending-review states
separate. A failed initial lookup never becomes an awake child with a Start
button. The active lookup excludes removed and completed records and keeps all
live active rows; multiple timers require care-log review rather than choosing
or deleting one. Reload is explicit and does not rewrite an existing action.

Before dispatch, Start captures a request UUID and its first start time; Wake
captures its first endpoint and the displayed record's opaque revision. The
intent is saved in `localStorage` under family, authenticated actor, and child.
It survives refresh, tab closure, and browser restart on the same browser
profile and origin while that storage is retained. It is not synchronized
across devices, browsers, profiles, or private sessions, and clearing browser
storage removes this recovery copy. Authentication tokens are never included
in the intent.

All intent creation, verification, and removal use a short origin-wide Web
Lock and an exact comparison. A retry cannot recreate an action another tab
has cleared, overwrite a different saved action, or clear a newer action after
a delayed response. The lock covers only synchronous storage access, never the
network request, and lock acquisition is bounded to two seconds. If storage or
Web Locks is unavailable, dispatch is blocked with an explanation; a first
action that could not be saved remains visible in memory. An unreadable saved
action also blocks ordinary timer changes even when the server lookup succeeds.

Requests have a 20-second deadline covering authentication refresh and response
body reading. A rejected, lost, or timed-out response retains the original
action for an explicit retry or review. Waiting never moves its Start or Wake
time. Child, family, or authenticated actor changes invalidate request epochs;
late replies cannot populate another child's timer or local activity summary.
The server separately checks the expected family/actor/child scope against
current authentication, including after token refresh.

Reload reads the current timer and the saved action's target without rebasing
the saved revision. A changed or missing target blocks retry. A missing row or
an already completed Wake is not treated as proof that this request succeeded.
After inspecting the current state and care log, the caregiver can explicitly
discard the action and use the current timer, or dismiss the review. Cards and
Big Tiles keep the frozen time, error, and recovery controls visible. A failed
Undo is retained in this review even after the short Undo toast expires.

The canonical sleep API accepts separate optional nursery metadata:
`nurseryAction`, `expectedScope`, and either `requestId` for Start or
`expectedRevision` for Wake/Undo. Strict parsing separates those keys from care
fields before Prisma. Every canonical sleep response includes a SHA-256
revision of all persisted scalar values, so hook updates and bulk location
renames invalidate stale actions even if `updatedAt` is unchanged.

An explicit nursery Start creates its row and an `ExternalImportRecord` receipt
in one Serializable transaction. Exact retries return only the unchanged live
row; removal, completion, correction, changed ownership, or ambiguous active
timers produce a conflict and never resurrect data. Start and Undo-Wake enforce
the single-active predicate inside their transaction. Wake requires exactly one
active timer. Updates and deletes claim the complete original row snapshot;
failed claims and serialization contention return controlled conflicts. No
request is automatically retried. Engines may abort both competing requests;
the saved intent permits a later explicit retry without allowing two active
timers.

Existing manual/historical callers can continue using their current payloads;
new POST calls without nursery identity remain distinct creates. Their in-flight
updates and deletes also use full snapshot claims, but they do not gain a stale
form baseline unless they send the new metadata. This change does not alter
historical sleep rows, repair ambiguous timers, or add a schema migration.

### Breastfeeding stop recovery

`useBreastfeedSession` owns the shared server timer and a per-tab stop review.
Before sending Stop it captures the displayed session revision, exact side
seconds, the pause gap (including a trailing pause), and the first stop time.
The intent is saved in `sessionStorage` under family, authenticated actor, and
child. It survives a refresh in that tab; it is not a promise of recovery after
the tab or browser is closed. A failed storage write keeps the stop visible in
memory and prevents dispatch.
An unreadable or invalid saved stop also blocks ordinary timer changes, even if
the server session GET succeeds. Explicit Reload rereads scoped storage before
restoring the saved intent and enabling recovery choices.

A failed or uncertain request retains those exact values. Manual Retry sends
the original revision and durations, so waiting does not accrue extra feeding
time or move the second side's span. The server validates the optional expected
scope against current authentication, including after token refresh. A child or
actor switch cannot send another scope's saved stop or apply a late response to
the new view. Cards and Big Tiles keep explicit recovery controls visible.
Requests have a 20-second deadline covering authentication refresh and response
body reading. Timeout aborts the request and releases the controls while keeping
the original stop; it never automatically resubmits.

Reload reads the current server session without rebasing the saved stop. A
changed revision or missing session blocks retry and offers care-log inspection.
After reloading, the caregiver can explicitly discard the stop and use the
current timer, or dismiss a missing-session review after inspecting care logs.
A 404 after a lost response is not confirmation of saving. There is no new
server replay receipt for breastfeeding; another caregiver may have ended or
changed the same timer. A confirmed successful response clears only its exact
local intent.

The JWT and API-key routes share atomic finalization: claim every scalar of the
authenticated session snapshot inside the transaction, then create all side
rows. A failed row insert restores the active session and all original rows;
a competing timer change or end returns a conflict. Timer actions also claim
their complete snapshot and advance `updatedAt` monotonically. Existing
first-side ordering, pause layout, zero-duration behavior, and attribution to
the authorized ending caregiver are retained. New nursery requests carry an
optional expected revision; older callers remain compatible. Duration overrides
must be finite, nonnegative whole seconds that fit the database and Date range.
New sessions also require a live child in the authenticated family; removing a
child does not change the recovery contract for an already active session.

Validation includes real JWT/API-key routes on migrated disposable SQLite,
second-side/delete failure injection, overlapping actions, and compiled-browser
rejected-stop, delayed retry, refresh, lost-response, revision, scope, storage,
and Big Tiles recovery scenarios.

## Drawer (`SettingsDrawer.tsx`, `drawer/`)

The settings drawer is one large component with sections for scene, layout,
per-scene options (ambient pattern/aurora/waves/bubbles/motion, starlit
density/aura, tapestry backdrop/sprites/palette/custom colors, photo picker),
icon shape/color, activity tile toggles, and screen wake lock/fullscreen
controls. `RugThumb`/`SpriteThumb` render live-recolored/outlined preview
thumbnails using the engine hooks above so a color change is reflected in the
picker immediately, not just in the active scene.

## Photo picker (`PhotoPicker.tsx`)

Lists the family's gallery photos (`fetchPhotosEnabled`/gallery API) for
selection as the Photo scene's background, plus upload. Disabled with a
message when the deployment's photos feature flag is off.

## Sprite/rug manifest (`spriteManifest.ts`)

`SPRITE_SETS` (11 sets, 6 poses each except balls' 8 — teddy, kittens,
puppies, unicorns, butterflies, flowers, rockets, cars, balls, stars,
fairies) and `RUGS` (5 paisley/medallion patterns) are static asset
manifests: `{ id, label, poses:
[{ file, label }] }`. `spriteUrl`/`rugUrl` build the `/nursery/...` public
asset paths consumed by the recolor engine. Sprite pose labels are
internal-only (not localized); set/rug `label` fields are run through `t()`
wherever they're displayed as picker names.

## Localization

Every user-facing string goes through `useLocalization()`'s `t()`. Static
labels are called directly (`t('Feed')`); labels sourced from data tables
(sprite sets, rugs, CSS backdrops, sleep locations, feed/diaper/pump type
maps) are looked up dynamically (`t(s.label)`, `t(typeLabels[latest.type])`)
— when adding a new entry to one of those tables, add the matching key to
`src/localization/translations/en.json` first, then run
`node scripts/check-missing-translations.js` to propagate it to the other
languages before translating.

## Reduced motion

Every `@keyframes` animation that moves content (drift, flare, rock,
floatXY, rise, aura curtains, the settings-drawer slide-in) is scoped inside
`@media (prefers-reduced-motion: no-preference)` in `nursery.css`; a couple
also carry an explicit `prefers-reduced-motion: reduce` fallback (e.g. rising
bubbles freeze at a static `--sy` position instead of animating, and the
drawer fades in without sliding). Opacity/color transitions (hover states,
toggle fills) are left unguarded — only translate/rotate/scale keyframe
animation is gated.

## Tests

### Pumping recovery

Nursery pumping stores a draft for the original family, authenticated caregiver
and child. The draft captures its unit and request ID when timing starts. Stop
freezes the wall-clock endpoint; duration is rounded from active seconds, with
zero preserved for very short sessions. A failed validation or definite rejected
write keeps the amounts, timer and selected disposition available for correction.

Before any POST, the exact request is persisted. Network interruption, timeout,
server failure or an unreadable response keeps that request immutable until the
caregiver retries it. Reload and browser restart do not generate a new ID or end
time. A later authentication or validation rejection cannot unfreeze an already
uncertain request. The authenticated API stores a receipt with the pump/feed
transaction and
only replays an unchanged, still-owned record. Changed or deleted records require
care-log review; a receipt survives deletion so a late retry cannot resurrect it.

All scoped draft mutations use Web Locks and recheck the current request ID and
pending payload inside the lock. A late response or stale timer snapshot cannot
overwrite another tab's newer draft or unfreeze a dispatched request. The UI
adopts restored snapshots without writing them back; running timer ticks derive
from persisted resume times without rewriting the draft. Browsers
without Web Locks, and browsers with unavailable local storage, retain the visible
input and block dispatch with an explanation. They cannot promise durable recovery
until those browser capabilities are available. A storage read failure is distinct
from a deliberately removed draft and does not clear the in-memory input.

An old unscoped V1 timer is kept for explicit caregiver and unit review; it is
never silently attributed to whichever caregiver next opens the page. Uncertain
drafts also offer care-log review and a confirmed local dismissal. Dismissal does
not delete any server record or report a successful save.

`tests/nursery-pump-session.test.ts` covers draft validation, scope isolation,
frozen requests, unavailable storage/locks and guarded mutations.
`tests/pumpCreateReplay.integration.test.ts` uses real JWT authorization and a
disposable migrated SQLite database for atomic replay, ownership, tombstones,
rollback and overlapping create requests. `scripts/nursery-pump-browser.mjs`
exercises the real Nursery controls and canonical API with synthetic failure,
restart, expired-auth, response-loss and two-tab scenarios. The release browser
gate requires these checks.

### Quick diaper and food recovery

Each Nursery diaper tap and food selection freezes its original care time,
payload and UUID before sending. The browser keeps one pending action per kind,
family, authenticated actor and child in localStorage. Refresh, closing a tab and
restarting the same browser profile at the same origin retain that action when
storage is available. This does not provide recovery on another device or after
browser storage is cleared. A failed first persistence keeps the input visible
and sends no care request; unreadable saved state blocks new quick actions.

Short Web Locks serialize synchronous create, verify and remove operations.
Network requests never hold these locks. Retry requires the exact existing saved
intent and cannot recreate an action another tab cleared. A late acknowledgement
cannot clear another tab's newer action. If a write succeeded but its read-back
failed, the action is treated as possibly persisted and must also be verified
before delivery. A twenty-second outer deadline bounds authentication refresh,
delivery and response reading; uncertain results keep the original details.

Cards and Big Tiles show the frozen diaper type or food name and the original
time in the configured app timezone, with retry, reload and care-log review.
Local dismissal becomes available after opening review; it does not delete a
canonical record or claim that an uncertain save failed. Owner and request
generations prevent late results from changing another child's UI or Undo.
Deliberate new UUID actions remain distinct even when their times and contents
match. Time/content similarity is never used to infer a duplicate event.

Only POSTs with the optional strict request identity use this recovery contract.
Their quick payload is limited to child/time/diaper type or child/time/food ID;
manual and older scope-only clients preserve their existing behavior. A
write-first Serializable transaction saves the canonical row and a durable
ExternalImportRecord receipt together, validates live relationships before
commit, and returns a controlled conflict during database contention. The receipt
survives deletion. Replay reconstructs every original persisted scalar from the
canonical first payload and receipt timestamp, then compares the full generated
revision inventory. An unchanged replay returns the same original Undo
descriptor. Changed, moved, deleted or revised rows require review and never gain
a fresh Undo baseline or a replacement record. Notifications occur only on the
first diaper creation. Food's optional enjoyment action retains its separate
conditional Undo contract below.

`tests/nurseryQuickCare.integration.test.ts` uses real ordinary-caregiver login,
migrated disposable SQLite, receipt failure rollback and separate connections,
including subsequent writes and reads through both adapters after contention.
`nursery-quick-care-intent.test.ts` and `nursery-quick-care-request.test.ts` cover
immutable storage, owner isolation, exact acknowledgement and complete deadlines.
The compiled `scripts/nursery-quick-care-browser.mjs` gate exercises the actual
controls and lost-success-response recovery; it uses synthetic care only.

### Conditional Undo

Nursery diaper, food, bottle, completed breastfeeding and pumping writes return
an Undo descriptor for their original authenticated owner and exact saved scalar
values. The existing DELETE routes accept that strict descriptor as an optional
precondition. Bodyless manual deletes keep their existing behavior. Undo never
fetches a newer row to replace its original baseline. Bottle and pump receipt
replays confirm the save without issuing a new Undo descriptor.

Breastfeeding Undo claims the complete original one- or two-side group in one
transaction. Pump Undo also claims the original linked feeding row, or verifies
that no feeding row existed. Changes to either member, group membership, ownership
or the child prevent the whole deletion. Food's immediate enjoyment update is
conditional on the same original descriptor and advances Undo only after its own
update is confirmed. Receipts survive deletion.

The view checks caregiver, child and request generation before applying late
callbacks. A newer activity summary is not cleared by an older Undo response.
Unattempted toasts expire after six seconds; an in-flight or failed Undo remains
visible with explicit retry or care-log review. A twenty-second deadline covers
the request, any shared authentication refresh and response reading; a late
refresh cannot dispatch the aborted original deletion. Later saves do not replace
that retained descriptor. A missing row on retry remains a review outcome, including
when a successful deletion's response was lost.

`tests/nurseryUndo.test.ts` covers strict metadata and transport outcomes.
`tests/nurseryUndo.integration.test.ts` uses real USER logins, migrated SQLite,
independent Prisma clients, peer corrections, transaction rollback and fresh
transactions through both clients after contention. The seventeen scenarios in
`scripts/nursery-undo-browser.mjs` exercise actual compiled Nursery controls;
the release gate requires `nurseryUndoChecksPassed`.

Pure logic extracted to `src/utils/nursery/` is covered in `tests/`:

- `nursery-settings.test.ts` — `normalizeNurserySettings` clamping/coercion.
- `nursery-color-math.test.ts` — `colorMath.ts` (hsl2hex, autoIconColor, etc).
- `nursery-dominant-color.test.ts` — `dominantColor.ts` (photo auto-tint).
- `nursery-recolor-svg.test.ts` — `recolorSvg.ts` (palette substitution).
- `nursery-placement.test.ts` — `placement.ts` (seeded outline-field layout).
- `nursery-backdrop-style.test.ts` — `scenes/backdropStyle.ts` (CSS pattern
  generation for tapestry backdrops).
- `nursery-photo-scene.test.ts` — `PhotoScene`'s `photoIdFromSrc` helper.
- `nursery-food-activity.test.ts` — `foodActivity.ts` (picker sorting, meta-line note).
- `nursery-activity-freshness.test.ts` — `activityFreshness.ts` (24 h meta-line cutoff).

The compiled browser acceptance modules cover the recovery and Undo interactions.
There is no separate React-render test harness for this feature.
