# Lots — form design and flow

Agreed 2026-08-13. Built in Creator first, against existing data. The Zoho Inventory sync comes
afterwards and is designed for here but not built yet — see `inventory-integration.md`.

## Decisions this is built on

- **A lot is a tone, not a delivery.** Same SKU, same width, same everything recorded — the only
  difference is visible to the eye. When new cloth arrives the store person compares it against
  the lots already on the rack: exact match goes into that lot, anything else becomes a new one.
- **This reverses `waste-master.md`'s opening decision** — *"SKU is unique per distinct material,
  so no dye lot / shade / batch fields."* That held while nothing could tell two deliveries apart.
  It no longer does.
- **Fabric only.** Accessories have no lots. Their `Quantity` is their stock exactly as today, and
  none of the code below runs on them.
- **The store person chooses the lot. The system never chooses for him.** He can see the rack; no
  rule we write knows that lot 3 is nearly finished or that lot 2 is behind a pallet. The screen
  advises and warns, and blocks nothing.
- **Lots are invisible to Zoho Inventory.** Inventory will hold one total per SKU. The split into
  lots is a Creator concept and stays one.

## Scope: what a lot does and does not touch

| Touched | Not touched |
|---|---|
| fabric stock balances | accessories, in any form |
| issue, receipt, dispute, wash | the cutting calculation itself |
| offcut provenance | `Required_Pieces` and the piece budget |
| the new inward screen | plan creation — a plan never names a lot |

**A plan never names a lot.** Plans are made days before anyone walks to the rack, and a lot
chosen at plan time would be stale by the time it mattered — the same reason waste is not
allocated at plan time.

## `Raw_Material_Lot`

One record per lot per material.

| Field link name | Type | Notes |
|---|---|---|
| `Material` | Lookup → Raw_Material | |
| `Lot_Number` | Text | **typed by the store person**, unique within the material |
| `Label` | Text | free text — "slightly darker", "left roll". Optional, for recognition |
| `Unwash_Quantity` | Decimal | |
| `Wash_Quantity` | Decimal | |
| `In_Transit_Qty` | Decimal | issued, not yet confirmed |
| `Disputed_Qty` | Decimal | |
| `Status` | Dropdown | `Active` / `Blocked` |
| `Remarks` | Multi Line | |

**FIFO comes from `Added_Time`**, Creator's own field — same as `Waste_Master`, and the same
reason: no `Created_On` needed and identical lots stay distinguishable.

**There is no `Exhausted` status.** A lot with all four numbers at zero is exhausted by
definition, and a dispute resolution can put stock back into it — a stored status would go stale
the moment that happened. `Blocked` is different and does need storing: it means *"this cloth is
quarantined, do not offer it"*, and without it the only way to hide a lot is to zero it, which
falsifies stock.

**`Lot_Number` is TYPED, not generated.** It is the store person's own label for a tone he can
see, and it has to match what is written on the roll — no rule we invent would.

**Unique within the material, not globally.** Two different fabrics may both sensibly have a lot
`1`; forbidding that would force him to invent numbers to dodge collisions with cloth he is not
even looking at. Within one material it must be unique, or every later reference is ambiguous —
which lot did that offcut come from.

Compared **upper-cased and trimmed**, so `l1` cannot slip in beside `L1` and read on screen as a
different lot when it is not. A `Blocked` lot still occupies its number: it is real cloth, just
quarantined.

Checked in the widget *and* in `saveStockInward`. The widget check is only so the collision is
reported while he is still looking at the list it clashed with; the server one is the one that
counts, because a Custom API is callable from anywhere. Two store people typing the same number in
the same second would still collide — there is one store person, so that is accepted rather than
solved.

## Changes to existing forms

| Form | Field | Why |
|---|---|---|
| `Raw_Material` | `Unallocated_Qty` | Decimal. **Always 0 today.** The Inventory seam — see below |
| `Waste_Master` | `Lot` | Lookup → Raw_Material_Lot. An offcut belongs to the lot it was cut from |
| `Material_Issue.Issue_Lines` | `Lot` | Lookup. Which lot crossed the counter on this line |
| `Material_Issue.Issue_Lines` | `Settled_Qty` | Decimal. How much of this line the supervisor has confirmed |
| `Wash_Request` | `Lot` | Lookup. Washing is per lot |

## The parent total stays maintained

`Raw_Material.Wash_Quantity` and friends **do not become derived roll-ups.** They stay real
fields, updated by the same function that updates the lot, in the same pass.

This is not laziness — recomputing a sum per material on every screen load is a query per
material, and that is the road to the statement-execution limit, which is the failure that is
**not catchable** and shows as a bare 500.

The payoff is large. Tracing every read and write of stock in the app:

