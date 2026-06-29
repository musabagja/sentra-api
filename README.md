# Sentra API

REST API for managing SIM card stock, opname (stock-taking), and distribution across checkpoints.

---

## What's New — 2026-05-25

### SQL Server support
- Default database is now **Microsoft SQL Server** (`DATABASE_PROVIDER=sqlserver`)
- PostgreSQL still supported — set `DATABASE_PROVIDER=postgresql` in `.env`
- All enum fields converted to `String` with application-level validation (SQL Server has no native enum support)
- All Prisma relations use `onUpdate: NoAction, onDelete: NoAction` to satisfy SQL Server's cascade restriction

### Port changed to 3000
- API now listens on `PORT=3000` by default

### Session-bound access tokens
- Access tokens now embed the session ID in the JWT payload
- Every authenticated request verifies the session still exists in the database — sign-out immediately invalidates outstanding access tokens (no 15-minute grace window)

### Bug fixes
- `DELETE /api/stock/cards/:key` — was incorrectly looking up by `id`; fixed to use `key`
- `PUT /api/stock/batches/close/:id` — crash when body was empty; fixed with safe destructure
- `POST /api/stock/cards/validate/:key` — cards already validated could be re-validated; now returns `409`
- `GET /api` health check — was blocked by auth middleware; moved before `Auth.authenticate`
- `POST /api/opname` — missing `checkpointCode` returned misleading `404`; now returns `400 checkpointCode is required`
- `GET /api/checkpoint` — non-deterministic ordering on SQL Server; changed to `ORDER BY id ASC`

### Dashboard — month/year filter and monthly breakdown
- `GET /api/stock/dashboard` now accepts `?month` and `?year`
- All data is cumulative from the start up to the end of the requested month (or today if the current month is requested)
- Response includes `distributedToDCByMonth` and `distributedToStoreByMonth` — 12-element arrays covering January through December; months after the cutoff are `0`

### New dashboard chart endpoints
- `GET /api/stock/dashboard/dc-distribution` — monthly DC distribution chart; filter by `year` only (cutoff = today or Dec 31)
- `GET /api/stock/dashboard/store-distribution` — monthly store distribution chart; filter by `year` only (cutoff = today or Dec 31)

---

## What's New — 2026-05-22

### Card status lifecycle — new `DELIVERY` and `OPNAME` statuses
- `HOLD` is replaced by `DELIVERY` for cards reserved in a distribution
- New `OPNAME` status: all `VERIFIED` cards at a checkpoint are set to `OPNAME` when an opname session starts
- Card status flow: `UNVERIFIED → VERIFIED → SOLD | BROKEN | LOST | DELIVERY | OPNAME`

### `POST /api/opname` — scopes cards on creation
- All `VERIFIED` cards at the checkpoint are atomically set to `OPNAME` when the session is created
- `amount` is derived from an actual `COUNT(VERIFIED)` at creation time

### `PATCH /api/opname/:id` — only accepts `OPNAME` cards
- Rejects any card that does not have `OPNAME` status
- Stock is decremented on scan only for `BROKEN`/`LOST` results

### `PATCH /api/opname/:id/close` — full status resolution
- Scanned `OK` → `VERIFIED`; scanned `BROKEN` → `BROKEN`; scanned `LOST` → `LOST`
- Unscanned `OPNAME` cards are auto-marked `LOST` with stock decremented

### `PUT /api/opname/:id` (cancel) — full rollback
- All `OPNAME` and already-scanned `BROKEN`/`LOST` cards restored to `VERIFIED`
- Stock restored for every `BROKEN`/`LOST` scan

### `GET /api/stock/dashboard` — top sales stats
- `topHighestSaleByCheckpoint` — top 10 STORE checkpoints by total SIM card sales
- `topHighestSaleByUser` — top 10 users by total SIM card sales

---

## Stack

| | |
|---|---|
| **Runtime** | Node.js + TypeScript |
| **Framework** | Express |
| **ORM** | Prisma 7 (SQL Server default, PostgreSQL supported) |
| **Auth** | JWT via HTTP-only cookies (access 15 min, refresh 7 days, session-bound) |
| **Default port** | 3000 |

## Getting Started

> **Requires pnpm 10+** (`pnpm --version`). Install/upgrade with `npm i -g pnpm`.

```bash
pnpm install          # build scripts (bcrypt, prisma) run automatically — see note below
npx prisma generate
pnpm run dev          # development
```

### Production deploy

