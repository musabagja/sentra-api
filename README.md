# Sentra API

REST API for managing SIM card stock, opname (stock-taking), and distribution across checkpoints.

---

## What's New — 2026-05-22

### Card status lifecycle — new `DELIVERY` and `OPNAME` statuses
- `HOLD` is replaced by `DELIVERY` for cards reserved in a distribution
- New `OPNAME` status: all `VERIFIED` cards at a checkpoint are set to `OPNAME` when an opname session starts, making the scope explicit and preventing new cards from being counted as initial stock mid-session
- `ItemStatus` enum: `VERIFIED | SOLD | BROKEN | LOST | DELIVERY | OPNAME | UNVERIFIED`

### `POST /api/opname` — scopes cards on creation
- All `VERIFIED` cards at the checkpoint are atomically set to `OPNAME` status when the session is created
- `amount` (initial stock) is now derived from an actual `COUNT(VERIFIED)` at creation time, not from the potentially stale `cardStock` counter

### `PATCH /api/opname/:id` (scan) — only accepts `OPNAME` cards
- Rejects any card that does not have `OPNAME` status — prevents scanning cards that weren't part of the initial stock
- Stock is decremented on scan only for `BROKEN`/`LOST` results (no increment for `OK` — those cards were already counted)

### `PATCH /api/opname/:id/close` — full status resolution
- Scanned `OK` → restored to `VERIFIED`; scanned `BROKEN` → `BROKEN`; scanned `LOST` → `LOST`
- Unscanned `OPNAME` cards are auto-marked `LOST` (OpnameUpdate created, card status set, stock decremented)
- New body fields: `picName`, `note`

### `PUT /api/opname/:id` (cancel) — full rollback
- When status is set to `CANCELLED`, all `OPNAME` cards and all scanned `BROKEN`/`LOST` cards at the checkpoint are restored to `VERIFIED`
- Stock is incremented back for every `BROKEN`/`LOST` scan that had already decremented it

### `GET /api/opname` — corrected `initialCount`
- `stats.initialCount` now uses `opname.amount` (the COUNT taken at session start) — accurate for both `ONGOING` and `COMPLETED` opnames regardless of current card statuses
- New query params: `startDate` / `endDate`

### `GET /api/opname/:id` — corrected `initialCount` and `items` scope
- `stats.initialCount` = `opname.amount`; added `finalCount = initialCount - totalBroken - totalLost`
- `items` scoped to cards with `OPNAME` status (unscanned) OR an `OpnameUpdate` entry (scanned) — excludes cards validated after the session started
- `items[].verifiedCondition` is `null` for unscanned cards

### `GET /api/stock/dashboard` — top sales stats
- `topHighestSaleByCheckpoint` — top 10 STORE checkpoints by total SIM card sales
- `topHighestSaleByUser` — top 10 users by total SIM card sales across scoped checkpoints

---

## Stack

- **Runtime**: Node.js + TypeScript
- **Framework**: Express
- **ORM**: Prisma (PostgreSQL)
- **Auth**: JWT via HTTP-only cookies (access token 15 min, refresh token 7 days)

## Getting Started

```bash
pnpm install
pnpm run dev
```

Copy `.env.example` to `.env` and set `DATABASE_URL` and `PORT`.

---

## Authentication

All routes except `/api/user/auth/*` require a valid `access_token` cookie. Tokens are set automatically on sign-in and refreshed via the refresh-token endpoint.

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
    "accesses": [{ "code": "ACCESS_CODE", "name": "Access Name" }]
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

Clears both cookies and invalidates the server session.

**Response** `200`
```json
{ "message": "Sign-out successful" }
```

---

## Stock

> Auth required

### `GET /api/stock/dashboard`

Returns aggregated stock overview for the user's circle.

