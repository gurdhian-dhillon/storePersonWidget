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
- **No comments INSIDE an `insert into X [ ... ]` field list either**, and this one is not a style
  rule — the field list is parsed specially and a `//` line in it is a **syntax error**.
  > It reports as *"Improper Statement… missing ';' at end of the line"* against the function's
  > opening **`try`**, which in `issueMaterials` was **1,870 lines** from the insert and said nothing
  > about an insert being involved. Deluge's reported line is a hint, not a fact — this is the
  > extreme case. Put the comment immediately **above** the `insert into`.
  >
  > Sixty-odd `.dg` files and not one of them had a comment in an insert block; that uniformity was
  > the evidence that found it. `tools/dgscan.js` now checks for it.
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
| `Sales_Order.Order_Status` | spaces | `Pending`, `In Progress`, `Production Complete`, `Checking Passed`, `Finishing Complete`, `Packed`, `Dispatched` |
| `Plan_Item.Item_Status` | underscores | `Awaiting_Material`, `Ready_For_Production`, `In_Production`, `Awaiting_Check`, `Complete` — **finishing does not write here**, see the post-checking section |
| `Finishing_Data.Finishing_Status` | underscores | `In_Progress`, `Done` — **only `Done` closes a batch**; anything else means the job is still open |
| `Plan_Item.Remake_Reason` | underscores | `Production_Loss`, `Check_Reject`, `Alteration` |
| `Material_Requirement.Source` | underscores | `Plan`, `Reissue`, `Check_Remake`, `Production_Remake`, `Alteration` |
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
- **Free text going into hand-built JSON needs the WHOLE chain, not just the quote:**
  `.replaceAll("\"","'").replaceAll("\r","").replaceAll("\n"," | ").replaceAll("\t"," ")`
  > **A raw newline inside a JSON string literal is invalid JSON, not an escaping nicety**, and it
  > fails in the one way that teaches you nothing: Deluge does not throw, so there is no error card
  > and no 9430 — the widget gets *"bad control character in string literal at line 1 column 1963"*
  > and the tab simply will not render. The column number is the only clue and it points at the
  > response, not at any line of code.
  >
  > **Every `Remarks` / `Note` / `Reason` field in this app is a Multi Line field fed by a
  > `<textarea>`**, so one press of Enter anywhere puts a newline in a record that a dozen readers
  > emit. `receiveFromThirdParty` also *appends* its return note under the existing remark with a
  > `\n` deliberately, so the field reads as a log in Creator — which is correct, and means the
  > flattening belongs to the READER, never the writer. **The record keeps its line breaks; only
  > the copy crossing JSON is flattened,** because a JSON string is a single line by definition.
  > `" | "` rather than a space: several appended notes run into one unreadable sentence otherwise.
  >
  > This bit once before and was patched at exactly one call site — `getStoreMaterialRequirements`
  > carried a lone `.replaceAll("\n"," ")` while `getSupervisorMaterials`, reading **the same
  > `Material_Requirement.Reason`**, did not. Patch the class, not the column number.
  >
  > **A backslash in free text breaks JSON too and is NOT handled.** It is left alone on purpose:
  > Deluge's `replaceAll` takes a regex, and a lone `"\\"` as a pattern is a syntax error, so the
  > cure throws where the disease has never yet occurred. If it ever does, that is the reason it
  > was skipped.

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

> **THE ZOHO INVENTORY TRANSFER ORDER API, AS THIS ORG ACTUALLY ANSWERED IT.** Four rounds of
> trial to establish, none of it guessable from the docs, and `postTransferOrders` is the only
> place that knows it:
>
> | | |
> |---|---|
> | `from_location_id` / `to_location_id` | **not** `from_warehouse_id` — that returns `9163 Please select a valid warehouse`, even though every location on this org is type Warehouse |
> | `transfer_order_number` | **mandatory.** This org does not auto-number transfer orders — omit it and you get `code 6` |
> | `line_items[].name` | required beside `item_id`, or `code 4: Invalid value passed for name` |
> | `is_intransit_order: false` | the supervisor already has the cloth; an in-transit order needs a second confirmation nobody will give |
>
> The warehouse naming is kept as a fallback on `9163` only — two lines, and an org with Locations
> switched off would need exactly it. **Locations:** Main Warehouse `3955559000000212001`,
> Production `3955559000000219654`, Finished Goods Store `3955559000000227307`, Head Office
> `3955559000000032097`. Read them again with `getInventoryRefIds`; probe endpoints with
> `probeInventoryEndpoints` and `probeWarehouses`.
>
> **The document number IS the voucher number.** Since one has to be supplied it may as well mean
> something, so the transfer order and the store issue voucher share an identifier and reconciling
> them is not a lookup. A partial receipt makes a second order, so it suffixes: `SIV-00001`,
> `SIV-00001-2`. The count comes off `Transfer_Order_IDs`, which accumulates one id per order
> posted and so cannot drift from how many exist.
>
> **`postTransferOrders("true")` is a dry run** that builds every body and posts nothing, and
> `("one")` writes exactly one order. Use them in that order against a live org — a dry run proves
> the body is well formed and nothing else.

