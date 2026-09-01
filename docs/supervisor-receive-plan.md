# Supervisor receive — scaling + per-order visibility plan

**Status: PLAN ONLY, nothing built.** Written after the store-side "one combined line per fabric
SKU per supervisor" change (`docs/one-line-per-sku-plan.md`). Decisions taken:

- Supervisor gets **visibility only** — a read-only per-order/per-item breakdown. The split is
  always **automatic, oldest-first**, exactly as today. Letting him steer which orders absorb a
  shortfall is a later feature, not in this scope.
- Breakdown is **expand-in-place** on the receive row, not a separate tab.
- **Server scale fixes first** (Phase 1), UI second (Phase 2).

The scale this must survive: **100 sales orders, ~100 items each, mostly on one supervisor**
(Faire wholesale). That is 20× the `docs/scaling.md` planning assumption of ~5 items/order —
so ~10,000 `Plan_Item` and ~60,000 `Material_Requirement` rows behind one supervisor's board.

---

## What already works — do not rebuild

**The per-item mapping survived the SKU-merge.** The store issues one combined line + one `SIV`
voucher, but `issueMaterials` still writes **one `Issue_Line` per allocation** (per
`Material_Requirement` / `mrqId`), each carrying `Requirement`, `Plan_Item`, `Lot`,
`Cut_Size_*`. The voucher's `Issue_Lines` subform *is* the order/item breakdown.

**The fan-out already runs on receipt:**

| Step | Where | What |
|---|---|---|
| Read | `getSupervisorMaterials` | groups Issue_Lines to one per-SKU aggregate, **also** returns `lines[]` — one per still-owed Issue_Line (`requirementId`, `planId`, `planNo`, `salesOrder`, `pending`) |
| Distribute | `submitReceipt` (widget) | spreads confirmed qty across `lines[]` **oldest-first**, emits `settlements[]` |
| Apply | `receiveMaterials` | per settlement: `Settled_Qty += settle`, `Received_Qty += confirmed` on the requirement, lot in-transit → production/disputed, one `Stock_Dispute` per plan for the shortfall, then a readiness sweep rolling `Item_Status` / `Order_Status` |

Both functions are already paged/chunked/budgeted (getSupervisorMaterials: 150 Issue_Lines/call;
receiveMaterials: 120 settlements/chunk, 15 plans/finalize, all resumable).

So "divide received material across orders then items" **already happens** — automatically,
oldest-first, invisibly to the supervisor.

---

## Phase 1 — server scale fixes — **BUILT (2026-09-01), not yet Execute-tested**

Files changed: `deluge/getSupervisorMaterials.dg`, `deluge/receiveMaterials.dg`,
`app/supervisor/js/receive.js`. Custom API arg lists unchanged. Verified by the Node port in
`tools/receive-lifecycle.test.js` (17 assertions: conservation, slice-equivalence, dispute
netting once, item-budgeted finalize, waste + printed) and `dgscan`. **Deluge itself is not run
here** — needs a Creator paste + Execute on both functions.

### The core idea: split the happy path from the shortfall path

A common trim ("care label") issued once across every open item = **10,000 Issue_Lines on one
voucher**, received in one press. Per-line settlement from the widget = 10,000 settlements ÷ 120
= ~84 sequential `receiveMaterials` calls. And each `receiveMaterials` chunk re-scans every
touched voucher's whole subform for the Issue_Status flip → tens of thousands of statement
visits → **uncatchable statement-execution limit**.

Fix: **the widget stops sending per-line settlements at all.** It names the vouchers and (only
for a material he flagged short) how much of that material actually arrived. The server walks
each voucher's `Issue_Lines` subform **once**, settling every line as it goes, in budgeted
resumable passes. This also kills a second cost the per-line path had: today each settlement
re-scans the whole subform to *find* its line — O(lines²) per chunk.

### 1A. `receiveMaterials` — new `receiptsJson` shape

Custom API args unchanged (`supervisorId`, `receiptsJson`). The JSON shape is replaced:

```
receiptsJson = {
  "vouchers": ["77","78", ...],          // every voucher the screen showed = the sweep scope
  "sweepCursor": {},                       // {} to start; server returns the resume point

  "shortMaterials": [                      // ONLY materials he marked short
    { "materialId":"123", "owed":10.0, "received":9.5, "remark":"half metre short" }
  ],
  "waste":         [ { "rowId":"456", "received":1, "remark":"" } ],
  "printedPieces": [ { "issueLineId":"555", "voucherId":"77", "received":3, "remark":"" } ],

  "plansTouched":  ["50","51"],            // for the readiness sweep (widget has this from orders[])
  "finalize":      false,
  "finalizeCursor": {}                     // {} to start; server returns the resume point
}
```

