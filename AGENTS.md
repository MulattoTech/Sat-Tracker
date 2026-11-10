# Canonical BabyTracker repository
This repository owns the application, deployment, product issues and roadmap.
Application code is in `application/`; read `application/CLAUDE.md` before editing it.
Run npm/Prisma/Next.js commands with `application/` as the working directory.
Use root `compose.yaml` for the existing production deployment. Preserve all three
`babytracker-sprout-*` volumes. Never use `docker compose down -v`.
Controller implementation belongs ONLY in MulattoTech/Fleet-Control-Hub.
Do not add controllers here or develop against the retired BabyTracker-App repository.
Never commit .env, family records, backups, runtime state, credentials or transcripts.
