# Store issue allocation — rolls, and priority reservation

**Two changes to the same mechanism, planned and built as one workstream**
because they touch the same function (`applyLotAllocation`), the same screen,
and the same numbers:

| Phase | What | Status |
|---|---|---|
| **A — Lot → Rolls** | A lot is a set of physical rolls, not a metres pool. The store person is told **which roll** to cut. | Allocator done (Pieces 1–4); Deluge side not started |
| **B — Priority reservation** | Stock is **reserved down a priority order** the store person controls, instead of every card seeing the full rack. | **Complete** (B1–B4) |

They are **not independent**. Phase B changes the scoping of the very ledgers
Phase A rewrote (`lotLeft` / `rollLeft` / `greigeLeft` / `wasteLeft`), so B must
land on top of a finished, tested A — and both share one parity discipline: a
frozen `git show` baseline, piece-by-piece, tests between every step.

> **Status: IN BUILD.**
> **Phase A** — Pieces 1–4 done and on `main` (`lotFill` per-roll drain,
> `spend()` roll ledger, `applyFabricOverride` multi-roll, `shortReasonFor`,
> dead-code removal). Parity 31/31 vs frozen baseline; 65/65 across all suites.
> Deluge side (Steps 4–9) not started.
> **Phase B** — B1–B4 all done: payload fields, default-order function, the
> reservation itself, and the reorder UI. **Phase B is complete.**
>
> **Revision 7.** Revs 2–5 were self-review + three external gap-analysis passes.
> Rev 6 recorded the decisions made during the Phase A build. Rev 7 **merges the
> priority-reservation work into this doc as Phase B** — it was briefly a
> separate plan, which would have let the two drift apart while both edit
> `applyLotAllocation`. Full table at the end.

---

# PHASE A — Lot → Rolls

## Why

`Raw_Material_Lot` carries `Wash_Quantity` (and `Unwash_Quantity`,
`In_Wash_Qty`) as a **scalar**, and every calculation that plans a cut treats
that scalar as **one continuous length**. It is not.

- A lot is a **shade** (a dye batch). Cloth of that shade arrives more than
  once. The store adds the new delivery to the existing lot — `Wash_Quantity +=
  n` — so one lot's 758 m is really **a ~750 m roll and an 8 m roll**.
- An order needing a 10 m marker cannot be cut from the 8 m roll, but the
  allocator sees `758 >= 10` and says the lot covers it. **Over-promise.**
- `getExpectedWaste` predicts **one** tail for the lot's fresh cloth; the truth
  is **one tail per roll**. **Waste under-predicted.**

And the thing that makes this worth building rather than merely correct:

> **The store person must be told WHICH ROLL to cut from.** He walks to the
> rack holding an instruction. Without a roll identity the instruction cannot
> be given, and the screen is guessing on his behalf.

Printed cloth is the same shape — a lot whose pieces are short — so this
retires `Fabric_Piece` and unifies the two.

---

## What a roll is, and what washing does to it

Two facts, two owners, **no overlap** — which is what makes them unable to
disagree:

| Fact | Owner | Grain |
|---|---|---|
| What lengths the cloth is in | `Lot_Rolls` | roll |
| How much of it is washed | `Raw_Material_Lot` | lot |

**A roll has a length. A roll does NOT have a wash state.**

That is not a simplification with a cost — it is how the floor actually works.
Washing follows the *cut*, not the roll: they either wash a whole roll, or they
cut what the job needs and wash that. **Washing never changes a roll's length.**
So a roll's length is state-agnostic by nature, and the lot's three wash columns
stay exactly as they are today.

> **This is why the `Fabric_Piece` failure does not repeat.**
> `lot-allocator.js:112-129` records that `Fabric_Piece.State` disagreeing with
> the lot's wash columns is *"the fault this whole design is built to avoid"* —
> and it is why piece-washing was never built. That happened because a piece
> **carried a state** that a second writer (`completeWashRequest`, moving lot
> metres) could contradict. A roll carries no state, so there is nothing to
> contradict. The lot's columns remain the single source of truth for wash.

### The five buckets, and which ones are rolls

A lot has **five** quantity buckets, not three:

```
Wash_Quantity + Unwash_Quantity + In_Wash_Qty   ==  Σ Lot_Rolls.Roll_Length
                                                    (cloth ON THE SHELF)

In_Transit_Qty                                  ==  issued, left the shelf
Disputed_Qty                                    ==  short on receipt, gone
```

**Rolls are only the cloth physically on the shelf.** Issuing 7.5 m off roll R3
shrinks R3 to 742.5 and moves 7.5 into `In_Transit_Qty` — the cloth is not on
the rack any more, so it is not a roll any more. This is the invariant the
first draft got wrong by omitting the last two buckets.

`In_Wash_Qty` **is** still a roll: cloth at the wash house is still that
physical roll, coming back the same length. It counts toward capacity.

### Store_Correction — cloth coming back

The one case that needs the roll id kept: a `Store_Correction` (or `Found`
resolution) returns cloth to the shelf. Because the issue line records **which
roll** it was cut from, the correction winds that roll back up by the corrected
metres. If the roll has since been consumed and closed, the correction creates a
new roll row (`Origin = "Returned"`). Either way `Σ Roll_Length` and the wash
columns move together.

---

## The model

### `Raw_Material_Lot` — the shade

| Field | Change | Meaning |
|---|---|---|
| `Lot_Number`, `Material`, `Status`, `Source_Lot`, … | — | unchanged |
| `Wash_Quantity` / `Unwash_Quantity` / `In_Wash_Qty` | **unchanged, still authoritative** | The wash-state split. Every existing writer keeps writing them exactly as it does today. Rolls do not replace or derive these. |
| `In_Transit_Qty` / `Disputed_Qty` | **unchanged** | Cloth off the shelf. Never rolls. |
| `Width` | **ADD** (Decimal, cm) | Constant for the lot, `= Raw_Material.Fabric_Width_Inches × 2.54`. Every roll shares it. Seeded at lot creation. Printed lots may differ from their plain base — see Open Questions. |

### `Lot_Rolls` — NEW subform on `Raw_Material_Lot`

One row = one physical roll the store person can walk to and identify.

| Field | Type | Written by | Meaning |
|---|---|---|---|
| `Roll_Label` | Single Line | receive (system-assigned) | **What the store writes on the roll.** Short and human — `L2-R1`, `L2-R2`. This is what the issue screen names, and what he matches at the rack. Unique within the lot. |
| `Roll_Length` | Decimal (m) | receive; issue (decrement); dispute (wind back); waste (remnant) | Physical length on the shelf, at the lot's `Width`. **Washing never changes this.** |
| `Roll_Status` | Dropdown | receive; issue | `Available`, `Consumed`, `Blocked` — the same three Step 0 lists. `Consumed` when `Roll_Length` reaches 0; `Blocked` is quarantined cloth on one roll, the lot-level `blocked` flag one roll at a time. Never deleted — history holds. **Only `Available` is cuttable**: `rollUsable` in the allocator and `readRolls` in api-experiment.js both exclude the other two, and this row said `Available, Consumed` while Step 0 said all three, which is how a Blocked roll came to be allocated like any other. |
| `Origin` | Dropdown | receive / waste / dispute | `Purchased`, `Printed`, `Remnant`, `Returned`. |
| `Source_Receipt` | Single Line | receive | GRN / print job / backfill marker. Provenance. |

**Deliberately NOT on a roll:** wash state (lot-level, see above), width
(lot-level), lot number (it is the parent).

### Identification at the rack

The screen shows **label + length together** — `L2-R2 · 8 m`. The label is the
primary key he reads; the length is the confirmation that he is at the right
roll. Either alone is ambiguous on a rack (labels smudge; two rolls can be
similar lengths), together they are not.

**This is a new floor practice.** Rolls are not labelled today. Step 1 of the
build is the store labelling existing stock as part of the backfill — that is a
real-world task, not just a script, and the plan must not pretend otherwise.

---

## The allocation rule

Per candidate lot, for **one sales order's** cut-piece demand:

### Check 1 — cut-piece capacity (reads the ROLLS)

```
perRow   = floor(lot.Width / cutW)                          // markers across
capacity = Σ over Available rolls:
             perRow × floor(roll.Roll_Length / cutL)        // whole rows per roll
```

Summed **per roll** — a roll too short for one marker row contributes 0. This
is the continuity fix.

### Check 2 — wash state (reads the LOT, unchanged from today)

```
orderMetres = Σ per cut: ceil(pieces / perRow) × cutL / 100

if Wash_Quantity                      >= orderMetres  → issue now
else if Wash + Unwash + In_Wash       >= orderMetres  → covered after a wash
else                                                   → this lot cannot
```

### The decision

| Check 1 (rolls) | Check 2 (state) | Outcome |
|---|---|---|
| capacity ≥ demand | washed covers | **use this lot — name the roll(s), issue now** |
| capacity ≥ demand | only wash+greige covers | **use this lot — raise its wash request** |
| capacity ≥ demand | nothing covers | this lot cannot — next lot |
| capacity < demand | (any) | this lot cannot — next lot |
| — no lot passes both — | | **raise a PO** |

**One order → one lot** (the atom rule — tone). Within a lot an order may take
rows off several rolls: same dye batch, and the store already does this.

### Which roll gets named

**Shortest roll first** — among the lot's rolls that can yield at least one
marker row of this cut, pick the shortest; tie on length broken by `Roll_Label`
(string sort). Drain it in whole marker rows until it can give no more, then the
next-shortest. Rationale: a short roll left sitting becomes unusable scrap, so
clear it while it can still take a marker row — this **consolidates the rack
into fewer, longer rolls** over time. A roll below one marker row of the cut
contributes nothing and is skipped. The issue line records every roll used and
the metres off each.

> This reverses an earlier draft of this doc, which said *longest*-first to
> protect big rolls. The shop's rule is the opposite: drain the small ones.
> The allocator implements shortest-first; `spend()` and `chooseLotForOrder`
> follow it.

Wash does not enter roll choice at all — see "what washing does to a roll".
The store cuts from the named roll and washes what the job needs.

---

## Blast radius

Each entry: **today** → **change** → **parity test**.