- **One reader** — [getStoreMaterialRequirements.dg:358-369](../deluge/getStoreMaterialRequirements.dg#L358).
  Every screen's stock figure comes through there, and **it does not change at all.**
- **Four writers** — [issueMaterials.dg:162](../deluge/issueMaterials.dg#L162),
  [receiveMaterials.dg:156](../deluge/receiveMaterials.dg#L156),
  [resolveDispute.dg:573](../deluge/resolveDispute.dg#L573),
  [completeWashRequest.dg:69](../deluge/completeWashRequest.dg#L69). Each gains a lot alongside
  the parent.

> The `Disputed_Qty` reads in `getStoreDisputes`, `getSupervisorDisputes` and
> `getSupervisorMaterials` are **`Stock_Dispute.Disputed_Qty`** — a different field on a different
> form, and none of this touches them. Same name, unrelated meaning; check which form a query is
> against before changing anything there.

### The Inventory seam

| | Who moves the parent total | Who splits it into lots |
|---|---|---|
| **Now** | the inward screen, as a side effect of creating or topping up a lot | store person, directly |
| **After the sync** | the Inventory pull | store person, draining `Unallocated_Qty` |

`Unallocated_Qty` exists from day one holding zero. When Inventory becomes the source of the
total, a purchase receipt raises the total before anyone has been to the rack, and the difference

```
Unallocated_Qty = Inventory total − SUM(lots: Unwash + Wash + In_Transit + Disputed)
```

is not drift — it is a **work queue**: cloth that has arrived and has not been assigned a tone.
It shows on the inward screen and **cannot be issued**, because promising cloth of unknown tone to
an order is the exact mistake lots exist to prevent.

## Inward — creating and topping up

New tab on the store widget. Fabric only.

Pick a material → the existing lots are listed with their balances → either **add to an existing
lot** or **create a new one** (number typed, label optional), then enter the quantity.

**Everything booked in is UNWASHED, and there is no choice about it.** Cloth is bought greige and
washed in-house, so booking it in as washed would claim a step that never happened. The only route
into `Wash_Quantity` is the wash flow.

> Because of that, **washing is the only thing that shifts the tone**, which makes it the moment a
> lot most often has to split — and the reason *move between lots* exists.

Later this same screen grows an "arrived, not yet lotted" banner fed by `Unallocated_Qty`. The
screen is built now; only its feeder changes.

## Moving between lots

One action, two uses: **take N from lot X into a new or existing lot Y.**

- The tone difference that only appears **after washing** — which is when it most often appears.
- Undoing a merge that turned out to be wrong.

**It moves on-hand quantity only** — `Unwash_Quantity` or `Wash_Quantity`. It must never move
`In_Transit_Qty` or `Disputed_Qty`: those belong to a specific handover that has already left the
counter, and re-labelling them would leave the receipt unable to find what it is settling.

## Issue — manual selection, advisory screen

For a fabric row the store person sees every `Active` lot with stock, oldest first, and types how
much he is taking from each. The screen does the thinking without making the decision:

- lots that can cover the whole outstanding ask **on their own** are marked as such
- if this order already took cloth from a lot, **that lot is called out**
- splitting across lots when one lot would have done raises a **warning, never a block**

### The payload

```
{ "materialId":"123", "cutWidth":55, "cutLength":55,
  "lots":[ {"lotId":"901","qty":300}, {"lotId":"902","qty":200} ],
  "wastePicks":[ {"wasteId":"456","pieces":3} ] }
```

Non-fabric lines send `qty` and no `lots`, exactly as today, and behave exactly as today.

### One lot = one pass

`issueMaterials` runs its existing logic **once per lot allocation**, not once per material line.
The fan across requirement rows already reads `Issued_Qty` live and updates it, so running it with
300 and then 200 lands in the same place as running it once with 500 — and every issue line comes
out naturally carrying exactly one lot.

Waste picks are applied **once, before the lot passes**, not repeated per pass.

### The trap this closes

`issueMaterials` currently derives pieces from the **total** metres issued:

```
rowsIssued = floor(issueQty * 100 / cutL)        // issueMaterials.dg:492
```

Split across lots that overstates the yield, because each lot's cloth rounds down to whole marker
rows **separately**. 500 m at a 55 cm cut is 909 rows in one piece, but 300 + 200 is 545 + 363 =
**908**. One row vanishes and `Pieces_From_Raw` is credited for a piece nobody cut.

Running one pass per lot fixes this by construction — the arithmetic is per lot because the pass
is per lot. This is the same shape as the four silent-loss bugs already recorded in CLAUDE.md, and
it is the reason the per-pass design was chosen over summing at the end.

### And the trap that closing it opens

**Each lot's share must be budgeted from the pieces still owed at that moment — not carved out of
a budget computed once for the whole issue.** Getting this wrong re-introduces the stranded-piece
failure one level down, and it is not obvious from reading the code.

100 pieces at 2 per row is 50 rows = **27.50 m as one continuous piece**. Split 20 + 7.50 it
yields 36 + 13 = 49 rows — **98 pieces**, because each lot loses its part-row. A budget worked out
once caps the second pass at 7.50 m, so the last two pieces can never be issued: the item stays at
`Awaiting_Material`, the plan never reaches `Material Ready`, and pressing Issue again does
nothing, because the "nothing outstanding" test needs *both* metres and pieces to be spent. The
cloth was sitting on the shelf the whole time.

Budgeting the second pass from the **28 pieces still owed** asks for 7.70 m instead, gets 14 rows,
and closes the requirement.

> So a split issue can legitimately spend **more** metres than the plan estimated — 27.70 against
> 27.50 here. That is the documented model, not a leak: `Required_Qty` rounds up once for the
> whole order, and every separate cut rounds up again. It is the same reason `Issued_Qty` may
> exceed `Required_Qty` on a fabric row.

## Receipt — settling in-transit per lot

This is the one place the existing design genuinely cannot be reused as-is.

[receiveMaterials.dg](../deluge/receiveMaterials.dg) reconstructs what is pending from
`Material_Requirement.Issued_Qty − Received_Qty`, fanned oldest-plan-first, and deliberately
stores **no mapping of issue to plan** — the comment at line 13 says so, and the argument is that
the same rule in the same order gives the same answer.

That argument still holds for `Received_Qty`. It does **not** hold for the lot, because a
requirement row records metres and has never recorded which cloth they were. So:

- **The requirement fan is unchanged.** `Received_Qty` keeps working exactly as it does today.
- **A second pass settles the lot.** Walk the supervisor's `Material_Issue.Issue_Lines` for that
  material where `Qty > Settled_Qty`, oldest first, and take the confirmed quantity off each
  line's lot — decrementing that lot's `In_Transit_Qty` and raising `Settled_Qty` on the line.

Two independent fans over the same quantity, both consuming oldest-first, so they agree by
construction — the same reasoning the file already relies on. The issue line is the only record of
which lot left the counter, which is why it has to be the one that answers.

A short receipt puts the gap in that lot's `Disputed_Qty`, and the `Stock_Dispute` records the lot
so the resolution knows where to put it back.

## Disputes

`Stock_Dispute` gains a `Lot` lookup, written when the dispute is raised.

`resolveDispute`'s `Store_Correction` — the one outbound outcome that puts stock back
([resolveDispute.dg:377](../deluge/resolveDispute.dg#L377)) — restores to **that lot**, not to the
material. A lot that had reached zero can come back to life; that is correct, the cloth was
always that tone.

`Found` and `Lost` drop `Disputed_Qty` on the lot without restoring, as they do today on the
material.

## Waste

An offcut is cut from a specific lot, so `Waste_Master.Lot` is written when it is declared.

**Where the lot comes from:** `Material_Issue.Issue_Lines` carries both `Plan_Item` and `Lot`, so
the lot for a given item's offcuts is derivable. If exactly one lot was issued for that item it is
filled in automatically; if two were, **the supervisor picks**, because nothing on the rack can
tell us which remnant came from which.

**The allocator does not filter by lot.** Every available remnant of the SKU is offered as it is
today, with **its lot shown on each suggested piece**, and the store person deselects what he does
not want. Filtering strictly to the chosen lot would be consistent with the tone rule but would
visibly destroy reuse, and the store person is better placed to judge whether a remnant matches
than a rule is.

`Waste_Movement` needs no lot field — it points at the piece, and the piece knows its lot.

## Wash

`Wash_Request.Lot` names the lot. `completeWashRequest` moves `Unwash_Quantity` →
`Wash_Quantity` on **that lot** and mirrors the same move on the parent.

**One existing guard has to change.** [raiseMaterialException.dg:280](../deluge/raiseMaterialException.dg#L280)
refuses to queue a second wash request while one is open **for that material**. With lots that is
wrong — a wash running on lot 2 would block a wash on lot 3. The guard becomes per material **and
lot**.

Washing being where tone most often diverges is exactly why *move between lots* exists.

## Migration

**One opening lot per fabric SKU**, carrying today's four balances off `Raw_Material`, labelled
so it is recognisable as pre-lot stock. Every existing `Waste_Master` row for that SKU points at
it.

`Raw_Material`'s own fields are left exactly as they are — they are already the correct total, and
after migration they equal the sum of the one lot underneath.

Accessories get no lot at all.

## Deliberately not done

- **Lots are not offered per plan item.** When a split is unavoidable the store person types
  metres per lot, which means two garments on one order *can* end up in different tones. Assigning
  a whole lot per item would prevent that, and was rejected as more machinery than the problem
  warrants today. Revisit if it actually happens.
- **No lot on accessories.** Thread shade varies too; when it matters, the same design applies
  with `Is_Fabric` no longer gating it.
- **No cost per lot.** Costing lives in Inventory, which does not know lots exist. If per-lot cost
  is ever wanted, that is the argument for Inventory batch tracking, not for a field here.
- **`Blocked` has no workflow.** It hides a lot from issue and nothing else — no approval, no
  reason codes.

## What has not been verified

Nothing here has been run. The forms do not exist in Creator yet, so no Deluge has been written
against them. The read/write survey above was taken from the current source and is accurate as of
this commit; every conclusion drawn from it still needs a Creator **Execute** to confirm.