> **ZOHO INVENTORY IS MOVED AT RECEIPT TOO, AND THAT IS THE SAME RULE.**
> `postTransferOrders` posts one **transfer order per store issue voucher**, Main Warehouse
> (`3955559000000212001`) to Production (`3955559000000219654`), with `SIV-…` in the order's
> `reason` so the document says which handover it is. Nothing moves warehouse when cloth leaves the
> counter — at that moment it is in transit and belongs to neither side.
>
> **`Material_Issue` IS the store issue voucher**, one record per press of Issue, numbered
> `SIV-00001` upward by `issueMaterials` at the insert. The number is built in Deluge, **not** by an
> "on add" form workflow — `input.Voucher_No` fires only when a human opens the Creator form, and
> nothing ever does. It is generated off `sort by ID desc range from 1 to 10`, keeping the largest
> parsed number: sorting on `Voucher_No` is a *text* sort and would issue `SIV-100000` twice once
> the width changed.
>
> **THE TRIGGER IS `Issue_Lines.Settled_Qty`, NEVER `Issue_Status`.** `receiveMaterials` flips
> `Issue_Status` for *every* open handover on the plan rather than the one being received
> (`receiveMaterials.dg:979`), so a voucher issued this morning reads `Received` the moment an older
> one is confirmed — triggering on it would transfer cloth still on the store counter. `Settled_Qty`
> is per line and only ever written by an actual receipt.
>
> **What moves is `Settled_Qty − Transferred_Qty`**, which is also the idempotency: it is stamped in
> the same pass that posts, so a re-run finds the difference closed. Partial receipts fall out for
> free — 8 of 10 today is one order, the last 2 tomorrow is a second, both carrying the same voucher
> number. A voucher goes `Done` only when nothing is owed *and* nothing is left to move; anything
> else stays `Pending`, which is what bounds the sweep.
>
> **A material with no `Inventory_Item_ID` refuses the WHOLE voucher.** Moving four of five lines
> and marking it Done would strand the fifth silently.
>
> Run it with **`true` first** — dry run builds every request body and reports it without posting.
> Transfer orders are the one thing in this app that moves stock in a system this repo cannot read
> back.

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

**A PIECE LOST IN PRODUCTION IS ALWAYS MADE AGAIN, AND NOBODY IS ASKED WHETHER TO.**
`coverProductionLoss` is the only thing that opens a `Production_Loss` batch. `saveProductionPhase`
calls it the moment a stage closes with fewer pieces out than in; `saveMaterialDamage` calls it too,
only to ask *which* batch a damage report belongs to so it can write `Remake_Item`.

> **It is IDEMPOTENT, and that is the whole design.** `lost` comes off the root family's `Stage_Log`
> rows, `covered` off the `Production_Loss` batches under that root, and it writes `lost − covered`
> — setting coverage *to* the derived loss rather than adding a number handed to it. Two callers on
> one event cannot double the batch. The old code added `damagedPieces` to whatever was there, which
> is exactly why it had to be called once, from one place, behind a modal.
>
> **THE BATCH IS WHAT GUARANTEES THE ORDER.** It sits at `Awaiting_Material`, so the all-items-done
> test cannot pass and the order cannot reach `Production Complete`. Same property that makes an
> unchecked item impossible to lose: no report to remember, it simply cannot proceed.
>
> **What this replaced.** The batch used to be opened by `saveMaterialDamage`, and only when a
> tickbox was left ticked in a modal offered once, right after the stage saved. Three things lost the
> pieces — cancelling the dialog, unticking the box, and lowering a finished count afterwards — and
> in every case the item completed with a reduced `Qty_Produced`, the checker inspected fewer,
> packing's "every finished piece boxed" test passed, and the order reached `Packed` under quantity
> with **nothing anywhere saying so**. The widget's own comment admitted it: *"Without it the order
> simply ends short."*
>
> **An alteration batch is skipped**, and not as a special case bolted on: one garment can be worked
> at two of its stages, so a survivor count cannot be derived from any `Qty_Out` — it is *declared*
> by `closeAlterationBatch`. Reading a shortfall off its stage logs would invent losses and open a
> batch to replace garments that are fine.
>
> **A batch that has STARTED is never topped up.** Its `Qty_In` is fixed, and raising the quantity
> underneath it would leave the stage short of the item it belongs to. A later loss opens a second
> batch instead — the same rule the merge-or-create block has always applied.
>
> **`saveMaterialDamage` no longer opens batches at all.** `Damaged_Qty` means "material that had to
> be replaced", not "garments destroyed" — a torn label ruins no piece. If garments really were lost
> the stage closes short and the batch appears from there. It still writes `Remake_Item`, which is
> load-bearing: `raiseReissueRequest` follows it to point the replacement *cloth* at the batch rather
> than the original item, and without it the store is asked twice for one event.

**SHIPPING SHORT IS A DELIBERATE, RECORDED ACT — `shortCloseOrder`.** The only way past an
uncovered loss. It writes `Sales_Order.Short_Closed` plus a mandatory `Short_Close_Reason`, cancels
the `Production_Loss` batches **nobody has started** (work already on the floor still finishes and
still ships), and calls `recheckOrderComplete` so the order moves on immediately.

> `Short_Closed` already existed and `recheckOrderComplete` already read it — it forgives the
> quantity test in checking and finishing and nothing else. What was missing was any way to set it
> except ticking a box on the record in Creator, which is the same quiet decision that was happening
> by accident. **The reason is mandatory**: an unexplained short close is indistinguishable from the
> bug. The supervisor's Reissue tab is where it is offered, behind a red confirmation that states
> what the customer ordered against what they will actually receive.
>
> **Cancelling the unstarted batches is not tidying, it is required.** Leaving one at
> `Awaiting_Material` would forgive the order its quantity and strand the plan anyway — two answers
> to one question.

**NOBODY ASKS THE STORE FOR MATERIAL EXCEPT THE SUPERVISOR.** Both routes that discover a batch
needs cloth — he ruined some (`saveMaterialDamage`), or the checker rejected garments
(`saveItemCheck`) — write the batch and stop there. The demand is raised separately, from his
**Reissue tab**, by `raiseReissueRequest`. A rejection used to create its `Material_Requirement`
rows inline, which let an inspector three rooms away commit him to a handover he had not asked for
and could not see coming.