> **The first draft named 3 Deluge writers.** Verified line-by-line against the
> code: **10 functions genuinely move a lot's cloth and need a roll decision**
> (of which `issueMaterialsHandover` stamps the label and `issueMaterialsApply`
> decrements the length — the split matters), **2 more** are read-only drift
> reports that gain the roll sum, **5 more** touch only the wash-state columns or
> a material-level bucket and need **no roll change**, and **1 is dead**
> (`resolveStockDispute`). The full breakdown is in Group B. This is the true
> cost of the model and the main reason the build is staged.

### The roll-length invariant

`Roll_Length >= 0`, always, on every roll — and `Σ Roll_Length` for a lot's
`Available` rolls equals `Wash + Unwash + In_Wash` for that lot (the shelf
buckets). **Enforced by every Deluge writer**, not assumed:

- **Decrement (issue, send-to-print):** if the payload asks for more than the
  roll holds, the writer **caps at the roll's current length and errors the
  line** — it never drives a roll negative and never silently spills onto
  another roll. The allocator should not produce such a payload (it read the
  same rolls), so this firing means the data moved between read and write —
  treat it as a concurrency / stale-read failure, report it, do not partially
  apply.
- **Wind-back (`Store_Correction`, `Found`, `cancelPrintJob`):** adds to the
  roll named on the issue line. If that roll is `Consumed`, create a new roll
  row (`Origin = "Returned"`) rather than un-consuming — a consumed roll may
  have been physically discarded.
- **Concurrency:** two issues racing on one roll is the real risk. Deluge has
  no row lock, so each writer **re-reads `Roll_Length` inside its own execution**
  immediately before the decrement (the pattern `issueMaterials` already uses
  for `Issued_Qty`), and caps against that fresh read.

### Group A — the allocation and estimate path (read-only, reversible)

**1. `getStoreMaterialRequirements.dg`** — payload gains `lots[].rolls[]`
(`{label, length, status, origin}`). The per-cut fresh estimate becomes
per-roll: `Σ perRow × floor(rollLen/cutL)` rather than `floor(washMetres/cutL)`.
The lot-level rollups (`calcWashByMat` etc.) are **unchanged** — they still read
the wash columns.
*Parity:* one-roll-per-lot = today's output exactly; multi-roll cases hand-worked.

**2. `app/js/api-experiment.js`** — read `Lot_Rolls` (a `Lot_Rolls_Report`,
joined by lot id, the pattern `Fabric_Piece_Report` already uses). Expose
`rolls[]`.
*Parity:* `api-experiment-parity.test.js` extended — assembled `rolls[]` matches
the Deluge read path.

**3. `app/js/lot-allocator.js` — one path. `lotFill` per-roll rewrite BUILT in
Piece 1.** `lotFill` works off a shortest-first sorted working copy of
`lot.rolls[]`. The fresh-cloth loop drains each roll in whole marker rows —
`rowsAvail = min(rowsThisRoll, rowsWashGateAllows)` — then the next-shortest.
The **wash gate bounds the loop as a budget** (`gateBudget`, starting at the
lot's washed metres, or wash+greige+in-wash when `greige` is true), so a lot
with 50 m of rolls but 0 m washed places nothing today and `covers` is false —
it never cuts cloth it cannot wash. `lotFill` returns `rollLinesPer` (per demand,
`[{rollId, label, metres}]`) and `rollsAfter`. The `if (pcs.length) {…} else
{…}` Pieces-vs-continuous branch is gone — printed cloth is short rolls, same
loop. `chooseLotForOrder`'s tier logic is unchanged (per-roll `lotFill.covers`
does the work). `lotLines[]` gains `rolls: [{rollId, label, metres}]`. The
remnant scorer is untouched — `wasteStock` stays separate from rolls.
`lotIsPieces` / `lotPieces` / `lotGreigePieces` are still in the file (Piece 4
deletes them) but no longer called from `lotFill` / `spend()`. Four sub-points:

- **`spend()` roll ledger — BUILT in Piece 2.** `spend()` decrements in-memory
  ledgers after each order so the *next* order on the card measures against
  what's left — its own comment: *"two orders each took 5.50 m from a 6.00 m
  lot… the double-promise this whole design exists to prevent."* It now also
  carries **`rollLeft`**, keyed `materialId|lotId|rollId`, seeded in
  `applyLotAllocation` alongside `pieceLeft`. After each fill, `spend()` sums the
  per-roll metres `lotFill` placed (`fill.rollLinesPer`) and drains BOTH
  `rollLeft` and the working `lot.rolls[]` objects. On a *commitment* (`emit`
  false — an after-wash order) the rolls drain too: the order has spoken for
  that physical cloth. `lotFill` returns `rollLinesPer` (per-demand
  `[{rollId, label, metres}]`) and `rollsAfter` (the drained working copy).
  **The input payload `m.lots[]` is never mutated** — the allocator works on
  copies + ledgers, exactly as it never wrote spent `wash` back to `m.lots`.
- **`perRowFor` and width — RESOLVED, no change needed.** OQ1 answered: fabric
  width is **fixed per SKU** — every lot and every roll of a material shares one
  width; a width difference is a different `Raw_Material`. So `allocateMaterial`'s
  one `fab = { fabricWidthCm: m0.fabricWidthCm }` per material is correct, and
  `perRowFor` is unchanged. The "different-width two-lot" parity case is dropped.
- **`shortReasonFor` `nofit` message — DONE in Piece 3.** Was
  `have: round2(Number(l.wash))` — the lot's total washed metres. Now `have` is
  the **longest single Available roll** of the lot with the longest roll:
  *"L2 longest roll 10 m, need 12 m"* over two 10 m rolls, not *"L2 has 20 m"*.
- **`chooseLotForOrder` — SHORTEST-first, and its ranking.** Roll choice within
  a lot is **shortest-roll-first, drain it, then next-shortest** (see "Which
  roll gets named" — this reverses the earlier longest-first draft). Tie on
  length broken by `Roll_Label`. The lot-level ranking still filters to
  `lotFill(...).covers` (a lot of pure unusable scrap is excluded automatically,
  since the per-roll `lotFill` returns `covers:false`) then picks the smallest
  covering lot to protect big lots for big orders. The metric could sharpen from
  `wash + unwash` to `Σ usable roll capacity`; it is a heuristic, not a
  correctness issue (`covers` is the gate), left as-is for now.

*Parity:* the whole existing `allocator.test.js` set, re-run with each lot given
ONE seed roll = its old scalar, is **byte-identical** to the pre-rewrite
allocator (verified via a FROZEN `git show e000519:` baseline, not a live second
copy). 31/31 including the end-to-end `applyLotAllocation` cases and a 400-iter
random sweep. Multi-roll: the 750+8 continuity case, shortest-first drain across
three rolls, two orders racing one roll (the `spend()` ledger), printed cloth as
short rolls — all hand-verified.

**3b. `applyFabricOverride` (in `lot-allocator.js`) — the store-screen manual
override. BUILT in Piece 3; the rule is NOT the earlier "refuse multi-roll"
draft.** The store person can hand-edit **every** lot's metres box, single-roll
or multi-roll — there is no read-only case. The box is per lot (a SKU row can
have several lot sub-lines, each independently editable), and the edit re-spreads
across that lot's rolls in **drain order** (shortest-first, as the allocator
placed them):

- **Edit DOWN** — unwind the drain **newest-roll-first**. The rolls drained
  earliest keep their auto figure; the shortfall comes off the last roll used,
  then the second-last. `[R1:4.95, R2:3.30]` edited to 6.0 → `[R1:4.95,
  R2:1.05]`; edited to 3.0 → `[R1:3.00]` (R2 drops out).
- **Edit UP** — extend **only the last roll used**, clamped at its physical
  `Roll_Length`. **No spill onto a fresh, previously-unused roll** — a hand-edit
  never opens a new roll. `[R1:4.95, R2:3.30]`, R2 cap 8 → edit to 10.0 gives
  `[R1:4.95, R2:5.05]`; edit to 20.0 clamps at `[R1:4.95, R2:8.00]` (total
  12.95).
- **`ln.rolls` and `ln.qty` stay in step** — every line of the lot carries the
  same re-spread roll breakdown, so the handover payload's `qty` and `rolls[]`
  cannot disagree.
- **`fromRaw` (Pieces_From_Raw) is re-derived from the edited total** in whole
  cut rows — `floor(totalMetres / cutLength) × perRow`, capped at the row's
  outstanding pieces after offcuts. A short edit leaves the requirement OPEN for
  the rows not cut; an over-edit's surplus is an offcut. Unchanged from before.
- **`cutSummary`** on a multi-roll line reads `"Rolls: L2-R1 5m, L2-R2 1.05m"`.

*Live UI* — the store screen showing which roll's metres are decreasing as the
box is typed — is a **follow-up `main.js` change**, not in the allocator work.

*Parity:* seed-roll (one roll = the old scalar) override output is byte-identical
to the old allocator for every `allocator.test.js` override case. Multi-roll
edit-down / edit-up hand-verified against the four cases above.

**4. `app/js/main.js`** — the issue row shows the named roll(s):
`L2-R2 · 8 m`. `buildShortfallSummary` is **unaffected** — it already drives off
`orderOutcomes` (the D11 fix), which is roll-agnostic.
*Parity:* `shortfall-summary.test.js` re-run against the roll allocator; the
issue-invariance and no-false-PO assertions must still hold.

**4b. `app/admin/js/main.js` — the calculation-audit widget.** It loads
**the same `../js/lot-allocator.js`** (`app/admin/widget.html:102`) and calls
`applyLotAllocation(LIVE)` (`main.js:1844`) over the payload
`getAdminCalculation.dg` returns. So `getAdminCalculation` must also carry
`lots[].rolls[]`, and the audit's lot breakdown gains a roll level (which roll
each order's rows came off, each roll's tail). `getAdminCalculation`'s headline
numbers (issuedQty, receivedQty, pinLot) are unchanged — only the working shown.
*Parity:* the audit's totals unchanged for one-roll-per-lot; `applyLotAllocation`
output identical to Group A item 3's.

