# ADR-0025: Privacy, Encryption-at-Rest, Attachment Retention, and Sensitive-Document Controls

- **Status**: Accepted
- **Deciders**: MulattoTech Engineering Orchestrator / BabyTracker Core Team
- **Date**: 2026-11-01
- **Context**: Issue #25: [BabyTracker] Privacy, encryption, attachment retention, and sensitive-document controls
- **Applies to**: Application layer (`application/`), OCR subsystem (`application/src/lib/ocr/`), attachment storage (`Files/`), database and backup procedures.

---

## 1. Context and Problem Statement

BabyTracker (Sprout Track) manages sensitive household and infant care telemetry:
- Feeding events (volume, formula/breast milk, donor milk, notes)
- Diaper changes (type, stool consistency, alerts)
- Sleep sessions (start/end, duration, night vs. nap)
- Growth measurements (head circumference, length, weight)
- Medical records, medications, and vaccination records (with medical documentation attachments)
- Photos and milestones (intimate family images)
- Raw uploaded source documents (scanned pediatric logs, hospital intake sheets, daily nanny journals via OCR)

BabyTracker installations run in two primary operational topologies:
1. **Self-Hosted Local Area Network (LAN)**: Private household networks running on local hardware (Raspberry Pi, NAS, homelab mini-PC) via Docker Compose. May be accessed by shared family tablets, smartphones, and guest devices without external routing.
2. **Internet-Exposed Deployments**: Publicly accessible deployments routed through zero-trust tunnels (e.g., Cloudflare Tunnel with `mtechlabs-service-hub`), reverse proxies (Nginx/Traefik), fronted by identity-aware edge proxies (Cloudflare Access) and TLS termination.

Without rigorous defense-in-depth, sensitive family data faces critical security threats:
- Unauthorized lateral access between multiple families hosted on the same instance.
- Insecure direct object reference (IDOR) attacks allowing cross-family attachment leakage.
- Unencrypted storage of raw uploaded PDFs/images on disk leading to data exfiltration via media theft or backups.
- Unbounded retention of raw source documents containing protected health information (PHI) long after events are extracted.
- Malicious payload injection (polyglot files, SVG cross-site scripting, HEIF decompression bombs, oversized DoS vectors).
- Credential leakage through query strings, logs, or unencrypted backups.

This ADR formalizes the security and privacy architecture, threat model, cryptographic strategy, retention lifecycle, attachment authorization controls, and backup/restore requirements.

---

## 2. Threat Model

### 2.1 Assets to Protect

| Asset | Sensitivity | Primary Threat Vectors |
| :--- | :--- | :--- |
| **Infant Care Timeline** | High (PHI / Privacy) | Lateral cross-family read, unauthenticated data tampering |
| **Attachment Files (Photos, Vaccines, Feedback)** | Critical (PII / Health) | IDOR retrieval, directory traversal, unencrypted disk harvesting |
| **OCR Source Scans & Page Previews** | Critical (Raw PII / PHI) | Unbounded retention, disk theft, cross-family leakage |
| **Credentials & Secrets (`ENC_HASH`, JWT, PINs)** | Critical (System Access) | Log leakage, unmasked error traces, unsecured backups |
| **Audit Trails (`OcrAudit`, `ExternalImportRecord`)**| High (Integrity) | Ledger tampering, replay attacks, repudiation |

---

### 2.2 Threat Vectors & Mitigations: Self-Hosted LAN vs. Internet-Exposed

```
                       +-------------------------------------------------+
                       |            Internet-Exposed Boundary            |
                       | (Cloudflare Access / Zero-Trust Tunnel / TLS)  |
                       +-------------------------------------------------+
                                                |
                                                v
+------------------------+             +------------------+             +------------------------+
|   LAN Client (Local)   | ----------> | Next.js App / API| <---------- | Internet Client (Edge) |
| (Home Wi-Fi, Tablets)  |             |  (JWT Auth & RBAC|             | (Capacitor App, Browser|
+------------------------+             +------------------+             +------------------------+
                                                |
                                                v
                               +----------------------------------+
                               |    Attachment & Crypt Boundary   |
                               | (AES-256-GCM + Family Scoping)   |
                               +----------------------------------+
                                  /            |             \
                                 v             v              v
                       +--------------+  +------------+  +-----------------+
                       | SQLite / PG  |  | Encrypted  |  | Retention Sweep |
                       | (Sealed AAD) |  | Disk Store |  | (Auto-Purge)    |
                       +--------------+  +------------+  +-----------------+
```