> **A check-remake draft is DERIVED, and there is no draft record anywhere.** The draft *is* a
> `Plan_Item` with `Is_Remake` + `Remake_Reason == "Check_Reject"` sitting at `Awaiting_Material`
> with no `Material_Requirement` of `Source == "Check_Remake"` against it; its lines are rebuilt
> from the batch's own BOM through the shared `buildItemRequirements`. Those requirement rows are
> therefore also the only guard against raising twice, and they are enough — no flag exists that
> can drift out of step with them. `getReissueDrafts`, `getSupervisorCounts` and
> `raiseReissueRequest` all apply that same test and **must keep applying the same one**, or the
> badge, the tab and the button disagree about whether there is work.
>
> **A `Production_Loss` draft is the same card with a different test.** Its batch is real (see
> `coverProductionLoss` above); what is derived is the *material request*, exactly as here. But its
> guard is **`Material_Requirement[Plan_Item == batchId].count() == 0` — any row, any `Source`** —
> not a `Source` list. A damage report on the same event points its cloth at that batch through
> `Material_Damage.Remake_Item` and writes rows of `Source == "Reissue"` against it; matching only
> `Production_Remake` would offer the full BOM on top of those and the store would be asked twice
> for one loss.
>
> **All THREE sites carry the pair of tests, not two of them.** `getReissueDrafts` (the tab),
> `getSupervisorCounts` (the badge) and `raiseReissueRequest` (the button) — the same three named
> above, for the same reason. `getSupervisorCounts` was missed on the first pass and the badge read
> 0 over a tab holding a production loss, which is worse than no badge because he stops opening it.
>
> Storing the draft was considered twice and rejected both times. As a `Material_Damage` row it
> would put a check rejection in the consumption report's **damaged** column — the exact double
> count `docs/checking.md` forbids. As draft `Material_Requirement` rows it would make every screen
> that reads that form learn to ignore them, silently and one miss at a time.
>
> Legacy batches are untouched by any of this: they already carry their requirements, so the
> "no `Check_Remake` row" test never sees them, and the strict `Check_Reject` match skips
> `QC_Reject` and empty reasons for the same reason.

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
>
> **A CLOSED SHARE IS READ-ONLY ON THE SCREEN.** Its finished count renders as text
> (`.share-out-done`); there is no field and no **Fix** button. Both existed, so a mistyped count
> could be corrected while the stage was still open — and what that actually bought was a way to
> **lower a finished count long after the moment the shortfall would have been explained.** A
> stage's lost pieces are only replaced by `saveMaterialDamage`, which opens the `Production_Loss`
> batch and writes the damage lines the Reissue tab asks the store from, and that dialog is offered
> **once**, when the stage ends. Reduce a share afterwards and the stage just produces fewer pieces
> with nothing raising a replacement: the order ends short and nothing says why.
>
> **`saveStageAssignment` still accepts `end` on a `Done` share while the stage is open**, and that
> is deliberate — it is a Custom API, the guard that matters is `STAGE_DONE` on the *stage*, and no
> rule should rest on a button being absent from one screen. The correction is not lost either, it
> costs the stage: nothing is final until **End stage**, which is where the shortfall is asked
> about, which is where the answer belongs.
>
> **This does NOT stop a short close, and must not.** The *open* share row keeps its editable
> finished field beside **Done** — "he finished 38 of the 40 he was given" is a real thing that has
> to be recordable. Only the after-the-fact edit is gone.

**A THIRD PARTY IS ONE OF THOSE SHARES.** `sendToThirdParty` writes a `Stage_Assignment` with
`Third_Party` filled instead of `Operator`, plus `Sent_On` / `Returned_On` / `Outsource_Ref`. A
vendor doing 40 of a stage and two men doing the other 60 are three rows of one table, the
"how many are left to hand out" test counts all three, and the stage's `Qty_Out` sums all three.
Sending starts from the stage card's own *who is taking these* dropdown, next to the men.

> **That dropdown offers ONE option — "Send to a third party…" — never vendor names.** Which
> vendor may take the work is decided by the *stages*, and the stages are not chosen until the
> dialog: a send covers a contiguous block and only a party covering **every** stage in it is
> eligible. Naming vendors on the card answers that a step early — he picks one for Stitching,
> ticks Embroidery too, and finds the choice was never valid. The card offers the action; the
> dialog names the parties once it knows what it is asking about. The option shows whenever any
> party exists, *not* filtered by this stage: if none covers the block he builds, the dialog names
> the stage nobody does, which is an answer where a missing option is a dead end.

> **This is what fixed a silent-loss bug, and the shape of it is worth keeping in mind.**
> The old model put the vendor on the stage **header** and set `Stage_Log.Qty_In` to the sent
> quantity. That is only true when the whole stage goes out. Send 40 of 100 and the header then
> claimed the stage had only ever received 40 — the other 60 left every count, every total and
> every screen, the card locked as outsourced so nobody could be put on them, and nothing
> anywhere said so. **`Qty_In` belongs to the stage and is never rewritten by who takes a share
> of it.**
>
> **One send covers a contiguous BLOCK of stages** — one van, one gate, one return — so it writes
> one share per stage under one `Outsource_Ref`. Only the block's **first** stage has a known
> `Qty_In`; the later ones receive what the stage before them produces, which is not settled
> until the in-house shares finish, i.e. after the van has left. So their headers are opened with
> `Qty_In = 0` and filled in exactly once by whichever comes first: the first in-house operator
> put on them (`saveStageAssignment`), or `receiveFromThirdParty` closing the chain.
>
> **The screen therefore draws MORE THAN ONE STAGE.** "One stage at a time" still holds for
> everything else, but a later stage of a block is rendered as soon as it is holding a share —
> otherwise the supervisor watches five pieces leave and cannot find them anywhere, which reads
> exactly like losing them. Those cards are look-ahead only (`.stage-card.is-ahead`): `Qty_In`
> prints as a dash, nothing can be handed out from them, and **End stage is disabled**. Closing
> one early would publish a `Qty_Out` built from the single share that happens to exist and hand
> it to the next stage as fact. `saveProductionPhase` refuses it too — `STAGE_NOT_REACHED`, when
> a stage with shares has no stored `Qty_In` and the payload offers none.
>
> **THE VAN ARRIVES ONCE, AT THE BLOCK'S LAST STAGE, and everything else follows from that.**
> *Take it back* is offered on that stage's vendor row only; every earlier row reads
> "back at `<last stage>`". And an earlier stage is **not waiting for the van** — those pieces
> left it when the van did. So `saveProductionPhase` treats an open vendor share whose
> `Sequence_No` is below its block's maximum as **passing through**: it credits `Assigned_Qty` to
> the stage's output and does not count it as an open share. That is not a shortcut — it records
> exactly the figure the return would write, only sooner, because the loss lands on the block's
> last stage and every earlier share is credited in full regardless. Without it a cutting stage
> stayed shut for the days a vendor held the panels, stranding the in-house half of that same
> stage behind pieces that were not in the building. The widget mirrors the rule (`isPassThrough`,
> `shareOutFor`) so the meter, the End button and the damage prompt all agree — reading `Qty_Out`
> on a pass-through share would report those pieces as lost and ask what happened to cloth that
> is fine.
>
> **`receiveFromThirdParty` closes SHARES, not stages.** The loss still lands on the last stage of
> the block. It then walks the block forward and closes each stage *only* while two things hold —
> every share on it is Done, and the shares add up to everything the stage received — stopping at
> the first stage where they do not, because that stage's output is the next one's input. A
> whole-stage block therefore closes end to end on the return exactly as it always did, and a
> partial one leaves the stage for the ordinary **End stage** press. That walk keeps the strict
> `Assignment_Status != "Done"` test rather than the pass-through rule above: it is a
> *pre-test* for a convenience, and the stage it declines to auto-close is one the supervisor can
> now close himself.
>
> **`saveStageAssignment` refuses to end, re-size or remove a vendor's share.** Those pieces are on
> a van: the only event that knows what became of them is the return. Removing one would say the
> van never left and free the pieces to be handed out a second time — the one way that screen can
> invent stock from nothing.
>
> **Legacy blocks still work and nothing new goes down that path.** `Stage_Log.Is_Outsourced`,
> `.Third_Party`, `.Sent_On`, `.Outsource_Ref` are no longer written. They are still read, by
> `receiveFromThirdParty` (which branches on where the reference is found, not on a flag), by the
> locked `is-outsourced` card, and by the `STAGE_OUTSOURCED` guards in `saveProductionPhase` and
> `saveStageAssignment` — kept so a van already on the road survives the deploy. Those guards now
> only ever fire on a legacy row.

