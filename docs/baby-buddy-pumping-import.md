# Baby Buddy pumping import timing

New pumping imports resolve both source endpoints to actual instants before
calculating duration. Naive timestamps use the caregiver-selected source timezone;
an explicit `Z` or UTC offset identifies its own instant. Seconds and up to three
fractional-second digits survive in `PumpLog.startTime` and `endTime`.

The existing `PumpLog.duration` contract remains integer minutes, rounded to the
nearest minute after subtracting those instants. For example, Chicago
`2026-03-08 01:55:10` to `03:05:20` spans 610 elapsed seconds across spring DST
and stores 10 minutes, with both exact endpoints retained. No schema migration or
automatic historical correction accompanies this change.

- Invalid calendar dates, missing endpoints, nonexistent local times and ambiguous
  repeated local times are rejected. For a repeated local hour, provide the source
  UTC offset to identify which occurrence was recorded.
- End-before-start is rejected before rounding, including a reversal shorter than
  one minute. Durations outside the signed 32-bit minute field are rejected.
- The CSV mapper does not invent a duration before source-zone resolution. An
  optional duration on the internal import record must match the rounded elapsed
  minutes when supplied.
- A rejected new row aborts its transaction, preserving existing records and
  preventing partial pumping, feed, stock or provenance changes.
- Family-scoped source replay identity is unchanged. Already imported records are
  returned as duplicates; their dates, historical duration, disposition and
  caregiver corrections are not rewritten. An unrelated edit also preserves
  untouched historical timing.
- Imported disposition remains `UNKNOWN`. This timing correction creates no
  stored inventory or feeding record and does not infer what happened to the milk.

Regression coverage lives in `babyBuddyPumpingTime.test.ts`,
`babyBuddyPumpingDisposition.integration.test.ts` and the existing pumping browser
acceptance flow. Shared timestamp-resolution behavior remains covered by the
feeding tests. The browser fixture includes an actual spring-DST import through
the wizard, canonical API and database. These synthetic checks do not establish
complete Baby Buddy parity or acceptance of an actual family export.