**Unified sweep pass** (runs whenever `sweepCursor` / `vouchers` present, `finalize:false`):

- Build `shortLeft` = `{materialId: received}` from `shortMaterials` (seed from `sweepCursor.sd`
  on a resume so it survives across calls).
- Walk `vouchers` in order; per voucher walk `Issue_Lines` **once**, skipping past
  `sweepCursor` (`{v: <voucher index>, l: <last line id>}`). Per still-owed line
  (`Settled_Qty < Qty`):
  - `owed = Qty − Settled_Qty`.
  - material in `shortLeft`: `conf = min(owed, shortLeft[mat])`, `shortLeft[mat] −= conf`,
    `short = owed − conf`. Else `conf = owed`, `short = 0`.
  - `Settled_Qty = Qty`; `Requirement.Received_Qty += conf`; accrue `settledByMat[mat] += owed`,
    `settledByLot[lot] += owed`, `disShortByMat` shortfall per `(plan, material)`.
- Stop at `LINE_BUDGET` (~250 lines); return `sweepCursor = {v, l, sd: shortLeft}` and
  `sweepDone:false`. When the last voucher's last line is done → `sweepDone:true`.
- **After the slice:** drain `In_Transit_Qty` once per material in `settledByMat` and once per
  lot in `settledByLot` (never below 0). For each `(plan, material)` in `disShortByMat`,
  **upsert** one `Stock_Dispute` — find the open Outbound one for that supervisor+plan+material
  and add to it, else insert. So a shortfall split across several sweep slices is one dispute,
  not one per slice (an improvement on today, which inserts per chunk).

**Waste pass** and **printed-piece pass** — first sweep call only (`sweepCursor` empty),
**unchanged from today**. Both are inherently per-physical-piece and bounded (one row per
`Waste_Movement` / per printed panel a person handles by hand); they never need the sweep.

**Finalize** (`finalize:true`) — one phase per call, driven by `finalizeCursor = {ph, ...}`:

1. `ph:"vouchers"` — recheck `Issue_Status` for the `vouchers` list, ~50 per call
   (`finalizeCursor.vi`), each from its own `Issue_Lines`. Moved here from *every chunk* — nothing
   reads voucher status mid-receipt. → `ph:"items"`.
2. `ph:"items"` — readiness sweep over `plansTouched`, **budgeted by `Plan_Item` count, not plan
   count** (`SWEEP_BUDGET = 15` plans × 100 items was the limit-killer). Walk plans from
   `finalizeCursor.pi`, items within a plan from `finalizeCursor.ii`, stop at ~250 items
   (`finalizeCursor.ic`). Per item: skip the req/waste walk entirely if `Item_Status` is already
   past `Awaiting_Material`; otherwise the existing per-item check, roll `Item_Status`. Per plan,
   once its items are done: `Plan_Item[Plan==p && Item_Status=="Awaiting_Material"].count()==0` →
   `Material Ready`; some ready and plan is `Pending` → `Partially Received`. Forward-only guard
   unchanged. → `ph:"transfer"` when all plans done.
3. `ph:"transfer"` — `postTransferOrders("auto")`, its own try/catch, last. → `ph:"done"`.

Response carries `sweepCursor` / `finalizeCursor` (or `{}` / `{"ph":"done"}` when finished) and
`errors[]` / `received[]` as today.

### 1B. `getSupervisorMaterials` — roll up, drop `lines[]`

