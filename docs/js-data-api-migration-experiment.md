# JS Data API vs Custom Functions — migration experiment

**What was tried:** replace the `getStoreMaterialRequirements` custom (Deluge)
function with a browser-side build that reads the same forms through
`ZOHO.CREATOR.DATA.getRecords` and assembles the identical payload in JavaScript.

**Status:** experiment, wired into the store widget behind a commented-out
fallback. Files:

- `app/js/api-experiment.js` — `ApiExperiment.run()` / `.compare()` / `.assemble()`
- `app/widget.html` — `<script>` tag (loads **before** `main.js`)
- `app/js/main.js` — `loadRequirements()` calls `ApiExperiment.run()`; the
  custom-API path is in a `/* CUSTOM-API PATH */` comment block
- `tools/api-experiment-parity.test.js` — 15 parity tests over `assemble()`

**To revert:** delete `api-experiment.js` + its `<script>` tag, uncomment the
`CUSTOM-API PATH` block in `loadRequirements()`.

---

## Headline result

The JS path is **substantially faster** than the paged custom-function path, and
produces the same screen (the client allocator `applyLotAllocation` runs
unchanged on top of it).

### Why it is faster — and it is architectural, not a hack

`getStoreMaterialRequirements` is slow because it is **paged around Zoho's
uncatchable statement-execution limit**. It fans per-plan → per-material →
per-lot queries in Deluge; the widget fires `getOpenPlanCount` + N parallel
`getStoreMaterialRequirements` windows (`REQ_PAGE_PLANS = 25`) to keep each
window under the cap, then `mergeRequirementPages` reassembles them. See
`getStoreMaterialRequirements.dg`'s 60-line header and the
`mergeRequirementPages` / `loadRequirementsSequential` comments in `main.js`.

The JS version is **9 flat report reads** assembled in the browser, where there
is no statement cap. Cursor-paged only when a single report genuinely exceeds
1000 rows.

### Metering — confirmed OK

Widget → custom-API calls are not metered (already in `CLAUDE.md`, verified).
`getRecords` calls from a widget are **also not metered** — confirmed by the user
against the Usage page during a real day with the experiment live. So "9 reads
per screen load" costs nothing against the daily quota.

### `getRecords` hard limits — confirmed from the v2 docs

- **1000 records per call** maximum. `max_records`: `200` / `500` / `1000`
  (1000 = default).
- Pagination is **`record_cursor`** — the response carries a cursor token when
  more rows exist; pass it back in the next call's config. There is no
  page/from parameter.
- `ApiExperiment.getAll()` loops the cursor until the response has none, so a
  5000-row `Material_Requirement` form = 5 transparent calls.

---

## Things encountered while migrating

### 1. `getRecords` config is **snake_case**, not camelCase

`report_name`, `field_config`, `max_records`, `record_cursor`, `criteria`.
Passing `reportName` / `fieldConfig` (the natural guess, and what the packing
widget originally had) leaves the required fields `undefined` and the call fails
— sometimes silently. `invokeCustomApi` uses `api_name` / `http_method`
(snake_case) and that had trained the wrong instinct.

### 2. `criteria` takes **no wrapping parentheses**

`criteria: 'ID == 123'` works; `criteria: '(ID == 123)'` is rejected as
"Invalid Configuration". (Learned first on the packing-photo work; re-confirmed
here.)

### 3. `field_config` must be **`all`** to get file/image/lookup fields

The default `quick_view` returns a limited field set — a multi-image field like
`Box_Images` comes back `undefined` under `quick_view`. `all` returns every
field of every row, which is correct but see cost note below.

### 4. **An empty result is returned as HTTP 400**, not `[]`

`code 9280 "No records found matching the given criteria"` comes back as a
**400 rejection**, not an empty list. This bit `Fabric_Piece_Report` filtered by
`Piece_Status == "Available"` on an org with no available pieces, and would also
bite `Waste_Master` / `Material_Exception` with no matching rows. `getAll()` now
treats `code 9280` / "no records found" as a valid empty result and resolves
`[]`.

### 5. `getRecords` reads a **report**, not a form

There is no "read the form directly". Every form needs a list report, and the
call fails if the report link name is wrong or the report is deleted/renamed.
The link names are **not** predictable — Creator's default is `All_<Form>` but
this app's reports are a mix:

