# Waste Material — form design

## Decisions this is built on

- SKU is unique per distinct material, so **no dye lot / shade / batch fields**. If anything differs, it is a different SKU.
- **Grain is fixed.** `Width` always runs across the fabric width; `Length` always runs along the roll. The two are never swapped, so a `40x30` piece can never fill a `30x40` requirement.
- **Width unchanged = raw material.** A short full-width roll stays in `Raw_Material` as metres of stock. Only a piece whose width has been *reduced* becomes a waste cut piece.
- **A waste piece is always consumed whole.** It is issued, cut, and whatever is left is re-declared by the supervisor as new waste. There is no partial return of a half-used piece, so a plain count decrement is enough — no per-piece IDs.
- **No minimum usable size.** The calculation emits every remnant it produces; the supervisor deletes the ones not worth keeping.
- Waste applies to **fabric only**, not accessories.

## Structure: flat table, not master + subform

One record per **generation event per size**, not one record per SKU with a growing subform.

A per-SKU subform accumulates rows forever, gets slow to update in Deluge, and two store persons editing the same SKU record collide. More importantly, merging identical sizes into a running total destroys `Source_Plan` and `Generated_On`, which kills the aging report and any costing later.

The widget still groups by size for display — the store person sees `40x30 — 12 pieces` even though that is three rows underneath. FIFO consumption then falls out naturally: oldest row first.

## Waste_Master

Form link name is **`Waste_Master`** (display name "Waste Master"). Built as phase 1 — six fields, enough for the whole issue / cut / return loop to work end to end:

| Field link name | Type | Notes |
|---|---|---|
| `SKU` | Lookup -> Raw_Material | |
| `Piece_Width` | Decimal | cm, across the fabric width |
| `Piece_Length` | Decimal | cm, along the roll |
| `Piece_Count` | Decimal | pieces of this size in this batch — always written as a whole number |
| `Status` | Dropdown | `Pending_Receipt` / `Available` / `Reserved` / `Disputed` / `Consumed` / `Scrapped` / `Miscounted` / `Issued` / `Lost` |
| `Remarks` | Multi Line | |

Rows are never deleted. A discarded remnant is written with `Status = Scrapped` so the scrap is reportable.

**`Scrapped` and `Miscounted` are not the same thing, and the difference is the scrap report.** `Scrapped` means he cut a real remnant and decided it was not worth keeping — fabric genuinely left the process, and that is the number "how much did we throw away this month" is asking for. `Miscounted` means the piece never existed: he typed the wrong count, the store found nothing, and he owned up via `Supervisor_Correction`. Putting a miscount into `Scrapped` would inflate scrap with fabric that was never cut.

**`Piece_Count` means two different things depending on the status.** While the row is `Pending_Receipt` it is what the supervisor *declared* — a claim, not stock. From `Available` onwards it is what is physically on the rack. `receiveWastePieces` is the moment it changes meaning, and it may reduce the number: see *Receipt handover* below.

`Disputed` is for a row the store found **none** of. `Pending_Receipt` would offer it again on the receipt screen tomorrow, and `Available` with a zero count would hand the allocator a phantom row — so it needs a status of its own, invisible to both.

**FIFO comes from `Added_Time`**, Creator's own system field — no `Generated_On` needed. This is what makes "one record per generation event" still correct with the reduced field set: identical sizes stay as separate rows with different `Added_Time`, so the oldest gets consumed first and aging is still reportable.

Deferred to phase 2, none of them blocking:

| Field | Buys you |
|---|---|
| `Source_Plan` -> Production_Planning | which job produced the piece — costing and traceability |
| `Source_Type`, `Parent_Waste` | how deep the reuse chain goes |
| `Generated_By`, `Received_By`, `Received_On` | who cut it, who accepted it |
| `Location` | which rack it is on |

`Location` is the one worth adding soonest. Without it the widget can tell the store person to fetch a 40x165 piece but not where it is.

## Receipt handover

The supervisor saves the kept remnants into `Waste_Master` himself, at `Status = Pending_Receipt`. The store person then physically receives them and marks them `Available`.

**Only `Available` rows are stock.** `Pending_Receipt` pieces must be excluded from the waste stock the issue screen allocates against — otherwise the calculator will promise the store person pieces that are still sitting on the cutting table. This is the one place the status filter genuinely matters, so it belongs in the fetch criteria, not in widget-side filtering.

**Receipt is a count, not a tick.** `receiveWastePieces` takes a number per row, and the declared count is only a claim until it is checked. What the store found becomes `Piece_Count`; the gap goes to `Disputed_Count` and raises an `Inbound` `Stock_Dispute` against the supervisor — the mirror of the one he raises when the store issues him short. This is the same two-key rule as the outbound leg: the store saying "they were on the rack after all" (`Found`) is the only thing that puts the missing pieces back, the supervisor saying "I declared more than I sent" (`Supervisor_Correction`) just drops them, and it only becomes `Lost` once both have said no.

The supervisor has a third answer the outbound leg has no equivalent for: **`Supervisor_Resending`** — *"I still have them and I am sending them now."* The pieces go back to `Pending_Receipt` and the store checks them in normally. Without it his only exits were to claim pieces that exist never did, or to deny them into a write-off.

**A row still holding `Available` stock must not be re-queued.** Those pieces are already checked in; putting the whole row back to `Pending_Receipt` offers them a second time. `resolveDispute` reuses the row only when `Piece_Count` is 0, and otherwise creates a **new** `Waste_Master` row for the re-sent pieces plus its own `Declared` movement — the check-in list reads the plan, order and supervisor off that movement, not off the piece.

