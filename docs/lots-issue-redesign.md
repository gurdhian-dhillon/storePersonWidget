# Issuing from lots — the redesign

Agreed 2026-08-17. Supersedes the *Issue* sections of [lots.md](lots.md); everything that
document says about inward, migration, disputes, waste provenance and carton numbers still
stands. **Nothing here is built yet.**

## Why lots exist, in one sentence

> When we buy more of the same SKU, the new cloth can come out a different shade.

That is the whole reason. No cost per lot, no expiry, no location — the carton answers *where*,
the lot answers *which shade*. Everything below is exactly as much machinery as that one fact
needs, and no more.

## The rule

**An order is the atom. It is served whole, off one lot, or it is not served at all.**

- *Cover* means one lot's **washed cloth plus that lot's own offcuts** close **every**
  outstanding piece of an order, across every cut size on it.
- A supervisor's card is **several orders**. A partial issue to a supervisor means *some of his
  orders go complete and the rest go nowhere* — never a fraction of an order.
- If no lot covers even one order on that fabric, **nothing is issued** for it. It goes to wash
  or to purchase.
- The lot is only ever reconsidered later on a **remake or reissue**, and then only when the
  pinned lot has nothing left at all.

### The atom is order × MATERIAL, not the order entire

A shade belongs to one fabric, so an order needing two fabrics picks a lot for each,
independently. An order whose linen is ready but whose thread is not **still gets its linen** —
holding the fabric back would protect nothing, because there is no shade to protect on a cone of
thread.

**Accessories are untouched by all of this.** No lots, no pieces, no atom: they fan by quantity
and are partially issuable exactly as they are today. Only fabric has a shade to keep together.

**A plan row and a remake row of the same order are ONE atom.** They are separate requirement
rows deliberately — a remake must stay visible as a remake — but they are the same order in the
same shade, so what counts is *the order's outstanding pieces at this moment*, wherever they sit.
Both go, or neither does.

The order key is the **plan id**, and that is only sound because one order produces exactly one
plan (CLAUDE.md, `createProductionPlans`). If that ever stops being true, this breaks.

### Why the atom is the order and not the metre

A part-issued order is the thing that pins a shade and then cannot be finished in it. Cloth gets
burned on an order that cannot complete, while the next order — which *could* have completed —
goes without. Making the order the atom puts that failure out of reach rather than guarding
against it, and it retires the whole family of stranded-piece bugs recorded in CLAUDE.md: there
is no longer a per-lot metres budget that can round a last piece out of existence, because the
unit being budgeted is an order and an order is all or nothing.

### All-or-nothing applies to the FIRST issue only

**What the rule protects is the shade decision, and that decision is made once.** Refusing a
partial issue stops an order being committed to a lot that cannot finish it. Once the order *is*
committed — it has a pin, cloth is already cut in that shade — refusing to top it up protects
nothing and costs everything: the order can then never be finished at all.

| The order | On Issue |
|---|---|
| has **no pin** — nothing cut yet | covered whole off one lot, or **skipped** |
| has a **pin** | takes whatever that lot can give today, however little |

Without this, an order that was part-issued under the old rules **deadlocks on day one** — pinned
to a lot that no longer covers its remainder, refused a top-up, and not eligible for the override
either, because the lot is not empty. There will be some of those in the data the moment this
ships.

The per-pass piece budget in `issueMaterials` stays exactly as it is, and it is what makes a
top-up safe: each pass budgets from **the pieces still owed at that moment**, never from a figure
computed once for the whole issue.

## What the store person does

He presses **Issue**. That is the entire interaction.

**He does not see orders.** He sees one row per material per supervisor, a metres figure, and
the lot it comes off. The fan across orders happens underneath.

**The metres box is a consequence, not an input.** It totals the orders that could be closed.
There is nothing to type and nothing to tick — a figure he typed would not be a whole number of
marker rows, and a tick-list of orders would be asking him to arbitrate work he cannot see.

**He is told which lot to walk to, and how much off it.** One line per lot in use, **always
carrying its metres** — including when there is only one lot. Two lots on a row is the allocator
serving two jobs, not a problem, and it is not labelled as one.

> The metres used to be printed only on a split row, because against a single lot they restate the
> box beside them. Observed in use and wrong: the box is computed and read-only now and sits at the
> far right, so a bare `L1` makes him pair a roll with a figure three columns away. Worse, a row
> that went from one lot to two grew a number out of nowhere, which read as the wash having changed
> something it had not. One line, one instruction: which roll, how much.

## How the material is assigned

Automatically, in priority order, skipping what will not fit.

1. Take this supervisor's orders for this material in **`Priority_Key`** order — highest
   priority first, oldest first inside a priority.
