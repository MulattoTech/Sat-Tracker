# Stock-upstream deployment is retired; never silently replace the maintained app.
param([string]$Version)
throw 'Direct stock Sprout image updates are disabled. Review upstream releases, merge accepted changes into BabyTracker, then run scripts/update-babytracker.ps1 -Build from a clean accepted checkout. Existing production volumes must be preserved.'