#### Topology A: Self-Hosted LAN Deployments
- **Threat A1: Eavesdropping on unencrypted Wi-Fi**:
  - *Risk*: Plaintext HTTP on local subnets can expose session tokens and downloaded medical records to untrusted IoT devices or guest networks.
  - *Mitigation*: HTTPS recommendation; token authentication (`Authorization: Bearer <jwt>`) with restricted lifetimes (`AUTH_LIFE`); native Capacitor shells strictly enforce HTTPS when communicating over network boundaries.
- **Threat A2: Physical device / media theft**:
  - *Risk*: Direct extraction of the host hard drive or SD card exposing raw attachments in `Files/`.
  - *Mitigation*: **Encryption-at-rest**. Every stored attachment on disk is encrypted with AES-256-GCM prior to filesystem write. The encryption key (`ENC_HASH`) is held in environment memory and an isolated persistent volume (`babytracker-sprout-env`), completely segregated from files (`babytracker-sprout-files`).
- **Threat A3: Shared household device / accidental exposure**:
  - *Risk*: A babysitter or relative using a shared tablet views medical documents or historical scan sources outside their scope.
  - *Mitigation*: Role-based access control (RBAC); caretaker role restrictions (OWNER, ADMIN, REGULAR); system caretakers automatically disabled upon caretaker provisioning; automatic screen relock via `IDLE_TIME`.

#### Topology B: Internet-Exposed Deployments
- **Threat B1: Cross-family IDOR (Insecure Direct Object Reference)**:
  - *Risk*: An attacker with a valid account in Family A crafts requests to `/api/photos/file/[id]`, `/api/vaccine-log/file/[id]`, or `/api/ocr/documents/[id]/source` to fetch Family B's attachments.
  - *Mitigation*: **Golden Rule Enforcement**. Client-supplied family IDs or path parameters are NEVER trusted for authorization. The authenticated JWT context (`authContext.familyId`) is the sole authority. All database queries enforce `{ where: { id, familyId: authContext.familyId } }` (or relation join `{ vaccineLog: { familyId } }`). Any unauthorized access returns `404 Not Found` (never revealing resource existence).
- **Threat B2: Malicious file upload and execution**:
  - *Risk*: Uploading executable binaries, SVG files containing `<script>` tags, polyglot PDFs, or decompression bombs (HEIF/AVIF).
  - *Mitigation*:
    - Magic-byte sniffing (`identifyDocumentBytes`, `identifyOcrUpload`) verifying genuine binary signatures (`%PDF`, PNG, JPEG, WebP) independent of client `Content-Type` headers.
    - Explicit rejection of HEIF/AVIF containers before image decoders are reached (`isHeifContainer`).
    - Bounded file size caps (max 10MB for attachments; max 12MB for OCR).
    - Hardened response headers: `Content-Security-Policy: sandbox; default-src 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Cache-Control: private, no-store`.
- **Threat B3: Denial of Service via OCR resource exhaustion**:
  - *Risk*: Uploading complex PDFs or thousands of scanned pages to monopolize server CPU/memory.
  - *Mitigation*: Concurrency slot acquisition (`acquireOcrSlot`) limiting concurrent recognition jobs per family and globally; PDF page bounds (max 6 pages per batch, max 10 for single-page selection); kernel-level resource bounds via Linux `prlimit` (address space limited to 768MB, CPU time capped at 25s, output file size capped at 64MB).
- **Threat B4: Long-term exposure of sensitive source documents**:
  - *Risk*: Uploaded daily intake sheets or medical papers remain on disk indefinitely after data entry.
  - *Mitigation*: **Configurable source retention policy & secure purge/redaction workflow**. Automatic lifecycle expiration sweeps and immediate post-import deletion (`purgeSourceAfterCommit`).

---

## 3. Cryptography & Encryption-at-Rest Architecture

### 3.1 Encryption Algorithm and File Storage Format

All attachment files (Photos, Vaccine Documents, Feedback Attachments, OCR source uploads, and OCR rendered preview images) are encrypted before writing to persistent storage.