2. For each order in turn, find the lots that **cover it whole**, and rank them:
   1. lots that cover it **today**, off the rack — washed cloth plus that lot's own offcuts →
      **smallest** such lot
   2. failing that, lots that cover it **after washing their own greige** → smallest such lot
   3. **greige never counts as available today**, and a lot that cannot cover the order whole is
      never chosen for it
3. Take the cloth off that lot, spend it down, and move to the next order.

**Skip, don't block.** An order that no lot covers is passed over and the fan continues.
Otherwise one impossible order — bigger than any lot on the rack — freezes that fabric for
everybody behind it, permanently.

**Smallest-that-fits**, so big lots stay whole for the big orders that will need them. Nibbling
the largest lot leaves a medium lot where a large one stood and makes the next order likelier to
be short.

> **Priority is approximate and must stay that way.** It comes from the order source — Shopify
> ranks above the rest — and inside a source, age is a nicety. That is fine for deciding **who
> gets served first**, which is a judgement. It is *not* fine as an implicit key that a second
> function re-derives to reconstruct what happened. See *Receipt* below.

### The pin — an order returns to the shade it started in

Unchanged from [lots.md](lots.md), and still the mechanism: `Material_Requirement.Issued_Lot`,
stamped on the first issue, never overwritten, read back per order from **any** line including
settled ones. It covers the remake, the reissue and the second handover with one rule.

Once an order is pinned there is **no choice left** and the screen offers none. The pinned lot
either covers the outstanding pieces — in which case they go — or it does not, and the row says
which of the three things is true (wash it, wait for it, it is finished).

**The lot changes on exactly one condition**: the pinned lot has nothing left in any state — no
washed cloth, no greige, no offcut, nothing at the wash house. Then, and only then, the recorded
override from [lots.md](lots.md) applies: he picks the replacement and must type why.

## What the row says — one problem, one line, one action

**A row that is getting everything it asked for says only which lot to walk to.** Nothing else.
No wash figures, no greige totals, no *"also needed by"*, no *"more than one order on this row"* —
all of it was true and none of it was his to act on, and a screen that explains itself constantly
teaches people to skim the one line that mattered.

```
Linen / Block Print / Wiltshire Green     12.4 Mtr    [x]  12.4  Mtr
RM-00005                                                    L1
```

**A row that is short says exactly one more line, and it is the next thing to do.** Not the
reasoning behind it, not the other lots, not the material's totals — the number and the action:

| Why it is short | The line | Button |
|---|---|---|
| the committed lot has greige | `L2 · 13.2 Mtr to wash` | **Send to wash** |
| that greige is already at the washer | `L2 · 4 Mtr at the wash house` | — |
| the committed lot is finished | `L2 is empty — this was cut from L2` | **Use another lot…** |
| nothing on the rack fits any job | `20 Mtr on L1, smallest job needs 22` | **Buy** |
| the stock that exists is blocked | `18 Mtr on L3 is blocked` | — |
| no lot at all | `Not booked in` | — |
| no cut size or fabric width | `No cut size on the material` | — |

Rules for the line:

- **At most one.** Where two are true, the actionable one wins — wash beats at-the-washer, and
  both beat anything explanatory.
- **It only appears when the row is short.** Every one of these on a row that is fully covered is
  noise, and that is exactly what the screen does today: it prints the greige line on rows with
  hundreds of metres available.
- **It always carries the number.** *"No lot holds enough"* is true and unusable — he is looking
  at a rack with cloth on it. *20, smallest job needs 22* ends the argument in one glance.
- **Never in marker rows.** He measures and cuts metres.

Two of these states are currently silent and both read as the screen being broken:

- **Blocked stock.** `getStoreMaterialRequirements` drops blocked lots entirely, so the row says
  *nothing on the rack* while he is standing in front of the cloth. The server must **send
  blocked lots flagged**, not drop them: unusable for allocation, but nameable.
- **Nothing fits.** Today the row goes blank and Issue does nothing.

### What is deliberately not shown

`Also needed by Suraj, Vivek` goes **from fabric rows**. Under the old screen he could favour one
supervisor by typing a smaller number; now the fan decides, the metres box is read-only, and the
warning names a problem he cannot act on. Contention is settled where it can actually be settled —
`issueMaterials` re-checks every lot, and whoever presses second gets what is really left.

**It stays on accessory rows**, where he still types the quantity and can therefore do something
about it. That is a refinement of what this section first said: the warning was never noise in
itself, it was noise on a row he had no control over.

The **status pill** goes from fabric rows too, and for the same reason. It could only categorise a
condition the lot column already states, and it did it wrongly: a row waiting on a wash read
*"Cannot cut"*, which is false — the cloth is there, it is greige, and the line beside it says how
much to send. The card header's *"N short"* count stays, and is judged on the same figure the rows
are, which is the rule that must never be broken again.