**Machines are not tracked.** Each operator works a fixed machine, so "which machine" is answered
by "which operator". `Machine_Master` and `Stage_Log.Machine` still exist in Creator holding what
they held; nothing in production reads or writes them, `setStageMachine` is retired, and machines
currently marked `Occupied` will stay that way for ever. `Machine_Master.Applicable_Stages` is no
longer one of the places a new stage name has to be added.

**Sales order statuses** (`Sales_Order.Order_Status`, a different field):
`Pending → In Progress → Production Complete → Checking Passed → Finishing Complete → Packed → Dispatched`.
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

**AFTER CHECKING, THE PLAN IS OVER AND ONLY THE ORDER MOVES.** Finishing and packing are done by
other people, on their own widgets, and neither writes anything on `Production_Planning` or
`Plan_Item`. Three statuses, three writers, each forward only:

| Status | Written by | Only from |
|---|---|---|
| `Checking Passed` | `recheckOrderComplete` | `Production Complete`, `In Progress` |
| `Finishing Complete` | `recheckOrderComplete`, same pass | `Checking Passed` |
| `Packed` | `savePackingRecord` | `Finishing Complete` |

> **`recheckOrderComplete` owns both post-production statuses, in one pass.** The finishing test
> briefly lived in its own `recheckFinishingComplete`, called from here — which put **two levels of
> `thisapp`** between `saveItemCheck` and the finishing test, something nothing else in this app
> does. Folding it in removes that question and the ordering problem with it: there is no longer a
> pair of functions that must be called in the right sequence for an order to reach packing.
> `completeFinishingJob` calls `recheckOrderComplete` too. **Every caller is exactly one level deep.**

> **FINISHING MUST NOT TOUCH `Plan_Item.Item_Status`.** It used to write `Finishing Done` there —
> off-picklist, wrong spelling style — and three readers test that field for exactly `Complete`:
> `recheckOrderComplete` (so the order could never reach `Checking Passed`),
> `saveProductionPhase`'s all-items-done test (so the **plan** stayed `In Progress` for ever, on the
> supervisor's board and in the store's issue list with no work left on it), and
> `getSalesOrderProgress`. The two bugs cancelled: the finishing recheck had a guard whose
> `else if` chain closed before the block it was meant to protect, so every path fell through to
> the write and dragged the order to `Finishing Complete` from wherever it was — including from
> `Packed` and `Dispatched`, which put it in front of the packer twice.
>
> **There is nothing to replace that write with, because the state was never missing.**
> **"This batch is finished" is `Finishing_Data[Item_Check == id]` with
> `Finishing_Status == "Done"`** — five functions ask it (`getFinishingItems`,
> `getFinishingHistory`, `recheckOrderComplete`, `getPackingQueue`, `getPackingDetails`) and
> they must keep asking the same one.
>
> **DONE MEANS DONE; ANYTHING ELSE MEANS THE JOB IS STILL OPEN.** One rule, no third case, and it
> decides which way all six fail. A row carrying neither value — hand-made, a mistyped dropdown
> choice, a write that half landed — reads as *unfinished*: the batch stays on the queue where
> somebody can see it and the order stops short of packing. `!= "In_Progress"` fails the other
> way, silently calling that row finished and walking the order through with a batch nobody
> folded. The three writers apply the same rule from the other side — `startFinishingJob` reuses
> any non-`Done` row rather than adding a second one next to it.

**Finishing is per BATCH, so it usually finishes before the order passes checking.** A finisher can
start the moment a check approves something, while other lines are still being cut. That is why
`recheckOrderComplete` runs the finishing test on **every** pass, not only when it writes
`Checking Passed`. Only on the transition would strand an order that was already `Checking Passed`
when its last batch finished; only on the finishing side would strand one whose last event was a
**check** — a batch that produced nothing, a short close. Both, or an order sits fully folded and
never reaches the packing queue. **`Short_Closed` forgives the quantity test in both halves**, for
the same reason — it is an answer about quantity, not a statement that unfinished work has stopped.

