# Live Linen / Gad Fashions Manufacturing

A Zoho Creator ERP for garment manufacturing: sales order → production plan → store issues
material → supervisor receives it → production stages → offcuts return to stock and get reused.

This repo holds the **source** for three widgets and every Deluge function. It is not the
running system — see Deployment.

---

## Deployment — read this first

**Nothing in this repo runs until it is pasted into Creator.** A change here has no effect on
the app until you do that. Two separate steps:

- **`deluge/*.dg`** → open the matching Custom API / function in Creator, paste, Save. Use
  Creator's **Execute** to see the real error; the widget only ever gets "code 9430".
- **`app/*`** → served locally during development (`https://127.0.0.1:5000`), zipped and
  uploaded for release.

**If a function's signature changes, the Custom API's argument list must change too**, or
every call fails. Adding an argument is a Creator config change, not just a code change.

When reporting work, always say which `.dg` files and which widget files need redeploying, and
call out any Creator form/field change separately — those are manual.

---

## Deluge rules, learned the hard way

These are not style preferences. Each one caused a real bug in this app.

**Formatting**
- **No comments outside the function body.** Nothing above `string fn(...)`. User's rule.
- `sort by` goes on its **own assignment**, never inline in a `for each` header.
- There is no reliable `break` in a `for each` — guard the body with an `if` instead.

**Types and null**
- Creator fields that were never written are **EMPTY, not null**. `ifnull()` does not catch
  empty, and `.toDecimal()` throws on it. Always:
  `s = ifnull(f,"0").toString().trim(); if(s == ""){ s = "0"; }`
- **Lookup fields hold record ids.** `.toString()` on one gives the id, not the label. Resolve
  through the master record — e.g. `Plan_Item.Item_Sku` → `Item_Master[ID == ...].SKU`. This
  shipped 18-digit ids to the UI twice.
- **Mixed-type comparison throws.** Compare like with like, and force ids to string.
- Integer division truncates **before** `.ceil()` sees it. Multiply by `1.0` first:
  `((remain * 1.0) / perRow).ceil()`.
- `.size()` is a **List** method. A query result needs `.count()`.
- Subform `deleteAll()` requires the collection as an argument.

**Picklist values**
- **A Dropdown choice is stored exactly as typed.** Creator auto-underscores the *field* link
  name ("Order Status" → `Order_Status`); it does **not** touch the *choices*. A choice typed
  `Awaiting Material` never matches `Item_Status == "Awaiting_Material"`, and the failure is
  silent — the record simply isn't found by any query. `Item_Status` carried both spellings at
  once for a while, which is exactly this bug sitting in the form.
- **Space or underscore is decided per field, by where the value goes:**
  > **Raw value reaches the screen → spaces. Widget maps it to a label → underscores.**

  `Order_Status` is printed straight into the plan header, so `In Progress`. `Item_Status` is
  always mapped (`Awaiting_Material` renders as "No material yet"), so it is a code and its shape
  does not matter. Nobody designed this, but it holds everywhere and it is the rule for new
  fields. Normalising the two onto one style was measured and rejected: 62 comparisons across 18
  files, each re-pasted into Creator by hand, each typo failing silently.

| Form . Field | Style | Values |
|---|---|---|
| `Production_Planning.Order_Status` | spaces | `Pending`, `Material Ready`, `Partially Received`, `In Progress`, `Production Complete` |
| `Sales_Order.Order_Status` | spaces | `Pending`, `In Progress`, `Production Complete`, `Checking Passed`, `Packed`, `Dispatched` |
| `Plan_Item.Item_Status` | underscores | `Awaiting_Material`, `Ready_For_Production`, `In_Production`, `Awaiting_Check`, `Complete` |
| `Plan_Item.Remake_Reason` | underscores | `Production_Loss`, `Check_Reject`, `Alteration` |
| `Material_Requirement.Source` | underscores | `Plan`, `Reissue`, `Check_Remake`, `Alteration` |
| `Stage_Log.Stage_Status` | underscores | `In_Progress`, `Done` — **only these two**. A stage not started has no `Stage_Log` row at all, so there is no third value and a `Not_Started` option is unreachable by design. |
| `Item_Check.Check_Type` | spaces | `Stain`, `Measurement`, `Thread`, `Stitching`, `Fabric Softness` |
| `Waste_Master.Status` | underscores | `Pending_Receipt`, `Available`, `Disputed`, `Issued`, `Consumed`, `Scrapped`, `Lost`, `Miscounted` |
| `Damage_Lines.Reissue_Status` | underscores | `Pending`, `Requested`, `Not_Needed` |