| Form | Report link name |
|---|---|
| Production_Planning | `Production_Planning_Report` |
| Material_Requirement | `Material_Requirement_Report` |
| Employee | `Employee_Report` |
| Plan_Item | `Plan_Item_Report` |
| Raw_Material | `All_items_Report` |
| Raw_Material_Lot | `All_Material_Lots` |
| Fabric_Piece | `Fabric_Piece_Report` |
| Waste_Master | `Waste_Master_Report` |
| Material_Exception | `Material_Exception_Report` |

A wrong name throws `<ReportName>: ...` — cheap to diagnose, but it is a runtime
dependency the custom function does not have.

### 6. **Script load order matters**

`api-experiment.js` must load **before** `main.js`, because `main.js`'s boot
runs `loadRequirements()` which calls `ApiExperiment.run()`. Loading it after
gave `Error: ApiExperiment not loaded`.

### 7. Lookup fields come back as **objects**, not ids

`{ ID, zc_display_value, <displayField> }` — occasionally a bare id. Needed
`lookupId()` / `lookupText()` helpers. `Material_Requirement.Plan` /
`.Assigned_To` / `.Material`, `Production_Planning.Sales_Order`,
`Waste_Master.SKU` (a Raw_Material id), etc. are all this shape.

### 8. Deluge list `.get()` is **0-indexed** (relearned via a seed bug)

Not this migration, but same session: `personPool.get((hashA % n) + 1)` threw
"Given index N is greater than the list size" — the `+1` (thinking 1-indexed)
overran. Deluge `list.get(0 .. n-1)`. The reported line number was wrong (a hint,
not a fact — a recurring theme).

---

## Bugs the parity tests caught in the JS port

The parity suite fixtures raw `getRecords`-shaped rows and asserts
`assemble()`'s output against what `getStoreMaterialRequirements.dg` would emit
for the same data. It found:

1. **`assemble()` was not re-filtering plans by `Order_Status`** — it trusted
   the `getRecords` criteria and used every row in `raw.plans`. The Deluge's
   plan query IS the gate, so `assemble()` now re-applies the
   Pending / Partially Received / In Progress filter itself.

2. **`dispName` had a `Name` fallback the Deluge does not have.** The Deluge's
   `matDispByMat` is `Material_Display_Name` only; an empty display name is
   supposed to fall through to the requirement's snapshot `Material_Name` in
   `showName`. The port was doing `Material_Display_Name || Name`, so a material
   with no display name showed its raw `Name` instead of the snapshot.

3. **`freshMeters` was seeded to `0`** (earlier in the session). The Deluge
   computes a per-cut whole-marker-row estimate
   (`ceil(remainCut / floor(fabricWidthCm / cutW)) * cutL / 100`, summed over
   cut sizes), with a `req - iss` fallback when no cut is countable, and sets
   `matEntry.required` and `matEntry.remaining` to it for fabric. The allocator
   recomputes this, BUT its own no-piece-data fallback reads `m.freshMeters` —
   so a `0` seed made a stale-widget / no-allocator fabric row read `0` where
   the Deluge reads `req - iss`. Now the full calc is ported into `assemble()`.

4. **`issuedLotNo` was missing from lines** (earlier in the session). Deluge
   emits it per line (readable pinned-lot number). `lot-allocator.js` falls back
   to the raw 18-digit lot id without it — a cosmetic pin label bug. Now
   resolved from the lot map in `assemble()`.

---

## Verified equivalent to `getStoreMaterialRequirements.dg`

Line-by-line comparison plus 15 parity tests. These match:

- Open-plan filter (3 statuses)
- Aggregation key `supId|matId|source`; Reissue never merges into Plan; empty
  source → `"Plan"`
- `required` / `issued` sums; fabric `reqPieces` / `issPieces` (waste+raw) /
  `wasteIssuedPieces`; `outstandingPieces` clamp
- Per-cut summary (`cuts[]`, keyed `WxL`)
- Per-line list — all 15 fields, `item` / `reason` flattened, `issuedLotNo`
  resolved
- Lot rollup: `calcWash` / `calcUnwash` / `calcInWash` sum **every** lot
  including blocked and empty (mirrors the Creator rollup)
- Lot list: drop unless wash/unwash/inWash > 0; `blocked` from `Status`;
  `form != "Pieces"` → `"Roll"`
- Pieces-form lot: `wash` = Σ washed-piece metres (Unwash excluded); full piece
  list carried for the allocator
