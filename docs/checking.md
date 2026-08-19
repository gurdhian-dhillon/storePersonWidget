# Checking — build spec

Checking replaces the old order-level `Quality_Check` entirely. It is the gate every
garment crosses between production and dispatch, one round per batch.

**The screen belongs to the SUPERVISOR, not the inspector.** Quality inspectors have no login;
supervisors do. So the checking widget opens on a supervisor's own finished batches and he names
which inspector judged each one, per check. See *Widgets* below.

**The word "QC" leaves the system with the form.** Every name that carried it is renamed to
Checking — see *Renaming* below, which is a migration step in its own right, not a cosmetic pass.

---

## The model in one page

The BOM's stages are production, done by operators, logged in `Stage_Log`. **The last BOM
stage closing is production's finish line** — it writes `Qty_Produced` and moves the item to
`Awaiting_Check`. That is "production complete" from the supervisor's side.

Checking is **not** a stage. It is its own record, `Item_Check`, keyed on `Plan_Item`. There is
no handover record: the transfer is physical, and `Item_Status == "Awaiting_Check"` **is** the
checker's queue. One less thing to forget to press.

The checker records five checks (pass/fail counts, nothing derives from them), then splits what
production made three ways:

| | goes to | becomes |
|---|---|---|
| **Approved** | packing | `Plan_Item.Qty_Accepted` |
| **Rejected** | remade from scratch | new `Plan_Item`, **no material yet** — see below |
| **Alteration** | back to named stages | new `Plan_Item`, `Alteration_Stage` rows, no material |

> **A rejection does not ask the store for anything.** `saveItemCheck` used to insert the remake
> batch's `Material_Requirement` rows itself, which put cloth on the store person's issue screen
> the instant an inspector pressed Save — a third party committing the supervisor to a handover he
> had not asked for and could not see coming. The batch is still opened here, because the order is
> short whatever anybody decides; what waits is the **demand**. The batch sits at
> `Awaiting_Material` with no requirements, the supervisor's **Reissue tab** reads exactly that
> pair as a draft, and `raiseReissueRequest` builds the rows when he presses *Ask the store*.
> Same shape `saveMaterialDamage` always had — report now, ask when it suits.

Finishing is a separate process, tracked on its own form, and is **out of scope here** — it is
not a production stage and gets no `Stage_Log`. It slots in later between `Awaiting_Check` and
`Complete` without moving anything else.

---

## The invariant that forces every item through checking

> **`saveProductionPhase` no longer writes `Complete`. Only `saveItemCheck` does.**

Everything else follows:

- An item that finishes production and is never checked sits at `Awaiting_Check` for ever. It
  cannot reach `Complete`, so it cannot vanish — it stays on the checker's queue, visibly.
- The **plan** reaching `Production Complete` changes its test from "every item `Complete`" to
  "every item at `Awaiting_Check` or beyond". The plan tracks production, and production is done.
- The **order** reaching `Checking Passed` runs only through `saveItemCheck`. One unchecked item
  blocks it permanently.

Two different tests, both honest: the plan asks whether production finished, the order asks
whether the customer's quantity was met.

`Sales_Order.Ready_For_QC` is deleted. `Item_Status == "Awaiting_Check"` answers the same
question with one field instead of two that have to be kept in sync — which is the exact drift
the old `Ready_For_QC` comment block in `saveProductionPhase` was written to warn about.

### Meeting the order requirement

Counted **per original line**, never per item and never as a plan-wide total:

```
Qty_Ordered  vs  root.Qty_Accepted + Σ children.Qty_Accepted   (children = Plan_Item[Remake_Of == root])
```

`Remake_Of` always points at the **root**, never at the previous batch, so this stays one flat
query however many rounds it takes. Deluge has no recursion; this is why that rule exists.

Three outcomes: satisfied, short with a batch still open, or short with nothing open. The third is
an order that will never finish on its own — `Short_Closed` on the sales order is the deliberate
way out, and it stays.

This is the test `createRemakeItems` already runs, including its guard that nothing passes while
any item is still in production. It moves out into **`recheckOrderComplete(orderId)`**, a plain
Deluge function — not a Custom API — called by everything that can change the answer:

| caller | when |
|---|---|
| `saveItemCheck` | last step of every check |
| `closeAlterationBatch` | when a batch closes with 0 survivors and never reaches a check |
| `saveProductionPhase` | when an item completes with 0 produced |
| `Sales_Order` workflow | on edit, when `Short_Closed` is ticked |

**One writer, four callers.** The old design had this logic inside the QC function and relied on
the QC record being re-saved to re-run it; with no such record there is nothing to re-save, so
every path that can satisfy an order has to say so itself. The `Short_Closed` row is the one most
easily missed — someone ticking that box is deciding the order is finished, and nothing else in
the system is watching that field.

---

## Renaming

**The transactional data has been wiped and the app starts fresh**, so these are straight renames
with no migration and no synonym handling. Nothing needs to read the old values.

| Old | New | Where |
|---|---|---|
| `Order_Status` = `QC Passed` | `Checking Passed` | `Sales_Order` picklist |
| `Remake_Reason` = `QC_Reject` | `Check_Reject` | `Plan_Item` picklist |
| `Source` = `QC_Remake` | `Check_Remake` | `Material_Requirement` picklist |
| `Plan_Item.QC_Ref` | `Check_Ref` | new field, old one dropped |
| `Sales_Order.Ready_For_QC` | — | deleted |
| `Quality_Check` form | `Item_Check` | replaced, not renamed |