- **Several forms share the link name `Status`** — `Waste_Master`, `Stock_Dispute`,
  `Material_Damage`, `Wash_Request`, `Machine_Master`, `Raw_Material_Lot`. A grep for
  `.Status = "` mixes all of them, so attribute by the variable in front of the dot before
  trusting a value. `Resolved`, `Closed` and `Occupied` are **not** Waste_Master values however
  often they appear next to them.
- **A value the code writes but the picklist lacks is a silent corruption, and both directions
  have already happened here.** `resolveDispute` writes `Miscounted` and `saveMaterialDamage`
  writes `Not_Needed`; neither existed on its Dropdown. Conversely `Waste_Master.Status` carried
  `Reserved` and `Stage_Log.Stage_Status` carried `Not_Started`, which nothing has ever written —
  leftovers from the rejected reservation ledger and from before stage rows were created at
  Start. **When adding a status to a function, add it to the Dropdown in the same pass**, and
  when a Dropdown offers something no function writes, delete it: set by hand from a report it
  makes the record invisible to every query, with nothing to say why.

**JSON**
- **Build every JSON response by hand.** `Map.toString()` does not emit valid JSON once the
  structure nests (Map → List → Map), and `List.toString()` does not wrap in `[]`. This
  worked for months only because the deepest level happened to be empty.
- **Always stringify ids** — 18-digit ids break `JSON.parse` on the widget side.
- Escape free text going into hand-built JSON: `.replaceAll("\"","'")`.

**Iteration**
- Two live iterators over the same list do not work. Build a **separate counter list** if you
  need a bounded outer repeat over the same rows.
- **Loop variables and locals share one namespace per function.** A name bound to a query
  result (`for each pl in Production_Planning[...]`) can never also hold a scalar (`pl = 0`)
  anywhere else in that function. Deluge rejects the **query** with *"UnPredictable exception,
  Invalid statement found"* and blames the `for each` line — nowhere near the assignment that
  caused it. Iterating a plain list is fine; only query records bind the name.

**Email**
- **`sendmail`'s `from` must be `zoho.adminuserid`.** A string literal there does not save — Creator
  rejects it in the editor, not at runtime, so no try/catch can report it. The address recipients
  actually see is Creator's own (`notifications@trial.zohocreatormail.com` on trial), decided by the
  account, not by the code. Verifying an address does not let you put it in `from`.
- Wrap `sendmail` in its own try/catch when the function has already written records. Mail is
  queued asynchronously, so a send that throws — or one that silently never arrives — must not make
  a completed run look failed. `createProductionPlans` does this.
- **"accepted" is not "delivered."** Returning without throwing proves nothing; **Settings → Email →
  Sent Emails** is the only log that gives the real outcome.
- **The Email Notifications counter on the Usage page ticks for a mail that never arrives.** It
  counts sends *accepted*, so it proves the code reached `sendmail` — nothing more. Useful for
  exactly one thing: telling "the block never ran" apart from "it ran and the mail was lost".
- **HTML tables and inline styles deliver fine** — tested and ruled out, so don't go hunting there.
  Have the function log the recipient it actually used; a stale `notifyTo` in the deployed copy
  looks identical to a delivery failure from the outside.
- When a mail does go missing, send variants differing by **one property each** (subject built vs
  literal, plain body vs table) rather than changing several things at once. Two rounds of that
  found more than a day of guessing.

**Failure modes**
- Creator reports every runtime failure to a widget as **`code 9430`**. Wrap the body in
  try/catch and return the real message inside the payload — otherwise you are debugging blind.
- **The statement-execution limit is NOT catchable.** It kills the script, so the try/catch
  never runs and the widget sees a bare HTTP 500 with no error card. *A 500 with no error card
  usually means the statement limit, not a thrown error.* Keep queries bounded: group by key
  before scanning, filter by date, hoist repeated fetches out of loops.
- Cross-function calls use `thisapp.functionName(...)`. Older comments in this repo claim these
  do not work; `getAdminCalculation` now relies on them. If it fails, that claim was right.

---

## Domain rules

**Grain is fixed.** Cut width runs across the fabric width and is never rotated. A remnant
narrower than the cut width is useless for that cut, however long it is.

**Fabric fulfilment is counted in CUT PIECES, not metres.** This is the single most important
rule in the app. `Material_Requirement.Required_Qty` is a *pre-waste estimate* made at plan
time; the real target is `Required_Pieces`. A row whose pieces read as issued looks complete no
matter how few metres it has. Four separate silent-loss bugs came from forgetting this.

