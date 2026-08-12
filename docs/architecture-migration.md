# Architecture migration — from one plan form to a tracked module set

Agreed 2026-07-30. Incremental, nothing breaks at any step.

## Why

Everything currently hangs off `Production_Planning` and its four subforms. That
is fine for the material side but makes real tracking impossible, because
**a subform row is not a record**: it cannot be looked up from elsewhere, cannot
carry its own status, cannot be reported on independently, and cannot be written
concurrently — the whole parent record locks.

Two principles drive the target shape:

1. **Anything tracked must be a record, not a subform row.**
2. **Balances and events are different things.** A balance answers "how much is
   owed"; an event answers "what happened at 3pm". You cannot un-sum a balance,
   so storing only balances loses history permanently.

## Target module map

Masters are unchanged: `Item_Master`, `Raw_Material`, `BOM` (+ `Material_Required`,
+ `Production_Stages`), `Employee`, `Waste_Master`.

### Job records

| Form | Grain | Purpose |
|---|---|---|
| `Production_Planning` | one per Sales Order | order-level status, assignment |
| `Plan_Item` | one per finished item | item-level status, ordered vs produced |
| `Material_Requirement` | one per Plan_Item x material x cut size | balances |
| `Stage_Log` | one per Plan_Item x stage | operator, times, qty in/out |

### Event records

| Form | Grain |
|---|---|
| `Material_Issue` + lines | one per handover |
| `Waste_Movement` | issued / returned / received / scrapped |
| `Material_Exception` | already exists |

`Plan_Item` is the pivot. Once it is a record, `Material_Requirement` and
`Stage_Log` link to it instead of to a plan plus a text SKU, and item-level
tracking becomes a query rather than a subform walk.

## Status model

Three levels, each derived from the one below, each written by **exactly one
function**, recomputed at the end of every operation that could change it.

```
Stage_Log.Status         Not_Started -> In_Progress -> Done
Plan_Item.Item_Status    Awaiting_Material -> Ready -> In_Production -> Complete
Production_Planning      Pending -> Material Received -> Production Complete
```

Statuses are stored, not computed on read — computing on read means walking every
child on every screen load.

## Reliability rules

1. **Events are append-only.** Never edited, never deleted. Corrections are new
   events.
2. **A balance is only written by the function that writes its matching event.**
   Nothing else may touch `Issued_Qty`.
3. **Every retryable operation carries an idempotency key.** The waste
   double-declaration bug exists precisely because there is none — with
   `Waste_Movement` keyed on `Stage_Log`, a second declaration is refusable.
4. **Widgets never compute state.** The server decides, the widget renders.

## Migration order

**Existing data is disposable.** Plans can be deleted and recreated from sales
orders, so no backfill scripts and no dual-write period: create the form, point
the writer and the readers at it in the same sitting, delete the old plans,
re-run `createProductionPlans`. That is only true while volume is this low — the
moment there is history worth keeping, revert to create -> backfill ->
dual-write -> move readers -> drop.

| Step | Change | Unblocks |
|---|---|---|
| 1 | `Plan_Item` out of `Item_Table` | item-level tracking |
| 2 | `Stage_Log` out of `Production_Tracking` | write contention, operator/throughput reports |
| 3 | `Material_Requirement` out of `Raw_Material_Check` | coupled to step 1 |
| 4 | `Material_Issue`, `Waste_Movement` (new, no backfill) | handover history, waste audit |

Do it now rather than later only because migration cost scales with data volume:
a few scripts today, a project after a year of orders.

---

# Step 1 — `Plan_Item`

## Form: `Plan_Item`

Built, with these link names:

