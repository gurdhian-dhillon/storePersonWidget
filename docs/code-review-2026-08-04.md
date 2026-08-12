# Codebase review — 4 Aug 2026

Full read of all 24 Deluge functions and the four widget JS files.
Structural scan (brace/paren balance, loop-variable/scalar name clash, bare `break`,
inline `sort by`) clean except where noted below. All JS passes `node --check`.

Nothing in here has been executed — Deluge cannot be run outside Creator. The
arithmetic in **C1** was verified numerically against the admin widget's own
re-derivation; **C2, C4, C5, C6** are control-flow readings that need a Creator
**Execute** to confirm.

---

## Critical — silent wrong numbers or lost stock

### C1. `createProductionPlans.dg:189` — integer division truncates the fabric requirement

```deluge
piecesPerRow = (widthCm / cutWid).floor();
totalRows    = (piecesNeeded / piecesPerRow).ceil();   // both integers
```

This is the trap CLAUDE.md documents (`* 1.0` first). Every other site got the fix —
`getStoreMaterialRequirements.dg:453,491`, `getAdminCalculation.dg:419` — this one
did not. `.ceil()` runs on an already-truncated quotient, so whenever the order
quantity is not an exact multiple of pieces-per-row, `Required_Qty` is short by
exactly one full row:

```
fab 111.76cm cut 45x55 qty 11: perRow=2  stored=2.75m  correct=3.30m   (-0.55m)
fab 111.76cm cut 45x55 qty 25: perRow=2  stored=6.60m  correct=7.15m   (-0.55m)
fab 142.24cm cut 45x90 qty 20: perRow=3  stored=5.40m  correct=6.30m   (-0.90m)
fab 142.24cm cut 30x60 qty 50: perRow=4  stored=7.20m  correct=7.80m   (-0.60m)
fab 111.76cm cut 55x55 qty  7: perRow=2  stored=1.65m  correct=2.20m   (-0.55m)
```

The admin audit re-derives this in JS (`app/admin/js/main.js:80`,
`Math.ceil(pcs / perRow)` — true float division), so the audit screen is already
flagging these as disagreements.

**Fix:** `totalRows = ((piecesNeeded * 1.0) / piecesPerRow).ceil();`

### C2. `createProductionPlans.dg:44` — bare `break` in a `for each`

```deluge
for each lp in allPlansDesc
{
    lastNo = lp.Plan_No;
    maxNum = lastNo.substring(lastNo.lastIndexOf("-") + 1).toLong();
    break;
}
```

CLAUDE.md: *"There is no reliable `break` in a `for each` — guard the body with an
`if` instead."* The list is sorted **desc**, so if the break does not take, `maxNum`
ends up holding the **oldest** plan's number and every subsequent plan number
collides with an existing one. The re-fetch at line 236 is
`Production_Planning[Plan_No == planNo]`, so a collision attaches the new plan's
items to the **wrong plan record**.

This is the only bare `break` in the repo. `lastNo` is also unguarded against an
empty `Plan_No`.

**Fix:** guard with a flag, e.g. `if(maxNum == 0){ ... }` inside the body, or track
the max explicitly rather than relying on sort order + break.

### C3. `Material_Exception` type field has two different link names

| File | Reads |
|---|---|
| `getStoreMaterialRequirements.dg:209` | `oex.Type_field` |
| `getStoreRequests.dg:66` | `ex.Type` |
| `raiseMaterialException.dg:109` | queries `Type == exType` |

Only one can be the real link name.

- If it is `Type_field` (what Creator generates, since `Type` is reserved):
  `raiseMaterialException`'s dedupe query never matches, so **every repeat report
  raises a new ticket** instead of appending; and `getStoreRequests` renders every
  row with a blank `kind`, breaking its `exType == "Wash_Needed"` branch at line 88
  so wash tickets never show their job status.
- If it is `Type`: `getStoreMaterialRequirements` throws and the whole issue screen
  returns the error card.

**Fix:** read the form, make all three agree. Creator-side check required.

### C4. `issueMaterials.dg` — waste pieces can leave the rack with no movement record

Consuming the picks (line 330) is unconditional once validation passes. But the
`Waste_Movement` "Issued" insert is nested three levels deep inside
`if(fanWaste > 0)` → `if(pRem2 > 0)` → `if(giveW > 0)` (lines 468–538).