> **`Issued_Qty` may exceed `Required_Qty` on a fabric row. That is correct, not a bug.**
> Cloth is only usable in whole marker rows, and `Required_Qty` rounds up **once** for the whole
> order. Every separate handover rounds up again, so *k* handovers can genuinely need up to
> *(k−1) × cutLength* more cloth than the plan estimated. Both the store screen and
> `issueMaterials` therefore derive the metres budget from **outstanding pieces**, and raise the
> stored estimate when it falls short — they never cut it back.
>
> Before that, two more silent-loss bugs lived here. Issuing a round 10 m of a 55 cm cut yields
> 18 rows and throws 10 cm away, but the budget was charged the full 10 m — so the last piece
> could never be issued, the item stayed at `Awaiting_Material` for ever, and **pressing Issue did
> nothing with no error**, because the "nothing outstanding" test needs *both* metres and pieces
> to be spent. In the other direction, a row whose pieces had been covered by offcuts that were
> since used up still quoted the plan's full metres, and the surplus walked out with nothing
> booking it.
>
> A **Creator report** comparing the two columns will show fabric rows over 100 % issued. Expected.

Anything that re-opens a requirement must wind back **every** counter the store screen reads:
`Issued_Qty`, plus `Pieces_From_Raw` (fabric) and `Pieces_From_Waste` (remnants).

**Three different calculations, never the same number:**
1. **Plan-time requirement** — `createProductionPlans`. Assumes no offcuts exist.
2. **Issue-time allocation** — `getStoreMaterialRequirements`. Re-decides how much offcuts
   cover; moves whenever waste stock moves. Fewer *pieces* than (1), never more — but **not
   necessarily fewer metres**: it re-rounds to whole marker rows for the pieces still outstanding,
   so across split handovers the metres can total more than (1). See the `Issued_Qty` note above.
3. **Waste generation** — `getExpectedWaste`. The side strip, part-filled row and tail.

Conflating them is the most common way to conclude the maths is broken when it is not.

**Stock is consumed at RECEIPT, not issue.** Issuing moves quantity to `In_Transit_Qty`;
receipt settles it. A shortfall goes to `Disputed_Qty` and raises a `Stock_Dispute`.

**The same rule runs backwards for offcuts.** A declared remnant is not stock: while
`Waste_Master.Status` is `Pending_Receipt`, `Piece_Count` holds what the supervisor *declared*,
not what is on the rack. `receiveWastePieces` is where the two get compared — what the store
actually found becomes `Piece_Count`, and the gap goes to `Disputed_Count` and raises an
`Inbound` dispute. A row the store found none of goes to `Status = "Disputed"`, which is
invisible to both the receipt list and the allocator.

**Disputed quantity is not pending receipt.** It belongs to the disputes screen until resolved,
or the same material gets received twice and counted as both arrived and missing.

**Plan statuses** (`Production_Planning.Order_Status`):
`Pending → Partially Received → Material Ready → In Progress → Production Complete`
**`Production Complete` is where a plan stops for good.** QC, packing and dispatch are tracked on
the *sales order*, not the plan — the plan picklist ends here.
> **Invariant: a plan that still owes material must be Pending, Partially Received or
> In Progress** — those are the only three `getStoreMaterialRequirements` and `issueMaterials`
> accept. Anything that re-opens a requirement must also pull the plan back into that set.

**Item statuses** (`Plan_Item.Item_Status`):
`Awaiting_Material → Ready_For_Production → In_Production → Complete`
Written by `receiveMaterials`, `resolveDispute` (both directions) and `saveProductionPhase`.
`resolveDispute` only moves items in the two states *before* cutting — dragging a started item
backwards would deny work that really happened.

**A stage is split between several operators.** The supervisor hands out shares as people come
free — `Stage_Assignment`, one record per operator per stage, its own form for the same reason
`Plan_Item` and `Stage_Log` are: two men finishing minutes apart would both rewrite one parent
and the second write would lose the first.