> **An empty `Remake_Reason` still has to read as a rejection.** Not for legacy records — there
> are none — but because it is the safe default if anything ever writes a batch without setting
> it. A batch of unknown cause is more honestly a rejection than an alteration, which would
> otherwise send it down a path expecting `Alteration_Stage` rows that do not exist.

UI copy changes with it: the remake tag in `production.js` reads *"Failed checking"* rather than
*"QC remake"*.

### The four batch kinds are not three

`Production_Loss` must **never** be folded in with `Check_Reject`. It replaces garments spoiled on
the floor — pieces that were never inspected and never rejected. Drawing it as a rejection tells
the inspector they came back from his own last round, which is wrong and quietly moves the blame
for a cutting-table accident onto him. `production.js` already keeps them apart, so collapsing
them would also make two screens disagree about one item.

| `Is_Remake` / `Remake_Reason` | `batch` in the queue | Label |
|---|---|---|
| false or empty | `Original` | no tag |
| `Check_Reject` or empty reason | `Remake` | Remake — failed checking |
| `Production_Loss` | `Replacement` | Replacement — spoiled in production |
| `Alteration` | `Alteration` | Alteration batch |

---

## Statuses

`Plan_Item.Item_Status`

```
Awaiting_Material → Ready_For_Production → In_Production → Awaiting_Check → Complete
```

`Awaiting_Check` is new. Written by `saveProductionPhase` when the last BOM stage closes, and by
`closeAlterationBatch` when an alteration batch is declared finished.

`Sales_Order.Order_Status`

```
Pending → In Progress → Production Complete → Checking Passed → Packed → Dispatched
```

`Checking Passed` gets a real writer: `saveItemCheck`, via `recheckOrderComplete`, when every
original line is satisfied and nothing is still in production. Forward-only, the same rule every
other status writer in this app applies.

`Production_Planning.Order_Status` — unchanged, but `Production Complete` now means *production*
is complete, not that the order is inspected.

---

## Forms (Creator, manual)

### `Item_Check` — new

| Field | Type |
|---|---|
| `Plan_Item` | Lookup → `Plan_Item` |
| `Plan` | Lookup → `Production_Planning` |
| `Sales_Order` | Lookup → `Sales_Order` |
| `Inspector` | Lookup → `Employee` |
| `Check_Date` | Date |
| `Round` | Number — `Item_Check` count against this item's **root line** + 1 |
| `Qty_Inspected` | Number |
| `Qty_Approved` | Number |
| `Qty_Rejected` | Number |
| `Qty_Alteration` | Number |
| `Remake_Item` | Lookup → `Plan_Item` |
| `Alteration_Item` | Lookup → `Plan_Item` |
| `Remarks` | Multi Line |
| `Processed` | Decision box |

`Check_Lines` (subform) — `Check_Type` (Dropdown: Stain / Measurement / Thread / Stitching /
Fabric Softness), `Passed_Qty` (Number), `Failed_Qty` (Number), `Note` (Single Line).
Five rows always written. **Record only** — a piece can fail two checks, so these do not
reconcile with each other or with the disposition, and nothing computes from them.

`Alteration_Lines` (subform) — `Stage_Name` (Single Line), `Planned_Qty` (Number). These may sum
**above** `Qty_Alteration`, because one garment can need two stages fixed.

No per-line `Processed` flag here, unlike `createRemakeItems`' `QC_Items`. That form needed one
because every row created its own remake; here one check creates at most one remake batch and one
alteration batch, and `Remake_Item` / `Alteration_Item` on the header are the guards. A per-line
flag nothing writes is worse than no flag.

### `Alteration_Stage` — new

| Field | Type |
|---|---|
| `Plan_Item` | Lookup → `Plan_Item` |
| `Sequence_No` | Number |
| `Stage_Name` | Single Line |
| `Planned_Qty` | Number |

Exists **only** for alteration batches — which is why it is named for them. An ordinary item gets
its stage list from the BOM; an alteration batch cannot, because it runs two stages, not eight.

`Sequence_No` is copied from the BOM's own sequence for that stage, so a batch runs Embroidery
before Stitching whatever order the checker listed them in. Nothing in the arithmetic depends on
that order any more, but the physical work does.

**Insert the rows in BOM order as well as stamping `Sequence_No`.** Readers are supposed to sort
by it — and in Deluge that means a `sort by` on its own assignment, which is exactly the kind of
line that gets left off. Writing them in order too means both have to fail before a batch runs
its stages in whatever order the checker happened to type them. The lifecycle simulation caught
this; it is not hypothetical.

`Stage_Name` is Single Line, not a dropdown — a snapshot of what the stage was called that day,
the same rule `Stage_Log.Phase_Name` follows. Renaming a stage later must not rewrite history.

### `Plan_Item` — changes

- `Item_Status` gains `Awaiting_Check`
- `Remake_Reason` gains `Alteration` and `Check_Reject` (`QC_Reject` stays as a legacy synonym)
- `Check_Ref` — Lookup → `Item_Check` (replaces `QC_Ref`)
- `Qty_Lost` — Number, declared at alteration close