When `outPieces` is 0, line 271 caps `piecesFromWaste` to 0, so `fanWaste` is 0 and
**no movement is written** — yet `Piece_Count` was already decremented and
`In_Transit_Count` incremented at line 360.

Result: pieces off the rack, sitting in `In_Transit_Count` forever.
`getSupervisorMaterials` builds the receive list from
`Waste_Movement[... Movement_Type == "Issued"]`, so there is nothing for the
supervisor to confirm and nothing to settle it.

Reachable via a stale screen: the store person loads the issue list (picks offered
because `outstandingPieces > 0`), someone else issues, he presses Issue with the old
payload. The pick still validates — `Status == "Available"`, count still there — but
`outPieces` is now 0.

**Fix:** write the Issued movement whenever `picks` were actually consumed, not only
when waste credit was applied.

### C5. Double-counted disputes between `getSupervisorMaterials` and `receiveMaterials`

`getSupervisorMaterials.dg:196-206` subtracts open disputes from the pending figure
it sends the widget. `receiveMaterials.dg:103` computes
`rowPend = Issued_Qty - Received_Qty` with **no dispute subtraction**.
`receive.js:405` submits the widget's (dispute-adjusted) number.

So once a material has an open dispute *and* fresh stock is issued against the same
plan + material, the second receipt raises a duplicate dispute for the
already-disputed quantity:

```
issue 10 → receive 8   → Disputed_Qty = 2, dispute #1 open
issue 5 more           → Issued=15, Received=8
widget shows pending 5 (7 raw − 2 disputed)
supervisor confirms 5  → server pendingTotal = 7, shortBy = 2
                       → dispute #2 raised, Disputed_Qty = 4
```

The same 2 metres counted as missing twice. CLAUDE.md's own rule — *"Disputed
quantity is not pending receipt"* — is applied in the read function but not the
write function.

**Fix:** subtract open-dispute quantity in `receiveMaterials` when computing
`pendingTotal`, using the same per-plan/material keying `getSupervisorMaterials` uses.

### C6. `saveProductionPhase.dg:163` — `Qty_Produced` escapes the cap

```deluge
lg.Qty_Out = capped;          // line 119 — capped at Qty_In
...
pi.Qty_Produced = qtyOut;     // line 163 — raw payload value
```

The header comment says *"capped here at Qty_In: you cannot finish more than you
received, whatever the payload claims"* — but the field the order summary and
`getOrderConsumption` read is not capped. The widget checks
(`production.js:781`), so this needs a crafted payload; a Custom API is callable from
anywhere.

**Fix:** one word — use `capped` / `capped2`.

---

## Should fix

- **`issueMaterials.dg:522`** — `Pieces_Yielded = nPcs3 * pkYield.get(wId3)` records
  the *uncapped* yield even when line 271 capped `piecesFromWaste`.
  `resolveDispute.dg:696` then winds back `take * mvYield` cut pieces — more than
  were ever credited — pulling `Pieces_From_Waste` off rows this handover never
  touched.

- **`issueMaterials.dg:593-600`** — "only X was needed, issued that instead of Y" is
  pushed into `errors[]`, and `app/js/main.js:1220` renders that as *"Some materials
  could not be issued"*. A capped-but-successful issue reads as a failure.

- **`issueMaterials.dg:410` vs `receiveMaterials.dg:82`** — the issue fan matches on
  `row.Material` only; the receive fan also requires `row.Assigned_To == supId`.
  They agree today because `createProductionPlans` writes both from the same
  `assignedEmpId`. The moment the reassign action lands, a reassigned plan will have
  rows issuable but not receivable — `pendingTotal` 0, no In-Transit settle, no
  dispute, silent stranding.

- **`markWasteReceived.dg:41-54`** — writes a `Received` movement with no
  `Parent_Movement` and no `Moved_By`, where `receiveWastePieces.dg:160` sets both.
  Anything walking Declared → Received children will not see it.

- **`createProductionPlans.dg:171-178`** — when width or cut size is missing the row
  is written with `Required_Qty = 0` but `Required_Pieces = produceQty`. Because
  `issueMaterials.dg:378` requires `cutW > 0` to credit `Pieces_From_Raw`, that row
  **can never be satisfied**: metres get issued, pieces never move, and the item sits
  at `Awaiting_Material` forever. The comment says the empty requirement gets
  questioned — but nothing on the store screen says why the row will not close.
  Consider blocking the plan instead, or surfacing it.