> **`Stage_Log` is still ONE row per `Plan_Item` × `Phase_Name`, and that stays load-bearing.**
> `saveWasteFromCutting` resolves the cutting log by item + phase, `sendToThirdParty` reuses it,
> `saveMaterialDamage` hangs off it, `getExpectedWaste` filters on it, and the next stage reads
> its `Qty_Out` as its own `Qty_In`. Splitting a stage into several `Stage_Log` rows breaks all
> five at once. The people go one level down; the stage header does not move.
>
> **`Stage_Log.Operator` null means the stage was split** — that is the test the reports use to
> tell a split stage from a legacy single-operator one, and it is why `saveStageAssignment` opens
> the header with an empty `operatorId`. Both are counted, never both at once: a header with
> shares is skipped, or its pieces appear twice.
>
> **The stage's `Qty_Out` is the SUM of its shares, computed server-side.** The payload figure is
> ignored when shares exist. `saveProductionPhase` refuses to close a stage while any share is
> still open — that figure is the next stage's `Qty_In`, the item's produced count and possibly
> the sales order, and none of them walk back.
>
> Pieces the supervisor never handed to anybody are allowed. They fall out as the ordinary
> "fewer out than in" shortfall and raise the existing damage prompt.

**Machines are not tracked.** Each operator works a fixed machine, so "which machine" is answered
by "which operator". `Machine_Master` and `Stage_Log.Machine` still exist in Creator holding what
they held; nothing in production reads or writes them, `setStageMachine` is retired, and machines
currently marked `Occupied` will stay that way for ever. `Machine_Master.Applicable_Stages` is no
longer one of the places a new stage name has to be added.

**Sales order statuses** (`Sales_Order.Order_Status`, a different field):
`Pending → In Progress → Production Complete → QC Passed → Packed → Dispatched`.
`Pending` **is** the plan-builder's queue — `createProductionPlans` takes every Pending order,
plans it, and moves it to In Progress. An order it cannot plan keeps its status and is retried.

**The plan hands over to the order at `Production Complete`.** `saveProductionPhase` is the seam:
when the last item finishes it sets the plan to `Production Complete` and mirrors it onto the
order. That mirror is only correct because **one order produces exactly one plan** — the insert in
`createProductionPlans` sits inside its per-order loop. Split an order across two plans and the
order would complete when the *first* one did.
> **The mirror is FORWARD ONLY.** That block re-runs on every stage save and the
> all-items-done test stays true once true, so an unguarded write would drag an order back from
> `QC Passed` to `Production Complete` and put it in front of QC twice. It writes only when the
> order is still `Pending` or `In Progress` — the same rule `resolveDispute` applies to the plan
> and `receiveMaterials` to `Item_Status`.

Both fields carry the words `Production Complete`. That is the seam, not one field seen twice —
always check which form a query is against.

**Dispute model.** Every dispute has a **sender** and a **receiver**, and `Stock_Dispute.Direction`
says which way round. **An empty `Direction` means `Outbound`** — every dispute raised before the
field existed was one, and both `resolveDispute` and the list functions apply that default.

| | `Outbound` | `Inbound` |
|---|---|---|
| Sender → receiver | store → supervisor | supervisor → store |
| Raised by | `receiveMaterials` | `receiveWastePieces` |
| Receiver has it after all | `Found`, supervisor only | `Found`, **store** only |
| Sender over-recorded | `Store_Correction`, store only | `Supervisor_Correction`, supervisor only |
| Sender still has them | — | `Supervisor_Resending`, supervisor only |
| Requirement side-effects | full | **none** |

Each side answers only for its own side, enforced server-side because a Custom API is callable
from anywhere:
- `Found` — always "the *receiving* side has it". Outbound that credits the receipt and returns
  nothing to the shelf; inbound the receiver *is* the rack, so it is what puts the pieces there.
- Sender correction — always "it never left me". Outbound (`Store_Correction`) stock returns and
  the requirement re-opens; inbound (`Supervisor_Correction`) the pieces never existed, so the
  disputed count just drops and the row ends at **`Miscounted`**.
  > **`Miscounted` is not `Scrapped`.** `saveWasteFromCutting` writes `Scrapped` when he cuts a
  > real remnant and discards it, and that is what makes *"how much did we throw away this
  > month"* answerable. A piece that never existed must not inflate that figure — and `Consumed`
  > would be worse, claiming it was used.
- **`Supervisor_Resending`** — inbound only, supervisor only: *"I still have them and I am
  sending them now."* The pieces go back to `Pending_Receipt` and the store checks them in
  through the ordinary waste-receipt flow. Without it his only exits were to claim pieces that
  exist never did, or to deny them into a write-off.
  > **A row already holding `Available` stock must not go back to `Pending_Receipt`.** The store
  > has checked those pieces in; re-queueing the whole row offers them a second time and invents
  > count out of nothing. `resolveDispute` reuses the row only when `Piece_Count` is 0, and
  > otherwise gives the re-sent pieces a **new** `Waste_Master` row plus its own `Declared`
  > movement — without that movement the store's check-in list cannot say where they came from.