- `lotNameById` filled before the blocked/empty filters (an offcut can name a
  dropped lot)
- `availableStock` (fabric = calcWash, else `Quantity`); `unwashedStock`;
  `inWashStock`; `fabricWidthCm` = `Fabric_Width_Inches * 2.54`
- Display name: `Material_Display_Name` else requirement snapshot
- `wasteStock[]`: available only, zero-dim/count dropped, lot number + carton
- Exceptions: open only, `Type_field` → `Type`, deduped covered plan ids,
  `poNumber`, `lot`
- `poCoveredBySku`: only `Shortage` tickets with a `PO_Number`, counted only
  while on-hand < required (fabric on-hand = calcWash; non-fabric = 0, so a
  non-fabric PO shortage always counts — same as the Deluge)
- `remaining` (non-fabric) = `required - issued`
- `freshMeters` / `required` / `remaining` (fabric) = the per-cut estimate
- `applyLotAllocation` then overwrites the fabric output fields (`freshMeters`,
  `remaining`, `required`, `wastePicks`, `piecesCoveredByWaste`, `freshPieces`,
  `lotLines`, `washLotId`) — the field names in `assemble()`'s output match
  exactly what the allocator reads

---

## Known deliberate gaps (documented, not bugs)

1. **Print-base chaining NOT ported.** A printed SKU that is out of printed
   stock will not fall back to naming its plain-cloth base lot. `printBase` /
   `printBaseName` / `printBaseLots` come out empty. Plain (non-printed) fabric
   and all trims are unaffected. `_experiment.printBasePorted = false`.

2. **Priority order approximated.** The Deluge sorts plans by `Priority_Key`;
   the port sorts supervisor blocks by each supervisor's *lowest* `Priority_Key`
   across the plans that feed his materials. Card order is correct in the common
   case; a rare edge (two supervisors with close lowest keys but different
   priority in the bulk of their work) could order cards differently, which
   affects only which card the allocator contends on first for a shared remnant.

3. **No parallel paging.** One cursor walk per report. At real volume the thing
   to watch is total wall time of the 9 reads + assembly vs. the paged custom
   path, not a statement limit (there is none browser-side).

---

## Costs of migrating (weigh before doing more)

1. **`field_config: 'all'` pulls whole forms.** Every field of every
   `Material_Requirement` / `Raw_Material_Lot` / `Raw_Material` row, unfiltered
   (except the 3 with `criteria`). Fine now; grows linearly with those forms.
   Mitigation: `field_config: 'custom'` + an explicit `fields` list per report.

2. **Logic now lives in two places.** The Deluge stays (other callers, batch
   workflows, the admin audit page replays allocation globally). The JS port is
   a second copy of the aggregation to keep in sync — 2 known divergences
   already. Every future rule change is two edits and a re-run of the parity
   tests.

3. **Report dependency** (see #5 above).

4. **No server guardrails.** The Deluge clamps negative stock, validates ids,
   nets disputes. A JS reader that skips those is fine for *display* but loses
   the single-source-of-truth property.

---

## Rule for what to migrate

**Migrate:** pure read + assemble, no concurrent-write hazard, currently
paged/slow.

- `getStoreMaterialRequirements` (this experiment)
- `getSupervisorProductionHistory`, `getStoreIssueHistory` — history reads,
  already paged, no writes
- `getProductionWidgetData`, `getSupervisorMaterials` — large read fans
- `getPackingHistory`, `getOrderConsumption`, admin/audit dashboards

**Never migrate — the write path stays server-side:**

- `issueMaterials`, `receiveMaterials`, `saveProductionPhase`, `saveItemCheck`,
  `savePackingRecord`, `resolveDispute`, `pushInvoiceToGad`,
  `postTransferOrders` — anything that writes. `CLAUDE.md`: `Issued_Qty` is
  read-and-written live server-side precisely so two concurrent issues cannot
  race. Moving the write logic to JS reopens that race. The store screen's
  *read* can be JS; the Issue button still calls `issueMaterials`.

**Process for each migration:**

1. Extract the pure assembly (like `ApiExperiment.assemble()`).
2. Write parity tests over it against the Deluge's shape.
3. Wire it behind a commented-out fallback to the custom function.
4. Run `compare()` against real data before flipping.
5. Keep the Deluge as the fallback path, not deleted.