> **`Check_Ref` on a `Plan_Item` means "the check that CREATED this batch"**, exactly what `QC_Ref`
> meant. It is written only on remake and alteration batches, never on the item being inspected.
>
> Giving it the second meaning — "the check that inspected me" — looks harmless and is not: a batch
> created by round 1 carries `Check_Ref = 1`, and its own inspection in round 2 would overwrite
> that with 2, destroying the only record of why the batch exists. Nothing is lost by leaving it
> off, because "which check inspected this item" is already a query from the other side,
> `Item_Check[Plan_Item == itemId]`.
>
> Three fields share the name and none of them mean the same thing:
>
> | Field | Points at | Means |
> |---|---|---|
> | `Item_Check.Plan_Item` | the item | what was inspected |
> | `Plan_Item.Check_Ref` | the check | what created this batch |
> | `Material_Requirement.Check_Ref` | the check | why this cloth was issued |

### `Material_Requirement` — changes

- `Source` gains `Alteration` and `Check_Remake` (`QC_Remake` was never written; it can go)
- **`Issued_Lot` — Lookup → `Raw_Material_Lot`.** Already added and live; listed here because
  everything below depends on it. See *Lots and tone* at the end of this section.
- **`Check_Ref` — Lookup → `Item_Check`.** New field. This is the reason record for a
  `Check_Remake` requirement, and it is what the consumption report follows to answer *why was
  this cloth issued*. `Damage_Ref` already plays the same role for a `Reissue` row; without this
  one, remake material has a `Source` but nothing to trace it back to.

### Lots and tone — what the lot work already decided for you

Fabric lots are colour tone, and the store screen now guarantees **one order, one lot**. Three
consequences land directly on this spec, and none of them needs new work here.

**A `Check_Remake` requirement is automatically pinned to the original lot.** The store screen
reads the pin from *any* line of the order, settled or not, so a remake batch raised weeks later
against a finished item is allocated from the same lot the rejected garments were cut from. That
is exactly what a replacement needs — four new pieces in a different shade to the ninety-six they
sit beside is a second rejection, not a fix.

> This was a real bug found while testing. The pin was read only from lines that still owed
> something, and a finished original owes nothing — so the ordinary remake was allocated freshly
> and landed on whichever lot was smallest. Fixed; `issueflow.test.js` covers it.

**`Alteration` requirements inherit the same pin**, by the same mechanism and for the same reason.
An alteration batch is a new `Plan_Item` under the same plan, and the pin is keyed on the **order**
rather than the item, so it carries across without the checking functions doing anything.

**The lot can be exhausted, and the screen now says so rather than failing silently.** If the
original lot has nothing usable left, the remake row is unissuable and reads *"Already cut from L2,
which is now empty."* Nothing here needs to handle it — but a remake sitting unissued on the store
screen is a real outcome to expect on the first order that hits it, and the reason will be tone,
not stock.

> Worth knowing why that was hard: an emptied lot is **dropped from the store screen's data
> entirely**, so "the pin is unusable" normally looks like *the lot is absent*, not *the lot is
> there with zero*. Missing that, the allocator fell through to choosing freely and moved the
> remake onto another tone silently. A blocked lot behaves the same way, correctly.

**He can override it, and the override is recorded.** When the original lot is unusable the row
offers *"Use a different lot…"*, which requires him to pick a replacement and give a reason. The
handover then carries `Lot_Override_From` and `Lot_Override_Note` while `Issued_Lot` keeps the
original — the disagreement between them is the evidence a person chose it.

So a check remake has three possible endings, and the checking flow should expect all three:

| | what the store screen does |
|---|---|
| original lot has stock | allocated from it, no interaction |
| original lot has only greige | allocated what it can, wash ticket **aimed at that lot** |
| original lot unusable | nothing allocated, override offered, reason required |

**What this spec must NOT do:** do not set `Issued_Lot` when creating remake or alteration
requirements. It is stamped by `issueMaterials` on first issue and never overwritten — writing it
at creation would pin the row to a lot before anyone has looked at the rack, and the store screen
would obey it.

**What it must carry:** a remake or alteration `Material_Requirement` needs `Plan_Item` set and
must sit under the **same plan** as the item it replaces. The pin is keyed on the ORDER, so a batch
under a different plan would be treated as a new order and allocated freely. `createRemakeItems`
already does this; a new function has to do the same.

Also: `Required_Pieces` matters as much as `Required_Qty` on these rows. The store allocator sizes
everything from pieces — metres are a pre-waste estimate — so a remake requirement with pieces
unset gets no lot allocation at all and the row sits unissuable with no explanation.

### Fields this work already added

Listed so the checking build does not re-add them or assume they are missing:

| Form | Field | Purpose |
|---|---|---|
| `Material_Requirement` | `Issued_Lot` | the pin |
| `Material_Issue.Issue_Lines` | `Lot`, `Settled_Qty` | which lot crossed the counter, and how much is confirmed |
| `Material_Issue.Issue_Lines` | `Lot_Override_From`, `Lot_Override_Note` | a deliberate tone override |
| `Waste_Master` | `Lot`, `Carton_Number` | an offcut's tone, and which box it is in |

Full detail in `lots.md` — *The pin*, *When the pinned lot runs out*, and *The override*.

