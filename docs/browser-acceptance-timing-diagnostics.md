# Sat-Tracker synthetic browser acceptance phase timings

**Source-only instrumentation. No private data, Docker access, backup or deployment.**

The canonical browser acceptance process may reach its existing 600-second
subprocess deadline before completing all 186 browser/API checks. The
release-gate coordinator already fails closed on such a timeout. See
GitHub issue #119 for the observed problem and complete test evidence.

This source package adds a narrow, synchronous, test-only diagnostic file:

    application/test-results/acceptance-browser-timing.jsonl

Each JSON line contains only a fixed source-defined module name, a start,
pass or fail event, a monotonic elapsed-millisecond count, and (for
completed modules) a duration count. No fixtures, care events, credentials,
child identities, URLs, family names, arguments or exception messages are
recorded. The synthetic fixture creates the file at run start and appends
events synchronously. Therefore if the parent kills a slow child process,
the last unmatched "start" event can identify which module was executing.

The timing helper is constrained to the synthetic browser suite. It wraps
the existing module calls without skipping, parallelizing, repeating or
altering their assertions and returned check arrays. The original timing
limits, cleanup behavior, privacy/family-boundary checks, 34 service tests,
186 browser/API checks and 12 photo-browser checks remain unchanged. The
CI workflow also runs six small dependency-free timing recorder unit tests
before the existing npm test, build and release-gate steps.

The diagnostic trace should be treated as approximate performance evidence,
not as proof of which individual assertion is slow. Time spent before a
module starts or in module cleanup may appear under the initial or cleanup
phase. Compare traces from multiple source-identical hosted runs before
modifying any test or CI execution plan.

## Release controls

Do not increase acceptance timeouts, relax ownership/privacy checks, delete
failing tests, suppress an incomplete artifact or represent a timed-out
browser run as success. A full green application source gate still requires
all expected checks and its exact source-bound synthetic report, with
deploymentAcceptance equal to NOT_RUN.

No real production backup, restore, container restart, protected preview
modification or hotfix promotion is enabled by this instrumentation.
