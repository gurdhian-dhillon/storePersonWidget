# Inventory sync — the build plan

Agreed 2026-08-18. This is the **execution** plan: what gets built, in what order, and what is
already done. [inventory-integration.md](inventory-integration.md) remains the design rationale —
read that for *why*. Where the two disagree, this document is newer and wins.

---

## Settled facts

| | |
|---|---|
| Organization id | `60076905558` |
| Data centre | **India** — `https://www.zohoapis.in/inventory/v1/` |
| Creator connection | link name **`inventory_connection`** (display name `Inventory_Connection`) |
| Inventory plan | 2,500 API calls/day, **100/minute per organization** |
| Locations | Head Office · Main Warehouse · Production · Finished Goods Store |

**`connection:` takes a literal link name, never a variable.** Deluge resolves it at save time.
Every new function that calls Inventory types it inline.

---

## Phase 0 — seeding. DONE

- 33 items created in Inventory by CSV import: 23 raw material (`RM-000xx`), 10 finished goods
  (`SKU-000xx`), with custom fields `Product Type`, `Type`, `Pattern`, `Color`, `Fabric Width`,
  `GSM`, `Quality`.
- Opening stock seeded by adjustment import: **29,463.97 units**, ₹1,15,19,533.90, at
  **Main Warehouse**, offset to **`Opening Balance Offset`** (equity — keeps a stock statement out
  of the P&L).
- `Inventory_Item_ID` stamped on 23 `Raw_Material` and 10 `Item_Master` records by
  [mapInventoryItemIds.dg](../deluge/mapInventoryItemIds.dg), matched on SKU.

> Fabric opening stock came from **Wash + Unwash + In_Transit + Disputed**, not the `Quantity`
> column — those disagree on 9 of 12 fabric rows and the app itself reads wash+unwash. Non-fabric
> used `Quantity + In_Transit + Disputed`.

**Left over, not blocking:** 4 `LL00x` raw materials with no Inventory item; ~1,930 unmapped
`Item_Master` rows; most of `Raw_Material`'s 210 rows carry no SKU at all.

---

## Phase 1 — Inventory → Creator, sales orders. MOSTLY DONE

An Inventory workflow rule (`SynctoCreator`) posts new sales orders to the Creator Custom API
`syncSingleSalesOrder`. [That function](../deluge/syncSingleSalesOrder.dg) now:

- writes **`Order_Status = "Pending"`** — without it the order is invisible to
  `createProductionPlans`, which queries exactly that string
- resolves **`Order_Source`** to one of `Shopify` / `Faire` / `Custom` / `PR`, storing empty rather
  than guessing, because an unranked source sorts **last** silently
- **skips drafts and voids**
- checks every line resolves to `Item_Master` and has **exactly one** BOM
- mails the admin only when something is wrong, before the planner runs

**Supervisor assignment is not done here.** `createProductionPlans` resolves it from
`Order_Assignment[Order_Source == …]` at plan time, which is fresher and keeps one writer.

### Still to do

- A second workflow rule firing on **edit**, reusing the same webhook action, so a draft that is
  later confirmed syncs without a manual Resend. The `Inventory_sales_order_Id` duplicate check is
  what makes firing on every edit safe.
- Optional: a scheduled sweep that asks Inventory for confirmed orders it hasn't seen. Worth having
  regardless — webhooks get missed.
- **Cancellation is unhandled.** A void in Inventory after sync leaves Creator planning and issuing
  against a dead order. Needs a business decision about what cancel means once cutting has started.

---

## Phase 1b — purchased material arriving. RUNNING

Taken out of order and built before the queue, because it is the half that unblocks the store:
purchasing happens entirely in Inventory today and Creator never hears about it.

```
purchase + arrival in Inventory
  → syncPurchaseInflow reads the arrival document
  → fabric      → Raw_Material.Unallocated_Qty
    non-fabric  → Raw_Material.Quantity
  → store person drains Unallocated in the "Unallocated quantity" tab, giving it a lot
```