```bash
pnpm install
npx prisma generate
npx prisma migrate deploy   # apply DB migrations
pnpm run build              # compile TypeScript -> dist/
pnpm start                  # node dist/server.js
```

### ⚠️ `ERR_PNPM_IGNORED_BUILDS` on install

If you see `Ignored build scripts: @prisma/engines, bcrypt, esbuild, prisma, protobufjs`,
the dependency build scripts did **not** run — the app will crash at runtime because
`bcrypt`'s native binary and the Prisma query engine are missing.

This repo allowlists those packages in **`pnpm-workspace.yaml`** (the location pnpm 10
reads), so a fresh `pnpm install` runs them with no prompt. If the warning still appears
on a stale server checkout:

```bash
git pull                 # make sure pnpm-workspace.yaml is present
pnpm approve-builds      # approve the listed packages, then reinstall
pnpm install
```

The deprecated-`supertest` warnings are harmless — it is a test-only dependency and is
not used in production.

Copy `.env.example` to `.env`. Required variables:

| Variable | Description |
|---|---|
| `DATABASE_URL` | SQL Server: `sqlserver://HOST:PORT;database=DB;user=U;password=P;encrypt=true;trustServerCertificate=true` |
| `DATABASE_PROVIDER` | `sqlserver` (default) or `postgresql` |
| `PORT` | API port, default `3000` |
| `JWT_SECRET` | Secret for signing tokens |
| `COOKIE_SECRET` | Secret for signed cookies (production) |
| `NODE_ENV` | `development` or `production` |

---

## Authentication

All routes except `/api/user/auth/*` require a valid `access_token` cookie. Tokens are set automatically on sign-in and refreshed via the refresh-token endpoint. **Sign-out immediately invalidates the access token** — the session ID embedded in the token is deleted from the database.

---

## API Reference

Base URL: `/api`

### Conventions

| Field | Detail |
|---|---|
| All responses | `{ message, data: { ... } }` |
| Paginated responses | `{ message, data: { ... }, pagination: { page, limit, total, pages } }` |
| Errors | `{ message }` with appropriate HTTP status |
| Auth | HTTP-only cookie (`access_token`) required on all routes except `/user/auth/*` |
| File uploads | `multipart/form-data` |

---

## User / Auth

> No authentication required

### `POST /api/user/auth/sign-in`

**Body**
```json
{ "code": "USR001", "password": "secret" }
```

**Response** `200`
```json
{
  "message": "Sign-in successful",
  "data": {
    "userName": "John Doe",
    "userImageURL": null,
    "userCode": "USR001",
    "accesses": [{ "code": "1001", "name": "Dashboard" }]
  }
}
```
Sets `access_token` (15 min) and `refresh_token` (7 days) cookies.

---

### `POST /api/user/auth/refresh-token`

Reads `refresh_token` cookie, rotates both tokens.

**Response** `200`
```json
{ "message": "Refresh token successful" }
```

---

### `POST /api/user/auth/sign-out`

Clears both cookies and deletes the server session, immediately invalidating the access token.

**Response** `200`
```json
{ "message": "Sign-out successful" }
```

---

## Stock

> Auth required

### `GET /api/stock/dashboard`

Returns aggregated stock overview for the user's circle, scoped to all data up to the end of the requested month/year.

**Query params**

| Param | Type | Description |
|---|---|---|
| `year` | number | Default: current year |
| `month` | number | Default: current month. Cutoff = today if current period, otherwise last day of month |
| `dcCode` | string | Scope DC totals/monthly data to a specific DC checkpoint |
| `storeCode` | string | Scope Store totals/monthly data to a specific store checkpoint |

**Response** `200`
```json
{
  "message": "Dashboard synced successfully",
  "data": {
    "year": 2026,
    "month": 5,
    "cutoff": "2026-05-25T23:59:59.999Z",
    "initialStock": 5000,
    "finalStock": 3200,
    "distributedToDC": 1200,
    "distributedToStore": 800,
    "distributedToDCByMonth": [
      { "month": 1, "amount": 100 },
      { "month": 2, "amount": 150 },
      "...",
      { "month": 12, "amount": 0 }
    ],
    "distributedToStoreByMonth": ["...same 12-element structure"],
    "topLeastStoreStock": ["...top 10 stores with least stock"],
    "topMostDCStock": ["...top 10 DCs with most stock"],
    "topHighestSaleByCheckpoint": [
      { "checkpoint": { "code": "ST01", "name": "Store A", "type": "STORE" }, "totalSales": 320 }
    ],
    "topHighestSaleByUser": [
      { "user": { "code": "USR001", "name": "John Doe" }, "totalSales": 150 }
    ]
  }
}
```