- **`orders[]` per plan, not per line.** Replace the per-line `detail` string append with
  `ordAgg` keyed `matId|planId` → `{ planId, planNo, salesOrder, pending (sum),
  isReissue (OR), reason (first non-empty), lineCount }`, plus `ordKeys` = `matId` →
  ordered list of its plan keys. A SKU feeding 100 plans → 100 entries, not 10,000.
  (`lineCount` is a raw increment — no distinct-item dedup, which would re-introduce a
  per-line list. Exact item counts come from Phase 2's lazy `getReceiveItemBreakdown`.)
- **Kill the `~`-joined per-lot strings** (`lineLotByMat` / `lineQtyByMat` / `lineNoteByMat`).
  Accumulate `lotAgg` = `matId` → (`lotId` → summed qty) and `lotNoteAgg` likewise. Bounded by
  distinct lots per SKU. The "cap at adjPending" walk it replaces was a no-op safety —
  non-printed line pendings already sum to `adjPending`.
- **Drop `lines[]`** (`lineRowsByMat`) from the payload entirely. The widget no longer distributes
  per line — the server sweeps. Add instead **`voucherIds[]`** per material = the distinct
  vouchers that material sits on (bounded by vouchers-per-material). The widget unions these into
  the top-level `vouchers` list it sends back.
- Paging (`skipLinesTxt` / `linesConsumed`, 150 Issue_Lines/call) is unchanged internally — it
  just emits less per page now.

### 1C. `submitReceipt` (widget) — sweep + finalize loops

- Collect `vouchers` = union of every material's `voucherIds` + every waste row's / printed row's
  voucher. `plansTouched` = union of every confirmed material's `orders[].planId`.
- `shortMaterials` = for each material row where he typed **less than `pending`**:
  `{ materialId, owed: pending, received: typed, remark }`. Empty in the one-click "all received"
  case.
- **Sweep loop:** POST `{vouchers, shortMaterials, waste, printedPieces, sweepCursor}`,
  `finalize:false`. Re-POST with the returned `sweepCursor` until `sweepDone`. Waste + printed go
  on the first call only.
- **Finalize loop:** POST `{vouchers, plansTouched, finalize:true, finalizeCursor}`; re-POST with
  the returned `finalizeCursor` until `ph:"done"`.
- Reuse the progress bar from the store Issue screen for both loops. Rate-limit backoff as today.
- No more client-side chunking of settlements — there are none.

### 1D. `getSupervisorCounts` — noted, low priority

Line 84 `Plan_Item[Item_Status == "Awaiting_Material" && Remake_Reason in (...)]` is
factory-wide, filtered to the supervisor only afterward. Bounded by remake volume, not item
count, so it holds for now — but if remake volume climbs it needs a per-supervisor bound
(e.g. via `Production_Planning[Assigned_To == supId]` first).

---

## Phase 2 — UI: expand-in-place breakdown (visibility only) — **BUILT (2026-09-01)**

Files: `deluge/getReceiveItemBreakdown.dg` (NEW → NEW Custom API), `app/supervisor/js/receive.js`,
`app/supervisor/css/style.css`.

Receive screen **stays one row per physical thing** (SKU / roll) — that is what he measures.

- **Chevron on each material row (`renderMaterialRow`) → toggles a full-width breakdown `<tr>`**
  under it (`toggleMatBreakdown`). Only rendered when `m.orders` is non-empty. Both modes.
- The breakdown lists **one line per order** (`m.orders`, rolled up per plan by
  `getSupervisorMaterials`): `SO-1042 · needs 40 Mtr · 2 lines`, a `reissue` pill where the plan
  is one.
- **Each order line has its own chevron → lazy per-item detail** (`toggleOrderBreakdown`), fetched
  once from `getReceiveItemBreakdown(planId, materialId)` and cached in `BD_CACHE` keyed
  `planId|materialId`. Returns each item on that plan carrying a requirement for the material —
  SKU, name, still-owed (`owedPieces` for fabric / `owedQty` for trim), `Item_Status` mapped to a
  shop-floor word, and a remake-reason pill.
- **Read-only in every mode.** No inputs anywhere in the breakdown. The old always-expanded
  EDIT-mode `order-chip` list is removed — the chevron replaces it.
- `getReceiveItemBreakdown` is bounded: `Plan_Item[Plan == planId]` then that item's
  `Material_Requirement` rows, `Material` matched in code (a `Material ==` query filter on that
  form is unreliable — same reason the printed-piece sibling scan matches in code).

Verified: `dgscan` clean; `node --check`; stub-DOM render smoke test (both modes, no-orders row
gets no chevron, item table / status labels / remake pills render); full regression suite green.

**Deferred:** letting the supervisor pick which orders absorb a shortfall. When wanted, it slots
into the EDIT-mode breakdown as "short by" inputs summing to the row shortfall, prefilled
oldest-first, and `submitReceipt` builds explicit settlements from them for the affected plans.
`receiveMaterials` already applies whatever per-line settlement the widget sends, so it needs no
change for that.

---

## Phase 3 — orphan lines (low priority)

An Issue_Line whose `Requirement` won't resolve (deleted plan, empty field) lists under the SKU
with `planId=""`, settles stock, but raises no dispute if short and never reaches the readiness
sweep. At 10,000 lines the odds of one bad row rise.

- `getSupervisorMaterials`: tag such lines `"orphan": true`.
- `receiveMaterials`: an orphan short line raises a store-visible dispute with no plan instead of
  dropping silently.

---

## Deploy footprint (when built)

- `deluge/getSupervisorMaterials.dg` — paste + Execute
- `deluge/receiveMaterials.dg` — paste + Execute; **Custom API arg list unchanged** (still
  `supervisorId`, `receiptsJson`) so no Creator config change
- `deluge/getReceiveItemBreakdown.dg` — NEW function → **create a NEW Custom API** in Creator,
  method POST, args **`planId`, `materialId`** (in that order)
- `app/supervisor/js/receive.js` + `app/supervisor/css/style.css` — widget bundle
- No Creator form/field changes (all fields read already exist).