## Washing

**One ticket per lot, sized to close whole orders.**

Not sized to a metre gap. A wash that leaves the order one piece short bought nothing, so the
ticket asks for enough of *that lot's* greige to let it cover an order outright, capped at what
the lot actually holds:

> Wash **13.2 Mtr of L2** → order **#501** can then go out complete, in one shade.

**When several orders wait on the same lot, the ticket totals them and is capped at the lot's
greige.** A wash that lands smaller than the total still closes the earliest orders, because the
fan is priority-ordered and takes them in the same sequence next time.

**An unpinned order has no committed lot, so the wash target is a recommendation, not a
commitment.** It is recomputed on every render from the live rack — nothing is stored, and if the
stock moves the target moves with it. Only the pin is durable, and a pin only exists once cloth
has gone out.

**The gap and its remedy are read off the committed lot and nothing else.** Never off the
material's totals. The greige on the other lots is another shade and can never serve this order,
so quoting it offers cloth that is unusable by definition.

**The bottom-of-page summary stops calculating.** It becomes a roll-up of what the rows are
already asking for: group the row-level asks by lot, sum across supervisors, cap at the lot.
One source of truth for the number, so the row and the summary cannot contradict each other —
which they do today, in both directions.

**Purchase is only for cloth that does not exist in any state.** Never for cloth at the wash
house, and never for a shade that simply is not the one this order needs.

### This needs a Creator field

`Material_Exception` is keyed **material + type + Open**, so a second lot's wash ticket appends
to the first one's and overwrites its quantities — and the widget, reading the same
material-level state, greys out the second lot's button so it can never be raised at all.

> **Add `Material_Exception.Lot`** — Lookup → `Raw_Material_Lot`. Without it "one ticket per lot"
> is unbuildable. This is a manual Creator change.

The dedup in `raiseMaterialException` then keys on material + type + **lot**, and the widget's
open-ticket state does the same.

## Receipt — settle from the record, not from a re-derived order