| Field | Description |
|---|---|
| `cutoff` | Actual date all data is filtered up to |
| `distributedToDC` / `distributedToStore` | Cumulative totals from the beginning up to `cutoff` |
| `distributedToDCByMonth` / `distributedToStoreByMonth` | Monthly breakdown for the selected year; months after `cutoff` are `0` |
| `topHighestSaleByCheckpoint` | Top 10 STORE checkpoints by total SIM card sales up to `cutoff` |
| `topHighestSaleByUser` | Top 10 users by total SIM card sales up to `cutoff` |

---

### `GET /api/stock/dashboard/dc-distribution`

Monthly DC distribution bar chart data with dropdown support. Returns the list of accessible DC checkpoints (for the dropdown) and 12 monthly totals for the selected year.

**Query params**

| Param | Type | Description |
|---|---|---|
| `year` | number | Default: current year. Cutoff = today if current year, otherwise Dec 31 of that year |
| `checkpointCode` | string | Filter to a specific DC checkpoint. Omit for all DCs combined |

**Response** `200`
```json
{
  "message": "DC distribution chart retrieved successfully",
  "data": {
    "year": 2026,
    "cutoff": "2026-05-25T23:59:59.999Z",
    "checkpoints": [
      { "code": "DC01", "name": "Distribution Center 01" }
    ],
    "chart": [
      { "month": 1, "amount": 200 },
      { "month": 2, "amount": 350 },
      "...",
      { "month": 12, "amount": 0 }
    ]
  }
}
```

---

### `GET /api/stock/dashboard/store-distribution`

Monthly store distribution bar chart data. Omit `checkpointCode` for "Seluruh Toko" (all stores combined).

**Query params**

| Param | Type | Description |
|---|---|---|
| `year` | number | Default: current year. Cutoff = today if current year, otherwise Dec 31 of that year |
| `checkpointCode` | string | Filter to a specific store. Omit for all stores combined |

**Response** `200`
```json
{
  "message": "Store distribution chart retrieved successfully",
  "data": {
    "year": 2026,
    "cutoff": "2026-05-25T23:59:59.999Z",
    "checkpoints": [
      { "code": "ST01", "name": "Store 01" }
    ],
    "chart": [
      { "month": 1, "amount": 80 },
      "...",
      { "month": 12, "amount": 0 }
    ]
  }
}
```

---

### Batches

#### `GET /api/stock/batches`

**Query params**

| Param | Type | Description |
|---|---|---|
| `page` | number | Default `1` |
| `limit` | number | Default `10` |
| `status` | `ONGOING \| COMPLETED` | Filter by status |
| `search` | string | Search by batch code or name |

**Response** `200` — `{ data: { batches, amount: { totalBatch, totalCards, totalVerified, totalUnverified } }, pagination }`

---

#### `GET /api/stock/batches/:id`

**Response** `200` — `{ data: { batch } }` with up to 50 most recent `cards` and `numbers`, and the latest `progress` snapshot.

---

#### `PUT /api/stock/batches/close/:id`

Marks remaining UNVERIFIED cards as LOST and closes the batch.

**Body** *(optional)*
```json
{ "note": "Optional closing note" }
```

**Response** `200` — `{ data: { batch } }`

---

#### `DELETE /api/stock/batches/:id`

Deletes a batch and all its cards/numbers. Only allowed on `ONGOING` batches with no `SOLD` or `DELIVERY` cards.

**Response** `200` — `{ message: "Batch deleted successfully" }`

---

### Cards

#### `GET /api/stock/cards`

**Query params**

| Param | Type | Description |
|---|---|---|
| `page` | number | Default `1` |
| `limit` | number | Default `10` |
| `checkpointCode` | string | Filter by checkpoint |
| `status` | `VERIFIED \| SOLD \| BROKEN \| LOST \| DELIVERY \| OPNAME \| UNVERIFIED` | Filter by status |
| `search` | string | Search by key or name |
| `uploadAt` | `YYYY-MM-DD` | Filter by upload date |
| `batch` | string | Filter by batch code |
| `validatedAt` | `YYYY-MM-DD` | Filter by validation date |

**Response** `200` — `{ data: { cards, amount: { upload, sold, available } }, pagination }`

---