- **Cipher**: AES-256-GCM (Authenticated Encryption with Associated Data).
- **Key Derivation & Handling**:
  - Key is read from `ENC_HASH` environment variable.
  - Must be a 32-byte (256-bit) cryptographically random hexadecimal string (64 hex characters).
  - Validated on application startup; if missing or malformed, encryption/decryption routines throw immediately, preventing silent unencrypted fallbacks.
- **Binary Disk Format**:
  Stored files are named with random UUIDs (`<uuid>.enc`) and formatted as:
  ```
  +-------------------+----------------------+---------------------------------+
  | IV / Nonce        | Authentication Tag   | Ciphertext                      |
  | 16 bytes (random) | 16 bytes (GCM tag)   | Variable length (N bytes)       |
  +-------------------+----------------------+---------------------------------+
  ```
- **Integrity Guarantee**:
  Any bit-level tampering, truncated data, or corrupt ciphertext causes AES-GCM tag verification to fail during `createDecipheriv`, throwing an explicit error rather than emitting corrupted plaintext.

### 3.2 Sealed Database State & Authenticated Additional Data (AAD)

Intermediate OCR review states, original extractions, and ledger audit snapshots in SQLite/PostgreSQL are sealed using AES-256-GCM with scope-bound AAD:
- **Format**: `v1.<iv_base64>.<tag_base64>.<ciphertext_base64>`
- **AAD Binding**:
  - Document Scope: `${familyId}:${documentId}:${kind}` (e.g. `fam-123:doc-456:original`, `fam-123:doc-456:review`, `fam-123:doc-456:audit`).
  - Cryptographic invariant: A sealed record cannot be copied, spliced, or injected into another family or another document. Attempting to decrypt under a mismatched family or document ID fails GCM authentication.

---

## 4. Configurable Retention Policy & Secure Purge/Redaction Workflow

### 4.1 Configurable Retention Policies

BabyTracker enforces automated and manual data minimization:
1. **Configurable OCR Retention**:
   - On upload, users configure retention duration (`retentionDays`: 0 to 365 days; default 30 days).
   - Setting `retentionDays: 0` or specifying `purgeSourceAfterCommit: true` triggers immediate deletion of raw source files upon successful reconciliation.
   - Unimported drafts expire after the configured window (with a 1-hour grace period for active sessions).
2. **Photo Trash Retention**:
   - Photos placed in Trash are held for `TRASH_RETENTION_DAYS` (30 days) before permanent unlinking, allowing recovery from accidental deletion.

### 4.2 Automated Lifecycle Maintenance (Sweeper)

- `sweepOcrRetention(db, now)` runs automatically in the background (10-second initial delay, recurring every 5 minutes):
  1. Identifies all documents where `sourceExpiresAt <= now` and `sourceFile != null`.
  2. Transactionally claims document rows, setting `sourceFile = null`, `previewFiles = '[]'`, `purgedAt = now`.
  3. Records an immutable audit ledger entry: `action: 'retention-purge'` with sealed snapshot.
  4. Unlinks physical encrypted files (`.enc`) from storage.
  5. Scans storage directory for orphan `.enc` files older than 1 hour (unreferenced by any live database row) and removes them.
- `purgeExpiredPhotos(familyId)` lazily purges trashed photos older than 30 days during photo list and upload actions.

### 4.3 Secure Post-Import Purge & Redaction

When an OCR document is reviewed and committed:
- **Decoupled Architecture**: Canonical care events (`FeedLog`, `DiaperLog`, `SleepLog`) and import provenance records (`ExternalImportRecord`) are stored in the core care database.
- **Immediate Post-Import Purge**:
  - Users can enable "Purge raw source document and page images immediately after successful import" in the UI.
  - When enabled, `commitOcrReview` transactionally creates canonical timeline events, logs the `commit` audit, and immediately unlinks all encrypted source/preview files from disk, setting `sourceFile: null`, `previewFiles: '[]'`, and `purgedAt: new Date()`.
  - An append-only audit event (`action: 'purge-source'`, reason: `'auto-purge-on-commit'`) is recorded in `OcrAudit`.
  - Canonical timeline records remain 100% intact and queryable on the infant's timeline.
- **Dedicated Redaction Workflow**:
  - `redactOcrDocument(db, actor, id, options)` allows authorized administrators to redact sensitive clinical notes, names, or remarks in document review states (`notes: '[REDACTED]'`, `rawText: '[REDACTED]'`) and immediately purge raw source binaries.
  - An audit record with `action: 'redact'` logs the action and timestamp without retaining sensitive PII.