- `Denied` — either side, either direction, "not with me". Resolves nothing on its own.
- **`Lost` is never an input.** When the *second* side denies, `resolveDispute` writes the loss
  off itself. No one person can take stock off the books.

**An inbound dispute touches no requirement.** Offcuts coming back are owed to nobody: there is
no `Issued` movement to read a yield from, no `Pieces_From_Waste` to wind back, and the
`Item_Status` / `Order_Status` sweep is skipped. Never tell the store an inbound write-off
re-opens anything — it does not.

---

## Widgets

Three, all Creator JS API **v2** — `ZOHO.CREATOR.DATA.invokeCustomApi`, **no `init()`**.

| Path | Screen |
|---|---|
| `app/` | Store — Issue / History / Waste receipt / Disputes / My requests / Material used |
| `app/supervisor/` | Supervisor — `shell.js` owns tabs + the shared picker; `receive.js`, `production.js`, `tabs.js` |
| `app/admin/` | Calculation audit — shows the working behind the fabric maths |

**Custom API calls from a widget are NOT metered** — verified empirically; only external/Postman
calls count against the daily quota. Do **not** build router APIs to "save calls"; that advice
was tested and retracted.

**Conventions**
- Tabs load lazily via `TAB_LOADERS`; `Refresh` only reloads tabs already opened.
- The supervisor picker is a **stand-in for login** until `zoho.loginuser` can be resolved to an
  `Employee`. It lists every employee — a login does not appear and disappear based on whether
  you have work.
- **Sizes are always displayed Length × Width**, labelled `(L × W)` where the numbers appear.
  Field names and all maths keep width and length as they are — only display order is fixed.
- Inter font, `--primary: #2563eb`, `#e9eef4` page background. Reused classes: `item-card`,
  `status-pill`, `table-wrapper`, `mat-name` / `mat-sku`, `col-num`, `raise-btn`
  (`.is-stale` = secondary).
- An offcut is green throughout; reuse is the good outcome.
- Widgets are ES5-flavoured (`var`/`function`) except `production.js`, which uses `const`/`let`.
  Match the file you are in.

---

## Verifying without a Creator instance

Deluge cannot be run here, so:
- **Widget JS** — `node --check <file>`; render functions can be exercised in a stub DOM with
  `vm` to assert real output. Do this; several UI bugs were caught this way.
- **Deluge** — port the arithmetic to a small Node script and test the lifecycle (this caught
  the fabric-piece rollback and the double-count). Check brace/paren balance with a scanner that
  skips comments and strings, and scan for the loop-variable/scalar name clash above — both are
  comment- and string-aware text passes, so they cost nothing and catch what Deluge only reports
  at runtime, at the wrong line.
- **Never claim a Deluge change is verified.** Say what was checked and what needs an Execute.
- **Deluge's reported line number is a hint, not a fact.** It points at the statement that
  *failed*, which is often not the statement that is *wrong*. Isolate first — a per-row
  try/catch that names the record beats reading the reported line.

---

## Deliberate gaps — do not "fix" without asking

- **No roles or login.** Pickers stand in. Blocks all authorisation work.
- **Stages are a hardcoded picklist, and will not stay that way.** The same set of stage names
  is spelled out as dropdown options in `BOM.Production_Stages.Operation` and
  `Third_Party.Applicable_Stages` — and matched everywhere **by exact string**.
  (`Machine_Master.Applicable_Stages` was a third; machines are no longer read.) Planned: an admin **stage master** where he adds and edits
  stages, with `BOM.Production_Stages` becoming a **lookup** to it rather than free text.
  > Two things to keep true until then, because both get harder the more code assumes strings:
  > **stage names are compared with `==`, never `contains`** — they collide as substrings
  > ("Machine Embroidery" is inside "Manual Machine Embroidery"), which is why
  > `getProductionWidgetData` reads the multi-selects as lists instead of querying them. And
  > **`Stage_Log.Phase_Name` stores the name, not a reference** — it is a snapshot of what the
  > stage was called on the day, so renaming a stage later must not rewrite finished history.
  > When the master lands, `Phase_Name` stays as the snapshot and a `Stage` lookup goes
  > *alongside* it. Keep new stage picklists **single**-select where the grain allows
  > (`Operator_Assignment.Stage` does) — a multi-select is what forces the `contains` problem.