#### `GET /api/stock/cards/:key`

**Response** `200` — `{ data: { card } }` with `checkpoint` and `movements`.

---

#### `DELETE /api/stock/cards/:key`

Not allowed on `SOLD` or `DELIVERY` cards.

**Response** `200` — `{ message: "Card deleted successfully" }`

---

#### `POST /api/stock/cards/validate/:key`

Validates a card. Only `UNVERIFIED` cards can be validated — returns `409` if already validated.

**Body**
```json
{ "status": "VERIFIED" }
```
`status` must be `VERIFIED` or `BROKEN`.

**Response** `200` — `{ data: { card } }`

---

#### `POST /api/stock/upload/xlsx`

Upload an Excel file with ICCID and/or MSISDN sheets.

**Form fields**

| Field | Type | Description |
|---|---|---|
| `source` | file | `.xlsx` file (max 5 MB) |
| `batchID` | number | *(optional)* Append to existing batch |

Excel sheets: `ICCID` (columns: `KEY`, `CHECKPOINT`, `REMARK`) and `MSISDN` (columns: `KEY`, `REMARK`).

**Response** `200`
```json
{ "data": { "total": 100, "created": 98, "skipped": 2 } }
```

---

### Numbers

#### `GET /api/stock/numbers`

**Query params**

| Param | Type | Description |
|---|---|---|
| `page` | number | Default `1` |
| `limit` | number | Default `10` |
| `checkpointCode` | string | Filter by checkpoint |
| `status` | string | Filter by status |
| `search` | string | Search by key or name |
| `remark` | string | Filter by remark |
| `sort` | `ASC \| DESC` | Sort direction |

**Response** `200` — `{ data: { numbers, amount: { upload, available, merge: { total, monthly, daily } } }, pagination }`

---

#### `GET /api/stock/numbers/:key`

**Response** `200` — `{ data: { number } }` with `checkpoint` and `movements`.

---

#### `PUT /api/stock/numbers/:key`

**Body** *(all optional)*
```json
{ "name": "New Name", "status": "VERIFIED", "remark": "Some remark" }
```

**Response** `200` — `{ data: { number } }`

---

#### `DELETE /api/stock/numbers/:key`

**Response** `200` — `{ message: "Number deleted successfully" }`

---

### Merges

#### `GET /api/stock/merges`

**Query params**

| Param | Type | Description |
|---|---|---|
| `page` | number | Default `1` |
| `limit` | number | Default `10` |
| `checkpointCode` | string | Filter by checkpoint |
| `type` | `SIMCARD \| ESIM \| CPP \| MIGRATION` | Merge type. Defaults to `SIMCARD` |
| `startSoldAt` | `YYYY-MM-DD` | Start of sale date range |
| `endSoldAt` | `YYYY-MM-DD` | End of sale date range |
| `search` | string | Search by number key. Only applies when `type` is `SIMCARD` or omitted |
| `cardRemark` | string | Filter by number remark. Only applies when `type` is `SIMCARD` or omitted |

**Response** `200` — `{ data: { merges, amount: { total, monthly, daily } }, pagination }`

---

#### `POST /api/stock/merges`

Merge a single SIM card with a number (sale).

**Body**
```json
{
  "cardKey": "ICCID001",
  "numberKey": "08123456789",
  "checkpointCode": "STORE001",
  "type": "SIMCARD",
  "trn": "TRN-XYZ"
}
```
`type`: `SIMCARD` | `ESIM` | `CPP` | `MIGRATION`. `cardKey` required for `SIMCARD` type only.

**Response** `200` — `{ data: { sim } }`

---

#### `POST /api/stock/merges/bulk`

Merge multiple SIMs in one request.

**Body**
```json
{
  "sims": [
    { "cardKey": "ICCID001", "numberKey": "08123456789" }
  ],
  "checkpointCode": "STORE001",
  "type": "SIMCARD",
  "trn": "TRN-XYZ"
}
```

**Response** `200` — `{ data: { merges } }`

---

## Opname

> Auth required. Opname is a physical stock-taking session where cards are scanned and their physical condition recorded.

### `POST /api/opname`

Creates a new opname session. `checkpointCode` is required (returns `400` if missing). Only one `ONGOING` opname is allowed per checkpoint at a time.

**Body**
```json
{ "checkpointCode": "STORE001", "type": "ICCID" }
```
`type`: `ICCID` (default) | `MSISDN`

**Response** `201` — `{ data: { opname } }`

---