**Response** `200`
```json
{
  "message": "Dashboard synced successfully",
  "data": {
    "initialStock": 5000,
    "finalStock": 3200,
    "distributedToDC": 1200,
    "distributedToStore": 800,
    "topLeastStoreStock": [...],
    "topMostDCStock": [...],
    "topHighestSaleByCheckpoint": [
      { "checkpoint": { "code": "STORE001", "name": "Store A", "type": "STORE" }, "totalSales": 320 }
    ],
    "topHighestSaleByUser": [
      { "user": { "code": "USR001", "name": "John Doe" }, "totalSales": 150 }
    ]
  }
}
```

| Field | Description |
|---|---|
| `topHighestSaleByCheckpoint` | Top 10 STORE checkpoints ranked by total SIMCARD sales (merges), descending |
| `topHighestSaleByUser` | Top 10 users ranked by total SIMCARD sales across all scoped checkpoints, descending |

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

**Body**
```json
{ "note": "Optional closing note" }
```

**Response** `200` — `{ data: { batch } }`

---

#### `DELETE /api/stock/batches/:id`

Deletes a batch and all its cards/numbers. Only allowed on `ONGOING` batches with no `SOLD` or `HOLD` cards.

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
| `status` | `VERIFIED \| SOLD \| BROKEN \| LOST \| HOLD \| UNVERIFIED` | Filter by status |
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

Not allowed on `SOLD` or `HOLD` cards.

**Response** `200` — `{ message: "Card deleted successfully" }`

---

#### `POST /api/stock/cards/validate/:key`

Validates or marks a card. Adjusts `CardStock` automatically.

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

Creates a new opname session for a checkpoint. Only one `ONGOING` opname is allowed per checkpoint at a time.

**Body**
```json
{ "checkpointCode": "STORE001" }
```

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

| Field | Description |
|---|---|
| `checkpoint.name` | Name of the checkpoint this opname belongs to |
| `stats.initialCount` | Total cards expected at opname start |
| `stats.totalGood` | Cards scanned as `OK` |
| `stats.totalBroken` | Cards scanned as `BROKEN` |
| `stats.totalLost` | Cards scanned as `LOST` (includes auto-marked on close) |
| `stats.finalCount` | `initialCount - totalBroken - totalLost` |

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
        "totalICCID": 100,
        "totalScanned": 100,
        "totalGood": 90,
        "totalBroken": 5,
        "totalLost": 5
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
| `stats.totalICCID` | Total cards expected (= `amount`) |
| `stats.totalScanned` | Total cards with an opname update entry |
| `stats.totalGood / totalBroken / totalLost` | Breakdown by condition |
| `items[].iccid` | The card's ICCID / MSISDN key |
| `items[].initialCondition` | Card's system status before opname |
| `items[].verifiedCondition` | Condition recorded during opname (`OK \| BROKEN \| LOST`) |
| `items[].scannedAt` | When the update was recorded |
| `closingReport` | Submittance data recorded when the opname was closed |

---

### `PATCH /api/opname/:id`

Scan a card during an opname session. Records the physical condition and adjusts `CardStock` if the physical state differs from the system state.

**Body**
```json
{ "cardKey": "ICCID001", "status": "OK" }
```
`status`: `OK` | `BROKEN` | `LOST`

Stock adjustment rules:
- Card is `VERIFIED` in system but scanned as `BROKEN`/`LOST` → stock decremented
- Card is not `VERIFIED` in system but scanned as `OK` → stock incremented

**Response** `200` — `{ data: { opname } }`

---

### `PATCH /api/opname/:id/close`

Closes the opname. Any `VERIFIED` cards at the checkpoint that were **not scanned** are automatically marked `LOST` (both in the opname record and their actual card status), and stock is decremented accordingly.

Accepts file uploads via `multipart/form-data`.

**Form fields**

| Field | Type | Description |
|---|---|---|
| `signFile` | image | Operator signature (max 5 MB) |
| `picSignFile` | image | PIC signature (max 5 MB) |
| `documentationFile` | image | Documentation photos, up to 2 files |
| `picName` | string | Name of the PIC who signed |
| `note` | string | Description / closing notes |