### `Sales_Order` — changes

- `Order_Status` gains `Checking Passed` (`QC Passed` stays as a legacy synonym)
- `Ready_For_QC` — **deleted**
- `Short_Closed` — kept, plus a new on-edit workflow calling `recheckOrderComplete`

### Deleted

- `Quality_Check` form, both its workflows, and its subform
- `BOM.Production_Stages.Operation`: remove `Finishing` from the picklist, and from every BOM
  that lists it — finishing stops being a production stage

---

## Alteration batches

This is the part with the least precedent in the codebase, so the reasoning matters more than
the field list.

A batch is **one** `Plan_Item` for the physical garments set aside — not one per stage. One per
stage would double-count any garment needing two stages fixed, and the order would read complete
while the customer was short.

```
Plan_Item          Qty_Ordered = Qty_Alteration
                   Is_Remake = true
                   Remake_Reason = "Alteration"
                   Remake_Of = root
                   Item_Sku, BOM = COPIED from the source item
                   Item_Status = "Ready_For_Production"     ← not Awaiting_Material
                   (no Material_Requirement rows)
Alteration_Stage   one row per Alteration_Lines row
```

`BOM` is copied even though the batch builds no material from it, because the alteration picker
at the **next** check needs the root's full stage list and has nothing else to resolve it
through. `Item_Sku` for the same reason the remake copies it: the checker's queue shows a SKU.

`Ready_For_Production` and no requirements is what makes material **optional** — alteration needs
no cloth unless he asks for it. See *Material accounting* below.

### Loss is declared at the batch, not derived from stages

An alteration batch has no continuous quantity flow: a garment can be worked at two stages, so
per-stage `Qty_Out` cannot be summed into a batch total without knowing which garments overlap,
and nobody records that.

So:

- **Alteration stage logs are work records, not attrition records.** `Qty_In` is the checker's
  `Planned_Qty` for that stage — what he was asked to fix. The widget does not ask for `Qty_Out`;
  the function writes it equal to `Qty_In`, so nothing downstream reads a blank as total loss.
  The row answers *who did what work, when*. It deliberately does not answer *how many survived*.
- **One closing action ends the batch.** When every alteration stage is `Done`, the supervisor
  gets *"Alteration finished — how many garments are going back for checking?"*, defaulted to the
  batch size and reducible only. That number becomes `Qty_Produced`; the shortfall becomes
  `Qty_Lost` and opens the existing damage report so there is a reason on the record.
- **The declaration is compulsory.** `Awaiting_Check` is reachable only through
  `closeAlterationBatch`. If the batch could reach the checker without it, the shortfall would
  surface weeks later as an order that will not close.

> **The arithmetic is declared at the batch; the explanation is attributed at the stage.**
> The damage report asks which stage he lost them at, and that answer is allowed to be
> approximate precisely because nothing computes from it. The number that must be right has one
> owner and one place to be wrong.

Per-stage attrition reporting for alteration batches is given up deliberately. Ordinary
production keeps per-stage `Qty_Out` exactly as it is, and that is where the volume is.

### Recursion

A re-check can send a batch to alteration again, or reject it into a fresh remake. `Remake_Of`
always points at the root, so it stays flat. It terminates when quality is good; `Short_Closed`
is the escape if it never does.

**The alteration picker always offers the root item's full BOM stage list**, never the parent
batch's `Alteration_Stage` rows. Otherwise the choices narrow every round and by the third
alteration he cannot name the stage that is actually wrong.

### Nothing to inspect

If he declares 0 coming back, the batch closes at `Qty_Produced = 0` and goes straight to
`Complete` — never to checking, because there is nothing to inspect. A batch sitting at
`Awaiting_Check` with nothing in it would jam the queue for ever.

**The same applies to an ordinary item whose last BOM stage produced 0.** It goes to `Complete`,
not `Awaiting_Check`, for exactly the same reason.

Both cases must then run the order recompute. This is the trap: `Complete` is normally reached
through `saveItemCheck`, which recomputes as its last step — so an item that reaches `Complete`
*without* a check is the one path where the order can silently stop being reassessed, and the
last item of an order taking that path would leave it hanging at `Production Complete` for ever
with nothing to press.

---

## Material accounting

The end goal is a consumption report: *how much cloth did this order eat, where did it go, and
why was there extra?* That goal decides the design here, so start from it.

### One rule

**Material enters an order exactly one way — a `Material_Requirement` that is issued and
received.** Total consumed for an order is the sum of `Received_Qty` across every requirement of
every batch on it. Nothing else is needed to answer *how much*.

What is needed is *which bucket, and why*. That is `Source` plus a reason record:

| `Source` | Quantity comes from | Reason record | Meaning |
|---|---|---|---|
| `Plan` | BOM at plan time | — | what it should have taken |
| `Reissue` | supervisor declares | `Material_Damage` | spoiled during production |
| `Check_Remake` | BOM × rejected qty, **raised by the supervisor** | **`Item_Check`** | lost with rejected garments |
| `Alteration` | supervisor declares | `Material_Damage` | spent on rework |

Every row has a source, and every non-`Plan` source points at a record that explains itself.

> **All four sources are allocated from the order's own lot.** `Source` decides which requirement
> a handover credits; it does not decide the tone. A `Check_Remake` row and the `Plan` row it
> replaces belong to one order and therefore one lot — see *Lots and tone* above.