- **Damage salvage is double-counted as loss, at Cutting only.** He ruins a panel, salvages
  the usable part into the waste box, *and* reports the damage to get cloth reissued. **Stock is
  correct** — the remnant is really on the rack and the reissue is really new cloth, nothing is
  invented. What is overstated is the *loss*: `Material_Damage.Damage_Lines.Damaged_Qty` says
  what had to be replaced, and part of it came back as usable offcut. Net loss is
  damaged − salvaged and nothing computes it. `Waste_Master` also carries **no provenance**, so a
  strip salvaged off a ruined panel is indistinguishable from the ordinary side strip and tail
  `getExpectedWaste` predicts.
  > **`Damaged_Qty` means "material that had to be replaced", not "material destroyed."**
  > Subtract returned offcuts from it without knowing which came from damage and `Unaccounted`
  > goes **negative** — which will read as an arithmetic bug in the report rather than as this.
  >
  > Deliberately deferred until the consumption report exists, because only then is it clear
  > whether netting has to be **per incident** or **per material** — and that decides the design.
  > The fix is salvage captured inside the damage dialog (Cutting only) with a `Damage_Ref` on
  > `Waste_Master`, **not** a flag bolted onto the existing waste dialog: the waste dialog fires
  > *before* the damage record exists, so there is nothing to link to at that moment.
- **An `Issued` `Waste_Movement` carries ONE `Plan_Item`, and the pieces may serve two.**
  `issueMaterials` writes the movements once per issue, stamped with the first requirement row
  that took waste credit. Picks are allocated against the aggregate of every row sharing
  *(supervisor, material, cut size, source)*, which can span two `Plan_Item`s — realistically
  **two lines of the same SKU on one order**, or two products whose cut sizes coincide. QC remakes
  mostly escape it: by then the root is fully issued, contributes no outstanding pieces, and the
  fan skips it.
  > The cost is a missed **prompt**, not lost stock. `getExpectedWaste` filters on `Plan_Item`, so
  > the second item's cutting screen predicts pure fresh-fabric waste and never offers the
  > remnant's tail and side strip back. He can still declare them by hand. `receiveMaterials`
  > makes the first item's readiness wait on waste meant for the second, which clears on receipt.
  >
  > **Not fixable by changing the stamp.** One remnant can yield cuts for two items, so the
  > movement genuinely belongs to both and any single id is a guess. Widening `getExpectedWaste`
  > to match on plan and cut size instead would let **both** items predict the same tail —
  > inventing waste, which is worse than under-predicting it. The real fix is pieces-per-item
  > recorded against the movement, i.e. the same `Waste_Master` provenance the damage-salvage gap
  > needs. Solve both together or neither.

- **Notifications half-wired.** `createProductionPlans` sends a run summary — one mail per run,
  created plans and skipped orders together, wrapped in its own try/catch so a mail failure can
  never make a completed run look failed. `raiseMaterialException` still has its `sendmail`
  commented out. There is **no email field on `Employee`**, so nothing can notify a supervisor
  directly yet; every mail goes to the single `notifyTo` address.
  > **It currently mails on EVERY run, including one that did nothing** — deliberate while
  > notifications are being tested, because silence cannot be told apart from a mail that never
  > fired. **Put the `if(createdCount > 0 || unassignedCount > 0)` guard back before this runs on a
  > schedule**, or a daily "nothing happened" mail burns the quota and trains people to ignore the
  > one that matters.
- **No finished-goods stock.** Production says how many were made; nothing receives them.
- **QC / Packing / Dispatch** have Creator nav but no widgets.
- **`resolveStockDispute.dg`** is a legacy form workflow duplicating `resolveDispute`. It has
  none of the current logic. **Delete it in Creator.**
- **Old `Production_Planning` subforms** (`Item_Table`, `Production_Tracking`,
  `Raw_Material_Check`, `Waste_Issued`) are unused post-migration and can be deleted.

---

## Working style that fits this project

- The user is hands-on and reviews output closely. Be concrete about what changed and why.
- Prefer the **simplest layout that answers the question on screen**. Grouped blocks, totals
  panels and extra structure have been rejected more than once — one row per physical thing,
  every column meaning the same on every row.
- Never assume a field name. Read the form or the function that writes it.
- When something looks wrong, check who *writes* the field before trusting what its name implies
  — `Order_Status` staying `Pending` after issuing caused a whole class of wrong assumptions.