- **Pure-waste issues produce no `Material_Issue`** — `issueMaterials.dg:614` is
  guarded on `issueLines.size() > 0`, and lines are only added when `give > 0` metres.
  `getSupervisorCounts.dg:41` counts the receive badge off `Material_Issue`, so a
  fabric requirement fully covered by offcuts gives a badge of 0 with rows waiting on
  the tab.

- **Inline `sort by` in a `for each` header** — against the project's own rule, 3
  sites: `getProductionWidgetData.dg:12`, `getProductionWidgetData.dg:161`,
  `getSupervisorMaterials.dg:27`.

- **`resolveStockDispute.dg` is a live hazard, not just clutter.** It is an
  On Add / On Edit form workflow on `Stock_Dispute`. `receiveMaterials` and
  `receiveWastePieces` both *insert* into that form and `resolveDispute` *edits* it,
  so it fires on every one of those. The `Processed=true` flag is the only thing
  keeping it from double-applying. Deleting it in Creator is the fix CLAUDE.md
  already calls for — worth doing before go-live, not after.

- **Statement-limit exposure.** `getSupervisorMaterials` walks *all* open plans (not
  just the supervisor's) and nests `Material_Requirement[Plan == plan.ID]` **inside**
  the per-waste-movement loop (line 288) — plans × movements × requirements. That is
  the shape that killed the allocator before, and it fails as an uncatchable bare 500.
  Also unbounded, no date filter: `createProductionPlans.dg:38`,
  `getStoreRequests.dg:34`, `getStoreRequests.dg:61`, `getOrderConsumption.dg:41`,
  `getAdminCalculation.dg:57` — all `[ID != 0]`.

- **`app/js/main.js:80-89`** — the `applyStockAllocation` header describes subtracting
  earlier supervisors' demand from later ones' stock. The body (rewritten to show true
  stock plus a contention badge) does nothing of the kind. The comment will send the
  next reader looking for a bug that is not there.

---

## Incomplete workflows

Beyond the gaps CLAUDE.md already lists (no login, no finished-goods stock,
QC/packing/dispatch widgets), these are the ones the code implies but does not finish:

- **`qcAutoPopulate.dg` exists and looks correct, but nothing consumes it.** It
  rebuilds `QC_Items` from `Plan_Item` on the `Quality_Check` form — so the QC seam is
  half-built: `saveProductionPhase` hands the order to `Production Complete`, and then
  the chain stops. Nothing writes `QC Passed`, `Packed` or `Dispatched`, so
  `Sales_Order.Order_Status` has three terminal states no code path can reach.

- **Notifications are commented out in two places** — `raiseMaterialException.dg:310-325`
  and `createProductionPlans.dg:321-341`. The second is the more serious one: an order
  with no `Order_Assignment` rule is skipped silently on every run and nothing tells
  anyone.

- **The store's waste-receipt screen has no way to defer a row.**
  `submitWasteReceipt` (`app/js/main.js:1619`) submits every row in `wastePending` at
  whatever the default is. A piece the supervisor declared but the store has not
  physically seen yet gets received in full when he presses the button for an
  unrelated row.

- **`Wash_Request` has a `Cancelled` status** that `completeWashRequest.dg:38` guards
  against, but nothing writes it, and `getStoreRequests.dg:107` does not count it — a
  cancelled wash would show as neither open nor closed.

---

## Redeployment, if these are fixed

**Deluge (`.dg` → paste into the matching Custom API / function in Creator, Save):**

- `createProductionPlans.dg` — C1, C2
- `issueMaterials.dg` — C4, plus the `Pieces_Yielded` and `errors[]` items
- `receiveMaterials.dg` — C5
- `saveProductionPhase.dg` — C6
- `markWasteReceived.dg` — movement links
- whichever of `getStoreMaterialRequirements.dg` / `getStoreRequests.dg` /
  `raiseMaterialException.dg` has the wrong `Type` spelling — C3

**Widget (served locally, then zipped and uploaded):**

- `app/js/main.js` — comment correction only

**Creator config / manual, not a code change:**

- Confirm the real link name of the `Material_Exception` type field (C3)
- Delete the `resolveStockDispute` form workflow

No function signature changes are implied by any of the above, so no Custom API
argument lists need editing.