**5. `getExpectedWaste.dg` + `getProductionWidgetData.dg`** — **the big number
change, in TWO places.** `getExpectedWaste`'s Pass 2 already gives each *lot* its
own side strip + full rows + one part-row; it goes one level deeper to each
*roll*. N rolls → N tails. Pass 1.5 (printed pieces) merges into Pass 2 —
printed pieces are just short rolls.
**`getProductionWidgetData.dg` carries an INLINE COPY of this arithmetic**
(`getProductionWidgetData.dg:~925-1070`, `ewPerRowR = (ewFabWcm / ewCutW).floor()`
… — the "ARITHMETIC ONLY" fold-in `CLAUDE.md` documents). It must be upgraded to
per-roll tails **in the same pass**, or the supervisor production widget's
"Expected waste" cell diverges from the cutting dialog's.
*Parity:* one-roll-per-lot = identical for BOTH (the regression guard);
multi-roll tails hand-worked; a cross-check that `getProductionWidgetData`'s
inline result still equals `getExpectedWaste`'s no-lot path exactly (8 cases, as
the original fold-in was verified).

**6. `saveWasteFromCutting.dg` — reader, needs the roll for provenance.** Today
it stamps an offcut's lot from `Material_Requirement[Plan_Item].Issued_Lot`
(`saveWasteFromCutting.dg:49-83`, with an `ambigMat` guard for split-lot items).
Under rolls it also wants **which roll** the offcut came off, so the remnant-vs-
`Waste_Master` decision (Open Q 3) and any later re-shelving know the parent
roll. The lot resolution is unchanged; the roll stamp is additive and never
blocks. `Waste_Master.Source_Roll` — ADD, optional.
*Parity:* provenance resolves to the same lot for one-roll lots; the roll stamp
is additive.

**7. `getStoreIssueHistory.dg` / `getSupervisorProductionHistory.dg` — readers,
display only.** Both read `Issue_Lines.Lot` and resolve lot names for the
history card (`getStoreIssueHistory.dg:387-411`). Once Step 5 stamps a roll
label on `Issue_Lines`, these should surface it too (`L2-R2 · 8 m` on the
history line), so what the store person cut from reads back the same way it was
issued. No write path; if the label is absent (a pre-Step-5 line) the card
falls back to the lot name exactly as now.
*Parity:* pre-Step-5 lines render identically; post-Step-5 lines gain the label.

### Group B — the writers, staged

Verified `grep` against every `.dg` for `<var>.(Wash_Quantity|Unwash_Quantity|
In_Wash_Qty) =` **on a lot object** vs on `Raw_Material`, and for
`insert into Raw_Material_Lot`:

**Roll decision needed (10 + 1 dead):**

| Function | What it moves | Roll decision |
|---|---|---|
| `issueMaterials` / `issueMaterialsApply` | shelf → in-transit; decrements the lot's washed metres | **payload names the roll**; `issueMaterialsApply` decrements `Roll_Length` |
| **`issueMaterialsHandover`** | inserts `Material_Issue` + `Issue_Lines` (no stock write) | **stamps `Issue_Lines.Roll_Label`** from the handover payload — the record every wind-back and history read depends on |
| `saveStockInward` | new bought cloth → lot washed/greige | **new roll row** (+ label) |
| `receiveFromPrint` | printed cloth in, per table run | **new roll rows**, one per run; a `Piece_Count` run = that many rows |
| `sendToPrint` | plain cloth → printer, off the lot | **named roll(s)** — same choice as an issue; stamp `Print_Job.Source_Roll` |
| `cancelPrintJob` | printed cloth back | wind the sent rolls back up (read `Print_Job.Source_Roll`) |
| `resolveDispute` | disputed → shelf on `Store_Correction` / `Found` | wind back the roll named on the `Issue_Line`; new `Origin="Returned"` row if consumed |
| `seedOpeningLots`, `seedTestLots`, `migrateOpeningLots`, `resetRawMaterialBaseline` | seeding / test | create seed rolls |
| ~~`resolveStockDispute`~~ *(dead — see note)* | `Raw_Material.Wash_Quantity` / `.Disputed_Qty` on `Store_Correction` | **DELETE, do not migrate** |

**Read-only reports — gain the roll sum, write nothing:**

| Function | Role |
|---|---|
| `verifyLotSync` | drift report — **gains `Σ Roll_Length == Wash+Unwash+In_Wash` as a third check** (Group C) |
| `reconcileRawMaterial` | drift report — reads `Fabric_Piece[Piece_Status=="Available"]` (`:53`), never writes it; swap that read for `Lot_Rolls`, add the roll sum to the report |

**No roll change — touch the wash columns or a non-lot bucket only:**

| Function | Why |
|---|---|
| `completeWashRequest` | moves cloth `Unwash → Wash` on lot **and** `Raw_Material` — a state change, no length |
| `cancelWashRequest` | `In_Wash → Unwash` — state change, no length |
| `raiseMaterialException` | moves `Unwash → In_Wash` when a wash ticket is raised — state change, no length |
| `resolvePurchaseShortages` | **reads** `Wash_Quantity` (`:76`); writes only `Material_Exception.Status = "Resolved"` |
| `syncPurchaseInflow` | writes `Raw_Material.Unallocated_Qty` / `.Quantity` only — **never references `Raw_Material_Lot`** (0 refs); the material-level unallocated bucket, not a lot or a roll |