| Link name | Type | Notes |
|---|---|---|
| `Plan` | Lookup -> Production_Planning | |
| `Item_Sku` | Lookup -> Item_Master | replaces `Item_Table.Plan_Item_Sku` |
| `Item_Name` | Single Line | denormalised, for display and reporting |
| `BOM` | Lookup -> BOM | which BOM this item was planned against |
| `Qty_Ordered` | Decimal | from `Quantity_to_Produce`, never changes |
| `Qty_Produced` | Decimal | final stage `Qty_Out`; 0 until Finishing ends |
| `Item_Status` | Dropdown | `Awaiting_Material` / `Ready` / `In_Production` / `Complete` |
| `Line_No` | Number | display order within the plan |

`Qty_Ordered` and `Qty_Produced` are deliberately separate: ordered is the
promise, produced is what came out, and the gap is loss. Overwriting one with the
other destroys the only evidence that anything went wrong.

## What changed in code

Only two functions ever touched `Item_Table`, so this was a clean cutover.

**`createProductionPlans`** — no longer builds an `Item_Table` collection.
`Plan_Item` is a separate form and cannot be inserted before the plan header
exists, so item rows are gathered into a list during the item loop and written
after the header, alongside the `Raw_Material_Check` subform insert. `Item_Status`
starts at `Awaiting_Material`; `Qty_Produced` starts at 0.

**`getProductionWidgetData`** — reads `Plan_Item[Plan == plan.ID] sort by Line_No`
instead of walking `plan.Item_Table`. Field mapping: `Plan_Item_Sku` -> `Item_Sku`,
`Quantity_to_Produce` -> `Qty_Ordered`. The item JSON now also carries `status`
and `produced`, which the widget does not use yet.

Note `so.Item_Table` in `createProductionPlans` is the SALES ORDER's subform and
is unrelated - it stays.

`Production_Planning.Item_Table` is now unused and can be deleted from the form
once new plans are confirmed working.

---

# Step 2 — `Stage_Log`

## Form: `Stage_Log`

| Link name | Type | Notes |
|---|---|---|
| `Plan` | Lookup -> Production_Planning | denormalised, for cross-plan reports |
| `Plan_Item` | Lookup -> Plan_Item | the real parent |
| `Sequence_No` | Number | from the BOM stage |
| `Phase_Name` | Single Line | |
| `Operator` | Lookup -> Employee | was `Operator_Name` |
| `Log_Date` | Date | stamped at Start — NEW |
| `Start_Time` | Time | |
| `End_Time` | Time | |
| `Qty_In` | Decimal | |
| `Qty_Out` | Decimal | |
| `Remarks` | Multi Line | |
| `Stage_Status` | Dropdown | `Not_Started` / `In_Progress` / `Done` |

`Log_Date` is new. The times were `15:55` with no date, so a stage spanning two
days was ambiguous and "how much cutting happened this week" was unanswerable.
A Date field alongside the Time fields fixes that without any datetime parsing.

## What changed in code

**`saveProductionPhase`** — rewritten against `Stage_Log`. Payload now carries
`planItemId` instead of `itemSku`, plus `sequence` and `isLastStage`. Also rolls
status up, which nothing did before:

- End of any stage -> `Plan_Item.Item_Status = In_Production`
- End of the LAST stage -> `Item_Status = Complete`, `Qty_Produced = Qty_Out`
- All items Complete -> `Production_Planning.Order_Status = "Production Complete"`

**`getProductionWidgetData`** — reads `Stage_Log[Plan_Item == itm.ID] sort by
Sequence_No` instead of filtering `plan.Production_Tracking` by SKU. Log JSON now
also carries `status`.

**Widget** — sends `planItemId` (which is `item.id`, already the Plan_Item id
after step 1), the phase's `sequence`, and `isLastStage` computed from the sorted
phases array.

`Production_Planning.Production_Tracking` is now unused and can be deleted from
the form once new plans are confirmed working.

## Why this step mattered most

Every Start and End used to rewrite the plan record. Two supervisors working
different items of the same plan could silently lose each other's writes, because
Creator locks the parent record on a subform update. Separate records cannot
collide.

---

# Step 3 — `Material_Requirement`

