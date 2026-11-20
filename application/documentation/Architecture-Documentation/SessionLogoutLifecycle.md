# Browser session logout lifecycle

The family application, Nursery provider and account button share one logout
operation per browser document. The first caller captures the original session,
destination and authentication-key list synchronously. Other callers join that
operation; they do not send another request or own another navigation.

This closes a reproduced application race. A failed authenticated request could
schedule an automatic logout while a caregiver clicked ordinary Logout. The
manual request exposed the next login page; a later automatic response then
replaced that page, losing a committed PIN digit. A separate controlled case
showed the same old response clearing a newer USER's browser authentication and
refresh cookie while that USER's explicit bearer remained authorized. These
controlled traces reproduce the CI symptom; the failing CI did not record the
request ordering itself.

## Ownership and ordering

`session-lifecycle.ts` tracks token/caregiver changes with a document generation.
Normal token refresh stays in the same generation. New logins and a claimed
logout invalidate older request continuations. Activity timestamps are not
session identity. The family fetch interceptor owns and cancels its delayed
logout timers, and rechecks both request ownership and the current login path
before refresh, replay or logout. A caller-aborted care request is never replayed.

An existing refresh must settle before the single logout POST, because its HTTP
response can rotate a cookie even when its JavaScript token result is ignored.
Only an explicitly claimed logout bounds that drain to 15 seconds and aborts
the original refresh if needed. Ordinary refresh keeps its existing caller
deadlines and cookie-only behavior. Logout itself has a separate 15-second
deadline covering fetch and its body; a timeout aborts the request before
recovery controls become available.

Network failure leaves an explicit retry using the original session and
destination. Returning to sign-in after failure is a deliberate local sign-out;
the UI does not claim that the server confirmed it. Only the established
authentication keys are removed. Scoped care drafts, journal storage and other
family data are retained.

## Navigation and limits

The old document remains noninteractive through full document navigation. Main
manual logout now uses the same document-navigation boundary as automatic
logout. Existing PIN/account destinations and native-shell handoff remain.
Assigning a location does not release the claim. If the destination does not
open within 15 seconds, an explicit return-to-sign-in control remains available
without another logout POST. Native destination helpers have source tests;
this change does not claim new native-device acceptance.

This is same-document coordination, not a cross-tab cookie lock. It does not
change authentication endpoints, roles, server authorization or session schema.
An obsolete refresh encountered after a generation change is aborted and fails
closed without issuing a follow-up refresh or installing another token. A caller
that already needed refresh may therefore require sign-in again. The client
does not infer a new actor's identity from an uncertain existing refresh cookie.

The parent-owned account drawer also hides and synchronously rejects new
submissions while logout is claimed. A login request already in flight before
the logout claim is outside this slice's cookie-ordering guarantee; the UI gate
does not qualify that separate interleaving.

## Regression coverage

Focused lifecycle/interceptor tests cover single ownership, stale responses and
timers, refresh rotation, cookie-only refresh compatibility, bounded aborts,
body hangs, explicit retry, original-owner guards, retained care keys and
navigation recovery. Existing session and native destination tests also run.

`logout-lifecycle-browser.mjs` adds five compiled synthetic browser checks with
real USER login and real logout/refresh endpoints. It exercises the controlled
response ordering, current-session rejection, next-user cookie validity,
request abortion, recovery and navigation boundary. The required
`logoutLifecycleChecksPassed` flag prevents skipping these checks. With the
existing acceptance modules, the source runtime gate contains 164 checks:
157 browser checks and seven explicitly authenticated HTTP checks. Deployment
acceptance remains a separate gate.
