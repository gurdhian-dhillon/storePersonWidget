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

## Phase 2 — the queue. NEXT

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