**The consuming half already existed.** [saveStockInward](../deluge/saveStockInward.dg#L228) has
always taken its quantity out of `Unallocated_Qty` before raising the parent total, `getStoreLots`
already returns the figure and the widget already renders the tab. `lots.md` called this "the
Inventory seam" and left it holding zero. This is the feeder it was built for; nothing downstream
changed.

**Fabric does not go into a lot, and that is the whole point.** A lot is a *tone*, and nobody has
looked at the cloth yet. Unallocated stock is deliberately unissuable — promising cloth of unknown
tone to an order is the exact mistake lots exist to prevent.

### Which document is the arrival

Zoho raises stock on **one** of two documents, never both: the **Purchase Receive** if receives are
switched on, otherwise the **Bill**. Reading both double-counts every arrival; reading the wrong one
sees nothing ever land. Both failures are silent.

`inflowSource` in [syncPurchaseInflow.dg](../deluge/syncPurchaseInflow.dg) is a **constant**, set
once from [probePurchaseInflow](../deluge/probePurchaseInflow.dg)'s verdict. Auto-detecting per run
would let the mode flip underneath live data. The tell is on the bill, not the receive: a bill line
raised after a receive carries `receive_item_id`. A `Bill`-mode line that carries one is refused as
`Skipped_Duplicate` rather than trusted — that combination means the org setting changed.

> **SETTLED, 2026-08-24, by running the probe against the live org.** `PR-001` → `BILL-0001`, and
> the bill's single line carries `receive_item_id` pointing at the receive's line. So
> **`inflowSource = "Receive"`**, and bills must never be read for stock on this org.

**A receive carries two statuses and only one of them answers the question.** The live receive read
`status: "billed"` with `received_status: "received"` — `status` runs on to `billed` once the money
side happens and stops saying whether the cloth arrived. The sync tests `received_status` when it is
present, and keeps the `status` blacklist (`in_transit`, `draft`, `void`, `cancelled`) for the case
where it is not.

### `Inventory_Inflow` — the ledger, one row per (document, line)

| Field | Type | Holds |
|---|---|---|
| `Doc_Type` | Dropdown | `Purchase_Receive`, `Bill` |
| `Doc_ID` · `Doc_No` | Single line | the Inventory document |
| `Doc_Date` | Date | what the window and the cutover are tested against |
| `Doc_Modified` | Single line | `last_modified_time` as read; the unchanged-document test |
| `Line_ID` | Single line | `line_item_id` |
| `Inventory_Item_ID` | Single line | |
| `Material` | Lookup → `Raw_Material` | empty while unmapped |
| `Doc_Qty` | Decimal | what the document says **now** |
| `Applied_Qty` | Decimal | what Creator has actually taken in |
| `Target` | Single line | `Unallocated` or `Quantity` |
| `Location_ID` | Single line | |
| `Sync_Status` | Dropdown | `Applied`, `Unmapped`, `Skipped_Duplicate`, `Skipped_Not_Raw_Material`, `Blocked_Reduction` |
| `Note` | Multi line | |

`Sync_Status`, not `Status` — six forms already share that link name and a grep for `.Status = "`
mixes all of them.

**Why a ledger and not a last-synced timestamp.** Everything difficult falls out of the one shape:

- **Applied exactly once.** The row *is* the record that it landed — no window, no clock skew.
- **An edited receive is a delta.** 200 corrected to 180 applies −20, because the row remembers the
  200. Posting the total would add 180 on top of 200. Same rule as the finished-goods post.
- **A deleted line reverses.** It is a key the ledger has and the document no longer does.
- **Provenance.** "Where did these 200 metres come from" stays answerable, which it is not once a
  number has been added to a field.

### A purchased item Creator has never heard of

Without this the store is blocked on somebody noticing an `Unmapped` ledger row and hand-building a
`Raw_Material` before any of that cloth can be given a tone. Purchasing buys new materials
routinely, so that is the normal case, not the exception. It resolves in three ways, in order, and
only the last writes a new record:

1. **A `Raw_Material` already carries this SKU but no `Inventory_Item_ID`** → stamp it and use it.
   This is the `mapInventoryItemIds` case arriving one material at a time. **Creating a second row
   here would split one material in two** — two SKUs, two stock balances, and every BOM pointing at
   the empty one. Matched upper-cased and trimmed, the same way lot numbers are.
2. **Inventory says it is not raw material** → `Skipped_Not_Raw_Material`, and never retried.
   Unmapped re-opens its document every run because it is waiting on somebody; this is not waiting
   on anybody. A finished good belongs to `Item_Master`, and creating it here would put a garment on
   the store's issue screen as cloth.
3. **Mint it**, with the same field list `sendToPrint` uses — `Name` inside the insert block because
   it is mandatory, every quantity at zero. The arrival then lands through the ordinary path, so a
   material minted here and one mapped by hand are applied by exactly the same code, **on the same
   run**.

> **`Product Type` IS MATCHED BY `customfield_id`, NEVER BY LABEL.** Custom fields come back only
> inside a `custom_fields` array of `{customfield_id, label, value}` — there are no `cf_` keys.
> Matching on the label means renaming the field in Inventory silently unclassifies every item, and
> the first symptom is purchases quietly no longer landing. The ids come from
> [probeItemCustomFields](../deluge/probeItemCustomFields.dg) and are constants at the top of the
> sync. **While `cfProductType` is empty nothing is ever created** — an item that cannot be
> classified is refused and says why rather than being guessed at.

Refused, each with the reason on the ledger row: no `Product Type` set, no SKU (the join key
everywhere — a `Raw_Material` without one cannot be found again), no name (mandatory on the form).
All of these re-open their document every run, so filling the gap in Inventory is enough.

**A fabric with no width still lands.** The cloth is really on the rack and saying so is right, but
the cut calculation divides by `Fabric_Width_Inches`, so the run report and the ledger note both
shout about it and `createdWithoutWidth` counts it. It must be set by hand before the material can
be planned.

### Rules that are load-bearing

> **THE CUTOVER DATE IS NOT OPTIONAL.** Creator's opening balances were seeded from Creator's own
> figures, and Inventory already holds purchase documents from before this function existed. Without
> a floor the first run reads every one of them as an arrival and puts months of history on the rack
> a second time. `cutoverDate` **must be set to the go-live day before the first real run.** Too
> late is the harmless direction: an arrival is not seen, the store person says so, the date moves
> back.

> **NEVER COMPARE TOTALS.** `reconcileRawMaterial` already reads `stock_on_hand` per SKU and knows
> the difference; turning it into a writer would be a dozen lines and is the worst thing that could
> be built here. Consumption posting is **switched off** — `receiveMaterials` no longer enqueues one
> — so every supervisor receipt lowers Creator and leaves Inventory untouched. A balance-driven sync
> would read that growing gap as material arriving and credit cloth that was cut last week, for
> ever. Document driven, always.

> **A REDUCTION STOPS AT ZERO AND NEVER TOUCHES A LOT.** Once cloth has a tone it is in a lot, and
> which lot loses metres is a decision only the store person can make — he can see the rack. Taking
> it off a lot here would be the system choosing a tone. The reduction takes what `Unallocated_Qty`
> still holds; the remainder is recorded at `Blocked_Reduction` with the ledger keeping the unapplied
> part, and is re-attempted every run until it clears.

- **An in-transit receive moves nothing.** Zoho holds it against the order until it is marked
  received — the same distinction this app already makes between issue and receipt.

> **EVERY LOCATION COUNTS, and the first real receive is why.** This was written to accept Main
> Warehouse only, on the reasoning that a receive into Production is not cloth at the store counter.
> The org's first purchase receive landed at **Head Office** (`3955559000000032097`) and would have
> been silently dropped — the worst shape this can fail in, because a skipped arrival is
> indistinguishable from no arrival.
>
> The deeper reason is the identity itself: `reconcileRawMaterial` compares Creator against
> `item.stock_on_hand`, which is the **org-wide** total, and Creator has no location concept
> anywhere in it. Cloth received at any location is inside the number Creator is measured against,
> so ignoring a location guarantees permanent drift nothing can explain. A purchase receive only
> ever exists against a purchase order, so it is newly bought stock whatever door it came through.
> The location is **recorded** on the ledger row rather than acted on.
- **An unmapped line applies nothing and says so**, rather than refusing the whole document the way
  `postTransferOrders` refuses a voucher. The ledger row makes the gap visible and it lands in full
  on the next run once `Inventory_Item_ID` is stamped — a per-line record can be self-healing where
  a stamp on a document cannot.
- **`Unmapped` and `Blocked_Reduction` re-open their document** even though `last_modified_time` has
  not moved. Both wait on something outside Inventory, and without this the unchanged-document
  shortcut would skip them for ever while the ledger cheerfully said they had been seen.

### What triggers it

**`runPurchaseInflow` is the only entry point any automatic caller uses.** No arguments, on
purpose: `syncPurchaseInflow` takes a `dryRun` string, and a webhook URL with that parameter
missing or mistyped runs as a dry run for ever — landing nothing while reporting success. A
no-argument Custom API cannot be called wrong. `syncPurchaseInflow` stays directly runnable from
Execute, which is the debugging path.

| Trigger | What it is |
|---|---|
| **Purchase Receive workflow → webhook** | Inventory-side, automatic, on Created or Edited |
| **"Check for arrivals" button**, Unallocated tab | The store person, standing at the rack |

The webhook is a bare POST to `runPurchaseInflow` with **no parameters and no body that matters**.
It does not tell the sync which receive landed and does not need to — the ledger works that out.
That is what makes it safe to fire on every receive, as often as it likes.

**Created or Edited, no other criteria.** Create alone would miss a receive corrected from 200 to
180 after the fact; the sync applies the −20 correctly but has to be told to look. A fire where
nothing changed costs one list call and applies nothing, which the `unchanged` counter shows.

> **THERE IS NO LOCK, AND THAT IS A DECIDED RISK.** Two overlapping runs would both read
> `Applied_Qty = 0` for the same line, both compute the same delta, and both apply it — crediting
> cloth twice. It does **not** self-correct: the next run finds the document and the ledger
> agreeing, so nothing is left to notice it, and only `reconcileRawMaterial` would show the drift.
>
> Skipped because the window is the two or three seconds a run takes, and this factory books a
> handful of receives a week. **Add it when receives start being booked in batches or by more than
> one person, or when a second automatic trigger is wired** (a bill rule, a schedule, Zoho Flow).
>
> The shape: a `Sync_Lock` row taken before the work and released after, with staleness as a stored
> day plus a **minute-of-day integer** rather than datetime arithmetic — the one path that cannot
> release a lock is the statement-execution limit, and a lock is the wrong place to find out how
> `subMinute` behaves. It would not be atomic either (Deluge has no test-and-set), so it narrows
> the window rather than closing it. Adding it touches `runPurchaseInflow` and a new form only, and
> **never the webhook** — which is why the no-argument wrapper exists separately from the locking
> question.

### A deleted purchase receive is NOT reversed

The sync reverses a line that vanishes from a document it opens, but a document deleted outright is
never opened, so its ledger rows are never touched and its stock stays credited in Creator for ever.
A Delete trigger on the webhook does not fix it — the fix belongs in the sync: sweep for ledger
documents inside the window that are absent from Inventory's list, and reverse those, guarded so a
truncated list page (`listed >= 200`) can never be mistaken for a mass deletion. Not built.

### Call cost

One list call per run in the steady state. A document is only opened line by line when the ledger
has never seen it or its `last_modified_time` has moved, so an unchanged history costs nothing
however long it gets. `maxDetail` (12) bounds a bad day and the rest waits for the next run —
the statement limit is not catchable and shows as a bare 500 with no error card.

### Still to do

- ~~Run `probePurchaseInflow` and set `inflowSource`~~ — done, `Receive`.
- ~~Create `Inventory_Inflow`~~ — done. First real run: 2 calls, 1 document, 1 `Unmapped` line
  (`HeliosZoho test item`), nothing moved.
- Run `probeItemCustomFields` and set the seven `customfield_id` constants. Until `cfProductType`
  is set, auto-create refuses everything and says so.
- Set `cutoverDate`.
- Deploy `runPurchaseInflow` as a Custom API with **no parameters**, and redeploy the store widget.
- Point the Inventory Purchase Receive workflow webhook at it, Created or Edited.
- Deferred, deliberately: the lock, the deleted-receive sweep, the daily Creator sweep. None is
  needed at this volume, and `reconcileRawMaterial` is what would report a miss.

---

## Phase 2 — the queue

New form **`Inventory_Post_Queue`**:

| Field | Type | Holds |
|---|---|---|
| `Post_Type` | Dropdown | `Consumption`, `Write_Off`, `Finished_Goods` |
| `Post_Status` | Dropdown | `Pending`, `Posting`, `Posted`, `Failed`, `Abandoned` |
| `Source_Form` | Single line | `Material_Requirement`, `Stock_Dispute`, `Plan_Item` |
| `Source_Record` | Single line | the Creator record id behind the post |
| `Inventory_Item_ID` | Single line | the Inventory item to adjust |
| `Quantity` | Decimal | always **positive** — the drain applies the sign |
| `Reference_No` | Single line | the batch reference, written **before** the call |
| `Attempts` | Number | |
| `Last_Error` | Multi line | |

**Nothing is stamped on the source forms.** Rows are deleted once posted, so the queue holds only
unfinished work and its record count *is* the backlog depth.

### Why `Posting` exists

Deleting on a successful response is not enough on its own:

```
POST succeeds   →  Inventory has deducted 400m
                   ↓  statement limit kills the script (uncatchable)
delete rows     →  never runs
next run        →  rows still Pending  →  posts again  →  800m deducted
```

So the batch reference is written onto every row **before** the call. Any crash therefore leaves
rows at `Posting`, and the next run asks Inventory *"did reference `CR-Consumption-…` land?"* — one
GET, only ever when recovering. Landed → `Posted`. Not landed → back to `Pending`.

Each run then deletes last run's `Posted` rows, so a row lives at most one extra cycle.

`Failed` means structurally bad — no item id, or a non-positive quantity — and is never retried.
A row whose *API call* failed goes back to `Pending` with `Attempts` incremented, and only becomes
`Abandoned` once attempts run out. Otherwise a transient outage would permanently park every post
made during it.

Batches are capped at **40 events**, because each batch now writes every row twice (mark, then
settle) and the statement limit is the real ceiling — not the API.

`Post_Status`, not `Status` — six forms already share that link name and a grep for `.Status = "`
mixes all of them.

### The drain, `postInventoryQueue`

Scheduled every 10–15 minutes. **One adjustment per (reason, account, location) group**, so a
backlog of 200 rows is still 1–3 calls, not 200.

Rules it must hold:

- **`quantity_adjusted` (a delta), never `new_quantity_on_hand`.** Absolute values race with the
  purchase team: if they receive 500m between our read and our write, an absolute post erases it.
  Deltas compose, and only deltas can be batched or aggregated.
- **Aggregate by item before posting.** Four receipts of one SKU is one line, summed.
- **`Attempts` → `Abandoned`** after N failures, or one malformed payload retries every 10 minutes
  for ever.
- **On a batch failure, retry those rows individually** on the next run. A batch is all-or-nothing,
  so one bad line fails fifteen good ones and hides which was at fault. Isolating costs calls, but
  only after a failure, never routinely.
- **Keep `Posted` rows. Do not delete them.** `Inventory_Doc_ID` is the only thing tying a batched
  adjustment back to the receipts inside it. Purge after 90 days if it ever matters; ~50 posts a day
  is ~18k rows a year and nothing ever scans the whole form.

> **The queue row is written LAST, after the Creator records.** If the queue row lands and the
> Creator writes then fail, Inventory is told about consumption that never happened — it believes
> stock is gone that is still on the shelf, and nothing contradicts it. The other way round,
> Inventory is merely behind by one event, which is exactly what the daily reconciliation catches.
> Under-deducting is visible and recoverable. Over-deducting invents consumption.

---

## Phase 3 — raw material consumption

Hooks, all through the queue:

| Event | Function | Post |
|---|---|---|
| Supervisor confirms receipt | `receiveMaterials` | −confirmed qty |
| Dispute → `Found` | `resolveDispute` | −disputed qty |
| Dispute → `Lost` | `resolveDispute` | −disputed qty, as a write-off |

| | Consumption | Write-off |
|---|---|---|
| Reason | `Consumed in production` *(add)* | `Stock Written off` *(exists)* |
| Account | `Raw Materials And Consumables` | `Other Expenses` |
| Location | Main Warehouse | Main Warehouse |

**Nothing else posts.** Issuing is an internal movement, offcuts are Creator-only, wash is a
Creator-only split, `Store_Correction` never left the shelf.

---

## Phase 4 — finished goods

**Posted at finishing completion, per line item, as a delta.**

Not at checking — pieces can still be lost before they are real stock. Not at packing — under A4
packing is a *shipping* act that Inventory performs as a Package/Shipment, which **deducts**; the
stock has to exist before that. So:

```
finishing completes  →  +qty into Finished Goods Store
Inventory ships      →  −qty, by Zoho's own Package/Shipment
```

**Per line, not per completed order.** Inventory on-hand should say what physically exists, not what
is commercially releasable. 200 finished napkins held back because the order's quilts are stuck in
remakes makes Inventory simply wrong for as long as the slowest item takes. The obvious objection —
"those are committed to an order" — is already handled: Inventory tracks committed stock against
sales orders separately from on-hand.

**A delta, tracked.** `Qty_Accepted` is cumulative across QC rounds, so a second round would re-post
the first round's pieces. Needs `Qty_Posted_To_Inventory` on `Plan_Item`; post
`finished − already posted`.

| | |
|---|---|
| Reason | `Production output` *(add)* |
| Account | `Raw Materials And Consumables` — same as consumption, so the conversion nets |
| Location | Finished Goods Store |

---

## Phase 5 — the pull

Scheduled every 15 minutes. Only records changed since the last run (`last_modified_time`), paged at
200. Refreshes the `Raw_Material` stock replica and stamps `Last_Synced`.

**No screen ever calls Inventory.** Reads come from Creator's own fields. The store screen shows the
**age** of the figure — a stale cache that looks live is the dangerous failure, because if the
scheduler dies nothing visibly breaks, the numbers just quietly stop moving.

---

## Phase 6 — reconciliation

Daily, off-hours. Per SKU:

```
Inventory on-hand = SUM over that SKU's lots of ( Unwash + Wash + In_Transit + Disputed )
```

It **reports** differences and never silently corrects them. A silent correction hides the bug that
caused the drift, and the drift is always caused by something worth knowing about.

---

## Phase 7 — dispatch mirror

Pull `Dispatched` down from Inventory shipments onto `Sales_Order.Order_Status`. Closes one of the
deliberate gaps in CLAUDE.md for free, since nothing in this repo writes `Dispatched` today.

---

## The accounting shape

Raw material consumed and finished goods received hit the **same account**, so the conversion nets
out and only the sale posts COGS:

```
consume linen      →  Raw Materials And Consumables  +₹50,000
finish garments    →  Raw Materials And Consumables  −₹60,000
sell garments      →  COGS  +₹60,000    ← posted by the sales side, once
```

Posting consumption to COGS instead would count the same cloth twice: once as raw material, again
inside the finished garment's cost on sale. Write-offs deliberately do **not** net — a real loss
belongs on its own line.

> **Two COGS accounts exist in the chart:** `Cost Of Goods Sold` and `Cost of Goods Sold`. The API
> matches the exact string. Delete or rename one before either has activity.

---

## Call budget

| | Calls/day |
|---|---|
| Consumption posts, batched | 1–3 per drain run |
| Finished goods, batched | 1 per drain run |
| Drain, every 15 min | ~96–144 |
| Reconciliation | ~5 |
| **Total** | **~150, or 6% of 2,500** |

**The daily cap is not the constraint. The 100/minute rate is** — and only in bursts: a drain
clearing a backlog, or a one-off backfill. Batching by (reason, account, location) is what keeps a
backlog cheap; the per-run cap is the backstop.

---

## Open decisions

1. **Confirm the consumption account** with whoever owns the books. The double-count trap above is
   the thing to show them. It is one constant in the drain, but changing it after posts exist leaves
   earlier entries stranded elsewhere.
2. **Finishing copies the check quantity** (`Qty_Finished = checkQty`) rather than counting. A piece
   damaged after checking has nowhere to be recorded, and Inventory would receive a garment that does
   not exist. Decide whether finishing should confirm the count before this goes live.
3. **Order cancellation** — see phase 1.
4. **Creator trial expires 2026-08-27.** The external-call quota the drain and pull consume depends
   on the plan landed on.