## Form: `Material_Requirement`

| Link name | Type | Replaces |
|---|---|---|
| `Plan` | Lookup -> Production_Planning | — |
| `Plan_Item` | Lookup -> Plan_Item | `For_Item_Sku` (was an Item_Master id) |
| `Material` | Lookup -> Raw_Material | `SKU` |
| `Material_Name` | Single Line | `Name` |
| `Is_Fabric` | Checkbox | same |
| `Unit` | Single Line | same |
| `Assigned_To` | Lookup -> Employee | same |
| `Required_Qty` `Issued_Qty` `Received_Qty` | Decimal | same |
| `Cut_Size_Length` `Cut_Size_Width` | Decimal | same |
| `Required_Pieces` `Pieces_From_Waste` `Pieces_From_Raw` | Number | same |

Also added: **`Plan_Item` (Lookup -> Plan_Item) on the `Waste_Issued` subform**,
replacing its `For_Item_Sku`.

The rename from `SKU`/`Name` to `Material`/`Material_Name` is deliberate: `SKU`
meant two different things depending on which record you were holding, and
`For_Item_Sku` no longer holds an item SKU at all.

## What changed in code — seven functions

**`createProductionPlans`** — requirements can no longer be built as a Collection
because each one needs its Plan_Item's id, which does not exist until the header
is inserted. They are gathered per item as a JSON string on the item's map, then
written after each `Plan_Item` insert.

**`getStoreMaterialRequirements`, `issueMaterials`, `receiveMaterials`,
`getSupervisorMaterials`, `getExpectedWaste`** — `plan.Raw_Material_Check`
becomes `Material_Requirement[Plan == plan.ID]`, plus the field renames.

**`getProductionWidgetData`** — now queries `Material_Requirement[Plan_Item ==
itm.ID]` directly instead of pulling the plan-wide list and filtering by SKU. The
waste block no longer cross-matches against requirements either, since
`Waste_Issued.Plan_Item` identifies the item on its own.

**`getExpectedWaste`** — parameter renamed `itemSku` -> `planItemId`. The widget
sends `item.id` for it.

`Production_Planning.Raw_Material_Check` is now unused and can be deleted from
the form once new plans are confirmed working.

## What this bought

- Two store people issuing at once no longer contend on plan records
- A requirement is a record, so `Material_Issue` lines can link to one
- The same item appearing twice on a plan is now distinguishable

---

# Step 4 — the event forms

Steps 1-3 turned every *balance* into a record. What is still missing is every
*event*: the balances say how much is owed and how much has gone out, but nothing
records that at 15:40 on Tuesday Ramesh handed 12m of a particular fabric to
Suresh. That is the difference the whole migration rests on — a balance answers
"where do we stand", an event answers "what happened", and neither can be
reconstructed from the other.

Both forms are new. No backfill, no dual-write, nothing to delete afterwards.

## Form: `Material_Issue` (header) + `Issue_Lines` (subform)

One record per handover — one press of Issue in the store widget, however many
materials it covered.

| Link name | Type | Notes |
|---|---|---|
| `Plan` | Lookup -> Production_Planning | |
| `Issued_By` | Lookup -> Employee | the store person |
| `Issued_To` | Lookup -> Employee | the supervisor; today `supervisorId` |
| `Issue_Date` | Date | |
| `Issue_Time` | Time | |
| `Issue_Status` | Dropdown | `Issued` / `Received` / `Partially_Received` |
| `Remarks` | Multi Line | |

`Issue_Lines` subform, one row per material actually handed over:

| Link name | Type | Notes |
|---|---|---|
| `Requirement` | Lookup -> Material_Requirement | the balance this line spends |
| `Plan_Item` | Lookup -> Plan_Item | denormalised, for item-level reports |
| `Material` | Lookup -> Raw_Material | |
| `Material_Name` | Single Line | |
| `Qty` | Decimal | |
| `Unit` | Single Line | |
| `Waste_Piece` | Lookup -> Waste_Master | set only when the line came off a remnant |
| `Piece_Count` | Number | pieces taken from that remnant |
| `Cut_Size_Length` `Cut_Size_Width` | Decimal | |

