# ChildAgeDisplay

Displays separately labelled chronological and corrected ages using the canonical
`calculateChildAge` helper. Pass `birthDate`, optional `gestationalAgeDays`, and the
explicit IANA `timeZone` from the existing timezone context. Optional `asOf` supports
historical displays. The component never alters stored birth timestamps.

```tsx
<ChildAgeDisplay
  birthDate={baby.birthDate}
  gestationalAgeDays={baby.gestationalAgeDays}
  timeZone={userTimezone}
/>
```

Unknown gestation displays “Not recorded”. Term births display “Not applicable”
for corrected age. Before the derived due date, the display gives the interval
remaining instead of clamping a negative corrected age to zero. Invalid input
displays “Age unavailable”.

`formatChildAgeSpan` uses the helper's completed calendar-month and calendar-year
values: weeks and days below six months, months and days below two years, then
years, months and days. `Intl.NumberFormat` and `Intl.ListFormat` provide localized
units and plurals. No average month/year durations are used.

The output uses spans so it can appear inside the child selector button. Optional
`id` lets that button refer to the ages using `aria-describedby`. Stable test IDs
are `child-age-display`, `chronological-age`, and `corrected-age`.