**`Finishing_Data` is the `Stage_Log` of finishing**: one row per `Item_Check`, opened by
`startFinishingJob` when the first stage starts, stamped a stage at a time by `saveFinishingStage`,
closed by `completeFinishingJob`. **Every stamp is the server's clock, taken at the press.** The
widget used to hold all six times in page state until branding closed, so a refresh, a closed tab
or a shift handover lost the job; and one card merged every check sharing an item *name* — a root,
its remake and its alteration batch — stamping all of them with one identical set of times.
**One card per `Item_Check`, which is one pile of garments inspected together.**

`Item_Check.Sales_Order` is only stamped where `saveItemCheck` could resolve one, so anything that
needs the order from a check must fall back through `Item_Check.Plan → Production_Planning`.
Without that, a check that missed it never moves its order and nothing says why.

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

> **AN OUTBOUND DISPUTE HAS EXACTLY THREE ENDINGS, AND TWO OF THEM MEAN THE STORE ISSUES AGAIN.**
> This is the whole point of the mechanism and every change to it has to keep it true:
>
> | | Ending | Requirement re-opens? | Stock back on the shelf? |
> |---|---|---|---|
> | Store's mistake | `Store_Correction` | **yes** | yes — it never left |
> | He found it in the production house | `Found` | no | no — it reached him |
> | Lost | both sides `Denied` | **yes** | no — it is gone |
>
> Correction and Lost differ **only** in whether stock comes back; production needs the material
> either way, so both wind back `Issued_Qty`, `Pieces_From_Raw` (fabric) and `Pieces_From_Waste`
> (remnants), *and* the `Issued` `Waste_Movement` itself. Miss that last one and the handover
> stays on the supervisor's receive screen for ever, the store re-issues into a second movement,
> and the item can never reach `Ready_For_Production` — the readiness test fails while any issued
> movement is unreceived.
>
> **A dispute is raised PER PLAN, and it must name the plan whose rows actually carry the gap.**
> The fan in `receiveMaterials` credits a bulk handover oldest-plan-first, so the shortfall lands
> on the newest rows; a ticket stamped with the first plan that merely had something *owed* points
> at the opposite end of the same walk. Both readers key off it — `getSupervisorMaterials`
> discounts per plan+material, `resolveDispute` re-opens `Material_Requirement[Plan == dsp.Plan]` —
> so naming the wrong plan leaves the material on his receive screen for ever *and* hands the stock
> back while re-opening nothing.
>
> **`receiveMaterials` must net off open disputes exactly as the screen does.** The figure he types
> is already net of them. Reading pending straight off `Issued_Qty - Received_Qty` raises a second
> dispute for material already disputed the moment more of it is issued against the same plan while
> the first is still open — and settles it off `In_Transit_Qty` twice.

> **THE INBOUND LEG IS THE SAME SHAPE REVERSED, and it has FOUR endings, not three.**
> The sender is the supervisor and the receiver is the store, so "the store issues that much
> again" becomes "he sends them again" — `Supervisor_Resending` is the mirror, and it is the only
> ending that puts anything back in front of anybody.
>
> | | Ending | Goes back on the check-in list? | Lands on the rack? |
> |---|---|---|---|
> | His mistake — never cut | `Supervisor_Correction` | no | no, they never existed |
> | Store found them | `Found` | no | **yes** |
> | Lost | both sides `Denied` | no | no |
> | He still has them | `Supervisor_Resending` | **yes** | on the ordinary check-in |
>
> **THE `Declared` MOVEMENT IS THE INBOUND `Issued` MOVEMENT, and it has to match what exists.**
> `getOrderConsumption` reads its `Piece_Count` straight into **waste kept** — the remnants that
> went back on the rack and *will be reused* — plus the area beside it, and
> `getSupervisorWasteReturns` and `getStoreWasteHistory` quote the same number. So
> `Supervisor_Correction` and `Lost` must reduce it, or the report credits the good outcome to
> cloth that does not exist. `Found` must not — the declaration was true. Reduced, **never moved
> to `Scrapped`**: that means deliberately binned, and `Waste_Master.Status` already carries
> `Miscounted` / `Lost`. Fixing the status and leaving the movement is the same mistake one level
> down, and it is the one that was live.
>
> **A resend that splits a declaration across two rows must net to zero.** When the row already
> holds `Available` stock the re-sent pieces get a `Waste_Master` and a `Declared` movement of
> their own — so the same count comes off the original declaration in the same pass. One cutting
> event threw off five remnants however many rows they end up spread across; leave the first at
> five and the report reads 5 + 2 = **seven**, two of them invented by the act of re-sending.
>
> **The inbound leg needs no dispute-netting on receipt.** `receiveWastePieces` only ever moves a
> `Pending_Receipt` row forward, so a piece already in dispute cannot be checked in a second time —
> the status guard does what the open-dispute discount does on the outbound side. Do not "fix" it
> by adding one.

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
| `app/checker/` | Checking — the inspection queue and `saveItemCheck` |
| `app/finishing/` | Finishing — folding / pressing / branding |
| `app/packing/` | Packing — supervisor picker, orders as an accordion, one card per box |