### `GET /api/opname`

**Query params**

| Param | Type | Description |
|---|---|---|
| `page` | number | Default `1` |
| `limit` | number | Default `10` |
| `checkpointCode` | string | Filter by checkpoint |
| `type` | `ICCID \| MSISDN` | Filter by type |
| `startDate` | ISO 8601 string | Filter `createdAt` from this date |
| `endDate` | ISO 8601 string | Filter `createdAt` up to this date |

**Response** `200`
```json
{
  "data": {
    "opnames": [
      {
        "id": 1,
        "batch": "OP/STORE001/1",
        "status": "COMPLETED",
        "checkpoint": { "name": "Store A" },
        "submittance": { "..." },
        "stats": {
          "initialCount": 100,
          "totalGood": 90,
          "totalBroken": 5,
          "totalLost": 5,
          "finalCount": 90
        }
      }
    ]
  },
  "pagination": { "..." }
}
```

---

### `GET /api/opname/:id`

**Response** `200`
```json
{
  "data": {
    "opname": {
      "id": 1,
      "status": "COMPLETED",
      "stats": {
        "initialCount": 100,
        "totalScanned": 100,
        "totalGood": 90,
        "totalBroken": 5,
        "totalLost": 5,
        "finalCount": 90
      },
      "items": [
        {
          "iccid": "8962...",
          "createdAt": "2026-01-01T00:00:00Z",
          "validatedAt": "2026-01-02T00:00:00Z",
          "initialCondition": "VERIFIED",
          "verifiedCondition": "OK",
          "scannedAt": "2026-01-03T00:00:00Z"
        }
      ],
      "closingReport": {
        "signURL": "/uploads/sign.jpg",
        "picSignURL": "/uploads/pic.jpg",
        "picName": "John Doe",
        "documentationURL": "/uploads/doc1.jpg",
        "note": "All cards accounted for.",
        "documentations": [{ "id": 1, "url": "/uploads/doc1.jpg" }]
      }
    }
  }
}
```

| Field | Description |
|---|---|
| `stats.initialCount` | Total cards expected at opname start |
| `stats.totalScanned` | Total cards with an opname update entry |
| `stats.totalGood / totalBroken / totalLost` | Breakdown by condition |
| `stats.finalCount` | `initialCount - totalBroken - totalLost` |
| `items[].verifiedCondition` | Condition recorded during opname (`OK \| BROKEN \| LOST`), `null` if not yet scanned |
| `closingReport` | Submittance data recorded when the opname was closed |

---

### `PATCH /api/opname/:id`

Scan a card during an opname session.

**Body**
```json
{ "cardKey": "ICCID001", "status": "OK" }
```
`status`: `OK` | `BROKEN` | `LOST`

Stock adjustment: `BROKEN`/`LOST` decrements `CardStock`; `OK` leaves stock unchanged.

**Response** `200` — `{ data: { opname } }`

---

### `PATCH /api/opname/:id/close`

Closes the opname. Unscanned `OPNAME` cards are auto-marked `LOST` and stock decremented.

**Form fields** *(all optional)*

| Field | Type | Description |
|---|---|---|
| `signURL` | string | Operator signature URL |
| `picSignURL` | string | PIC signature URL |
| `documentationURL` | string or array | Up to 2 documentation URLs |
| `picName` | string | Name of the PIC who signed |
| `note` | string | Closing notes |

**Response** `200` — `{ data: { opname, submittance } }`

---

### `PUT /api/opname/:id`

Manually update opname status. Only `CANCELLED` is accepted — use the close endpoint to complete.

**Body**
```json
{ "status": "CANCELLED" }
```

Cancelling restores all `OPNAME` cards and scanned `BROKEN`/`LOST` cards to `VERIFIED`, and restores stock.

**Response** `200` — `{ data: { opname } }`

---

### `DELETE /api/opname/:id`

**Response** `200` — `{ message: "Opname deleted successfully" }`

---

## Distribution

> Auth required. Distributes cards from source checkpoints to a target checkpoint.

### `POST /api/distribution`

Creates one distribution per source checkpoint represented in the card selection. Cards are set to `DELIVERY` immediately.

**Body**
```json
{
  "targetCode": "STORE001",
  "scheduledAt": "2026-06-01T08:00:00.000Z",
  "cardKeys": ["ICCID001", "ICCID002"]
}
```

**Response** `201`
```json
{
  "data": {
    "distributions": ["..."],
    "cards": ["..."],
    "missingKeys": ["ICCID999"]
  }
}
```
`missingKeys` lists cards that were not found or not `VERIFIED`.