**Response** `200`
```json
{
  "data": {
    "opname": { "id": 1, "status": "COMPLETED", "progress": 100 },
    "submittance": {
      "id": 1,
      "signURL": "/uploads/sign.jpg",
      "picSignURL": "/uploads/pic.jpg",
      "picName": "John Doe",
      "documentationURL": "/uploads/doc1.jpg",
      "note": "Closing notes here.",
      "documentations": [{ "id": 1, "url": "/uploads/doc1.jpg" }]
    }
  }
}
```

---

### `PUT /api/opname/:id`

Manually update opname status.

**Body**
```json
{ "status": "CANCELLED" }
```
`status`: `ONGOING` | `COMPLETED` | `CANCELLED`

**Response** `200` — `{ data: { opname } }`

---

### `DELETE /api/opname/:id`

**Response** `200` — `{ message: "Opname deleted successfully" }`

---

## Distribution

> Auth required. Distributes cards from source checkpoints to a target checkpoint.

### `POST /api/distribution`

Creates one distribution per source checkpoint represented in the card selection. Cards are set to `HOLD` immediately.

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
    "distributions": [...],
    "cards": [...],
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
| `sourceCode` | string | Filter by source checkpoint. When combined with `targetCode`, both must match (AND, not OR) |
| `targetCode` | string | Filter by target checkpoint. When combined with `sourceCode`, both must match (AND, not OR) |
| `startDueDate` | ISO date | Scheduled-at range start |
| `endDueDate` | ISO date | Scheduled-at range end |

Results are scoped to distributions where the authenticated user's circle owns at least one end (source or target).

**Response** `200` — `{ data: { distributions }, pagination }` with `source`, `target`, `items` (first 5), and `_count`.

---

### `GET /api/distribution/:id`

**Response** `200` — `{ data: { distribution } }` with `items`, `submittance`, `source`, `target`.

---

### `PUT /api/distribution/:id`

Update status or reschedule. Cannot set `DELIVERED` (use the submit endpoint) or `CANCELLED` (use the cancel endpoint).

**Body**
```json
{ "status": "HOLD", "scheduledAt": "2026-06-05T08:00:00.000Z" }
```
`status`: `SCHEDULED` | `HOLD`

**Response** `200` — `{ data: { distribution } }`

---

### `PUT /api/distribution/cancel/:id`

Cancels the distribution and restores all HOLD cards back to `VERIFIED`.

**Response** `200` — `{ data: { distribution } }`

---

### `PUT /api/distribution/submit/:id`

Marks the distribution as `DELIVERED`. Transfers cards to the target checkpoint, adjusts stock on both ends, and records delivery proof.

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

Deletes the distribution, restores HOLD cards to `VERIFIED`. Not allowed on `DELIVERED` distributions.

**Response** `200` — `{ message: "Distribution deleted successfully" }`

---

## Checkpoint

> Auth required.

### `POST /api/checkpoint`

**Body**
```json
{ "code": "STORE001", "type": "STORE", "name": "Store Jakarta Pusat" }
```
`type`: `DC` | `STORE` | `HQ`

Creates the checkpoint and automatically links it to the creator's circle.

**Response** `201` — `{ data: { checkpoint } }`

---

### `GET /api/checkpoint`

**Query params**

| Param | Type | Description |
|---|---|---|
| `limit` | number | If omitted, returns all (no pagination) |
| `page` | number | Default `1` (only used when `limit` is set) |
| `type` | `DC \| STORE \| HQ` | Filter by type |
| `search` | string | Search by code or name |
| `startSoldAt` | `YYYY-MM-DD` | Filter merge count from date |
| `endSoldAt` | `YYYY-MM-DD` | Filter merge count to date |

**Response** `200` — `{ data: { checkpoints }, pagination? }` with `_count.cards` and `_count.merges`. Pagination only included when `limit` is provided.

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