`receiveMaterials` reconstructs which order a receipt belongs to by re-running the same fan over
plans, on the argument that *the same rule in the same order gives the same answer*. That
argument is already false: it sorts by `Added_Time` while `issueMaterials` sorts by
`Priority_Key` ([receiveMaterials.dg:40](../deluge/receiveMaterials.dg#L40) against
[issueMaterials.dg:61](../deluge/issueMaterials.dg#L61)), so a receipt can credit
`Received_Qty` to a different order's row than the one that was charged. It gets worse the
moment issue becomes order-complete, because the two fans then describe genuinely different
things.

**Stop reconstructing.** `Material_Issue.Issue_Lines` already carries the `Plan_Item`, the `Lot`
and the quantity — it is the record of what actually crossed the counter, written at the moment
it happened. Settle both the requirement and the lot's in-transit from those lines, oldest
first. No ordering dependency, nothing to keep in sync, and a loose priority rule can never
corrupt a ledger.

> **Shipped as the one-line fix, not the restructure.** `receiveMaterials` now sorts by
> `Priority_Key`, which closes today's divergence: the two fans walk the same sequence again and
> the file's own correctness argument holds. Driving the requirement fan off `Issue_Lines` moves
> the stock and dispute writes in the middle of that function, and none of it can be run outside
> Creator — so it is written up here, commented at the call site, and left for a pass where it can
> be executed against real data. The residual risk is narrow and worth stating: if a plan's
> `Priority_Key` changes between the handover and the receipt, the fans diverge again.

## Where the arithmetic lives

**Stays in the widget.** It already has every input the decision needs — the outstanding pieces,
the lots, the offcuts with their lots — and it has no statement-execution limit, which is the
uncatchable failure that decides this kind of question in this app.

**`issueMaterials` validates invariants rather than recomputing.** It cannot trust the payload —
a Custom API is callable from anywhere, and stock moves between render and press — but it does
not have to redo the allocation to check it:

- every order in the payload names **exactly one lot**
- that lot exists, belongs to this material, is Active, and still holds the washed metres claimed
- the pieces the order claims to close match its outstanding pieces — **no partial orders**
- the pinned lot, where one exists, is the lot being used, or a recorded override is present

Anything that fails is rejected, not silently trimmed. Silent trimming is what produced the
handovers that looked complete and were not.

### A stale order must not fail the whole press

Two cards can offer the same cloth and the same offcut — stock is never divided between them —
so by the time he presses Issue another handover may have taken it. That is the design working,
not an error, and it means **the server rejects the affected order and issues the rest of the
press normally.**

The message has to come back in **material terms**, because he never saw an order:

> Linen / Cinnamon Brown — **8.2 of 12.4 Mtr** went. The rest was taken by another handover;
> refresh and it will re-plan.

Per-material outcomes already exist in `issueMaterials` (`okJson` / `errJson`); this extends them
to say *how much* of a material went when part of it was refused.

### An order covered entirely by offcuts

Legitimate, and it still pins. `qty` is 0, `wastePicks` is not empty, and the pin is stamped from
**the lot those offcuts were cut from** — the shade is decided by the cloth that went out, not by
whether any of it came off a roll.

### The payload

The order becomes explicit, so the server can enforce one-lot-per-order rather than infer it —
but as **one extra field on the existing shape**, not a restructure:

```
{ "materialId":"123", "cutWidth":55, "cutLength":55,
  "lots":[ {"lotId":"901","qty":3.85,"planItemId":"777","planId":"501"} ],
  "wastePicks":[ {"wasteId":"456","pieces":3,"planItemId":"777"} ] }
```

The nested `orders[]` form this section first proposed was rejected once the code was in front of
me. `issueMaterials` already keys its passes on **lot × plan item** and already carries the lot
line's own note and override — adding `planId` gives the server everything it needs to group by
order and refuse a straddling one, for one field instead of a rewrite of the payload parser in a
1,700-line function that cannot be executed outside Creator. A line with no `planId` behaves
exactly as it did before, so an older widget keeps working.

Non-fabric lines keep sending `qty` with no `lots`, and behave exactly as today.

`issueMaterials` keeps its **one pass per lot × plan item** structure — the reason for it is
unchanged: cloth is usable only in whole marker rows, so pieces must be counted per lot and
summed, never derived from a combined metres figure.

## What this deletes

- **The tie-break on lot size that ignores what can go out today.** It is what commits an order
  to a lot with no washed cloth while a ready lot sits beside it.
- **The second shortfall calculation** at the foot of the page.
- **Partial issue of an order**, in every form, and with it the per-lot metres budget.
- **`receiveMaterials`' plan fan** for the requirement settlement.

## Known, accepted, and not to be "fixed"

**A wash raised for one order can be taken by another.** The ticket is raised because order #501
needs L2 washed; by the time it lands, a higher-priority #502 may take that cloth. There is no
reservation and there must not be one — this app considered and rejected a reservation ledger,
and rebuilt it by accident once already inside the allocator. It settles itself: the greige cap
means each send lowers what the next shortfall is measured against, so #501 simply raises the
next ticket.

**Offcuts with no lot recorded are dead stock.** They predate the field and there is no honest
way to place them, and now that every allocation is lot-scoped they can never be chosen by
anything. Today they are silently invisible. They should at least be **listed on the waste screen
as "no lot recorded"** so somebody can assign one, otherwise real cloth quietly rots on the rack
with nothing anywhere saying why it is never offered.

**A pin can be blocked rather than empty.** Quarantining a lot correctly makes its orders
unservable, but the row must not say *"L2 is empty"* when L2 is full and blocked — that sends him
to the rack to check. Distinguishing the two is why blocked lots have to be sent flagged rather
than dropped.

## Deliberately not in this pass

- **No "force a partial issue anyway" button.** A partial issue is the one action that
  permanently commits a shade. The escape hatch that matters is *use a different lot*, recorded,
  and that already exists. Say the word if a real handover needs the other one.
- **Move between lots** — still unbuilt, still needed: washing is what most often splits a lot in
  two. It is the store person's tool for correcting a lot *after* the wash, not part of issuing.
- **Lots on accessories.** Thread shade varies too; the same design applies when it matters.
- **No lot at plan time.** A plan still never names a lot.

## What has and has not been verified

**The widget allocator is tested.** The real functions out of `app/js/main.js` are exercised in a
stub DOM with `vm`, 30 assertions over twelve scenarios: the today-beats-greige ranking, the
order-atom refusal, the wash ask reaching the summary, cloth at the washer not becoming a
purchase, one raisable ticket per lot, skip-don't-block, the two numbers on a no-fit row, the
pinned top-up, blocked stock named and never allocated, a blocked pin, two orders sharing a lot,
and the one-line rule on the row.

**No Deluge has been run, and none of it can be from here.** All four `.dg` changes are
comment-and-string-aware balance checked and scanned for the loop-variable/scalar clash, which
catches the two faults Deluge reports at the wrong line — nothing more. Each needs a Creator
**Execute**.

**`Material_Exception.Lot` does not exist yet.** Until it is added, `raiseMaterialException` will
throw on the `ex2.Lot` write and `getStoreMaterialRequirements` will return an error card from its
`oex.Lot` read. This field is a prerequisite, not an improvement.