A line points at a `Material_Requirement`, which is only possible because step 3
made requirements records. That link is what lets "what did we actually give
against this line" be answered without matching on SKU.

`Issue_Status` on the header, not the line, because receipt is confirmed per
handover in the supervisor widget — a partially received handover is the
exception, not the norm.

## Form: `Waste_Movement`

One record per thing that happened to a remnant. Append-only: a piece that is
declared, issued, then consumed has three rows, and none of them is ever edited.

| Link name | Type | Notes |
|---|---|---|
| `Waste_Piece` | Lookup -> Waste_Master | the remnant |
| `Movement_Type` | Dropdown | `Declared` / `Received` / `Issued` / `Consumed` / `Scrapped` |
| `Plan` | Lookup -> Production_Planning | |
| `Plan_Item` | Lookup -> Plan_Item | |
| `Stage_Log` | Lookup -> Stage_Log | **the idempotency key** — set on `Declared` |
| `Piece_Width` `Piece_Length` | Decimal | |
| `Piece_Count` | Number | |
| `Moved_By` | Lookup -> Employee | |
| `Moved_On` | Date | |
| `Remarks` | Multi Line | |

`Stage_Log` is the point of the form. `saveWasteFromCutting` currently cannot
tell a retry from a genuine second declaration, because a `Waste_Master` row
carries no source — so a failed phase save followed by pressing End again writes
the remnants twice. With this link the function can look up
`Stage_Log[Plan_Item == x && Sequence_No == n]`, check whether a `Declared`
movement already exists against it, and refuse. That is a durable guard; the
`pendingEnd.wasteSaved` flag in the widget is session-scoped and dies on reload.

## What will change in code

**`issueMaterials`** — writes the `Material_Issue` header and its lines in the
same pass that spends `Material_Requirement.Issued_Qty`, per reliability rule 2.
Its `Waste_Issued` subform writes become `Waste_Movement` rows of type `Issued`,
which retires the last subform in `Production_Planning`.

**`saveWasteFromCutting`** — takes `planItemId` and `sequence` as new parameters,
resolves the `Stage_Log`, refuses a duplicate declaration, and writes a
`Declared` movement alongside each `Waste_Master` insert. Scrapped rows get a
`Scrapped` movement instead.

**`markWasteReceived`** — adds a `Received` movement.

**`receiveMaterials`** — flips `Material_Issue.Issue_Status`, so the supervisor
confirms a handover rather than a set of numbers.

**Widget** — the production widget must send `planItemId` and `sequence` with the
waste payload. It already has both in `pendingEnd.payload`; they are simply not
forwarded today.

## Order to build it

`Waste_Movement` first. It is smaller, it closes a live data-loss bug, and it
touches three functions instead of one large one. `Material_Issue` second.

## 4a — done 2026-07-31

Both forms created. The **declaration half** of `Waste_Movement` is written and
is purely additive — no reader moved, so nothing else could break:

- `saveWasteFromCutting` — signature is now
  `(planId, planItemId, phaseName, piecesJson)`. Resolves
  `Stage_Log[Plan_Item == x && Phase_Name == y]`, refuses if any movement already
  exists against that stage, and writes a `Declared` or `Scrapped` movement
  beside each `Waste_Master` insert. A duplicate returns `duplicate:true` with no
  error, because it is a retry, not a mistake.
- `markWasteReceived` — adds a `Received` movement.
- Production widget — forwards `planItemId` and `phaseName`, which it already
  held in `pendingEnd.payload`, and treats `duplicate:true` as success.

The `Waste_Piece` link is set after the insert and only when the returned id
resolves; if it does not, the movement is still written without the link. Losing
the link is bad, losing the event is worse.