### A rejection does NOT create a `Material_Damage` record

Nobody has to report it. Five garments rejected means five garments' worth of cloth is scrap, and
the system already knows that exactly — the BOM says what one takes, and the remake batch's
requirements are built from it. `Item_Check` is the reason record, reached through
`Material_Requirement.Check_Ref`.

`Material_Damage` exists to capture what the system **cannot** know: a supervisor ruined 1.2 m
that nothing else recorded. A rejection is fully derivable, so asking anyone to re-enter it is
double entry that can disagree with itself — and booking it as damage *and* as a remake
requirement would double the reported loss.

Responsibility stays traceable without it: the five check rows say *what* failed, and that item's
`Stage_Log` for that stage says *who* did it.

> **This is also why the Reissue-tab draft is derived rather than stored.** The obvious way to get
> a remake onto that tab is to write it as a `Material_Damage` record, which the tab already reads
> — and it would land a check rejection in the consumption report's **damaged** column, which is
> exactly the double count this section exists to prevent. The other obvious way is draft
> `Material_Requirement` rows, which every screen that reads that form would then have to learn to
> ignore, silently and one miss at a time. So nothing is stored: the draft **is** a `Check_Reject`
> batch at `Awaiting_Material` with no `Check_Remake` requirement against it, and its lines are
> rebuilt from the batch's own BOM through the shared `buildItemRequirements`. It costs a BOM walk
> per waiting batch and cannot go stale.
>
> The requirement rows are also the only guard against raising twice, and they are enough —
> there is no flag that can drift out of step with them. `getReissueDrafts`, `getSupervisorCounts`
> and `raiseReissueRequest` all apply the same test and **must keep applying the same one**, or the
> badge, the tab and the button disagree about whether there is work.

### An alteration material request DOES

Here the quantity genuinely cannot be derived — there is no BOM formula for *"how much lace does
redoing seven stitchings need"*. Only the supervisor knows, so it must be declared, and the
existing draft-then-raise mechanism is the way to declare it.

> **`Material_Damage` is the reason record for material issued beyond the plan, in the cases
> where a human has to declare the quantity.**

Two flavours, told apart by `Damage_Reason`: *spoiled in production* (`Damaged_Pieces > 0`) and
*consumed by rework* (`Damaged_Pieces = 0`). Both are "extra material, with a reason and someone
answerable", which is exactly what the report needs from it.

### Two existing defects this must not inherit

- **`createRemakeItems` never sets `Source` at all.** Remake material therefore reads as `Plan`
  and is invisible in any breakdown. `saveItemCheck` must set `Check_Remake` and `Check_Ref`.
- **`raiseReissueRequest` hardcodes `Source = "Reissue"`.** It must write `Alteration` when the
  target item has `Alteration_Stage` rows — derived server-side, no payload change. Rework
  material and production spoilage are the two things an admin most wants told apart.

### Reissue during alteration — the trigger

Damage is currently reachable **only** when a stage closes with `Qty_In > Qty_Out`. An alteration
stage writes `Qty_Out = Qty_In` by definition, so that door never opens for a batch.

So one trigger comes back, named for what it is: **"Request material"**, opening
`openDamageDialog(plan, item)` with no `opts` — the manual mode that dialog still supports — and
the spoiled count defaulting to 0. **On alteration batch cards only.**

Everything downstream then runs untouched — no reader looks at the piece count:

1. `saveMaterialDamage` writes a draft against the alteration batch, stamped with the alteration
   stage's `Stage_Log` and phase name, `Damage_Reason = "Alteration"`.
2. `getReissueDrafts` lists it on the Reissue tab, grouped by `Plan_Item` — the batch is its own
   item, so it gets its own card.
3. `raiseReissueRequest` creates `Material_Requirement` rows. It targets `dmg.Remake_Item` when
   set and otherwise the item itself — an alteration damage has no `Remake_Item`, so it correctly
   targets the batch.
4. It moves the batch `Ready_For_Production → Awaiting_Material` and pulls plan and order back to
   `In Progress`, so the store can see it. Both rules already exist and are already right.
5. `receiveMaterials` puts it back to `Ready_For_Production`.

**`closeAlterationBatch` must refuse while the batch has a `Material_Requirement` with
`Received_Qty < Required_Qty`.** Otherwise he sends the batch to the checker while still waiting
on cloth for it.

### The consumption report itself is a separate document

Not specced here. Two limits to know before it is written, both already deliberate gaps:

- **Damage salvage at Cutting is double-counted as loss.** A ruined panel is salvaged into the
  offcut box *and* reported as damage. Stock is correct; the *loss* figure is overstated, and
  netting it needs provenance on `Waste_Master` that does not exist. This report is the thing that
  decision was deferred until — expect to make the call once the numbers are visible.
- **`Issued_Qty` exceeding `Required_Qty` on fabric is correct, not an error.** Cloth comes in
  whole marker rows, so split handovers legitimately total more than the plan estimated. The
  report must say so or it reads as a bug on every fabric row.

---

## Functions

### New

**`saveItemCheck(payloadJson)`** — Custom API, POST, one argument.

