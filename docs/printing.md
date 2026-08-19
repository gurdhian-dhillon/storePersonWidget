# Printing — plain fabric out, printed pieces back

Agreed 2026-08-19. Builds on [lots.md](lots.md), [lots-issue-redesign.md](lots-issue-redesign.md)
and [inventory-integration.md](inventory-integration.md). **Nothing here is built yet.**

Plain cloth is cut into full-width pieces, sent to an outside printer, and comes back printed. The
plain SKU's stock goes down, the printed SKU's goes up, and the printed cloth is then issued to
production like any other fabric.

## The one hard problem

**Printed stock is pieces, and pieces are not metres.**

Five 3.00 m pieces are not 15 m. Against a 55 cm cut each piece yields `floor(300/55) = 5` marker
rows and strands 25 cm — 25 pieces in total, where a continuous 15 m roll gives 27. The metres
figure is the same and the usable yield is not.

Every fabric path in the app today assumes continuous cloth. The allocator computes fresh rows as
`floor(metres × 100 / cutLength)` ([lot-allocator.js:159](../app/js/lot-allocator.js#L159)) and
`issueMaterials` derives pieces the same way. Feed either of them a metres figure that is really a
pile of pieces and you get the exact failure CLAUDE.md records four times: the row reads issuable,
the last pieces never come out, the item sits at `Awaiting_Material` for ever, and **pressing Issue
does nothing with no error.**

So printed stock is held as `length × count` at full width, and its capacity is **simulated per
piece** — never compared in metres.

The maths for that already exists and is already right. `remnantYield`
([lot-allocator.js:74](../app/js/lot-allocator.js#L74)) is
`floor(W / cutW) × floor(L / cutL)`; hand it a full-width piece and it gives the correct answer
unchanged. **A printed piece is algorithmically an offcut that happens to be full width.**

## Decisions this is built on

- **Printing is a store-side conversion, before issue.** It moves stock between two SKUs. It is not
  a production stage and does not go through `sendToThirdParty`.
- **Printed fabric is its own `Raw_Material` SKU**, identified by **plain SKU + pattern**, and it is
  **created on demand** when that combination has never been printed before. Nothing on the plan side
  changes — a printed requirement row is an ordinary fabric row with cut sizes and `Required_Pieces`.
- **Creator only, for now.** No Zoho Inventory work in this build: the quantity moves and the SKU is
  minted in Creator and nowhere else. The layering below is still designed so the sync drops in
  later without rework — see *Where the stock lives*.
- **Printing is to stock, not to order.** Runs are made in convenient sizes against overall demand.
  No print job carries a plan, and no order is pinned to one before the cloth comes back.
- **A print run is a lot.** Tone depends on the plain lot *and* the ink batch, so the run becomes a
  `Raw_Material_Lot` of the printed SKU. Everything the shade rules already do — the order atom, the
  pin, the recorded override — then works on printed cloth with no new concept.
- **Full width is preserved.** He cuts along the roll only. If a printer ever returns cloth narrower
  than the SKU's width, that is a defect to be caught at receipt, not a case to model.
- **Either state can go, either state can come back.** He chooses whether to send washed or greige
  cloth, and states on return which the printed pieces are.

## Where the stock lives — three layers, one owner each

This is the answer to *"Inventory has no idea how many pieces there are."* It does not need one, for
the same reason it has never needed to know about lots or offcuts.

| Layer | Holds | Owner | Built now? |
|---|---|---|---|
| **Zoho Inventory** | metres per SKU | Inventory | **no — later** |
| **`Raw_Material`** | metres per SKU | Creator | yes |
| **`Raw_Material_Lot`** | metres per tone, per state | Creator | yes |
| **`Fabric_Piece`** | length × count per lot, per state | Creator | yes |

Five pieces of 5.00 m is one `Fabric_Piece` row (`Piece_Length_Cm = 500`, `Piece_Count = 5`), a lot
holding `Wash_Quantity = 25`, and a `Raw_Material` total of 25 Mtr. When the sync lands, Inventory
shows **25 Mtr** and never learns there are five of them.

Each layer is a **maintained sum of the one below it**, written in the same pass by the same
function — not a derived roll-up. That is the rule [lots.md:97](lots.md#L97) already set for the
lot-to-parent total, and the reason is unchanged: recomputing a sum per material on every screen
load is a query per material, which is the road to the statement-execution limit — the failure that
is **not catchable** and shows as a bare 500.

The reconciliation identity therefore holds exactly as written, with one new term:

```
Raw_Material total (per SKU)          [and, later, Inventory on-hand]
    = SUM over that SKU's lots of ( Unwash + In_Wash + In_Print + Wash + In_Transit + Disputed )
```

and for a lot whose `Form` is `Pieces`, each of those metres figures is itself
`SUM over its pieces of ( Piece_Length_Cm × Piece_Count ) / 100`.

**Keeping that identity true is the whole reason the sync can be deferred without cost.** Inventory
is not written in this build, but the number it will eventually own is already being maintained
correctly, so the sync becomes a push of a figure that is right rather than a reconstruction of one
that is not.

> **The metres figure for a printed SKU overstates what is cuttable, and that is correct.** Ten
> 3.00 m pieces really are 30 m of cloth; they simply cannot all be cut at a 55 cm length. The same
> is already true of the tail on every roll in the building. The SKU total is a valuation and
> procurement figure — **nothing plans a cut off it**, and nothing ever should. The allocator reads
> the pieces.

**Where this can drift, and the one guard.** Editing a `Fabric_Piece` by hand in a Creator report
will not update its lot, and the lot is what the allocator reads.
[reconcileRawMaterial.dg](../deluge/reconcileRawMaterial.dg) already checks lot-versus-parent; it
gains a piece-versus-lot check on the same run. Report the difference, never silently correct it —
the drift is always caused by something worth knowing about.

**`Unallocated_Qty` gets one step longer for a printed SKU.** Once Inventory owns the total, cloth
bought ready-printed arrives as a SKU total with no tone *and no piece breakdown*. The inward screen
must take both before it can be drained, or the allocator is handed metres it cannot cut. Nothing to
build today — `Unallocated_Qty` is still always zero — but it is the reason the piece list must be
the finest grain and not an annotation on a metres figure.

## New forms

### `Fabric_Piece`

One row per (lot, length, state) generation event. **Never merged into a running total** — same
reasoning as `Waste_Master`: FIFO comes from `Added_Time`, and merging identical sizes destroys the
provenance that makes ageing and costing answerable.

| Field link name | Type | Notes |
|---|---|---|
| `Material` | Lookup → Raw_Material | |
| `Lot` | Lookup → Raw_Material_Lot | |
| `Piece_Length_Cm` | Decimal | along the roll |
| `Piece_Width_Cm` | Decimal | **stored, not derived** — the piece is a physical thing and the SKU's width may be edited later |
| `Piece_Count` | Decimal | always written as a whole number |
| `State` | Dropdown | `Unwash` / `In_Wash` / `Wash` |
| `Piece_Status` | Dropdown | `Available` / `Disputed` |
| `Carton_Number` | Single line | which box to walk to |
| `Print_Job` | Lookup → Print_Job | provenance |
| `Remarks` | Multi Line | |

A row at `Piece_Count = 0` is spent; it needs no status of its own. `Disputed` does, for the reason
`Waste_Master` needed it — a row the store found none of must be invisible to both the receipt list
and the allocator.

### `Print_Job`

One record per run.

| Field link name | Type | Notes |
|---|---|---|
| `Plain_Material` | Lookup → Raw_Material | |
| `Plain_Lot` | Lookup → Raw_Material_Lot | the tone that went out |
| `Printed_Material` | Lookup → Raw_Material | resolved from `Print_Base` + `Pattern`, or minted |
| `Printed_Lot` | Lookup → Raw_Material_Lot | **created at return, not at send** |
| `Printer` | Lookup → Third_Party | |
| `Source_State` | Dropdown | `Wash` / `Unwash` — which counter it came off |
| `Metres_Sent` | Decimal | `SUM(Send_Lines: Piece_Length_Cm × Piece_Count) / 100`, stored |
| `Metres_Returned` | Decimal | set at receipt |
| `Sent_On` / `Returned_On` | Date | |
| `Job_Status` | Dropdown | `At_Printer` / `Received` / `Cancelled` |
| `Remarks` | Multi Line | |
| `Send_Lines` | Subform | what was cut and sent |
| `Receive_Lines` | Subform | what came back |

**One plain lot per job.** Two lots in one run come back as one printed lot of mixed tone, which is
the defect lots exist to prevent and which nothing downstream could then separate.

**Piece length varies within a run**, so both sides are subforms rather than a length and a count on
the header:

| `Send_Lines` / `Receive_Lines` | Type | Notes |
|---|---|---|
| `Piece_Length_Cm` | Decimal | |
| `Piece_Count` | Decimal | whole number |
| `State` | Dropdown | **`Receive_Lines` only** — `Wash` / `Unwash`, what came back |

Two subforms rather than one edited twice: lengths change between the two (cloth shrinks), counts
drop (the printer ruins pieces), and the send record is what the return is checked against. Merging
them would overwrite the only evidence of what actually went out.

> **`Job_Status`, not `Status`.** Six forms already share the link name `Status`, and CLAUDE.md
> records that a grep for `.Status = "` mixes all of them. Do not add a seventh.

Underscored values because the widget maps them to labels — the rule from CLAUDE.md: *raw value
reaches the screen → spaces; widget maps it to a label → underscores.*

## Changes to existing forms

| Form | Field | Why |
|---|---|---|
| `Raw_Material_Lot` | `Form` | Dropdown `Roll` / `Pieces`. Default `Roll`; every existing lot is one |
| `Raw_Material_Lot` | `In_Print_Qty` | Decimal. Cloth at the printer — off the rack, still ours |
| `Raw_Material_Lot` | `Source_Lot` | Lookup → Raw_Material_Lot. Which plain tone this print lot came off |
| `Raw_Material_Lot` | `Print_Job` | Lookup |
| `Raw_Material` | `In_Print_Qty` | Decimal. The parent mirror |
| `Raw_Material` | `Print_Base` | Lookup → Raw_Material, on the **printed** SKU: the plain SKU it is printed from |
| `Material_Issue.Issue_Lines` | `Fabric_Piece` | Lookup. Which piece row crossed the counter |
| `Material_Issue.Issue_Lines` | `Pieces` | Decimal. How many of it |

`Raw_Material.Pattern` already exists and already reads values like `Block Print`. It stays the
pattern name; do not add a second field for the same fact.

**`Print_Base` is what makes the plain→printed link navigable in both directions**, and without it
no screen can say *"there is no printed stock, but there is plain cloth to print"*.

> **Watch the name `SKU`.** On `Raw_Material` it is a **text** field holding the code; on
> `Waste_Master`, `Material_Exception` and friends it is a **Lookup → Raw_Material**. Same link name,
> two different things, and the printing code touches both. Attribute by the variable in front of the
> dot before trusting it — the same rule CLAUDE.md already gives for `Status`.

## Minting a printed SKU

**A printed material is identified by `Print_Base` + `Pattern`, and that pair is unique.** The plain
SKU already carries width, colour, GSM and quality, so *"a pattern on a width that does not exist
yet"* is simply *"this pair has never been printed"* — one rule instead of a list of attributes to
compare, and the width invariant falls out of it rather than being enforced on top of it.

When the send form is given a plain lot and a pattern it resolves the pair. If nothing matches, it
offers to create it — **explicitly, showing the code and the name before anything is written.** Not
silently: this is permanent master data, it is the join key Inventory will use later, and nothing in
this repo has ever inserted a `Raw_Material` record before.

### What the new record inherits

Everything that describes the cloth comes from the plain SKU, unchanged:

| Field | From |
|---|---|
| `Fabric_Width_Inches` | **the plain SKU, copied** — this is the width invariant |
| `Name` | the plain SKU — the name part alone |
| `Design_Name` | the plain SKU — **inherited, not replaced** |
| `Type_field`, `GSM`, `Quality`, `Color`, `Unit` | the plain SKU |
| `Is_Fabric` | `true` |
| `Pattern` | the chosen print pattern |
| `Material_Display_Name` | composed — see below |
| `Print_Base` | the plain SKU |
| `SKU` | the next free `RM-` number |
| every quantity field | `0` — stock only ever arrives through a print receipt |

### The display name is composed, and the print is a part of its own

`Name`, `Design_Name`, `Color` and `Pattern` each hold **one fact and no separator**.
`Material_Display_Name` is the composition, and it is the only place `" / "` belongs:

```
<name>         / <design> / <colour> / <pattern>
Grey Sheeting  / Plain    / Grey                  ← the plain cloth
Grey Sheeting  / Plain    / Grey     / BP Flower  ← printed off it
```

A printed SKU reads as its base plus the print, which is what it physically is.

> **Two wrong versions were shipped here, and the second is the instructive one.**
>
> The first read `Material_Display_Name` and appended the pattern to it — so the whole composed
> string landed in `Name`, and `Design_Name` was never written at all.
>
> The second **replaced** the design part with the pattern (*Grey Sheeting / BP Flower / Grey*),
> on the reasoning that the convention had three parts and the print belonged in the design slot.
> That is wrong because **`Design_Name` is inherited**: the base cloth is still plain, so every
> print off one base would compose to the same display name and the SKUs could not be told apart on
> any screen. The print is a **fifth** fact, not a substitute for the third.
>
> Compose from the parts, append each only when it is non-empty, and a material missing one of them
> still reads cleanly instead of carrying a dangling separator. `Name` falls back to the first
> segment of the display name only when the field was never filled.

**The width is copied, not referenced.** A lookup would let someone edit the plain SKU's width years
later and silently rewrite the cutting maths for printed cloth already on the rack, which is the
`Phase_Name` snapshot argument in a different costume.

### The SKU code

Next free `RM-` number, zero-padded to the existing width (`RM-00113`). Derived by scanning
`Raw_Material`, parsing the digits after the prefix, taking the maximum and adding one; codes that
do not match the pattern are skipped rather than guessed at.

A fetch-all of `Raw_Material` is the **acceptable** kind of scan — `docs/scaling.md` records that
master-data fetch-alls are fine and that it is the transactional forms that get slowly worse. This is
20–40 records, not every plan ever created.

Re-check for a collision before inserting anyway. The scan and the insert are not atomic, and there
is no `break` in Deluge to make them so.

### Two guards, both server-side

A Custom API is callable from anywhere, so neither of these can live only in the widget — the same
reasoning that put the `Lot_Number` uniqueness check inside
[saveStockInward.dg:180](../deluge/saveStockInward.dg#L180) as well as on the screen.

1. **The pair must be unique.** Two records with the same `Print_Base` and `Pattern` split one
   material's stock across two SKUs, and every screen then shows half of it.
2. **`Print_Base` must be a fabric, and must not itself be printed.** Printing a printed SKU would
   chain `Print_Base` and make the plain-cloth question unanswerable.

### The pattern list is a picklist, and it now keys a SKU

`Raw_Material.Pattern` stays a Dropdown — no pattern master. Two consequences to hold onto, because
this is the same debt the stage names already carry and it is now load-bearing in a new way:

- **Renaming a choice orphans every printed SKU created under the old name.** The pair is the
  identity, so the old name is a snapshot. Add choices; do not rename them.
- **The widget needs the same list and cannot read a Creator picklist.** It carries a
  `PRINT_PATTERNS` constant, in exactly one place, and **it is updated in the same pass as the
  Creator dropdown** — the rule CLAUDE.md already states for adding a status to a function.

## Sending

New **Print** tab on the store widget. Two lists: what is at the printer, and a send form.

Pick plain material → its lots with balances → **Wash or Unwash** → pattern → printer → piece length
→ count → Send.

The pattern resolves the printed SKU through `Print_Base` + `Pattern`, or offers to mint it — see
*Minting a printed SKU* above. That step sits before the quantities on the form, because a new SKU is
a decision and typing metres against a material that does not exist yet is not.

```
send      plain lot   Wash_Quantity or Unwash_Quantity  −Metres_Sent
                      In_Print_Qty                      +Metres_Sent
```

Same two-step shape as the wash flow, and for the same reason [lots.md:750](lots.md#L750) gives:
**cloth at the printer is not cloth on the rack.** Without the middle counter the metres stay
counted as available, the issue screen offers cloth that is not in the building, and every shortfall
is measured against it.

The parent `Raw_Material` mirrors both moves in the same pass, so the SKU total never changes at
send — the cloth is still ours, it has only moved state. That is the same rule that keeps the issue
at [issueMaterials.dg:730](../deluge/issueMaterials.dg#L730) from being a consumption, and it is why
the deferred Inventory post belongs at **return** rather than here.

### The lines are a length and a count, and nothing else

He is cutting full-width pieces off the roll. The only thing that varies is how long each one is, so
a line is **a piece length and how many of them**, and he can add as many different lengths as he
likes. The screen totals the metres and holds it against the lot:

```
Send lines                             total
  3 × 300 cm                            9.00 Mtr
  4 × 275 cm                           11.00 Mtr
                                       20.00 Mtr of 42.60 on L1
```

Two hard limits, both server-side: `Metres_Sent` cannot exceed what the chosen counter of the chosen
lot holds, and every line needs a positive length and a whole count.

The cloth left on the roll — too short to make another piece — simply stays there. There is no loss
to record at send.

> **A cut-length scorer was built here and removed. Do not put it back.** It asked for the panel
> length the printed cloth would eventually be cut at and showed, per line, the marker rows a piece
> would yield and the tail it would strand — 3.00 m and 2.75 m pieces both give 5 rows of a 55 cm
> panel, so the extra 25 cm on each 3.00 m piece is dead.
>
> The arithmetic was right and the feature was wrong, twice over. **Printing is to stock**, so at
> send time there is no cut length — that cloth may serve several garments at different panel sizes,
> and the screen was asking him to guess one. And **the piece length is fixed by the printer's
> table**, so it was advising on a number that was not his choice to make.
>
> Nothing is lost by dropping it: the real yield is computed at **issue**, per piece, by the
> allocator's `remnantYield` — where it is a fact about cloth that exists rather than a guess about
> cloth that does not.
>
> This is the third time in this codebase that extra structure on a store screen has been added and
> then rejected, after the four-column lot table and the shortfall summary. The rule it keeps
> proving: **one row per physical thing, every column meaning the same on every row.**

## Receiving

**The length is not an input.** A piece comes back the length it left — printing does not shorten
cloth — so the receive screen shows one **fixed** row per size that went out, and the only thing he
decides is **how many of that size came back**, plus whether each is washed or greige and which
carton it went into. He cannot add a size, remove a row, or edit a length.

That single decision makes the whole thing safe:

- **The shortfall is whole pieces** — the counts on `Send_Lines` against those on `Receive_Lines`. The
  screen says it in pieces first, *"1 piece short — 3 Mtr written off"*, because *3 metres* is not
  something you can take to a vendor and *one piece* is.
- **Over-return is impossible by construction, not by a check.** `receiveFromPrint` takes the length
  from its own `Send_Lines` and ignores the payload's copy, and caps the count at what that row sent.
  A Custom API is callable from anywhere; a payload naming its own lengths could otherwise book
  printed cloth that no plain cloth ever paid for. The payload's length is still sent and still
  compared — a mismatch means a stale screen and is refused with that message.
- **A zero row is a record, not a blank.** A size that came back as nothing still writes a
  `Receive_Lines` row at zero, so the two subforms line up and the missing piece reads as a size that
  was checked rather than one nobody looked for. It writes **no** `Fabric_Piece` — an `Available` row
  holding zero pieces is the phantom `Waste_Master` had to grow a `Disputed` status to avoid — and it
  needs no carton, because it sits on no shelf.

- Create or top up the printed lot — `Form = Pieces`, `Source_Lot` = the plain lot, `Lot_Number`
  **typed by the store person**, exactly as any other lot. Not derived from the job: the number has
  to match what is written on the cloth, and no rule we invent would.
- Insert the `Fabric_Piece` rows, with their carton.
- Plain lot and parent: `In_Print_Qty −Metres_Sent`.
- Printed lot and parent: `Wash_Quantity` or `Unwash_Quantity` `+Metres_Returned`.
- `Job_Status = Received`.

**`Fabric_Piece.Piece_Width_Cm` is written from the printed SKU's own width**, which was copied from
the plain SKU when the material was minted. The whole design rests on the pieces being full width, so
a return that is visibly narrower is a `Waste_Master` remnant and not printed stock — booking it as
the latter puts cloth in front of the allocator that cannot yield what the allocator will think it
can. This is the second half of *while issue, plain and printed must be the same width*: minting
copies it, receipt stamps it, and by the time the issue screen reads it there is nothing left to
check.

### Recording the loss

`Metres_Sent − Metres_Returned` is real loss, and because the length cannot change it is **whole
pieces** — ones the printer lost or ruined. It is written off against the plain SKU: the plain lot's
`In_Print_Qty` clears by the full amount sent, the printed lot rises by what came back, and the
difference simply ceases to exist. That is correct — the cloth is gone — but it happens silently, so
the screen makes him confirm it before the receipt is saved.

**Nothing derived is stored on the job header.** Metres lost is `Metres_Sent − Metres_Returned`, both
already on the record. Pieces sent and pieces returned are sums over `Send_Lines` and `Receive_Lines`.
Every one of them is a second copy of a fact that already exists, and every one goes stale the moment
somebody edits a subform row in Creator — with nothing on the record to say the header and its lines
now disagree.

> **`Pieces_Sent` / `Pieces_Returned` header fields were written and then removed.** The argument for
> keeping them was that a Creator report cannot total a subform. It does not hold up: the loss in
> **metres** is already reportable off the two header fields, no code anywhere read the piece-count
> ones, and `receiveFromPrint` walks `Send_Lines` for the figure regardless. Add them back only if a
> report genuinely needs pieces — and populate them *from* the lines rather than in parallel with
> them.

It is **not** a `Stock_Dispute`: that model is store↔supervisor and has no vendor direction, so there
is nobody for it to be raised against.

> **A run that comes back with nothing at all cannot be received.** Every line at zero is refused,
> because there is no lot to create and no piece to book. **Cancel** is not the answer either — that
> puts the metres back on the plain lot, and cloth the printer lost is not cloth on the rack.
> Unbuilt: it needs a `Written_Off` job status that clears `In_Print_Qty` without crediting anything.
> Rare enough to leave, common enough to name.

### Cancelling a job

Cloth that goes out and comes back unprinted has to be put back, or it sits in `In_Print_Qty` for
ever and the SKU total is right while nothing can be issued off it. `Job_Status = Cancelled` reverses
the send exactly: `In_Print_Qty −Metres_Sent`, and the metres return to **the counter they came off**
— which is what `Source_State` is stored for. No printed lot is created and no printed SKU is minted.

**Cancel is only reachable from `At_Printer`.** A received job has already moved the cloth into
another material and there is nothing left to give back; reversing it would invent plain cloth out of
printed. Same forward-only shape as the plan-to-order status mirror.

### Inventory — designed, not built

**Nothing posts to Inventory in this build.** The quantity moves in Creator and stops there. Written
down now so the shape is fixed while the reasoning is fresh, and because the receipt is the one place
it will hook in:

| Event | Will post |
|---|---|
| Send to printer | **nothing** — still ours, sitting in `In_Print_Qty` |
| Print job received | plain SKU **−`Metres_Sent`**, printed SKU **+`Metres_Returned`**, one reference |

It would be the **first *conversion* in the posting map** — every entry in
[inventory-integration.md:57](inventory-integration.md#L57) today is a receipt or a consumption. Two
adjustments under one `Print_Job` id, through `Inventory_Post_Queue`. The two figures differing *is*
the loss, and it is right that it shows.

> **A Creator-minted printed SKU has no Inventory item, and `mapInventoryItemIds` will report it as a
> miss.** That is expected, not a fault — the item does not exist there yet. It becomes real work at
> sync time: either the items get created by hand before the first pull, or
> [mapInventoryItemIds.dg](../deluge/mapInventoryItemIds.dg) grows a create branch. Whichever, it is
> that phase's problem and not this one's. What matters here is that the SKU code is generated the
> same way every other one is, so the join key is sound when it is needed.

## Issuing printed fabric

The requirement row is an ordinary fabric row and the screen looks the same. Only `lotFill` learns
anything new.

### The allocator

`lotFill` keeps step 1 — remnants, least waste per cut — unchanged; a printed lot has offcuts of its
own like any other. Step 2 branches on **`lot.form`, where anything other than `Pieces` — including
blank — is a `Roll`**:

| `lot.form` | fresh cloth comes from |
|---|---|
| `Roll` | `floor(metres × 100 / cutLength)` rows, the existing code moved verbatim |
| `Pieces` | the same least-waste loop over `pieces[]`, scored with `remnantYield`, and **`metres` is zeroed** so there is no budget left for anything to spend twice |

Pieces are credited to `fromFresh` and `metresPer`, **not** to `fromWaste`: this is raw material, it
must land in `Pieces_From_Raw`, and it must never appear on a waste screen or in the scrap report.
Each lot line carries the pieces it took, so the server is *told* rather than left to re-derive.

A per-card **`pieceLeft`** ledger sits beside `wasteLeft` / `lotLeft` / `greigeLeft`, seeded and spent
the same way — one Issue press serves a whole card, so two orders on it must not be offered the same
physical piece.

`chooseLotForOrder` and `orderMetres` need no change at all — the first ranks on the lot's maintained
totals, the second is lot-blind by design.

> **Greige pieces are excluded even from the after-washing simulation**, which is deliberately not
> what a roll does. There is no way to wash a piece yet: a `Wash_Request` moves a lot's metres between
> two columns and would leave `Fabric_Piece.State` saying `Unwash` while the lot claimed washed
> metres — the header and its pieces disagreeing. Offering a wash the store cannot perform is worse
> than saying the row is short. `lotGreigePieces` exists so the row can name them rather than hide
> them. Take the greige flag in `lotPieces` when phase 3 lands.

### `issueMaterials` — the one line the feature exists for

```
rowsIssued    = floor(thisQty * 100 / cutL)
piecesFromRaw = perRow * rowsIssued          ← WRONG on a stack of pieces
```

Three 3.00 m pieces are 9.00 m; against a 55 cm cut that divides to 16 marker rows where the pieces
yield 15. So for a pieces pass, **both** figures are replaced by ones summed per piece:

- `thisQty` becomes the pieces' own metres, and is **not** snapped down to whole marker rows — a
  piece goes out whole, and there is no such thing as 0.20 m of one to leave behind
- `piecesFromRaw` becomes `Σ floor(W/cutW) × floor(L/cutL) × count`

Every piece named in the payload is **re-read off `Fabric_Piece`** and refused — never trimmed — if it
is on another lot, not `Available`, greige, or short of the count claimed. Then the rows are
decremented, because on a `Pieces` lot the metres that just moved are the maintained sum of exactly
those rows.

### On the row

Because he must fetch physical pieces, the lot line says which ones — carton first, the same way the
remnant lines already read:

```
Linen / Block Print / Wiltshire Green     8.25 Mtr    [x]  8.25  Mtr
RM-00112                                              P4 · 3 pieces of 2.75 m · carton C-7
```

Two rows join the short-reason table in
[lots-issue-redesign.md:150](lots-issue-redesign.md#L150). One line, one action, and only when the
row is actually short:

| Why it is short | The line | Button |
|---|---|---|
| the printed lot's pieces are greige | `P4 · 5 pieces to wash` | **Send to wash** |
| no printed stock of this pattern | `No printed stock — 120 Mtr of plain on L2` | **Print…** |

The second is why `Print_Base` exists. Printing is to stock, so the button is a shortcut into the
Print tab rather than an order-driven action — but a row that goes blank while plain cloth sits on
the rack is exactly the silent state that redesign was written to kill.

## Washing pieces

Choosing to send *and* receive in either state means **`Wash_Request` has to learn pieces**, and
that is the largest single cost of that decision. On a `Pieces` lot a wash request names pieces —
which length, how many — and moves them `Unwash → In_Wash → Wash`, flipping `Fabric_Piece.State`
rather than moving a metres figure between two columns.

Completion must let him **correct the length**, because washing shrinks cloth and the piece list is
the thing the cutting is simulated against. A stale length is not a rounding error here; it is the
allocator promising a marker row that will not fit.

Until this lands, greige printed pieces are visible and are correctly refused by the allocator —
which is the existing rule working, not a bug.

### Receipt needs no change, and the reason is worth stating

The supervisor confirms **metres**, exactly as he does for a roll, and that is exact rather than
approximate: whole pieces at a fixed length give a figure with nothing rounded in it.
`receiveMaterials` settles the lot's `In_Transit_Qty` by the same metres that were raised, so nothing
about the pieces path reaches it.

### A dispute on a pieces lot — refused, not guessed at

`Store_Correction` means *the cloth never left the shelf*, so the metres go back onto the lot. On a
roll that is just metres returning to the roll. On a **`Pieces`** lot the metres are the maintained
sum of its `Fabric_Piece` rows, so adding to `Wash_Quantity` alone would leave the lot claiming cloth
that no piece backs — and the allocator reads the **pieces**, not the header, so it could never find
it. The header and its pieces disagreeing is the fault this whole design is built around.

`resolveDispute` therefore **refuses** `Store_Correction` on a pieces lot, before anything is written,
and says what to do instead:

> Lot P1 is printed cloth held as pieces, and pieces cannot be put back by metres. Record which pieces
> came back on the lot first, then resolve this as **Found**.

Restoring properly means naming which physical pieces came back, and the dispute record cannot know —
it carries metres. Inventing a piece of some assumed length would put cloth on the rack nobody ever
cut, which is worse than a dead end that states its own remedy.

**Every other outcome is unaffected.** `Found`, `Denied` and the `Lost` write-off only ever *reduce*
`Disputed_Qty`, and reducing needs no piece to back it.

> **The proper fix is a design decision, not a coding one**, which is why it is a refusal today. It
> needs the handover to record which pieces crossed the counter, and a single `Issue_Lines.Fabric_Piece`
> lookup cannot hold a pass that took two different piece rows. The honest shapes are a
> `Piece_Movement` form mirroring `Waste_Movement`, or one issue line per piece. Decide that before
> printed cloth is issued to somebody who might come back short.

## What NOT to do

Each of these is a real trap, and the first two are the tempting ones.

1. **Never hold printed stock as metres alone.** It is the whole problem, and it fails silently.
2. **Never reuse `Waste_Master` for printed pieces.** It works perfectly — `remnantYield` handles it,
   `wastePicks` issue it, the receipt and dispute paths already exist — and it corrupts
   `Pieces_From_Waste`, the scrap report, the reuse reporting and every waste screen, which would
   then list brand-new printed cloth as offcuts in offcut green. The *algorithm* is worth reusing;
   the *form* is not.
3. **Never reduce the plain lot without raising `In_Print_Qty`.** The wash flow already learned this.
4. **Never mint a printed SKU silently.** It is permanent master data and a future join key; the
   store person confirms the code and the name before it is written.
5. **Never reference the plain SKU's width instead of copying it.** Editing the plain material later
   would rewrite the cutting maths for printed cloth already on the rack.
6. **Never add a seventh `Status`.**
7. **Never book a narrower return as printed stock.** Full width is the premise, so it is checked.

## The function contract

Four Custom APIs. Fixed here so the widget and the functions cannot drift, and so the pieces can be
built independently. Every id is a **string** in every payload, in both directions — 18-digit ids
break `JSON.parse` on the widget side. Every response is hand-built JSON; `Map.toString()` does not
emit valid JSON once the structure nests.

Failure is always `{"success":false,"error":"…"}` on the writers and `{"errors":["…"]}` on the
reader, with the real message inside — Creator reports every runtime failure to a widget as a bare
`code 9430`, so an uncaught throw is a debugging dead end.

### `getPrintData()` — read side

```
{ "errors":[],
  "patterns":[ "Plain", "Block Print" ],
  "plain":   [ {"id","name","sku","pattern","widthCm",
                "lots":[{"lotId","lotNumber","label","wash","unwash","inPrint","blocked"}]} ],
  "printed": [ {"id","name","sku","baseId","pattern","widthCm",
                "lots":[{"lotId","lotNumber","label","wash","unwash","inPrint","blocked"}]} ],
  "printers":[ {"id","name"} ],
  "jobs":    [ {"jobId","plainName","plainSku","plainLotNumber",
                "printedMaterialId","printedName","printedSku",
                "printerName","sourceState","metresSent","sentOn","status",
                "lines":[{"lengthCm","count"}]} ] }
```

`plain` is fabric with no `Print_Base`; `printed` is fabric that has one. **Both carry their lots, in
the same shape** — the receive form has to offer the printed material's existing lots so a second run
of the same tone can top one up instead of minting a lot per job. `jobs` carries
`printedMaterialId` for exactly that lookup.

`jobs` is `At_Printer` only — received and cancelled jobs belong to history, not to a screen whose
job is *what is out*.

**`patterns` is every `Pattern` value actually sitting on a fabric material**, deduped
case-insensitively and unsorted. Deluge cannot read a Dropdown's *choices* — there is no API for it —
so the widget also carries a `PRINT_PATTERNS` constant mirroring the Creator field. That constant is
hand-maintained and therefore always a step behind, and while it is empty the pattern select is empty
and **nothing can be sent at all**. What Deluge *can* read is the values on records, and the material
loop is already walking every one of them, so the choices in use come back for free. The constant
becomes a top-up for a choice no material carries yet, rather than the only source.

`plain` carries its own `pattern` so the send form can drop it from the options: offering to print
*Grey Sheeting / Plain / Grey* in **Plain** would mint a nonsense SKU.

The widget sorts the union of its three sources, so nothing is sorted on this end.

> Two Deluge collection calls worth knowing, both learned by Creator refusing to save:
> **`List.set(i,v)` does not exist** — *"Not able to find 'set' function"*, reported against the
> assignment. Append keys to a list and test with `.contains()` instead, which is what
> `receiveFromPrint` does to stop one send row being answered twice.
> **`.sort(true)` is the proven form**, used by `saveItemCheck` and `sendToThirdParty`; the bare
> `.sort()` is not. `List.get(index)` is fine — `sendToThirdParty` reads `seqList.get(0)`.

> **No demand figure, deliberately.** The run-size context would need outstanding pieces per printed
> SKU, and `docs/scaling.md` records that **nothing ever scans `Material_Requirement`** as a property
> that is already correct and must not be "fixed". The Print tab shows the figure only when the Issue
> tab has already been loaded and its payload is in memory, and says nothing otherwise. A nicety is
> not worth a new full-form scan on the hot path.

### `sendToPrint(string payloadJson)`

```
{ "plainMaterialId":"123", "plainLotId":"901", "sourceState":"Wash",
  "pattern":"Block Print A",
  "printedMaterialId":"",          // empty => mint from (plainMaterialId, pattern)
  "printerId":"77",
  "lines":[ {"lengthCm":300,"count":3}, {"lengthCm":275,"count":4} ],
  "remarks":"" }

→ { "success":true, "jobId":"…", "printedMaterialId":"…", "printedSku":"RM-00113",
    "printedName":"…", "minted":true, "metresSent":20.00,
    "lotWash":22.60, "lotUnwash":0, "lotInPrint":20.00, "materialInPrint":20.00 }
```

`minted` is echoed back so the screen can name a SKU it has just created. The lot balances come back
for the same reason `saveStockInward` returns them — the screen states what it did rather than
re-fetching and hoping.

### `receiveFromPrint(string payloadJson)`

```
{ "jobId":"555",
  "lotId":"",                      // empty => create a new printed lot
  "lotNumber":"P1", "lotLabel":"", // new lot only; TYPED, unique within the printed material
  "lines":[ {"lengthCm":298,"count":3,"state":"Wash","carton":"C-7"} ],
  "remarks":"" }

→ { "success":true, "printedLotId":"…", "lotNumber":"P1",
    "metresSent":20.00, "metresReturned":19.85, "loss":0.15,
    "lotWash":19.85, "lotUnwash":0, "pieceRows":1 }
```

### `cancelPrintJob(string payloadJson)`

```
{ "jobId":"555", "reason":"printer returned it unprinted" }

→ { "success":true, "restoredTo":"Wash", "metres":20.00,
    "lotWash":42.60, "lotInPrint":0 }
```

## Build order

Each phase is useful on its own and nothing breaks between them.

| | | Leaves you with |
|---|---|---|
| 1 | Forms, printed-SKU minting, `sendToPrint`, `receiveFromPrint`, `cancelPrintJob`, `getPrintData`, the Print tab | printed stock exists in Creator, is correct and is visible — not yet issuable |
| 2 | `getStoreMaterialRequirements` emits `form` + `pieces[]`; the `lotFill` piece path and its `pieceLeft` ledger; `issueMaterials` consuming named pieces; the store row naming which pieces to fetch | printed fabric is issued |
| 3 | `Wash_Request` on a `Pieces` lot | greige printed pieces become usable |
| 4 | the full-width remainder after cutting goes back into the printed lot as a shorter piece — `getExpectedWaste`, `saveWasteFromCutting` | reuse closes, per `waste-master.md`'s own *width unchanged = raw material* rule |
| — | the two Inventory adjustments | **deferred with the rest of the sync** |

Phases 1 and 2 are the feature. Phase 3 is only needed because greige can come back — if in practice
they always send washed cloth and get washed cloth back, it disappears. Phase 4 is the one that can
slip longest: until it lands, a full-width remainder has nowhere honest to go and the supervisor will
declare it as an ordinary offcut.

## Deliberately not done

- **No Inventory posting.** Decided: everything stays in Creator for this build. The identity above
  is maintained so the sync is a push, not a reconstruction.
- **No printer disputes.** `Stock_Dispute` is store↔supervisor and has no vendor direction. A short
  return is recorded as loss on the job.
- **No cost per print run.** Costing lives in Inventory, which does not know print jobs exist.
- **No pattern master.** Decided: `Raw_Material.Pattern` stays a Dropdown, mirrored by a
  `PRINT_PATTERNS` constant in the widget. This joins the stage-name picklist debt already recorded
  in CLAUDE.md, with one addition specific to printing — **a pattern name is now half of a SKU's
  identity, so choices are added and never renamed.** When patterns need attributes of their own, the
  argument for a master is the same one the stage master already has.
- **No print planning.** Printing is to stock; nothing recommends a run size on a schedule. The send
  form's suggested count is computed live from demand and stored nowhere.
- **Pieces on non-printed fabric.** A `Roll` lot stays a `Roll` lot. Nothing forces plain cloth into
  the piece model, and nothing should until there is a reason.

## What has and has not been verified

**Phase 1 is written.** `sendToPrint`, `receiveFromPrint`, `cancelPrintJob`, `getPrintData` and the
store widget's Print tab.

**The widget is tested.** `app/js/main.js` is loaded in a stub DOM with `vm` and exercised with 42
assertions: the job card's piece total and source lot, the receive form prefilling from the send
lines and defaulting to the state that went out, the loss figure when the printer returns short, a
blocked lot **named but never offered**, the pattern list picking up an in-use pattern, the SKU note
distinguishing an existing pair from a mint, the tail scoring (3.00 m stranding 25 cm at a 55 cm cut
and 2.75 m stranding nothing), availability following the **state selector** rather than the material
total, the over-draw guard, fractional and zero-length lines refused, the carton requirement on
receipt, and the case-folded lot-number clash.

**No Deluge has been run, and none of it can be from here.** All four `.dg` files pass a
comment- and string-aware pass checking brace/paren balance, the loop-variable/scalar clash, inline
`sort by`, `break`, `.size()` on a query result, a comment above the signature, and the
returns-only-inside-try trap — the faults Deluge reports at the wrong line. That is a text-level
check and nothing more. `getPrintData`'s hand-built JSON was additionally extracted by hand and
parsed. **Every function needs a Creator Execute.**

**The forms do not exist in Creator yet**, so none of this can even save until they are created —
see the deployment list below. Two things to watch on the first Execute:

- **`Raw_Material.Name`.** Eight functions in this repo read it as plain text, so it is a single line
  field in practice. `sendToPrint` sets it *after* the insert rather than inside the block, so if it
  turns out to be a composite Name type the mint still succeeds with its display name.
- **Dropdown choices must be typed exactly as the code compares them.** A choice that differs by a
  space or an underscore fails silently and the record simply is not found by any query — the failure
  mode CLAUDE.md records for `Item_Status`.

## Deploying phase 1

Read in order. **The steps are ordered because the lookups are circular** — `Print_Job` points at
`Raw_Material_Lot` and `Raw_Material_Lot` points back at `Print_Job`, so one of them has to be created
without its lookup and given it afterwards. Every field name below is taken from the source, not from
the prose above.

Field link names are what the code compares. Creator auto-underscores a *field* link name from its
display name but **never touches a Dropdown's choices** — type those exactly as written here.

### Three settings that apply to every field below

**Nothing is Mandatory.** Not one field. `sendToPrint` inserts the `Print_Job` with its scalars only
and sets `Plain_Material`, `Plain_Lot`, `Printed_Material`, `Printer` and `Send_Lines`
*afterwards* — a lookup inside an insert block fails the whole block when Creator will not take it,
which is why the code is shaped that way ([sendToPrint.dg:657](../deluge/sendToPrint.dg#L657)). Mark
any of those Mandatory and **every send fails at the insert**, reported against a line nowhere near
the cause.

**Every Decimal gets a default of `0`, 2 decimal places** unless said otherwise. A Creator field that
was never written is EMPTY, not null, and `.toDecimal()` throws on it. The code guards for that
everywhere, so this is belt-and-braces — but it also keeps Creator's own reports readable.

**A count is a Decimal with 0 decimal places, never a Number.** `Waste_Master.Piece_Count` is already
Decimal, and the code compares counts as decimals; a Number field reads back as a long, and
mixed-type comparison throws in Deluge.

### Step 1 — `Raw_Material`, two new fields

| Field link name | Creator type | Settings |
|---|---|---|
| `In_Print_Qty` | **Decimal** | 2 dp, default `0` |
| `Print_Base` | **Lookup** | form `Raw_Material`, display `Material_Display_Name`. Set on the **printed** SKU only |

### Step 2 — `Raw_Material_Lot`, three new fields

| Field link name | Creator type | Settings |
|---|---|---|
| `Form` | **Dropdown** | choices `Roll`, `Pieces` — **default `Roll`** |
| `In_Print_Qty` | **Decimal** | 2 dp, default `0` |
| `Source_Lot` | **Lookup** | form `Raw_Material_Lot` (self), display `Lot_Number` |

> **Existing lots will read EMPTY, not `Roll`.** A default only applies to records created after it.
> Nothing in phase 1 reads `Form`, so this is harmless today — but **phase 2's allocator must treat
> empty as `Roll`**, or every lot on the rack becomes uncuttable the day it ships. Alternatively set
> `Form = Roll` on the existing lots from a report once, which is cleaner.

### Step 3 — new form `Print_Job`

| Field link name | Creator type | Settings |
|---|---|---|
| `Plain_Material` | **Lookup** | form `Raw_Material`, display `Material_Display_Name`. **Not mandatory** |
| `Plain_Lot` | **Lookup** | form `Raw_Material_Lot`, display `Lot_Number`. **Not mandatory** |
| `Printed_Material` | **Lookup** | form `Raw_Material`, display `Material_Display_Name`. **Not mandatory** |
| `Printed_Lot` | **Lookup** | form `Raw_Material_Lot`, display `Lot_Number`. Set at receipt |
| `Printer` | **Lookup** | form `Third_Party`, display `Party_Name`. **Not mandatory** |
| `Source_State` | **Dropdown** | choices `Wash`, `Unwash` — no default |
| `Metres_Sent` | **Decimal** | 2 dp, default `0` |
| `Metres_Returned` | **Decimal** | 2 dp, default `0` |
| `Sent_On` | **Date** | not Date-Time — the code writes `zoho.currentdate` |
| `Returned_On` | **Date** | not Date-Time |
| `Job_Status` | **Dropdown** | choices `At_Printer`, `Received`, `Cancelled` — default `At_Printer` |
| `Remarks` | **Multi Line** | |
| `Send_Lines` | **Subform** | |
| `Receive_Lines` | **Subform** | |

`Send_Lines` subform:

| Field link name | Creator type | Settings |
|---|---|---|
| `Piece_Length_Cm` | **Decimal** | 2 dp, default `0` |
| `Piece_Count` | **Decimal** | **0 dp**, default `0` |

`Receive_Lines` subform:

| Field link name | Creator type | Settings |
|---|---|---|
| `Piece_Length_Cm` | **Decimal** | 2 dp, default `0` |
| `Piece_Count` | **Decimal** | **0 dp**, default `0` |
| `State` | **Dropdown** | choices `Wash`, `Unwash` |

> **Optional but worth it: add `Job_Ref` as an Auto Number.** `Raw_Material_Lot.Print_Job` and
> `Fabric_Piece.Print_Job` are lookups *to* this form, and a Creator lookup shows one field. With no
> name field on `Print_Job` those columns display a raw 18-digit id in every report. No code reads it —
> this is purely so the Creator side is legible.

### Step 4 — back to `Raw_Material_Lot`, one more field

Now that `Print_Job` exists:

| Field link name | Creator type | Settings |
|---|---|---|
| `Print_Job` | **Lookup** | form `Print_Job`, display `Job_Ref` if you added one, otherwise `Sent_On` |

### Step 5 — new form `Fabric_Piece`

| Field link name | Creator type | Settings |
|---|---|---|
| `Material` | **Lookup** | form `Raw_Material`, display `Material_Display_Name` |
| `Lot` | **Lookup** | form `Raw_Material_Lot`, display `Lot_Number` |
| `Piece_Length_Cm` | **Decimal** | 2 dp, default `0` — along the roll |
| `Piece_Width_Cm` | **Decimal** | 2 dp, default `0` — full fabric width **in cm**. Needs the decimals: 60″ is 152.4 |
| `Piece_Count` | **Decimal** | **0 dp**, default `0` |
| `State` | **Dropdown** | choices `Unwash`, `In_Wash`, `Wash` |
| `Piece_Status` | **Dropdown** | choices `Available`, `Disputed` — default `Available` |
| `Carton_Number` | **Single Line** | which box |
| `Print_Job` | **Lookup** | form `Print_Job` |
| `Remarks` | **Multi Line** | optional — nothing writes it yet |

`Fabric_Piece`'s lookups **are** set inside the insert block, so mandatory would be survivable here —
but leave them optional anyway, for the reason above and because phase 4 will write piece rows that
come from cutting rather than from a print job.

### Step 6 — `Raw_Material.Pattern`

The field already exists. **If it is a Dropdown**, add every print pattern as a choice. **If it is a
text field**, the code still works — it compares strings either way — but a Dropdown is what stops a
typo minting a duplicate printed SKU, which is the one failure this design cannot detect on its own.

Whatever the choices end up being, put the same list in `PRINT_PATTERNS` — see step 9.

### Step 7 — four new Custom APIs

| API name | Arguments | Method |
|---|---|---|
| `getPrintData` | **none** | GET |
| `sendToPrint` | one string, named `payloadJson` | POST |
| `receiveFromPrint` | one string, named `payloadJson` | POST |
| `cancelPrintJob` | one string, named `payloadJson` | POST |

**The argument name must be exactly `payloadJson`.** An argument list that does not match makes every
call from the widget fail. Paste each `.dg` and Save, then use Creator's **Execute** — the widget only
ever sees `code 9430`.

### Step 8 — widget files

`app/widget.html`, `app/js/main.js`, `app/css/style.css`. Zip and upload as usual.

### Step 9 — fill in `PRINT_PATTERNS`

At the top of the Print tab section in `app/js/main.js`. It ships **empty**. The select is built from
the union of that constant and every pattern already in use, so nothing breaks — but a pattern that
exists on no printed SKU yet cannot be chosen at all, so the first print of a brand-new pattern needs
it listed there. Update it in the same pass as the Creator dropdown, for ever.

### Order of testing

1. **`getPrintData`** first, on its own — it only reads. If it Executes clean, the forms are right.
2. **`sendToPrint`** against a real plain lot with a pattern that already exists on a printed SKU
   (no minting). Check the plain lot's `Wash_Quantity` fell and `In_Print_Qty` rose by the same amount,
   and that `Raw_Material`'s two figures moved with them.
3. **`sendToPrint`** again with a **new** pattern, to exercise the mint. Check the new `Raw_Material`
   record's SKU, that `Print_Base` points at the plain SKU, and that `Fabric_Width_Inches` was copied.
4. **`cancelPrintJob`** on one of those, and confirm the metres came back to the counter they left.
5. **`receiveFromPrint`** last — it is the only one that creates a lot and pieces.