Nothing on this path re-opens a requirement — an offcut coming back was never owed to an order.

The report bulk action `markWasteReceived` stays full-receipt-only. A report action fires on click with nowhere to type a number; use it when the count is not in question.

## Raw_Material

Fabric width lives in `Fabric_Width_Inches` — a **text** field, converted with `.trim().toDecimal() * 2.54`. Everything inside the cutting calculation is cm; the inch conversion and the metres conversion both happen at the boundary and nowhere else.

## Carrying the 2D requirement on the plan

`Raw_Material_Check.Required_Qty` stays exactly what it is today — **metres of fresh fabric assuming nothing comes from waste**. It is the plan's material demand, and `issueMaterials` keeps booking against it unchanged. New fields carry the 2D detail beside it, populated for fabric rows only:

| Field | Set at plan creation | Notes |
|---|---|---|
| `Cut_Size_Length` | from BOM | cm, along the roll |
| `Cut_Size_Width` | from BOM | cm, across the fabric width |
| `Required_Pieces` | `= Quantity_to_Produce` | one cut piece per item, always — never changes, the audit anchor |
| `Pieces_From_Waste` | `0` | pieces issued from waste so far |
| `Pieces_From_Raw` | `0` | pieces issued off fresh fabric so far |

The two `Pieces_*` fields are **issued-so-far counters**, exactly like `Issued_Qty` — not a planned split. Outstanding pieces are `Required_Pieces - (Pieces_From_Waste + Pieces_From_Raw)`.

Waste is deliberately **not** considered at plan creation: waste stock moves between plan creation and issue, so a split decided at plan time would be stale by the time the store person acts. The allocation is computed fresh on every requirements fetch.

## Fabric fulfilment is counted in pieces, not metres

Once waste is in play, `Required_Qty` stops being a target and becomes an estimate — "the metres this would take if nothing came from waste".

A requirement fully covered by waste needs 0 metres. It gets issued 0 metres. So `Required_Qty - Issued_Qty` never moves, and without a correction that line sits on the store screen as pending forever. `getStoreMaterialRequirements` therefore overrides `remaining` with the waste-adjusted `freshMeters` for fabric lines, and completion is judged on `Required_Pieces` vs `Pieces_From_Waste + Pieces_From_Raw`.

The consequence: **on the plan record itself, a fabric row covered by waste will show `Issued_Qty` short of `Required_Qty` and stay that way.** That is honest — no fabric was issued — but any Creator report reading those two fields will call the plan incomplete. The alternative is writing the saved metres into `Issued_Qty` anyway, which would falsify the material ledger. Left as-is deliberately; revisit if the reports start lying.

## Aggregation key

`getStoreMaterialRequirements` groups by `supervisor | material`. For fabric that is **not enough** — two plans needing the same fabric at `55x55` and `45x90` would sum into one meaningless piece count. The fabric key must be `supervisor | material | cut width x cut length`, so each cut size is its own line on the store person's screen. Non-fabric rows keep the old two-part key.

The store person sees: *"issue N pieces of `A x B` from waste, plus X.XX m fresh."* The supervisor later sees the same rows to know which cut sizes were issued to him.

## Issue history

Do **not** build a separate waste-issue log. Add to the existing `Raw_Material_Check` subform on `Production_Planning`:

| Field | Notes |
|---|---|
| `Source` | `Raw Material` / `Waste` |
| `Waste_Piece` | Lookup -> Waste_Material, set when `Source = Waste` |
| `Piece_Width`, `Piece_Length` | cm, for waste rows |
| `Piece_Count` | for waste rows |

One issue history, one place to reverse from, and the existing reassign action keeps working unchanged.

## Where cut sizes come from

The `BOM` form, `Material Required` subform:

| BOM field | Use |
|---|---|
| `Cut Size Length` | decimal — runs along the roll |
| `Cut Size Width` | decimal — runs across the fabric width |
| `Required Quantity` | **non-fabric only** — cones of thread, kg of filling. Not read on the fabric path. |
| `Unit` | non-fabric unit of measure. Not read on the fabric path. |
| `Type`, `Pattern` | not used by the calculation |

For fabric it is **always one cut piece per finished item**, so the piece count is `Quantity_to_Produce` directly. Cut sizes are cm. `Cut Size Length` / `Cut Size Width` map onto the calculator's `cutLength` / `cutWidth`.

## The cutting calculation

For a requirement of `qty` pieces at `cut_width x cut_length` on a fabric of width `W`:

```
per_row   = floor(W / cut_width)
side_w    = W - (per_row * cut_width)
rows      = ceil(qty / per_row)
full_rows = floor(qty / per_row)
last_row  = qty - (full_rows * per_row)
length_required = rows * cut_length
```

Exactly two remnants come out of this:

1. **Side strip** — `side_w x (full_rows * cut_length)`, as **one continuous piece**, because it is cut off in a single pass down the roll.
2. **Partial-row remnant** — when `last_row > 0`: `(W - last_row * cut_width) x cut_length`. One piece, because the unused slots and the side strip in that last row are contiguous.

The identical function runs against a waste piece: pass `W = Piece_Width` and cap `length_required` at `Piece_Length`. Because a waste piece leaves the store whole, a third remnant appears — the **unused tail**, `Piece_Width x (Piece_Length - length_used)`.

Each cut size is calculated **independently**. A remnant produced by one cut size is not re-used by another cut size within the same job; it goes back to store as waste and is picked up on a later job.