---

### `GET /api/distribution`

**Query params**

| Param | Type | Description |
|---|---|---|
| `page` | number | Default `1` |
| `limit` | number | Default `10` |
| `status` | `SCHEDULED \| HOLD \| DELIVERED \| CANCELLED` | Filter by status |
| `sourceCode` | string | Filter by source checkpoint |
| `targetCode` | string | Filter by target checkpoint |
| `startDueDate` | ISO date | Scheduled-at range start |
| `endDueDate` | ISO date | Scheduled-at range end |

Results are scoped to distributions where the user's circle owns at least one end (source or target).

**Response** `200` — `{ data: { distributions }, pagination }` with `source`, `target`, `items` (first 5), and `_count`.

---

### `GET /api/distribution/:id`

**Response** `200` — `{ data: { distribution } }` with `items`, `submittance`, `source`, `target`.

---

### `PUT /api/distribution/:id`

Update status or reschedule. Cannot set `DELIVERED` or `CANCELLED` through this endpoint.

**Body**
```json
{ "status": "HOLD", "scheduledAt": "2026-06-05T08:00:00.000Z" }
```
`status`: `SCHEDULED` | `HOLD`

**Response** `200` — `{ data: { distribution } }`

---

### `PUT /api/distribution/cancel/:id`

Cancels the distribution and restores all `DELIVERY` cards back to `VERIFIED`.

**Response** `200` — `{ data: { distribution } }`

---

### `PUT /api/distribution/submit/:id`

Marks the distribution as `DELIVERED`. Transfers cards to the target checkpoint and adjusts stock on both ends.

**Form fields** *(all optional)*

| Field | Type | Description |
|---|---|---|
| `signFile` | image | Sender signature |
| `imageFile` | image | Delivery photo |
| `storeFile` | image | Store photo |
| `recipientFile` | image | Recipient signature |
| `longitude` | number | GPS longitude |
| `latitude` | number | GPS latitude |
| `note` | string | Delivery note |
| `recipientName` | string | Recipient name |

**Response** `200` — `{ data: { submittance } }`

---

### `DELETE /api/distribution/:id`

Deletes the distribution and restores `DELIVERY` cards to `VERIFIED`. Not allowed on `DELIVERED` distributions.

**Response** `200` — `{ message: "Distribution deleted successfully" }`

---

## Checkpoint

> Auth required. Checkpoints are scoped to the authenticated user's circle via `CheckpointCircle` — only checkpoints linked to the user's circle are visible.

### `POST /api/checkpoint`

Creates the checkpoint and automatically links it to the creator's circle.

**Body**
```json
{ "code": "STORE001", "type": "STORE", "name": "Store Jakarta Pusat" }
```
`type`: `DC` | `STORE` | `HQ`

**Response** `201` — `{ data: { checkpoint } }`

---

### `GET /api/checkpoint`

Results are ordered by `id ASC` for deterministic ordering.

**Query params**

| Param | Type | Description |
|---|---|---|
| `limit` | number | If omitted, returns all (no pagination) |
| `page` | number | Default `1` (only used when `limit` is set) |
| `type` | `DC \| STORE \| HQ` | Filter by type |
| `search` | string | Search by code or name |
| `startSoldAt` | `YYYY-MM-DD` | Filter merge count from date |
| `endSoldAt` | `YYYY-MM-DD` | Filter merge count to date |

**Response** `200` — `{ data: { checkpoints }, pagination? }` with `_count.cards` and `_count.merges`.

---

### `GET /api/checkpoint/:id`

**Response** `200`
```json
{
  "data": {
    "checkpoint": {
      "cards": ["...up to 20 most recent cards"],
      "cardStock": ["...latest stock snapshot"],
      "_count": { "cards": 342 }
    },
    "amount": { "card": 342, "sold": 150, "verified": 180 }
  }
}
```

---

### `PUT /api/checkpoint/:id`

Updates `name` and/or `type`. `code` cannot be changed.

**Body** *(all optional)*
```json
{ "name": "New Name", "type": "DC" }
```

**Response** `200` — `{ data: { checkpoint } }`

---

### `DELETE /api/checkpoint/:id`

Blocked if any cards or distributions reference the checkpoint. Cleans up `CardStock` and `CheckpointCircle` records before deleting.

**Response** `200` — `{ message: "Checkpoint deleted successfully" }`