---

## 5. Attachment Access Authorization

### 5.1 Strict Family & Caretaker Scoping

All endpoints serving binary data enforce authenticated family scoping:

| Endpoint | Authorization Rule | Scope Check |
| :--- | :--- | :--- |
| `GET /api/photos/file/[id]` | `withAuthContext` | `Photo.familyId === authContext.familyId` |
| `GET /api/vaccine-log/file/[id]` | `withAuthContext` | `VaccineDocument.vaccineLog.familyId === authContext.familyId` |
| `DELETE /api/vaccine-log/file/[id]`| `withAuthContext` | `VaccineDocument.vaccineLog.familyId === authContext.familyId` |
| `GET /api/feedback/file/[id]` | `withAuthContext` | Feedback creator or admin (`accountId` / `caretakerId`) |
| `GET /api/ocr/documents/[id]/source` | `ocrRoute` | `OcrDocument.familyId === actor.familyId` && `Baby.familyId === actor.familyId` |
| `POST /api/ocr/documents/[id]/commit`| `ocrRoute` | Admin/Owner caretaker in `actor.familyId` |
| `DELETE /api/ocr/documents/[id]` | `ocrRoute` | Admin/Owner caretaker in `actor.familyId` |
| `POST /api/ocr/documents/[id]/redact`| `ocrRoute` | Admin/Owner caretaker in `actor.familyId` |

### 5.2 Defense-in-Depth Response Headers

All served attachments include strict isolation headers:
- `Content-Security-Policy: sandbox; default-src 'none'`: Prevents browser execution of scripts or HTML even if a file contains embedded active content.
- `X-Content-Type-Options: nosniff`: Prevents MIME type sniffing by the browser.
- `Cache-Control: private, no-store`: Disables intermediate proxy and browser caching of sensitive medical documents.
- `Referrer-Policy: no-referrer`: Prevents leaking document paths in HTTP referrer headers.

---

## 6. Secrets Handling and Backup/Restore Strategy

### 6.1 Secrets Segregation
- Credentials (`ENC_HASH`, `JWT_SECRET`, database connection passwords) are supplied exclusively via environment variables or protected configuration files (`.env`).
- Never committed to Git repositories (enforced via `.gitignore`, pre-commit hooks, and CI checks).
- In Docker production environments:
  - `babytracker-sprout-db`: Holds SQLite / database state.
  - `babytracker-sprout-files`: Holds encrypted `.enc` attachments.
  - `babytracker-sprout-env`: Holds runtime secrets including `ENC_HASH`.
- All three volumes must be preserved during updates and migrations. Never execute `docker compose down -v`.

### 6.2 Backup & Restore Integrity
- **Key Coupling**: A database backup containing encrypted `originalState`/`reviewState`/`snapshot` data and a file backup containing encrypted `.enc` files are useless without the corresponding `ENC_HASH`.
- **Backup Standard**:
  - Backup procedures (`scripts/promote-release.ps1`, backup scripts) must securely back up `ENC_HASH` alongside the database and `Files/` volume.
  - Restore procedures must verify `ENC_HASH` integrity (`sealOcrState({}, 'configuration-check')`) upon startup before opening services to clients.
  - If a restore is attempted with a missing or incorrect `ENC_HASH`, the system immediately fails fast with a descriptive configuration error, preventing unauthenticated access or ciphertext corruption.

---

## 7. Verification and Testing

Automated tests in `application/tests/` verify the security invariants:
1. `tests/sensitive-document-controls.test.ts`:
   - Enforces family isolation for photos, vaccine documents, feedback, and OCR sources (verifying cross-family 404 rejections).
   - Verifies encryption-at-rest format on disk and GCM tamper rejection.
   - Verifies automatic post-import purge (`purgeSourceAfterCommit`) deletes raw disk files while preserving canonical timeline records and audit receipts.
   - Verifies lifecycle retention pruning (`sweepOcrRetention`) and orphan encrypted file cleanup.
   - Verifies document upload validation rejecting spoofed MIME types, HTML scripts, and size violations.
   - Verifies backup/restore encryption key requirements.
2. `tests/ocr-import.integration.test.ts`:
   - Validates the complete pipeline: upload -> encrypted storage -> review correction -> canonical import -> source purge -> audit verification.