> **PACKING IS ITS OWN WIDGET.** It was briefly a second tab inside `app/finishing/`; it is not
> any more, so the finishing widget does one job. `app/packing/js/main.js` is still written as a
> module (`PackingScreen`) with every element id prefixed `pack-` — that cost nothing to keep and
> is what made sharing a page safe while it lasted. **Almost all its markup is generated in JS**:
> `widget.html` carries a count line and an empty list, and nothing else.
>
> **SUPERVISOR AT THE TOP, ORDERS AS AN ACCORDION.** `getPackingQueue` stamps each order with the
> supervisor off `Production_Planning.Assigned_To`, and the picker filters the list — the same
> move every other screen makes, in the same place in the header. The list is drawn with the
> **shared `item-card` classes** the supervisor and store screens use — `item-serial`,
> `item-title-row`, `item-meta-line`, `chevron`, `item-body` — so the three lists read as one
> product. One order opens at a time, full width.
>
> **A BOX IS A CARD, NOT A TABLE ROW.** A box carries two grains at once — its own carton,
> dimensions and weights, *and* the list of items inside it — and a table row can only draw one of
> them: it either repeats per item and counts the weights twice, or it holds one item and cannot
> hold two. So the box is a card with a small contents table inside it, and the same shape is used
> in History so the thing he built and the thing he reads back are recognisably one object.
>
> **The card is TWO CAPPED COLUMNS** — what the box *is* (carton, packaging, six dimensions) beside
> what is *in* it, weights underneath — laid out with `justify-content: start` so the grid stops
> where its columns stop. Every control was one full-width row to begin with, which on a wide
> screen put a 900-pixel dropdown next to a two-character quantity field and stranded the weight on
> the far side of the card from the numbers it belongs to. **A form reads at a fixed width; the
> card can be as wide as it likes.** They stack below 900px, where a dimension row — a label, three
> inputs and two `×` — stops fitting.
>
> **The solver is gone.** Both packing screens used to guess: a 3D bin-packer in the finishing tab
> and a points table in `app/packing/`. Neither could be right — no garment dimensions exist
> anywhere in this app, so the solver fell back to 10 x 10 x 2 cm for every product and the points
> model to a flat ten pieces a box, which locked the packer out of saving any fuller carton.

**Custom API calls from a widget are NOT metered** — verified empirically; only external/Postman
calls count against the daily quota. Do **not** build router APIs to "save calls"; that advice
was tested and retracted.

**PACKING IS TWO SUBFORMS, TWO GRAINS, AND EVERY PACKING RULE FOLLOWS FROM THAT.**

| Subform | One row is | Holds |
|---|---|---|
| `Packing.Packed_Boxes` | one **physical box** | `Box_No`, `Box_Type`, `Uses_Inner`, the six dimensions actually used, `Estimated_Weight_Kg`, `Gross_Weight_Kg`, `Volumetric_Weight_Kg` |
| `Packing.Packed_Box_Items` | one **item in a box** | `Box_No`, `Line_No`, `SKU`, `Item_Name`, `Quantity`, `Unit_Weight_Kg` |

> **Creator has no subform inside a subform, so the two are siblings joined by `Box_No`** — which
> is why `savePackingRecord` refuses a packing record where two boxes share a number, and why
> `getPackingHistory` reads the items **once** into a map keyed by box rather than querying per
> box. A query per box is fifteen hundred lookups across a page of fifty orders, which is exactly
> the shape that trips the uncatchable statement limit.

> **A BOX MAY HOLD SEVERAL SKUs.** It used to hold exactly one — the inner carton is *branded*
> packaging made for one product — and `SKU`, `Item_Name`, `Quantity` and `Line_No` therefore sat
> on the box row itself. They cannot stay there once a box holds two things: either the box row
> repeats and its weights are counted twice, or the second item has nowhere to go.
> **Those four fields are still on `Packed_Boxes` in Creator and are NO LONGER WRITTEN** — they
> carry the contents of every box packed before the split, and `getPackingHistory` reads them as a
> one-item box when a box has no `Packed_Box_Items` rows. Deleting them blanks the history of
> orders that really shipped. A mixed carton is still an exception on an export packing list and
> must be labelled MIXED; nothing in this app prints that yet.

> **THE INNER CARTON IS OPTIONAL, PER BOX.** Some orders ship in the outer alone. `Uses_Inner`
> records which, so `Total_Inner_Boxes` and `Total_Outer_Boxes` on the parent stop being the same
> number — outer is every box, inner is the ones that had an inner in them, which is the figure
> packaging reorders from. `Box_Master.Has_Inner_Carton` only decides whether the inner fields are
> **seeded** when a carton is picked; a branded inner that has run out on the floor must never need
> a master-data change before the box can ship. An unused inner stores as **zeroes**, not as the
> size it would have been — the record says what went out.

> **`Box_Master` IS AUTOFILL, NOT A CONTRACT.** Picking a carton seeds the six dimension fields on
> the box and stops there; every one stays editable, and what the packer leaves is what is stored
> and what the volumetric weight is computed from. One outer still holds exactly one inner — about
> 1.25 cm clearance a face — so each catalogue record still names both cartons and he still makes
> one choice per box. **Editing never writes back to `Box_Master`**: the catalogue is a starting
> point, and a correction made mid-pack would apply retroactively to nothing and confuse the next
> packer. This is why `savePackingRecord` **validates** the payload's dimensions (every outer above
> zero, every inner above zero when an inner was used) instead of overriding them from the master,
> which is what it used to do.

> **EVERY FINISHED PIECE MUST BE IN A BOX** before packing saves — enforced in
> `savePackingRecord`, not only on screen, because a Custom API is callable from anywhere. The
> finished figure is recomputed from `Item_Check` + `Finishing_Data` rather than trusted from the
> payload, using the same walk `getPackingDetails` does, so packing can never disagree with the
> status that let it be packed. **The SKU, the name and the unit weight are resolved server-side
> from the order line too** — the payload carries only a line number and a quantity, so nothing
> describing an item can arrive from outside.

> **Estimated weight is `Item_Master.Weight` × pieces, and nothing else.** The field is kilograms
> for one *saleable unit* — a napkin set of six is one unit, counted the way this screen counts
> pieces — so it multiplies straight. **No allowance is added for cardboard**: the gap between the
> estimate and the scale *is* the packaging, and burying a tare in the estimate hides it. An item
> with no weight on file estimates as zero and is shown as `—` rather than `0.00`; it never blocks
> a box that is physically packed and weighed.