```json
{ "planItemId":"9", "inspectorId":"5",
  "checks":[ {"type":"Stain","passed":98,"failed":2,"note":""} ],
  "approved":85, "rejected":5, "alteration":10,
  "alterationLines":[ {"stage":"Stitching","qty":7}, {"stage":"Embroidery","qty":3} ],
  "remarks":"" }
```

In order:

1. Refuse unless the item is at `Awaiting_Check` and has no completed `Item_Check`. One round per
   batch.
2. **Refuse unless approved + rejected + alteration equals `Qty_Produced` exactly.** Anything
   else lets garments vanish between the supervisor and the checker with nothing recording it,
   and a shortfall that real is a damage report, not a rounding gap in a form.
3. Refuse an alteration line naming a stage that is not on the root item's BOM, a line quantity
   above `Qty_Alteration`, or lines summing below it.
4. `Qty_Inspected` is read **server-side** off `Plan_Item.Qty_Produced`, never from the payload —
   same reason `raiseReissueRequest` reads its quantities off the damage record: a stale tab must
   not be able to inspect a number that has since changed.
5. Write `Item_Check` and both subforms.
6. `Qty_Accepted += approved`, `Qty_Rejected += rejected`, `Item_Status = "Complete"`. **Not
   `Check_Ref`** — see the field note below.
7. Rejected > 0 → remake batch: new `Plan_Item` from Cutting, `Is_Remake`,
   `Remake_Reason = "Check_Reject"`, `Remake_Of = root`, `Qty_Ordered = rejected`,
   `Awaiting_Material`, requirements built through `thisapp.buildItemRequirements` so the remake
   is costed by the same arithmetic as the original, each carrying **`Source = "Check_Remake"`**
   and `Check_Ref`. BOM is **copied** from the source item, not re-resolved from the master — a
   BOM edited between the runs must not change the replacement's spec.
8. Alteration > 0 → one alteration batch as specified above, plus its `Alteration_Stage` rows.
9. Pull plan and order back to `In Progress` if a batch was created — only from
   `Production Complete`, the existing forward-only rule.
10. Call `recheckOrderComplete(orderId)`.

Steps 7 and 8 are guarded by `Remake_Item` / `Alteration_Item` already being set. A record saved
twice must not create the work twice; the same guard is what stopped a re-saved QC record turning
90 accepted into 180.

**`recheckOrderComplete(orderId)`** — plain Deluge function, **not** a Custom API.

Per original line: `Qty_Ordered` against the root's `Qty_Accepted` plus every `Remake_Of` child's.
Sets `Order_Status = "Checking Passed"` when every line is satisfied (or the order is
`Short_Closed`) and no item is short of `Complete`. Forward-only, from `Production Complete`,
`In Progress` — and from `QC Passed`, so an order passed under the old name settles on the new
one rather than being stuck.

**`getCheckingQueue(supervisorId)`** — Custom API, POST, one argument.

Returns an `inspectors` array for the picker, plus supervisors each with their items at
`Awaiting_Check`. Per item: id, name, SKU, plan no, sales order, `batch` (one of the four kinds
above) and round, `Qty_Produced`, the **root** BOM's stage list for the alteration picker, and the
order-line position — ordered, accepted so far, outstanding.

The inspector list is built the way `getSupervisorMaterials` builds its supervisor list, including
the fallback to every employee when nobody matches `Designation == "Quality Inspector"`. Without
it the picker is empty and the widget looks broken, with nothing on screen saying why.

That last figure is not optional. Without it the inspector approves 85 with no idea whether the
order is whole or fifteen short.

Watch the statement limit: bucket by supervisor in one pass and denormalise, rather than walking
`Plan_Item → Plan → Sales_Order` per row. The limit is not catchable — it kills the script and
the widget gets a bare 500 with no error card.

**`closeAlterationBatch(payloadJson)`** — Custom API, POST, one argument.

```json
{ "planItemId":"31", "supervisorId":"5", "qtyReturning":28, "note":"" }
```

Refuses unless every `Alteration_Stage` row has a `Done` `Stage_Log`, and unless every
`Material_Requirement` on the batch is fully received. Writes `Qty_Produced = qtyReturning`,
`Qty_Lost = Qty_Ordered − qtyReturning`, and `Item_Status = "Awaiting_Check"` — or `Complete`
plus a `recheckOrderComplete` call when `qtyReturning` is 0.

Two payload fields are **informational only** and land in the `info` log, not on a record.
`Plan_Item` has no remarks field and no supervisor lookup, and inventing either would be a Creator
change for no reader: the supervisor is derivable from the plan, and the shortfall's reason
belongs on the damage report the widget opens next, which is where it can name a stage.

It also refuses an item already at `Complete` (`BATCH_CLOSED`). `Complete` means either
`saveItemCheck` has split `Qty_Produced` into accepted and rejected, or this function already
closed the batch at zero — re-declaring afterwards would put `Qty_Produced` at odds with
`Qty_Accepted`, and `recheckOrderComplete` reads both. A batch at `Awaiting_Check` is deliberately
still editable: the check has not happened, so correcting a mistyped count is honest.

Its own function rather than another argument on `saveProductionPhase`: closing a batch is a
different act from closing a stage, and folding it in would give `isLastStage` a second meaning.
That function already carries comments about the bugs it accumulated the last time something was
overloaded onto it.

### Changed