## 4a-ii — `Material_Issue` writer, done 2026-07-31

`issueMaterials` now writes one `Material_Issue` header per handover, with a line
per requirement it spent. Lines are gathered in the same pass that writes
`Issued_Qty` (reliability rule 2) and written once at the end, because a subform
row needs its parent to exist first.

Three deliberate choices:

- **The whole write sits in its own nested try/catch.** By the time it runs,
  stock is decremented and balances are moved. A failure to *log* the handover
  must never fail the handover — and Deluge has no transaction to roll back with.
  It logs to `info` and the widget never hears about it.
- **`Plan` on the header is the first plan that took credit**, matching the
  existing `Waste_Issued` precedent. An issue can fan across plans; the lines
  carry `Plan_Item`, which is exact, so the header link is only a convenience.
- **`Issued_By` is left blank.** `zoho.loginuser` is an email, not an `Employee`
  id, and guessing the Employee email field name is exactly the kind of assumption
  that fails silently.

Waste picks are **not** yet written as `Issue_Lines` — they still go to the
`Waste_Issued` subform. Recording them in both places would mean two
representations of one handover; they move wholesale in 4b.

Additive: no reader moved, nothing reads `Material_Issue` yet.

`receiveMaterials` closes them off, in the same pass that decides
`Order_Status = "Material Received"`. `recvComplete` is tracked separately from
the existing `allDone`, because `allDone` also goes false when a requirement
simply has not been fully *issued* yet — a handover is `Received` once everything
that went out has come back, whether or not the plan is finished being issued.
Same nested try/catch: the receipt is already recorded by then, and failing it
over a status flag would be worse than a stale flag.

Both halves are now scoped **per plan**, not per handover. An issue that fanned
across two plans gets closed by whichever plan completes first. Acceptable while
a handover almost always belongs to one plan; if that stops being true, the fix
is a real issue-to-receipt link, not a smarter guess.

## 4b — done 2026-08-01

`Waste_Issued` retired into `Waste_Movement` rows of type `Issued`. Writer and
all five read sites moved in one sitting, as required — there is no dual-write
period because plans are disposable.

**Four fields added to `Waste_Movement`:** `Parent_Movement` (self-lookup),
`Cut_Size_Width`, `Cut_Size_Length`, `Pieces_Yielded`.

**The design problem was `Received_Count`.** The subform carried a mutable
counter that `receiveMaterials` edited in place. That cannot live on an
append-only event log, and putting it there anyway would have recreated exactly
the shape of the waste double-declaration bug: a counter with no record of what
moved it, so a retry is undetectable afterwards.

**Resolution: receipt is its own movement.** A `Received` row carries
`Parent_Movement` pointing at the `Issued` row it answers. Outstanding is
`Issued.Piece_Count − sum(Received children)`. Nothing is ever edited, a short
receipt leaves both numbers and both dates, and two receipts against one issue
are two visible rows rather than one number that has quietly moved twice.

**What changed where:**

- `issueMaterials` — writes an `Issued` movement per waste pick instead of a
  subform row.
- `getExpectedWaste`, `getProductionWidgetData` — read `Issued` movements,
  summing children for the received figure.
- `getSupervisorMaterials` — same, and `rowId` in its waste payload is now a
  `Waste_Movement` id.
- `receiveMaterials` — fetches that id directly instead of walking every plan,
  caps at what actually went out, and inserts a `Received` movement.

**No widget change.** The supervisor screen round-trips `rowId` without
interpreting it, so only its meaning moved.

The material is no longer denormalised onto the row — it is read off the
`Waste_Master` piece the movement points at. One extra fetch per waste row, and
one fewer field that can drift.

---

## Not done yet

Nothing structural. `Production_Planning` now has no subform in use —
`Item_Table`, `Production_Tracking`, `Raw_Material_Check` and `Waste_Issued` can
all be deleted from the form once new plans are confirmed working.