> **Volumetric weight is `outer L x W x H / 5000`** — what FedEx and Blue Dart bill express
> shipments at, computed from the dimensions **the packer left**, not the catalogue's. It appears
> in `savePackingRecord` (authoritative) and in `app/packing/js/main.js` (live, as he types a
> dimension) and **nowhere else** — `getPackingDetails` no longer computes one, because a
> catalogue volumetric is meaningless the moment a dimension is editable. Air freight uses 6000 and
> some domestic surface 4000, so those are the two places to change. Chargeable weight is the
> greater of actual and volumetric.

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
- **Language semantics CAN be settled, at <https://deluge.zoho.com/tryout>.** No login, no token,
  and it really executes — so any question of the form *"does Deluge do X"* is a two-minute answer
  instead of a hedge in a comment. It has **no forms, no `thisapp`, no records**, so it cannot run
  anything in this repo; it answers about the *language*, not about the app. `return` is rejected
  there ("VOID function can not return any value") — build a string and `info` it.
  > Settled this way, and each one was load-bearing: **`Map.get()` on a missing key returns
  > `null`** (every lazy per-id cache tests exactly this), **relational operators work on dates**
  > (the `Plan_Start_Date` bounds compare with `<`), and **`substring` is valid lowercase**
  > — both spellings appear in this repo and both work.
- **Never claim a Deluge change is verified.** Say what was checked and what needs an Execute.
- **Deluge's reported line number is a hint, not a fact.** It points at the statement that
  *failed*, which is often not the statement that is *wrong*. Isolate first — a per-row
  try/catch that names the record beats reading the reported line.
- **`row` is a reserved word.** A loop variable named `row` fails at Execute with `Variable 'row'
  is not defined` — confirmed live, not a guess. `mrq` (or anything else) works fine.
  `List.toString()`-adjacent oddities aside, `row` specifically is off limits as an identifier.
- **A `List()` built by hand-appending fetched records (`for each x in Form[...] { lst.add(x) }`)
  does NOT reliably survive being iterated later.** Tried as a fix for `issueMaterials` (fetch
  `Material_Requirement` rows once, mutate them across three passes instead of re-querying) and
  failed at Execute with `Invalid collection object found`, reported against a line that was
  nowhere near the actual `for each` — same "line number is a hint" trap as above, at its worst.
  Reverted; not proven impossible, just not proven safe, and this repo doesn't rely on unverified
  Deluge behaviour. If this is ever worth revisiting, settle it at the tryout sandbox FIRST
  (fetch → add to List → read a field back later, in isolation) before writing it into a
  1000+-line write path again.

---

## Scaling work done at real volume — where it stands

Prompted by a real test: 119 sales orders, 111 of them landing on one supervisor (this org's
actual pattern — one supervisor can hold the whole queue). This is not a projection, it is what
Execute returned. Three functions were exercised against it; two are fixed and confirmed, one is
not.

**`createProductionPlans` → replaced by a Batch Workflow.** The single-script version that scanned
`Sales_Order[Order_Status=="Pending"]` and looped in one execution hit the statement limit at
~100 orders (confirmed, not theoretical). Replaced with a Creator **Batch Workflow** on `Sales_Order`
(`On Schedule`, condition `Order_Status=="Pending"`) whose per-record action calls
`thisapp.createPlanForOneOrder(input.ID)` — one script invocation per order, so the ~80-statement
cost of one order never sums across the backlog. `createPlanForOneOrder.dg` is the per-record body;
the old `createProductionPlans.dg` is left in the repo unused, parked in case the batch-workflow
route is ever abandoned. **Notifications are not wired for the batch-workflow path yet** —
`createPlanForOneOrder` writes `Plan_Reject_Reason` and `Batch_Run_Outcome`/`Needs_Plan_Summary`
onto `Sales_Order` per attempt (fields added to the form for this), and `sendProductionPlanSummary`
is meant to read them from the workflow's success-action step and send the run digest + push
notifications the old single-script version used to send inline. This was mid-build when the
session moved on to `issueMaterials` — check `sendProductionPlanSummary.dg` and the batch workflow's
"Configure success action" script before assuming it is finished.

> **A batch workflow's per-record calls do NOT share mutable state.** Tried defining a variable in
> "Before execution starts" and appending to it from "Action to execute for each record", expecting
> it to accumulate across all records in the run and be readable in "Configure success action" —
> confirmed by a real test mail that it does not: the variable came back holding only the LAST
> record's write (`testCount=1` after ~9 records ran). Whatever this scope is for, it is not a
> cross-record accumulator. The durable-field-on-the-record pattern (`Plan_Reject_Reason` etc.) is
> what actually works, because each per-record call, independently, writes to a row that survives
> past that call — no shared memory required.

**`getStoreMaterialRequirements` → fixed and confirmed working at 119 plans.** Was a single
unpaged call; failed at the statement limit once real plan/material/waste volume was reached.
Fixed by:
  1. Two previously-unbounded fetches — `Waste_Master[Status=="Available"]` (no material filter)
     and `Fabric_Piece[Piece_Status=="Available"]` (no lot filter) — scanned the WHOLE form on
     every call regardless of paging. Rebuilt to query per-material and per-lot respectively,
     bounded by `neededMats`/`lotMats` the way every other pass in this function already was.
  2. Paging changed from a **fixed plan-count page** (tried at 30, then 20, then 10 — all proven
     wrong, because statement cost tracks `Material_Requirement` ROW count and rows-per-plan is
     arbitrary, so a fixed plan count is not a fixed amount of work) to a **row-budget walk**:
     `skipCountTxt` in, the function walks plans one at a time up to a `rowBudget` (150) of
     `Material_Requirement` rows, returns `{"plans":[...],"plansConsumed":N}`, and the caller's
     next `skipCountTxt` is `skipCountTxt + plansConsumed`. Contract changed from a bare array to
     that wrapper object — `app/js/main.js` and `app/admin/js/main.js` were both updated to page
     through it and merge by `supervisorId` before rendering (merge, not concatenate — two pages
     can carry a block for the same supervisor).
  - `plan.Sales_Order.Sales_Order` (Deluge lookup dot-notation, reading a linked record's field
    without a separate query) — confirmed working against this org by Execute.
  - `"range from X to Y"` with **variables** for X/Y (not just literals) — confirmed working by a
    throwaway test function.
  - `List(1,2,3,...)` — a literal-argument `List()` constructor — does **not** work
    (`"Not able to find 'List' function"`). Build with `.add()` in a loop instead.