**`saveProductionPhase.dg`**

- The last BOM stage writes `Qty_Produced` and `Awaiting_Check` — **not** `Complete`. `Complete`
  is no longer written by this function at all.
- An item with `Alteration_Stage` rows is an alteration batch: its last stage closing leaves it
  `In_Production`, and `closeAlterationBatch` takes it from there.
- An alteration stage writes `Qty_Out = Qty_In`; the widget does not send one.
- The plan's `Production Complete` test becomes "every item at `Awaiting_Check` or beyond".
- An item completing with 0 produced goes to `Complete` and calls `recheckOrderComplete`.
- The `Ready_For_QC` block is removed.
- The produced/remade totals need **no change**. `Qty_Produced` is written before checking splits
  it, so the original already counted the rejected and altered pieces; both new batch types stay
  in `totalRemade` only, exactly like the existing rejection reason. Its display fallback string
  `"QC_Reject"` becomes `"Check_Reject"`.

**`getProductionWidgetData.dg`**

- `phases` comes from `Alteration_Stage` when rows exist, otherwise from `BOM.Production_Stages`.
  Alteration rows carry `plannedQty` so the card can read *"7 to alter"*.
- Send `Awaiting_Check` items and whether an alteration batch is ready to close.

**`raiseReissueRequest.dg`** — `Source = "Alteration"` when the target item has `Alteration_Stage`
rows, otherwise `Reissue` as now.

**`packingAutoPopulate.dg`** — remove the `Quality_Check` reads. Quantities already roll up
`Plan_Item.Qty_Accepted` per original line, so they keep working once `saveItemCheck` is the
writer of that field. `Round` comes off `Item_Check` or is dropped.

**`getSupervisorProductionHistory.dg`** — render `Awaiting_Check` and the check outcome.

### Deleted

`qcAutoPopulate.dg`, `createRemakeItems.dg`.

---

## Widgets

**`app/checker/` — new.** A SUPERVISOR picker at the top, not an inspector one, and that
reversal is the design rather than a detail.

**Quality inspectors have no login; supervisors do.** So the man at this screen is the supervisor
who made the garments, working through his own batches — the same shape as the production screen
he already knows — and **which inspector judged each batch is chosen inside the check dialog**.

That is not just where the control sits. Who inspected a batch is a fact about *that inspection*,
not about who happens to be looking at a screen, so it belongs on the record per check: two
batches on one trolley can honestly have been judged by two different people. `saveItemCheck`
refuses a check with no inspector, on the server as well as in the widget — it is a Custom API and
callable from anywhere, and an unattributed rejection can never be recovered afterwards.

The dropdown lists only supervisors with something waiting, each with its count. A flat list of
that supervisor's items follows, with a badge on the queue tab and a History tab beside it.

The check dialog: five check rows (pass / fail / note), then approved / rejected / alteration
which must sum to what production made, then — only when alteration is above zero — the root
BOM's stage list with a quantity box against each.

Reuse `item-card`, `status-pill`, `table-wrapper`, `col-num`. ES5-flavoured `var`/`function`,
matching `main.js` and the other widgets rather than `production.js`.

**`app/supervisor/js/production.js`** — alteration batch cards: stages from `Alteration_Stage`,
each showing its `Planned_Qty`, and the *"Alteration finished"* close action once every stage is
`Done`. Plus the **"Request material"** action, rendered only when the item has `Alteration_Stage`
rows — `openDamageDialog` in `reissue.js` needs no change, only a caller. The two stale comments
still referring to the removed Report damage button (around lines 1238 and 1483) want updating
with it, and the remake tag reads *"Failed checking"*.

---

## Build order

Nothing here is reversible once items start landing at `Awaiting_Check`, so the order matters.

0. **Simulate the lifecycle in Node first.** Deluge cannot be run here, and the alteration path —
   batch created, material reissued, garments lost, re-checked, sent to alteration again — is the
   most intricate arithmetic in the app after the fabric allocator. Porting it to a small script
   and running the full round trip is what caught the fabric-piece rollback and the double-count.
   *Done — 7 scenarios, 6 invariants; it caught the stage-ordering defect above.*
1. **Creator forms and fields.** `Item_Check`, `Alteration_Stage`, the new `Item_Status`,
   `Remake_Reason`, `Source` and `Order_Status` values, `Check_Ref`, `Qty_Lost`. No behaviour
   change yet — new picklist values sitting unused are inert.
2. **`recheckOrderComplete` + `getCheckingQueue` + the checker widget.** The queue is empty
   because nothing reaches `Awaiting_Check` yet, which makes it safe to build and look at.
3. **`saveItemCheck`, `closeAlterationBatch`, `Alteration_Stage` handling in
   `getProductionWidgetData`, `raiseReissueRequest`'s source, alteration rendering in
   `production.js`.** Still unreachable.
4. **The flip.** `saveProductionPhase` writes `Awaiting_Check` and the plan test changes. From
   this moment every finished item goes to the checker.
5. **Retire QC.** The `Short_Closed` workflow on `Sales_Order`; then delete the `Quality_Check`
   form and workflows, `qcAutoPopulate.dg`, `createRemakeItems.dg`, `Ready_For_QC`; update
   `packingAutoPopulate`.

   **Drop `Plan_Item.QC_Ref` before deleting the `Quality_Check` form**, not after — it is a
   lookup pointing at that form, and Creator will either refuse the deletion or leave the field
   dangling. `Check_Ref` replaces it and existing records simply have none.