> **`resolveStockDispute.dg` is a legacy form workflow** duplicating
> `resolveDispute`, flagged in `CLAUDE.md` for deletion ("It has none of the
> current logic. Delete it."). It writes `Raw_Material.Wash_Quantity` /
> `Disputed_Qty` at the **material** level (no lot, no roll). It must be
> **deleted before Step 5** — if still live when `issueMaterialsApply` starts
> moving rolls, a dispute resolved through it credits `Raw_Material` metres with
> no roll behind them and `verifyLotSync`'s third check flags the drift. On the
> Step 0 checklist.

**Five functions need NO roll change** — the three wash-column functions
(`completeWashRequest`, `cancelWashRequest`, `raiseMaterialException`), the
read-only `resolvePurchaseShortages`, and `syncPurchaseInflow` (material-level,
no lot at all). That is the payoff of the stateless-roll decision: washing moves
a lot-level metres figure between columns and never touches a roll's length.

### Group C — the third level

`Raw_Material.Wash_Quantity` (the parent material total) is maintained in the
same pass as the lot's, deliberately, *"so the lot and the maintained parent
total cannot disagree"* (`completeWashRequest.dg:207`). Rolls make it **three**
levels. `verifyLotSync` is the only checker and must gain the roll sum:

```
Σ Lot_Rolls.Roll_Length  ==  lot.Wash + lot.Unwash + lot.In_Wash     (per lot)
Σ lot.*                  ==  Raw_Material.*                           (per material)
```

### Group D — retire `Fabric_Piece`

Verified against the code — `Fabric_Piece` is named in **10 `.dg` + 3 `.js`**,
but half the `.dg` mentions are *comments explaining why that function does NOT
touch pieces*. The real code:

| File | Role | Under rolls |
|---|---|---|
| `issueMaterials.dg` | **writer** — `insert into Fabric_Piece` (remnant), field writes | insert a `Lot_Rolls` row instead (`Origin="Remnant"`) |
| `issueMaterialsApply.dg` | **writer** — same | same |
| `receiveFromPrint.dg` | **writer** — `insert into Fabric_Piece` (`:521`), one per run | insert `Lot_Rolls` rows — **`Piece_Count` rows per run** (see F1) |
| `reconcileRawMaterial.dg` | **reader** — `Fabric_Piece[Piece_Status=="Available"]` scan (`:53`), zero writes | scan `Lot_Rolls` instead |
| `getStoreMaterialRequirements.dg` | **reader** — `piecesByLot` (`:612`) | read `Lot_Rolls` |
| `app/js/api-experiment.js` | **reader** — `Fabric_Piece_Report` (`:55`) | read `Lot_Rolls_Report` |
| `app/js/lot-allocator.js` | **reader** — `lotPieces` / `lotGreigePieces` / `lot.pieces` | delete those, read `lot.rolls` |
| `app/js/main.js` | **reader** — piece display | **DONE (P5)** — reads `lotLines[].rolls`, one named roll per sub-line in drain order |
| `cancelPrintJob`, `completeWashRequest`, `raiseMaterialException`, `resolveDispute`, `sendToPrint` | **comment-only** — explain why they don't touch pieces | comments updated, no code change |

So: **3 writers, 5 readers, 5 comment-only.**

> **A `Fabric_Piece` row can hold `Piece_Count > 1` — the backfill must EXPAND
> it.** `receiveFromPrint` writes `Piece_Count=pCntS` (`:521`) and the allocator
> treats each *count* as a discrete mini-roll (`lot-allocator.js:322`,
> `p.pieces -= 1; // Take one count of this piece`). A row with
> `Piece_Length_Cm = 300, Piece_Count = 4` is **four 3 m pieces = 12 m**, not
> one 3 m roll. So the migration is:
>
> ```
> for each Fabric_Piece row:
>   repeat Piece_Count times:
>     insert Lot_Rolls { Roll_Length = Piece_Length_Cm / 100,
>                        Roll_Label  = "<Lot>-P<seq>",
>                        Origin      = "Printed",
>                        Source_Receipt = <its Print_Job> }
> ```
>
> Getting this wrong fails `verifyLotSync` on the first run — `Σ Roll_Length`
> would be short by `(Piece_Count − 1) × Piece_Length_Cm / 100` per row.

**Lossy on two fields:** `State` (deliberate — rolls are stateless; the lot's
columns carry the wash split) and `Piece_Width_Cm` (see Open Q 1 — verify
against real data first). Move readers one at a time behind a dual-read; delete
last.

> **`Fabric_Piece_Report` and `Lot_Rolls_Report` are Creator Reports, not
> Deluge.** `Fabric_Piece_Report` is a standalone report link the JS side reads
> via `getRecords` (`api-experiment.js:55`); no `.dg` defines it. `Lot_Rolls_Report`
> must be created the same way in Step 0 — a Creator Report on the `Lot_Rolls`
> subform, not a function.

---

## Build order — Phase A

| Step | What | Ships when |
|---|---|---|
| **0** | **DONE.** Creator, additive: `Lot_Rolls` subform (`Roll_Label`, `Roll_Length`, `Roll_Status`, `Origin`, `Source_Receipt`); `Raw_Material_Lot.Width` — Creator named it **`Width1`**. **No standalone `Lot_Rolls_Report`** — the subform comes back nested in `All_Material_Lots` records. Still owed for later steps: `Issue_Lines.Roll_Label`, `Print_Job.Source_Roll`, `Waste_Master.Source_Roll`; delete `resolveStockDispute` before Step 5. | fields exist |
| **1** | **DONE (dummy data).** `deluge/seedLotRolls.dg`, run in Execute: per lot with no `Lot_Rolls`, sets `Width1 = Fabric_Width_Inches × 2.54`, creates one seed roll `Roll_Length = Wash + Unwash + In_Wash`, `Roll_Label = "<Lot>-R1"`, `Origin="Purchased"`, `Source_Receipt="BACKFILL"`. Idempotent, dry-run flag, self-checks `Σ Roll_Length == Wash+Unwash+In_Wash`. **No rack labelling / seed-roll splitting** — OQ5 resolved (dummy data). `Fabric_Piece` migration deferred with the printed-fabric project. | `seedLotRolls` invariant check clean on every lot |
| **2** | Read path exposes `rolls[]` (`getStoreMaterialRequirements`, `api-experiment.js`). No behaviour change. | one-roll parity identical |
| **3** | `lot-allocator.js` — **DONE (Pieces 1–4), see BUILD LOG.** `lotFill` per-roll shortest-first drain + wash-gate budget (P1); `spend()` roll ledger + `lotLines[].rolls` + `allocateMaterial` forwards rolls (P2); `applyFabricOverride` multi-roll edit-down/edit-up + `shortReasonFor` longest-roll (P3); dead Pieces-lot code removed, superseded suites retired (P4). the roll DISPLAY on the issue row, dedupe-by-largest across the two `ln.rolls` writers, `isPiecesLot` retired (P5). **Step 3 COMPLETE.** Admin audit still roll-blind — it runs the Deluge path; decided it moves to the JS path instead. | 132/133 across all suites; allocator parity 31/31 byte-identical vs frozen `e000519` baseline; roll-display 10/10 |
| **4** | **DONE.** `getExpectedWaste.dg` per-roll tails. `getProductionWidgetData.dg`'s inline copy was not upgraded to match — it was removed instead (see Group A item 5 note below: a "Preview expected waste" button now calls `getExpectedWaste.dg` on demand, one item at a time). `saveWasteFromCutting.dg` roll stamp does not exist — **OQ3 decided it never will** (see Open Questions): the store issues to exact length, so a fresh-fabric tail is the exception, and when one exists it is ordinary `Waste_Master`, never a new roll. **Step 4 COMPLETE**, with less scope than originally planned. | waste parity: one-roll identical; multi-roll hand-worked (`tools/expected-waste-rolls.test.js`) |
| **5** | **`issueMaterialsApply.dg`** decrements the named roll (re-read length inside the execution, cap-and-error); **`issueMaterialsHandover.dg`** stamps `Issue_Lines.Roll_Label` from the handover payload. **First write — both, same pass.** | full lifecycle test, conservation invariants after every step; concurrent-issue race test; `Issue_Lines` carries the label |
| **6** | `saveStockInward`, `receiveFromPrint` create roll rows on receipt (`receiveFromPrint`: one row per printed run). | roll sum holds after each receipt |
| **7** | `sendToPrint` / `cancelPrintJob` / `resolveDispute` name and wind back rolls (new `Origin="Returned"` row if the roll is `Consumed`). | dispute lifecycle: correction returns exact roll length |
| **8** | `reconcileRawMaterial` swaps its `Fabric_Piece` scan for `Lot_Rolls` and adds the roll sum to its report; `verifyLotSync` third check. (`syncPurchaseInflow` needs nothing — material-level only.) | drift report clean |
| **9** | Retire `Fabric_Piece` — move the 5 readers, delete the 3 writers' piece code, update the 5 comment-only files. | no reader references it |

**On dummy data, every lot is one seed roll = its old scalar, so the whole port
behaves exactly as today** and parity is the guard the whole way. In a real
deployment Step 1 would be a stocktake (label the rack, split seed rolls into
the real physical rolls); here there is no rack, so the multi-roll paths are
built and unit-tested but not exercised by production data until
receipt-creates-rolls lands. Steps 5/7 still need `Issue_Lines.Roll_Label` and
`Print_Job.Source_Roll` added in Creator, and `resolveStockDispute` deleted,
before they run.

---

## BUILD LOG — Phase A allocator port, done in pieces

Actual work, as landed. Commits on `main`: `4e9bae4` (Piece 1),
Piece 2 and Piece 3 committed after.

**Data prep (before the code):**
- Creator: `Raw_Material_Lot.Width` added — Creator suffixed it **`Width1`**
  (a `Width` link name was taken). `Lot_Rolls` subform: `Roll_Label`,
  `Roll_Length`, `Roll_Status` (`Available`/`Consumed`/`Blocked`), `Origin`
  (`Purchased`/`Printed`/`Remnant`/`Returned`), `Source_Receipt`.
- **No standalone `Lot_Rolls_Report`.** The subform comes back nested inside
  `All_Material_Lots` records as `l.Lot_Rolls` (array) when fetched with
  `field_config: 'all'`. `api-experiment.js` reads it from there.
- **`deluge/seedLotRolls.dg`** — the backfill. Per lot with no `Lot_Rolls`:
  sets `Width1 = Fabric_Width_Inches × 2.54`, creates one seed roll
  `Roll_Length = Wash + Unwash + In_Wash`, `Roll_Label = "<Lot>-R1"`. Idempotent,
  dry-run flag, invariant self-check (`Σ Roll_Length == Wash+Unwash+In_Wash`).
  Run in Creator's Execute.

**Piece 1 — `lotFill` per-roll (`4e9bae4`).** Replaced the scalar-metres pool
and the whole `if (pcs.length)` Pieces branch with one shortest-first roll-drain
loop. `rollWork` = sorted working copy of `lot.rolls`; each demand drains each
roll in whole marker rows, bounded by `min(rowsThisRoll, rowsWashGateAllows)`;
the wash gate is a running `gateBudget` (washed metres, or wash+greige+in-wash
when `greige`). Returns `rollLinesPer` + `rollsAfter`. **Parity: C/D/E 14/14
byte-identical.** F-tests failed at this point — expected, they run the
end-to-end `applyLotAllocation` which needs Piece 2.

**Piece 2 — ledger + wiring.** `applyLotAllocation` seeds a **`rollLeft`** map
(`materialId|lotId|rollId → metres`) beside `pieceLeft`. `allocateMaterial`
takes `rollLeft`, forwards each lot's `rolls[]` into its working copy with the
ledger's remaining length, drops `Consumed`/zero rolls. `spend()` sums
`fill.rollLinesPer` per fill and drains BOTH `rollLeft` and the working
`lot.rolls[]` — on commitments too. The line-build attaches
`rolls: [{rollId, label, metres}]` to each `lotLines` entry (the old
`lnPieces`/`fill.piecesPer` block deleted). **Parity: 31/31** — every F-test and
the 400-iter G sweep byte-identical, via a FROZEN `git show e000519:` baseline
(the harness now loads that, not a live second copy).

**Piece 3 — `applyFabricOverride` + `shortReasonFor`.** Override rewritten per
the rule in item 3b: every lot editable, edit-down unwinds newest-roll-first,
edit-up extends only the last roll clamped at its cap, `ln.rolls`/`ln.qty` kept
in step, `fromRaw` re-derived from the edited total. `shortReasonFor` `nofit`
now reports the longest single roll, not the lot's washed sum. **Parity: 31/31.**
Multi-roll override hand-verified against four cases (down-to-6, down-to-3,
up-to-10, up-over-cap).

**Piece 3 aftermath — a review pass reverted it.** An external AI code review
run against the working tree reverted Piece 3's `applyFabricOverride` /
`shortReasonFor` edits before auditing, then reported the resulting failures as
new bugs. Restored, then re-audited: of five reported findings, **three were
real and are fixed** (`rollLeft` seeded `Consumed`/zero rolls; `owedBy` built on
`mrqId` but read on `mrqId || planItemId`; `+0.5` vs `+0.0001` epsilon
mismatch), **one was not reachable** (`rollTook` "cross-lot collision" — it is
function-call-scoped per lot, proven by a direct two-lot-same-rollId test), and
**one was the specified design** (edit-up clamps at cap, no spill).

**Piece 4 — dead-code removal + test-suite consolidation.**
`lotIsPieces` / `lotPieces` / `lotGreigePieces` deleted (dead since Piece 1 —
printed cloth is short rolls, no branch), `hasOwnStock`'s `l.pieces` fallback
removed (always `[]` since Piece 2), and the stale `main.js` `washableLots`
comment corrected (it cited the removed allocator internals; the still-active
`l.form !== 'Pieces'` guard on that picker is unrelated and untouched).
**Two suites retired** as superseded: `tools/allocator.test.js` (31 scalar-lot
cases — every one re-run with seed rolls by `allocator-rolls-parity.test.js`
against a frozen baseline, which is the stronger check) and
`tools/allocator-rolls.test.js` (B1–B9 — fully covered by the three
`allocator-edgecases-*` suites, more rigorously; its own known failures were the
broken `assertInvariants` C3 and the B8 refuse-rule that Piece 3 overturned).
The two remaining edge-case harnesses had their exposed-symbol lists trimmed to
match. **Final: 65/65** — parity 31, lotfill 12, ledger 10, override 12.

**Piece 5 — the roll DISPLAY.** The lot line on the store issue row now names
the physical roll under it: one `lot-rolls` sub-line per roll, in **drain order**
(shortest first, the order the allocator used them, which is the order to cut
them in). It replaces `pieceLineHtml`, which described a `Fabric_Piece` stack
that no longer exists. A **single** roll is still named — the row above prints
the lot and the metres, so on a one-roll lot this repeats the figure, and that is
the point: the metres and the roll they come off are one instruction.

> **The dedupe is the whole of the difficulty, and it is not obvious from either
> writer alone.** `applyLotAllocation` splits a lot's rolls **per requirement
> line**; `applyFabricOverride` stamps the lot's **entire** `rollAlloc` onto
> **every** line of that lot (see its own `ln.rolls = rollAlloc` comment — the
> handover payload's `qty` and `rolls[]` must not disagree). So the display
> dedupes by `rollId` **keeping the largest**, never summing: a sum
> double-counts every overridden lot by exactly the number of lines it serves.
> `tools/roll-display.test.js` D2/D3 pin this, and were confirmed to fail against
> a summing implementation.

`isPiecesLot` went with it — it locked the issue box on a lot held as pieces,
and Phase A retired that form, so the guard had nothing left to exclude. Every
lot is editable. **`tools/roll-display.test.js`, 10/10; full sweep 132/133**
(the one failure is `store-ui.test.js` U3, pre-existing at HEAD — a waste-decline
fixture, unrelated to rolls; see the open questions).

**Deluge debt this sweep surfaced (all recorded, none fixed here — each needs an
Execute against Creator):**

1. **`Fabric_Piece` is retired on the widget side only.** Ten `.dg` files still
   reference it, and `issueMaterials` / `issueMaterialsApply` still parse
   `"pieces":[{…"cutLengthCm"}]` off the payload. Nothing sends it, so those
   parsers are unreachable — real code with no caller. Pinned by `print-cut`'s
   `PC-SPLIT`.
2. **Two dead `PRINTED_PIECE` branches.** `getSupervisorMaterials` and
   `getExpectedWaste` still branch on a marker no writer emits — `issueMaterials`
   lost the literal, `receiveMaterials` lost its reader in `1acf01a`. Pinned by
   `receive-print` M3b, which fails if the set changes without this doc changing.

**Still unreachable, deliberately left:** `main.js`'s `PRINTED_PIECE` branch in
the issue-payload builder (`ln.pieces && ln.pieces.length && ln.cutSummary`).
`ln.pieces` has been `[]` since Piece 2, so the branch is dead — but removing it
changes the **handover payload**, which belongs with Step 5's
`issueMaterialsApply` roll decrement and `issueMaterialsHandover` roll-label
stamp. Cut it there, in one pass with the server side that reads it.

**Next (Phase A):** the Deluge side, Steps 4–9 — and note the admin audit widget
(`app/admin/`) still calls the **Deluge** `getStoreMaterialRequirements`, so its
lots carry no `rolls[]` and its shared `applyLotAllocation` call sees none.
Decided: rather than teach the Deluge function to emit rolls, **the admin widget
moves to the JS path** the store screen already runs on. Until it does, the audit
screen's allocation replay is roll-blind.

---

## Testing infrastructure — Phase A

- **`tools/rolls-model.js`** — **NEW, to be built.** Node reference model:
  `{ width, washQty, unwashQty, inWashQty, inTransit, disputed,
  rolls: [{label, length, status}] }` with `capacity(cutW, cutL)`,
  `chooseRolls(order)`, `issue(rolls, m)`, `returnToShelf(label, m)`,
  `invariants()` (asserts `Roll_Length >= 0`, `Σ Available == Wash+Unwash+InWash`,
  and the three-level sum). Every Deluge/allocator change is ported here and
  checked against a hand-worked number first. **Pattern:** `tools/receive-model.js`
  (exists — 15 KB, the issue/receive migration's reference model) — same shape,
  same `test()` + queue runner.
- **The regression guard is the same everywhere:** seed one roll = the old
  scalar, assert byte-identical output against today. Only then add multi-roll
  cases, each with a hand-verified expected number.
- **`tools/roll-display.test.js`** — **BUILT (P5), 10/10.** Renders the real
  `lotLinesHtml` in a `vm` sandbox over the real `lot-allocator.js` (which owns
  `round2` / `lotsFor` / `perRowFor`, called as globals because `widget.html`
  loads it first), pulling the needed `main.js` functions out by name with a
  brace-balanced `extract()` — the same trick `tools/store-ui.test.js` uses, and
  it fails loudly if a function is renamed rather than silently testing nothing.
  Covers both `ln.rolls` writers' grains (D1 per-line, D2 whole-lot-per-line),
  dedupe-keeps-largest (D3), lot isolation and sub-line placement (D4), the
  single-roll case (D5), a zeroed roll dropping out (D6), an unseeded lot
  degrading gracefully (D7), escaping (D8), a blank label (D9), and every lot
  being editable (D10).
  > **A suite that passes on its first run has proven nothing yet.** These did,
  > so the summing bug was reintroduced deliberately — D2 and D3 both failed,
  > which is what makes the other eight worth reading.
- `tools/dgscan.js` (exists) on every touched `.dg`.

---

## Open questions — Phase A

**RESOLVED:**

- **OQ1 — roll width.** Fabric width is **fixed per SKU** — every lot and roll
  of a `Raw_Material` shares one width; a width difference is a different SKU.
  Width lives on the lot (`Width1`), `perRowFor` unchanged.
- **OQ2 — multi-cut-size order across rolls.** Shortest-roll-first (see "Which
  roll gets named"), one cut size at a time, in demand order. The allocator
  does this.
- **OQ5 — splitting a seed roll.** No tool. Dummy data, no physical rack.
  Receipt-creates-rolls (store enters "N rolls × lengths" when new cloth is
  allocated to a lot) is a **later add-on**, not blocking.
- **OQ3 — remnant threshold. DECIDED: never a roll.** The store issues to the
  exact length the cut needs — no slack is handed out on purpose — so a fresh-
  fabric tail after cutting is the exception, not the expected case, and when
  one exists it is ordinary `Waste_Master`, full stop. **No `Lot_Rolls` row is
  ever created from a remnant.** `saveWasteFromCutting` needs no roll-stamp
  logic at all — there is nothing for it to write. This also closes the Step 4
  tail: the only remaining Step 4 work was this stamp, and it does not exist.
  Rolls and `Waste_Master` stay two separate, non-overlapping pools — a roll
  is only ever created at receipt (Step 6: `saveStockInward`,
  `receiveFromPrint`) or by a dispute restore (Step 7), never by cutting.

**Still open:**

- **OQ4 — roll label scheme (cosmetic).** `<Lot_Number>-R<n>` in use. Fine for
  now; revisit if lots ever split/merge for real.
- **OQ6 — the admin audit widget is roll-blind.** `app/admin/` still calls the
  Deluge `getStoreMaterialRequirements`, whose lots carry no `rolls[]`, so the
  shared `applyLotAllocation` it runs (deliberately the same file as the store
  screen, so the audit shows what the store person is offered *by construction*)
  sees none. **Decided: move the admin widget onto the JS path** the store screen
  already runs — `ApiExperiment.run()` — rather than teaching the Deluge function
  to emit rolls, which would build a second roll reader needing to stay in step
  with `api-experiment.js` for as long as it takes to retire it. Note the admin
  screen needs the **full** picture, not one budget-worth of plans (it exists to
  catch discrepancies, so auditing a prefix is actively misleading) — check
  `ApiExperiment.run()` pages everything before swapping. Not blocking Steps 4–9.

---

## Not covered (follow-up) — Phase A

- **Printed-fabric creation** — the print flow writing `Lot_Rolls` rows
  (`Origin = "Printed"`, one per table run). This doc only makes the
  *consumption* side treat printed cloth as short rolls; until the print flow is
  updated, printed lots get rolls from the `Fabric_Piece` migration.
- **Print-base chaining** — `plainBaseStock` in the allocator, unchanged.
- **Per-roll wash state** — deliberately excluded. Washing follows the cut, not
  the roll, so a roll's length is state-agnostic and the lot's columns stay the
  single source of truth. Revisit only if the floor starts holding one lot
  half-washed for long periods.

---

# PHASE B — Priority reservation

## Why

100 m of a fabric, four supervisors who all need it. Today **every card shows
the full 100 m**, because the allocator gives each supervisor his own ledger,
seeded from the whole rack:

> *"ONE LEDGER PER SUPERVISOR — NEVER ONE SHARED BETWEEN THEM. Shared, these
> three stopped being a working total and became a RESERVATION… the first
> supervisor spent the rack and the last was measured against what he left…
> A hard reservation ledger was considered for this app and rejected; this was
> it, rebuilt by accident inside the allocator."*
> — `lot-allocator.js`, the comment on `applyLotAllocation`

So the shortfall only exists in the whole-screen total, never on a card, and
contested stock is **said** ("Also needed by …") rather than **counted**.

**That is now being deliberately reversed.** The client wants the numbers to
answer "how much is actually short" per supervisor, which a per-card view of the
same 100 m cannot do.

### Why the old rejection does not apply any more

The rejected version failed because a low-priority card could read "no lot holds
enough" over cloth nobody had claimed, **with no way to see why and no way to
act on it**. Two things change that:

1. **The store person sets the order himself, on the screen.** A short card is
   short *because he put someone else first* — and he can move them up.
2. **It re-runs live.** Reordering recomputes the whole screen; there is no
   stale reservation to fight.

Priority stops being an invisible sort key and becomes the control.

## The model

**Reservation is a pure client-side view.** Nothing is written to Creator, no
lock, no reserved-quantity field. It is a function:

```
(raw rack from the server, priority order) → per-card numbers
```

recomputed on every reorder and every refresh. Two people with different orders
would see different numbers, and that is correct — each is looking at their own
*plan*, and only pressing Issue makes anything real (`issueMaterials` re-checks
every lot server-side regardless).

### Default order

One supervisor usually holds one order source, but a manual reassignment can
give them several. So the default rank is, per supervisor, over their open plans (four rungs):

1. **Best source RANK they hold** (Shopify > Faire > Custom > PR). Any Shopify
   order ranks them at Shopify's level, whatever else they carry.
2. **Tie → more plans AT THAT RANK wins.** Lower-rank plans do not pad it.
3. **Tie → earliest `Plan_Start_Date` among their plans AT THAT RANK.**
   (Matches the plan-age tiebreak the server already applies inside one level.)
   Falls back to the key's sequence half when a plan has no date.
4. **Tie → supervisor name**, so two loads of the same data never disagree.

Fully deterministic. `Priority_Key` is `rank * 1000000 + sequence`, stamped at
plan creation; the **rank is the top half** — counting raw keys would make every
plan its own level and rung 2 would always count 1. An empty key (a plan created
before `Priority_Key` existed) ranks `Infinity` and sorts **last**, never first.
`Plan_Start_Date` is a date, written once, never rewritten.

### What the store person can change

The order, on the issue screen. Changing it re-runs the allocation and redraws.
The cards render **in** priority order, so position and priority never disagree
— the card already prints "Priority N · highest/lowest" off its array index
(`main.js`), and that stays true by construction.

**No "reserved by whom" label.** The number is the answer: short means short
given the order he set. He set it; he can change it.

## What changes

**1. Payload — `priorityKey` + `planStartDate` per line.** Both read paths
(`api-experiment.js`, `getStoreMaterialRequirements.dg`) carry them the same way
`salesOrder` is already carried. Additive; nothing server-side reads them.

**2. Default-order function (`main.js`) — pure, unit-testable.** Takes the
supervisor blocks, returns an ordered array of supervisor ids per the four-rung
rule. Replaces the existing min-key-only sort as the *default*; the session's
chosen order overrides it.

**3. `applyLotAllocation` — hoist the ledgers.** The five ledgers
(`wasteLeft`, `lotLeft`, `greigeLeft`, `pieceLeft`, `rollLeft`) move **out** of
the per-supervisor loop: declared once, seeded once from the raw rack, drained
across every card in order. This is the whole behaviour change, and it is the
exact scoping the file's own comment warns about — deliberately, now.

*Phase A already made every one of those ledgers correct and tested at the
per-card level. Phase B only changes their scope.* That is why A had to land
first.

**4. `render()` — order the data.** Before `applyLotAllocation(data)`, sort
`data` by `window.__priorityOrder` (session-local; defaults to the computed
rank). Everything downstream already respects array order — the allocation walk,
the `actionable` filter, the card render, the "Priority N" label — so nothing
else needs to know this feature exists.

**5. Reorder UI.** Control shape **not yet decided** (arrows vs numeric rank).
The mechanism must exist and be callable first; the control swaps in without
touching the allocator or `render()`.

### What does NOT change

- **`buildShortfallSummary` / the D11 PO logic.** It already drives off
  `orderOutcomes` and sums true demand vs what could be placed. A reserved-away
  card correctly reports `skipped`, which is exactly the signal it already turns
  into a PO. No edit.
- **The server.** Still sends the true, unreserved rack. Ordering is a view.
- **The admin audit** (`app/admin/`) — calls `applyLotAllocation(LIVE)` with no
  order, so it keeps showing the underlying truth. The audit's job is what the
  rack really holds, not one store person's plan for the day.

## Build order — Phase B

| Piece | What | Ships when |
|---|---|---|
| **B1** | **DONE.** `priorityKey` + `planStartDate` on the payload — `api-experiment.js` (`openPlan` + every line) and `getStoreMaterialRequirements.dg` (`lnMap` + `linesJson`, numeric/free-text handled per repo rules). Additive, nothing reads them yet. | both paths syntax-clean; no behaviour change |
| **B2** | **DONE.** Default-order function in `main.js` — pure, four-rung rule, wired to nothing yet. | `priority-order.test.js` 20/20; full sweep 94/94 |
| **B3** | **DONE.** Ledgers hoisted; `applyLotAllocation` is now seed-once + walk-in-order. Old "never one shared" comment rewritten; two tests inverted. | `priority-reservation.test.js` 12/12; full sweep 106/106 |
| **B4** | **DONE.** `render()` sorts by the applied order before caching `__rawData`; up/down arrows build a draft and an **Apply** bar commits it (figures freeze until then); order survives Refresh. | `priority-reorder-ui.test.js` 16/16; full sweep 122/122 |

### How B3 is tested — NOT a frozen-baseline parity check

This is the one step where "identical to before" is the **wrong** goal: sharing
the ledger *is* the feature, and it *will* change card 2+'s numbers whenever
there is contention. So B3's tests assert two things instead:

1. **No contention → identical to today.** When every material has enough for
   everyone, hoisting the ledger changes nothing. This case *can* be checked
   against the frozen baseline, and must be.
2. **Contention → correctly reserved.** Hand-worked cases: 100 m, three
   supervisors wanting 60/50/40; assert card 1 gets 60, card 2 sees 40 and is
   short 10, card 3 sees 0 and is short 40 — and that reordering flips who is
   short, deterministically.
3. **Conservation.** Σ allocated across all cards ≤ rack, per material and per
   roll. Never over-promise, which is the entire point.

## BUILD LOG — Phase B

**B1 — payload fields.** `priorityKey` and `planStartDate` threaded through both
read paths, additive, nothing consumes them yet:
- `api-experiment.js` — `openPlan` gains `planStartDate` (raw string; the widget
  only ever compares two of these as sortable text, never does date maths).
  Every `lines[]` entry gains both, the same way `salesOrder` is already carried.
- `getStoreMaterialRequirements.dg` — `lnMap` gains both from the `plan` loop
  variable in scope; `linesJson` emits them with this repo's rules applied
  (`priorityKey` normalised to `"0"` when empty/non-numeric so it lands as a
  JSON number; `planStartDate` flattened for quotes/CR/LF/tab).

Verified: `node --check` clean on the JS; `dgscan` clean on the Deluge except
one **pre-existing** `sort by` inline finding in the `Fabric_Piece` printed-cloth
loop ~550 lines away — confirmed present on the unmodified file via `git stash`,
not introduced here.

**B2 — the default-order function.** `priorityRankOf(key)` and
`defaultPriorityOrder(data)` added to `main.js`, pure, wired to nothing yet.
`tools/priority-order.test.js`, **20 cases**, every one hand-worked in its
comment: the four rungs in isolation, then the traps —

- **rank, not the raw key.** `Priority_Key = rank * 1000000 + sequence`, so two
  plans from one source have *different* keys. Counting raw keys would make
  every plan its own level and rung 2 would always count 1.
- **plans, not lines.** A plan appears on a line of every material it needs;
  the test gives one supervisor a single plan across ten materials against
  another's two real plans, so a line-count would pick the wrong winner.
- **at the best rank only**, for both count and date. A supervisor's ancient PR
  order must not drag his Shopify ranking forward (rung 3), and nine PR orders
  must not pad his Shopify count (rung 2).
- **an unranked plan sorts LAST.** A pre-`Priority_Key` plan has an empty key;
  `priorityRankOf` returns `Infinity` so it can never outrank a real order by
  accident — the "backfill or it sorts to one end" trap the Deluge comment warns
  about.
- **rung 3 falls back to the key's sequence half** when a plan predates
  `Plan_Start_Date` and has no date to compare. (The sequence already carries
  age — preferring the explicit date keeps this readable and independent of the
  key's encoding staying stable.)

**Also fixed in this piece: `tools/shortfall-summary.test.js` (9 cases) was
failing at HEAD**, unrelated to B2 — its lot fixtures were scalar-metres with no
`rolls[]`, so under the rolls-only allocator every order reported `skipped` and
the PO figure inflated (S1 read 22.5 where it should read 7.5). Same fixture
obsolescence that retired two suites in Phase A Piece 4; this one was missed.
Given seed rolls (one roll = the lot's shelf total, exactly what
`seedLotRolls.dg` writes) and its printed-Pieces lot restated as 20 short rolls,
it is **9/9**. Verified pre-existing via `git stash` before touching it.

**Suite totals after B2: 94/94** — parity 31, lotfill 12, ledger 10,
override 12, priority-order 20, shortfall-summary 9.

**B3 — the ledgers hoisted. THE BEHAVIOUR CHANGE.** The five ledgers
(`wasteLeft` / `lotLeft` / `greigeLeft` / `pieceLeft` / `rollLeft`) moved out of
the per-supervisor loop. `applyLotAllocation` is now **two passes**: seed every
ledger from the whole screen, then walk the cards in array order spending them.
The separation *is* the reservation — every ledger holds the full rack before
card 1 takes anything, and each card after is measured against the remainder.

The `=== undefined` guards on seeding do real work here: the server repeats the
same full rack figure on every card, so a second card mentioning a lot must not
re-inflate a ledger the first card is about to spend.

**The old comment was rewritten, not deleted.** It said *"ONE LEDGER PER
SUPERVISOR — NEVER ONE SHARED"* and recorded a real past failure. The new
comment quotes it, then says why it no longer holds: that version failed because
the store person could see a card go short with **no way to see why or act on
it** — priority was an invisible server-side sort key. Now he sets the order on
the screen and it re-runs live. Priority stopped being a hint and became the
control.

**Two existing tests were INVERTED, deliberately** — both asserted the old rule
in their own names:
- `allocator-rolls-parity.test.js` **F9** *"two SUPERVISORS both offered the
  rack — no reservation ledger"*. It compared old-vs-new, which cross-card
  behaviour can now only fail. Rewritten to assert the new rule directly (S1
  served, S2 skipped, payload unmutated) and is no longer a parity case. The
  rest of that file stays genuine parity — everything else in it is
  within-one-card, which B3 did not touch.
- `allocator-edgecases-ledger.test.js` **5** *"Two supervisors same roll: no
  cross-card reservation"*. Same inversion, plus a conservation assertion.

That only these two moved is the evidence B3 changed **cross-card scope and
nothing else**: `F8` / `F10` (two orders within one card) and ledger `4` (roll
drain within a card) all still pass untouched.

**New suite `tools/priority-reservation.test.js` — 12 cases**, the three classes
the plan called for:
- **No contention (3)** — enough for everyone, everyone served; exact-fit; a
  single card. The hoist is invisible when nothing is contested.
- **Contention (5)** — the rack drains card by card; an over-subscribed rack
  serves who it can and skips the rest whole (never part-serves — the atom rule
  still holds); **reordering flips who is short** on identical rack and demand;
  a lower card still gets what a higher one did not want; contention on one
  material does not starve another.
- **Conservation (4)** — total promised never exceeds the rack **per material**
  *and* **per roll**; the raw payload is never mutated so a re-run is
  idempotent; and running the same array twice does not double-spend — which
  matters because every re-render (a lot override, a declined remnant) calls
  `applyLotAllocation` again.

**Suite totals after B3: 106/106** — parity 31, lotfill 12, ledger 10,
override 12, priority-order 20, **priority-reservation 12**, shortfall-summary 9.

**B4 — the wiring and the reorder control.** `render()` now calls
`orderByPriority(data)` **before** caching `__rawData`, so every later
re-render (a lot override, a declined remnant) re-runs the allocation over the
same order rather than falling back to the server's.

**Two pieces of state, deliberately separate:**

| | |
|---|---|
| `__priorityOrder` | what the numbers on screen were computed against. Only **Apply** writes it. `null` = use the computed default. |
| `__draftOrder` | what the arrows are building. `null` = no draft; what you see is what the figures mean. |

**Arrows move cards immediately; figures freeze until Apply.** Re-allocating on
every arrow click would recompute the whole screen three or four times while the
store person is still deciding, and the numbers would flicker through orders he
never chose. `movePriority` calls `redrawCards()` — a repaint from figures the
last render already computed — never `render()`, which is the allocating path.

**The Apply bar** only exists while a draft does, so its absence is the signal
that screen and numbers agree. It says *"the figures below are still for the
previous order"*, because that is the one thing not otherwise visible: the cards
have moved but every number under them belongs to the old sequence.

**Persistence:** the order survives Refresh for free — `loadRequirements()`
re-fetches stock and calls `render()`, which reads `__priorityOrder`; the fetch
never touches it. Resets on a page reload. Nothing is written to Creator.

**New suite `tools/priority-reorder-ui.test.js` — 16 cases**, run against the
extracted functions in a stub DOM. It caught **two real bugs in the code it was
written for**:

1. **Cancel did not cancel.** `redrawCards` writes the draft order back into
   `__reqData` — it has to, because every issue handler indexes into that array
   by card position. So by the time Cancel ran, `__reqData` was *already* the
   draft, and `displayOrder`'s "no draft, leave it as it is" fallback silently
   kept the order it was meant to discard. Fixed: `displayOrder` now rebuilds
   from `orderByPriority` (i.e. from `__priorityOrder`, which Cancel never
   touched) instead of trusting the current array.
2. **A dead click raised the Apply bar.** `movePriority` seeded the draft
   *before* checking the move was possible, so the top card's up-arrow created
   a draft identical to the current order — offering to "apply" a change nobody
   made. Fixed: work the move out first, commit to a draft only if it lands.

Also pinned: `I1`, that `__reqData` is always in the same order as the cards
drawn — a list drawn in one order and cached in another would point every Issue
button at the wrong supervisor.

**Suite totals after B4: 122/122** — parity 31, lotfill 12, ledger 10,
override 12, priority-order 20, priority-reservation 12, **priority-reorder-ui
16**, shortfall-summary 9.

*(`tools/store-ui.test.js` has one failure, `U3`, **pre-existing at HEAD** and
unrelated — a waste-decline fixture, most likely another rolls-migration
casualty like the `shortfall-summary` ones. Not touched here.)*

## Open questions — Phase B

- ~~Reorder UI shape~~ — **RESOLVED**: up/down arrows on the priority tag, with
  a separate Apply step so the allocation runs once per decision rather than
  once per click.
- **Does the shortfall summary need to distinguish "short because reserved" from
  "short because the rack is empty"?** Decided **no** for now — the number is
  the answer, and reordering is the way to interrogate it. Revisit if the store
  person finds PO figures confusing (a PO for cloth that is only "short" because
  of ordering would be wrong, but `orderOutcomes` already reports the *true*
  unseated demand across the whole screen, so this should be safe — **verify in
  B3's tests**).

---

## Revision history

### Rev 1 → Rev 2 (self-review against the code)

| Draft 1 said | Reality | Fixed |
|---|---|---|
| `Wash+Unwash+In_Wash == Σ Roll_Length` is the invariant | ignores `In_Transit_Qty` and `Disputed_Qty`; breaks on the first issue | rolls = **shelf only**; issued/disputed cloth is not a roll |
| 3 Deluge writers affected | **13 real + 3 no-length + 1 read-only + 1 dead** touch lot quantity | full table in Group B, build staged around it |
| `Wash_Quantity` becomes derived from rolls | written by many functions and mirrored onto `Raw_Material` | wash columns stay **authoritative and unchanged**; rolls are a parallel fact |
| Rolls stateless, "assume washed metres spread proportionally" | that approximation is the exact `Fabric_Piece.State` fault the allocator documents | rolls stateless **because washing follows the cut** — no state to disagree |
| Two levels to keep in step | three (`Raw_Material` mirrors the lot) | `verifyLotSync` gains the roll check |
| `Fabric_Piece` migration lossless | it carries `State` and `Piece_Width_Cm` | called out as lossy; width is OQ1 |
| Backfill is a script | it is a **stocktake** — the rack must be labelled | Step 1 is physical work; steps 2–4 ship against seed rolls first |

### Rev 2 → Rev 3 (external gap analysis, each verified against the code)

| Gap | Verified | Fix |
|---|---|---|
| `resolveStockDispute.dg` missing from writers | **valid** — writes `Raw_Material.Wash_Quantity` / `.Disputed_Qty` on `Store_Correction`; flagged legacy in `CLAUDE.md` | added to Group B as **delete, don't migrate**; Step 0 gate |
| `lotIsPieces`/`lotPieces`/`lotGreigePieces` don't exist | **rejected** — all three at `lot-allocator.js:108/129/141` | no change |
| `Fabric_Piece` 8w/13r count invented | **valid** | replaced with the verified 4-writer / 4-reader / 5-comment table in Group D |
| `Fabric_Piece_Report` is a Creator Report not `.dg` | **valid** | clarified; `Lot_Rolls_Report` created the same way in Step 0 |
| admin widget runs the same allocator, not in blast radius | **valid** — `app/admin/` loads `lot-allocator.js`, calls `applyLotAllocation` | added as Group A item 4b; `getAdminCalculation` payload gains `rolls[]` |
| OQ5 (split UX) vs Step 1 contradiction | **valid** | OQ5 is now an explicit Step 0 gate; Step 1 references it |
| `Width` backfill not in build steps | **valid** | Step 1 now sets `Width = Fabric_Width_Inches × 2.54` on every lot |
| no negative-`Roll_Length` guard | **valid** | "The roll-length invariant" section: `>= 0`, cap-and-error on decrement, re-read for concurrency |
| `saveWasteFromCutting` not in blast radius | **valid** | added as Group A item 6 (reader, `Waste_Master.Source_Roll`) |
| `receive-model.js` may not exist | **rejected** — exists, 15 KB | pattern reference kept, marked "exists" |

### Rev 3 → Rev 4 (external gap analysis pass 2, each verified against the code)

| Gap | Verified | Fix |
|---|---|---|
| `resolvePurchaseShortages` classified as a roll-creating writer | **valid** — it only *reads* `Wash_Quantity` (`:76`) and writes `Material_Exception.Status = "Resolved"` | moved to **NO ROLL CHANGE** in Group B; dropped from Step 6 |
| `perRowFor` "unchanged" glosses over lot-level width | **valid** — `allocateMaterial` builds one `fab.fabricWidthCm` per *material* (`:573`); two lots of different width break it | Group A item 3 sub-point; **OQ1 now blocks Step 3** as well as Step 1; parity gains a different-width two-lot case |
| `applyFabricOverride` not in blast radius | **valid** — refuses hand-edits on Pieces lots (`:1391-1403`); same ambiguity for multi-roll lots | added as Group A item 3b — guard widens to refuse multi-roll hand-edits |
| `chooseLotForOrder` ranks by `wash+unwash`, counts unusable short rolls | **valid but minor** — `covers` is still the gate; ranking is a heuristic | Group A item 3 sub-point — ranking metric to change to usable-roll-capacity, decided in Step 3 |
| `getStoreIssueHistory` / `getSupervisorProductionHistory` read lot data, need roll context | **valid, display-only** — read `Issue_Lines.Lot` (`:387-411`) | added as Group A item 7 — surface the roll label once Step 5 stamps it |

### Rev 4 → Rev 5 (external gap analysis pass 3, each verified against the code)

| Gap | Verified | Fix |
|---|---|---|
| Backfill formula `Roll_Length = Piece_Length_Cm / 100` drops `Piece_Count` | **valid, critical** — `receiveFromPrint` writes `Piece_Count > 1` (`:521`), allocator consumes one count at a time (`:322`); a 300cm×4 row is 12 m, not 3 | Group D F1 note + Step 1: **each `Fabric_Piece` → `Piece_Count` roll rows**; `verifyLotSync` gate on Step 1 |
| `Issue_Lines.Roll_Label` + `Print_Job.Source_Roll` missing from Step 0 schema | **valid** — the doc relies on the label being on the issue line for wind-back and history; no field, no write | added both to Step 0; Step 0 gate note |
| `issueMaterialsHandover.dg` missing from Step 5 | **valid** — `issueMaterialsApply` ignores `issueLines` (`:39`); `issueMaterialsHandover` inserts `Issue_Lines` (`:221-245`) | added to Group B and Step 5 — **both** functions, same pass; `apply` decrements length, `handover` stamps the label |
| single-roll `applyFabricOverride` leaves `ln.rolls` stale | **valid** — rebuilds from a clone, scales `ln.qty`, never touches `ln.rolls` (`:1446`) | Group A item 3b: single-roll edit also sets `ln.rolls[0].metres = ln.qty` and clamps to `Roll_Length` |
| `spend()` needs an in-memory roll ledger | **valid, load-bearing** — `spend()` decrements `lotLeft`/`lot.pieces`/etc. so the next order doesn't double-claim (`:890`, its own comment); rolls need the same | Group A item 3 first sub-point: `spend()` deducts `roll.Roll_Length`, carries `rollLeft`; parity gains a two-orders-race-one-roll case |
| `getProductionWidgetData.dg` inline waste copy missing from Step 4 | **valid** — inline `ewPerRowR = (ewFabWcm/ewCutW).floor()` (`:~925-1070`), the "ARITHMETIC ONLY" fold-in | Group A item 5 + Step 4: upgrade both in the same pass; cross-check parity |
| Group B said "1 read-only", table had 2; `reconcileRawMaterial` mislabelled writer | **valid** — `verifyLotSync` + `reconcileRawMaterial` both read-only reports; `reconcileRawMaterial` never writes `Fabric_Piece` (`:53`); `syncPurchaseInflow` never touches a lot (0 refs) | Group B regrouped into "roll decision (10+1 dead) / read-only reports (2) / no change (5)"; Group D → 3 writers, 5 readers |
| `shortReasonFor` `nofit` message reports lot total not longest roll | **valid** — `have: round2(Number(l.wash) || 0)` (`:~1620`); would say "L2 has 20 m, need 12 m" over two 10 m rolls | Group A item 3 sub-point: `have` = longest roll's length |

### Rev 5 → Rev 6 (decisions made DURING the build, Pieces 1–3)

| What the doc said | What was actually built | Why |
|---|---|---|
| `applyFabricOverride`: **refuse** hand-edit on any multi-roll lot (Group A 3b) | **Every** lot's box is editable — no read-only case. Multi-roll: edit-down unwinds newest-roll-first, edit-up extends only the last roll clamped at its cap. | User decision: "make the lot inbox editable… in multiple rolls if store person edit that then reduce from the most recent one." Refuse-if-multi-roll would block a real, needed action. |
| OQ1 (width lot vs roll) blocks Step 3; parity needs a different-width two-lot case | OQ1 **resolved** — width is fixed per SKU, `perRowFor` unchanged, that parity case dropped. | User: "no fabric width won't vary even in lots… within one SKU width is same throughout." |
| OQ5 (who splits a seed roll) is a Step 0 gate | OQ5 **resolved** — no split tool. Dummy data, no physical rack. Receipt-creates-rolls is a later add-on. | User: "we have dummy data the split don't matter." |
| `Raw_Material_Lot.Width` field | Creator named it **`Width1`** (link name collision). `seedLotRolls.dg` and `api-experiment.js` use `Width1`. | Creator auto-suffix. |
| Standalone `Lot_Rolls_Report` in Step 0 | Not created. `All_Material_Lots` returns `Lot_Rolls` nested in each record (`field_config: 'all'`). | Subforms come back inside the parent — no separate report needed. |
| Parity guard = "one-roll = today's output" | Guard is enforced against a **frozen `git show e000519:` baseline** loaded into the harness, not a live re-read of the working file. | A live second copy runs the new code both sides and proves nothing. |
| `spend()` roll ledger + wash gate as a note | Both built. Wash gate is a running **`gateBudget`** that bounds the drain loop, not just a post-check. | Piece 1/2 implementation detail worth recording. |

### Rev 6 → Rev 7 (priority reservation merged in as Phase B)

| Change | Why |
|---|---|
| Doc retitled **"Store issue allocation — rolls, and priority reservation"**; the rolls work becomes **Phase A**, priority becomes **Phase B**. | They edit the same function (`applyLotAllocation`), the same screen, the same numbers. Two docs would have let them drift while both in flight. User: *"both are linked to store issue part, so merge this priority thing in that migration so that we can go with proper plan testing each step."* |
| Phase A Piece 4 recorded (dead-code removal) | `lotIsPieces` / `lotPieces` / `lotGreigePieces` and `hasOwnStock`'s pieces branch deleted; `allocator.test.js` and `allocator-rolls.test.js` retired as superseded; the two edge-case harnesses fixed. 65/65 green. |
| Phase B B1 recorded (payload fields) | `priorityKey` + `planStartDate` threaded through both read paths, additive, nothing reads them yet. |
| **B3 is explicitly NOT a frozen-baseline parity step** | Sharing the ledger across cards *is* the feature — it must change card 2+'s numbers under contention. Its tests assert no-contention-identical, contention-correctly-reserved, and conservation instead. Written down so nobody later "fixes" B3 back to parity. |
| Phase A's "ONE LEDGER PER SUPERVISOR — NEVER ONE SHARED" comment will be **contradicted** by B3 | The comment records a real past failure. Phase B is that same mechanism rebuilt *with the two things that were missing*: user-controlled order and live recompute. The comment must be rewritten at B3, not silently violated. |

### Rev 9 → Rev 10 (live edit — the row answers the keystroke)

| Change | Why |
|---|---|
| **The lot box now repaints the roll lines on every keystroke.** | `applyFabricOverride` re-spreads the edited metres across the lot's rolls as he types — unwinding newest-roll-first going down, extending the last roll going up — so `A-1 · 2.2 Mtr` under the lot name was stale the instant he typed. He is being told to cut a **named roll to a length**; leaving the length behind while the box says something else is the one thing that column must never do. Only the LOT column repaints; the ISSUE column holds the box he is in, so the caret survives. |
| **Editing a waste pcs box moves the fresh metres live**, via a new `reallocateInPlace`. | Declining a remnant does not shrink the job — the pieces it would have covered come off the roll instead. The allocator always did that arithmetic correctly (`2.2 → 3.3 → 4.4 → 5.5` as three remnants are handed back); what was missing was **showing** it. This previously called the full `render()`, which recomputed right but repainted the whole screen: the box being typed in was destroyed and rebuilt, so the caret jumped to the end and the page scrolled to the top on every digit. |
| `reallocateInPlace` re-runs the allocation over the **whole screen**, not one card | The ledgers are shared across cards in priority order, so a remnant this supervisor gives back is stock the **next card down** can now be offered. Re-allocating one card would leave every card below it quoting pre-change figures. Safe because the allocator is a pure function of (raw payload, declines, overrides) and rebuilds every ledger from scratch — the same property the priority reorder relies on. Pinned by `Y2` (three passes == one). |
| **THE WASTE BOX CEILING IS THE ALLOCATOR'S OFFER, NOT THE RACK** — new `pick.autoPieces`, read by `rackCountFor`. | The rack says how many remnants **exist**; the offer says how many **this job needs**, and they differ constantly: a demand of 4 cuts takes ONE remnant off a row holding three. A rack ceiling of 3 invited the store person to hand over two more against a requirement that cannot credit them — issued, gone from the rack, off the screen, with nothing anywhere saying why. |
| The ceiling is the **undeclined** pick, never the current one | A ceiling read off the current pick drops to 1 the moment he types 1, **trapping him there** with no way back up to the 3 he was offered. `applyLotAllocation` now runs the allocation once with declines suspended to record the baseline, then again for real. Verified side-effect free: the raw lots and `wasteStock` are untouched, and the double-pass result is byte-identical to a single pass. Exact mirror of `m.autoMetres` on the lot side, and for the same reason. |
| `tools/waste-live-edit.test.js` — **NEW, 14 cases** | Both ceiling guarantees mutation-tested independently: reverting to the rack fails W1/W2/Z2, and following the current pick fails W3/Y3. X3 also pins the roll model doing its job — a 2 m roll gives **three** whole 0.55 m rows (1.65 m) and strands 0.35 m, so the fourth row opens the next roll; a metres-pool model would have said "2.20 off A-1" and sent him to a roll that cannot deliver it. |

### Rev 8 → Rev 9 (green sweep — one real bug found)

| Change | Why |
|---|---|
| **`inWash` removed from the greige gate in `lotFill` — a REGRESSION I introduced in Piece 1.** | The frozen `e000519` baseline widens the gate by `unwash` **alone**. The greige gate asks *"could this lot cover the order if somebody went and **washed** its greige"* — an action the store person can take, and the one the `wash` reason puts a button on. Cloth already **at** the wash house is not that: nobody can send it again, it has to come back. Counting it made a committed lot report **"send 40 Mtr to wash" over cloth already at the washer**, burying the `atWash` reason that exists to say exactly this. Caught by `print-shortreason` C5. |
| Ledger edge-case 7 **inverted** | I had written it during Piece 1 to pin the behaviour the rewrite happened to have, without checking it against the baseline. It was pinning the bug. It now pins the correct gate, and asserts real greige still widens it. |
| **Seed rolls added to five test fixtures** (`store-ui`, `pipeline`, `sku-row`, `print-shortreason`, and `print-writers`' printed SKU) | Same root cause every time: since the migration a lot's metres are a **wash-state budget over its rolls**, so `rolls: []` yields nothing however much is washed. The failures were **indirect** and read as allocator bugs — the lot stops covering its order, and the **atom rule then skips the order whole**, taking perfectly good remnants with it. `store-ui` U3 was exactly this: a partial waste decline behaved like a total one. |
| `print-cut` Parts A/B/E deleted; `print-writers`' 11 minting cases deleted; `receive-print` M1 inverted | All tested **removed** behaviour. A test of a deleted branch proves nothing about the branch that replaced it. Each deletion left a guard test in its place pinning the retirement, so re-enabling any of it fails loudly. |
| **The `Fabric_Piece` retirement is HALF DONE, and that is now written down** | Widget side retired (Piece 4); **server side still live in ten `.dg` files** — `issueMaterials` / `issueMaterialsApply` still parse `"pieces":[{…"cutLengthCm"}]` that nothing sends. `print-cut`'s `PC-SPLIT` guard pins the asymmetry in both directions. |
| `getSupervisorMaterials` / `getExpectedWaste` still branch on `PRINTED_PIECE`, which nothing writes | `issueMaterials` lost the literal and `receiveMaterials` lost its reader (commit `1acf01a`), so those two branches are unreachable. `receive-print` M3b pins the exact set, and fails if it changes without this doc changing too. |

### Rev 7 → Rev 8 (Phase A Piece 5 — the roll display)

| Change | Why |
|---|---|
| Phase A **Step 3 marked COMPLETE**; Piece 5 recorded. | The lot line names its roll now. `pieceLineHtml` → `rollLineHtml`, `.lot-pieces` → `.lot-rolls` in the CSS, `isPiecesLot` deleted. |
| **Dedupe by `rollId` keeping the LARGEST** written down as a rule, not an implementation detail. | The two `ln.rolls` writers disagree on grain and neither one's code says so on its own — `applyLotAllocation` splits per line, `applyFabricOverride` stamps the whole lot onto every line. A reader who checks only one concludes summing is correct, and summing double-counts every overridden lot by the number of lines it serves. |
| `PRINTED_PIECE` payload branch left in place though unreachable | Removing it changes the **handover payload**, which is Step 5's business (`issueMaterialsApply` roll decrement + `issueMaterialsHandover` roll-label stamp). Cut it there, in one pass with the server side that reads it — not as display cleanup. |
| **Admin audit widget moves to the JS path** (new open question OQ6) | It still calls the Deluge `getStoreMaterialRequirements`, so the lots it feeds to the shared `applyLotAllocation` carry no `rolls[]`. The alternative — teaching the Deluge function to emit rolls — builds a second roll reader that has to stay in step with `api-experiment.js` for exactly as long as it takes to retire it. User: *"don't care about deluge we will change admin too."* |

---

## Relationship to the issue/receive migration

`docs/issue-receive-model-migration.md` is **independent and ships first** —
it touches `Material_Requirement` / `Issue_Lines` / watermarks / the JS read
path, none of which depends on how a lot's cloth is shaped. This work builds on
top: Step 5 edits `issueMaterialsApply.dg`, which that migration created.