**`issueMaterials` → NOT fixed. Real bug found, fix not yet built.** `matPlanIdx` (which materials
land on which of a supervisor's open plans) was rebuilt the same way as `getStoreMaterialRequirements`'s
fixes — one query per material instead of one per plan×material — and that part is confirmed
working (Execute against 111 real open plans). The remaining problem is structural, not a query
count: `getStoreMaterialRequirements` and the widget already narrow a **fabric** line to specific
plans/items via `lotId`/`planItemId` in the payload (see `issueMaterials.dg`'s own top-of-file
comment on why — grain, tone-matching). **A non-fabric (trim) line carries only `materialId` and a
bulk `qty`, no `planId`/`planItemId`** — so `issueMaterials`' fan has no choice but to walk every
plan in `matPlanFor` for that material to decide which rows absorb the qty. For a common trim
(thread, labels) shared across most of a supervisor's plans, `matPlanFor` is close to the full open
count, and the three passes (pass 1 / pin-lefts / the fan) each re-query per plan — proven to still
blow the statement limit at 111 plans even after the `matPlanIdx` fix, confirmed by Execute.
**Two directions were floated and rejected/parked, not decided:**
  - *Move the fan to the frontend* (pre-compute which rows get how much, send it pre-resolved) —
    rejected: `Issued_Qty` is read-and-written live off the server's own current state precisely so
    two concurrent issues can't race each other into double- or under-issuing (this is the same
    concern the fabric side's per-lot, per-pass server-side accounting already exists to close).
    Pre-computing client-side reopens that race.
  - *Cap `matPlanFor` per call and resume next press* — floated, not built. Concern raised (unverified):
    Custom API calls from a widget are NOT metered per this file's own "Widgets" section, so a
    rate-limit objection to more calls may not actually apply — but the Code 2955 error that
    prompted the objection was never actually identified, so don't assume either way. Check what
    2955 is before designing around it.
  - A resumable-server-side-loop shape (function internally batches across plan-groups within one
    execution, returns "partially issued, press Issue again" only for the one trim line that hit
    budget) was suggested as a middle path that keeps `Issued_Qty` writes server-owned without
    needing more widget round-trips. Not built, not verified.
  **Whoever picks this up next: read `issueMaterials.dg`'s current state before changing it** — it
  was reverted mid-session back to the safe per-plan-requery shape after the caching attempt
  above failed, so the file is in the LAST KNOWN WORKING state for the statement-limit problem
  (confirmed clean of that specific error), just not yet fixed for the trim-fan-at-scale problem.

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
- **Dispatch is not built.** Nothing writes `Sales_Order.Order_Status = "Dispatched"`; `Packed` is
  where the app currently stops.
- **Dispatch has nothing to read yet.** Packing now records every carton, but nothing shows the
  dispatch person the box list, weights and volumetric weights, and nothing writes `Dispatched`.
- **Finishing has no shortfall capture.** `Qty_Finished` is always `Item_Check.Qty_Approved`. A
  piece scorched at the press has nowhere to go, and there is no undo once a job is closed —
  unlike a production stage, which prompts for damage when fewer come out than went in.
- **`packingAutoPopulate` must be DELETED in Creator.** It is a `Packing` form workflow that
  clears and rebuilds `Packing_Items` from `Plan_Item.Qty_Accepted` - a different number from the
  one the widget boxes, and a second writer of a subform that now has one.
- **Scaling debt is found, listed and deliberately unfixed** — see `docs/scaling.md`. Ten
  queries fetch a whole transactional form and get slowly worse as records accumulate; the
  worst is `createProductionPlans` fetching every plan ever to read one integer. None is broken
  today. That doc also records what is already *correct* and must not be "fixed": nothing ever
  scans `Material_Requirement`, the hot path is bounded by WIP rather than history, master-data
  fetch-alls are fine, and the paged history functions are the shape to copy.
- **`resolveStockDispute.dg`** is a legacy form workflow duplicating `resolveDispute`. It has
  none of the current logic. **Delete it in Creator.**
- **`resolveDispute` does NOT wind back `Issue_Lines.Settled_Qty` or `Material_Issue.Issue_Status`,
  and does not move Zoho Inventory on a `Store_Correction`.** Both are pre-existing — the receive
  path settles the WHOLE owed amount into `Settled_Qty` and disputes the gap, so on a
  `Store_Correction` / `Lost` resolution the requirement re-opens (`Issued_Qty` / `Received_Qty` /
  `Pieces_From_*` rolled back correctly) but:
  > 1. the handover's `Issue_Line` still reads `Settled_Qty == Qty` and its voucher still reads
  >    `Issue_Status == "Received"` — the Material Issue Report shows the voucher as fully received
  >    when part of it was corrected back.
  > 2. `postTransferOrders` already moved the disputed metres to Production (they were in
  >    `Settled_Qty − Transferred_Qty`), and `resolveDispute` only queues a `Write_Off` on `Lost`,
  >    not on `Store_Correction` — so after a store-correction Inventory says Production while
  >    Creator says the cloth is back on the shelf.
  >
  > The store/supervisor screen optimisations (allocation-applier issue, settlement-applier
  > receive, per-voucher `Issue_Status`, chunked/resumable finalize) did NOT introduce this — the
  > old fan also settled the full owed amount and the old `resolveDispute` also ignored
  > `Issue_Lines`. The dispute raise/display/net/resolve-requirement paths were all traced and are
  > correct after the optimisation.
  >
  > **To fix later:** `resolveDispute` needs to (a) wind back the oldest matching `Issue_Line`'s
  > `Settled_Qty` by the resolved qty, (b) re-derive that voucher's `Issue_Status` from its lines,
  > (c) queue an Inventory move for `Store_Correction` too. Needs a dispute→voucher link, which is
  > not stored today — `receiveMaterials` would have to stamp the voucher/line id on the
  > `Stock_Dispute` when it raises it.
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