**The data wipe removes the migration risk, not the ordering.** With no live records there is
nothing to strand, so the old picklist values can simply go. The build order above still holds:
`saveProductionPhase` must not start writing `Awaiting_Check` before there is a checker widget to
drain the queue.

---

## Deployment runbook

Nothing in this repo runs until it is pasted into Creator. Nine files, and the order between them
is not arbitrary — each group is safe to stop at.

### A — inert. Nothing behaves differently yet.

| Paste | Into |
|---|---|
| `recheckOrderComplete.dg` | a plain function — **no Custom API** |
| `getCheckingQueue.dg` | new Custom API, POST, arg `inspectorId` |
| `saveItemCheck.dg` | new Custom API, POST, arg `payloadJson` |
| `closeAlterationBatch.dg` | new Custom API, POST, arg `payloadJson` |

Upload `app/checker/`. Nothing writes `Awaiting_Check` yet, so **the queue is correctly empty** —
that is the expected first result, not a failure. Use Creator's **Execute** on each function here:
this is the last moment a mistake costs nothing, and the widget only ever sees "code 9430".

`getCheckingQueue` is the **first reader of `Item_Check` in the repo**, so its field names came
from this document rather than from a function that writes them. If a link name is wrong, this is
where it surfaces.

### B — still inert, but now the supervisor's screen can drive it.

`getProductionWidgetData.dg`, `raiseReissueRequest.dg`, `production.js`, `app/supervisor/css/`.

Alteration batches cannot exist yet — only `saveItemCheck` creates them, and nothing reaches it —
so this changes nothing visible. It has to be in place first, because the moment group C lands the
first check can produce a batch, and a batch with no screen to work it is stuck.

### C — THE FLIP. One file, and it is one-way.

`saveProductionPhase.dg`. From this paste every finished item goes to `Awaiting_Check` instead of
`Complete`, and the checker is on the critical path for every order.

Before pasting: **no order sitting between `Production Complete` and `QC Passed`.** Anything
mid-QC has to be finished through the old form first — group D deletes it.

Items already `Complete` when this lands were finished under the old rules and will never be
checked. That is correct and needs no repair.

### D — retire QC. Only once C is proven on a real order.

1. Add the `Short_Closed` workflow on `Sales_Order` calling `recheckOrderComplete`. **Do this
   first** — until it exists, ticking `Short_Closed` does nothing at all, and that is the only way
   to close an order short of pieces nobody will remake.
2. Paste `packingAutoPopulate.dg` and `getSupervisorProductionHistory.dg`.
3. **Drop BOTH lookups at `Quality_Check` before deleting the form**, not after — Creator will
   either refuse the deletion or leave them dangling:
   - `Plan_Item.QC_Ref`
   - **`Packing.QC_No`** — easy to miss. `packingAutoPopulate` filled it with every QC round on
     the order. Checking works at a different grain (one `Item_Check` per *batch*, not one per
     order per round), so a twenty-line order that went round twice would put forty entries in a
     field meant to name an inspection. The block that filled it is gone; the packed quantities
     still trace to an inspection through `Plan_Item.Qty_Accepted`, one line at a time.
4. Delete the `Quality_Check` form, both its workflows and its subform. Delete
   `Sales_Order.Ready_For_QC`.
5. Delete `qcAutoPopulate.dg` and `createRemakeItems.dg` from this repo.
6. Remove `Finishing` from the `BOM.Production_Stages.Operation` picklist and from every BOM
   listing it.

### What to watch on the first real order

- The inspector picker falls back to **every employee** until someone has `Designation = Quality
  Inspector` with `Status = Active`. The function logs which state it is in — that is the fallback
  firing, not a bug.
- A **bare HTTP 500 with no error card** is almost always Creator's statement-execution limit,
  which is not catchable and so cannot report itself. `getCheckingQueue` and
  `getProductionWidgetData` are the two most exposed.
- First alteration batch: check the stages appear in **BOM order**, not the order the inspector
  typed them.

---

## Deliberately not in this spec

- **The consumption report.** Its own document. The `Source` values and reason records defined
  above are what it will be built from.
- **Finishing.** Separate process, its own form, no `Stage_Log`. Slots between `Awaiting_Check`
  and `Complete` when it is built; nothing here has to move to make room.
- **Per-stage attrition inside alteration batches.** Given up on purpose — see above.
- **Material-only damage in ordinary production.** Since damage became reachable only when a
  stage closes `Qty_In > Qty_Out`, a supervisor who ruins three cones of thread without spoiling
  a garment has no way to ask for more — the case the `saveMaterialDamage` header says the form
  mostly exists for, and which its dialog still has the wording for. The manual door is being
  reopened for alteration batches **only**, on purpose. If it turns out to be wanted on ordinary
  items too, it is the same caller with a different condition.
- **Netting damage salvage out of reported loss.** Blocked on `Waste_Master` provenance; see the
  consumption report note above.
- **A rejection reason beyond the five check rows.** Ask before adding one.
- **A sixth check.** The five are fixed. Adding one is a Creator picklist change plus a widget
  change; cheap, but not free.
