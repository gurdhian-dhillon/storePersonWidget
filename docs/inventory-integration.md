# Zoho Inventory integration — plan

Agreed 2026-08-13. Creator and Inventory are the same Zoho org, synced over the REST API.

## Decisions this is built on

- **Inventory on-hand means real quantity we still hold.** Raw material is deducted when the
  supervisor *confirms receipt*, not when the store issues it — the same rule the app already
  runs on. Between issue and confirmation the cloth is on a trolley and still ours.
- **Offcuts never touch Inventory.** Waste is a Creator-only concept. Fabric is consumed once,
  at first supervisor receipt; reuse of a remnant costs nothing and posts nothing.
- **One writer per number.** Every stock figure has exactly one system allowed to change it.
  This is the rule that keeps the two from drifting, and everything below is derived from it.
- **Creator reads a replica, not the live API.** Screens read Creator's own fields; Inventory is
  called at the moment stock actually moves, and on a schedule to refresh the replica.
- **Lots live in Creator** — see `lots.md`. Inventory syncs at SKU level and its per-SKU total
  equals the sum of that SKU's Creator lots.
- **Lot management is built first, before any sync.** Lots are meaningless to Inventory, so there
  is nothing to coordinate; and the sync's job is to move a total that lots must already exist to
  receive. `lots.md` is therefore the current work and this document is the one that follows.

> **After the deduction, the cloth is still physically in the building** — in the cutting room.
> "On hand" therefore means *raw material we still hold as raw material*, not *material inside the
> four walls*. Anyone doing a physical count will find fabric Inventory says is gone. That is
> ordinary WIP behaviour; it is written down here so it is not reported as a bug later.

## Ownership

| Number | Owner | Changed by |
|---|---|---|
| Item catalogue, cost, purchase history | **Inventory** | purchase team |
| Raw material on-hand (total per SKU) | **Inventory** | purchase receipt, our consumption posts |
| Which lot, and its balance | **Creator** | store receipt of goods, issue, supervisor receipt |
| `Unwash_Quantity` / `Wash_Quantity` split | **Creator** | `completeWashRequest` |
| `In_Transit_Qty`, `Disputed_Qty` | **Creator** | issue, receipt, dispute resolution |
| Offcut stock (`Waste_Master`) | **Creator** | the whole waste loop |
| Finished goods on-hand | **Inventory** | our QC-acceptance posts, dispatch |

**The sync must never write a Creator-owned field.** A pull that overwrote `In_Transit_Qty`
because Inventory "says 400" would erase material sitting on a supervisor's trolley. The pull
touches the total-on-hand figure and the catalogue; nothing else.

The identity that ties the two together:

```
Inventory on-hand (raw material, per SKU)
    = SUM over that SKU's lots of ( Unwash + Wash + In_Transit + Disputed )
```

That equation is the reconciliation. If it does not hold, something is wrong — it is not a
tolerance to be tuned.

## The posting map

Every event that moves stock, and exactly what goes to Inventory. Nothing else posts.

| # | Event | Creator hook | Posted to Inventory |
|---|---|---|---|
| 1 | Goods arrive, store creates/tops up a lot | new inward screen | nothing — Inventory already knows from the PO receipt |
| 2 | Store issues to supervisor | [issueMaterials.dg:730](../deluge/issueMaterials.dg#L730) | **nothing** — internal movement |
| 3 | Supervisor confirms receipt | [receiveMaterials.dg:152](../deluge/receiveMaterials.dg#L152) | **−confirmed qty** (consumption) |
| 4 | Dispute → `Found` | [resolveDispute.dg:569](../deluge/resolveDispute.dg#L569) | **−disputed qty** — it did reach production |
| 5 | Dispute → `Store_Correction` | same | **nothing** — never left the shelf, `restore` puts it back |
| 6 | Dispute → `Lost` | same | **−disputed qty, as a write-off** — a real accounting event |
| 7 | Wash completes | [completeWashRequest.dg:95](../deluge/completeWashRequest.dg#L95) | **nothing** (assumption A2) |
| 8 | Offcut declared / received / scrapped | the waste loop | **nothing** — decided |
| 9 | QC accepts pieces | [createRemakeItems.dg:151](../deluge/createRemakeItems.dg#L151) | **+accepted delta** (finished goods) |
| 10 | Order dispatched | — none exists | handled *in* Inventory, mirrored back (assumption A4) |

Three of these deserve their own note.

### 3 — the consumption post

[receiveMaterials.dg:152-183](../deluge/receiveMaterials.dg#L152) already computes both numbers
the post needs: the settled quantity and `shortBy`. Confirmed = settled − short. **Only the
confirmed part is consumed**; the short part stays on hand in Inventory because it is still ours
until the dispute says otherwise.

### 9 — finished goods must be a plain item, posted as a delta

Two traps here, both of which corrupt stock silently.

**Never model the finished good as a composite/bundle item.** Assembling a composite makes
Inventory deduct its components — and we already deducted the fabric at step 3. The garment is an
ordinary item receiving a positive adjustment; the BOM stays entirely in Creator.

**Post the delta, not the total.** `Qty_Accepted` is cumulative across QC rounds — a rejection
creates remakes and a *second* `Quality_Check` is raised against the same order, and round two
adds to the same field ([createRemakeItems.dg:151](../deluge/createRemakeItems.dg#L151)). Posting
on the `QC Passed` status flip instead would be all-or-nothing and would post round one's pieces
twice. So `Plan_Item` gets a new field:

| Field | Meaning |
|---|---|
| `Qty_Posted_To_Inventory` | how many accepted pieces have been received into Inventory so far |

and the post is `Qty_Accepted − Qty_Posted_To_Inventory`, written back on success. That field is
also what makes the post safely re-runnable.

### 10 — dispatch belongs in Inventory

**Nothing in this repo writes `Dispatched`.** Packing exists; dispatch does not. Rather than build
a dispatch widget to then mirror into Inventory, dispatch should *happen* in Inventory as a
Package/Shipment against its Sales Order — that is what Inventory is for, and it drives invoicing
too. Creator's `Sales_Order.Order_Status = "Dispatched"` becomes a mirrored value, pulled down by
the sync.

This closes one of the deliberate gaps in CLAUDE.md for free.

## Sync mechanics

### Reads — replica, refreshed on a schedule

Screens read Creator's own fields. **No screen ever calls Inventory.**
[getStoreMaterialRequirements.dg:352](../deluge/getStoreMaterialRequirements.dg#L352) loops per
material, 20–40 of them; one call each, per refresh, per store person, is roughly 1,800 external
calls a day and a screen that takes 20+ seconds to paint. It would hit Creator's 6-concurrent and
50-per-minute throttles long before the daily cap, and risk the **non-catchable** statement limit.

Instead: a scheduled function every 10–15 minutes pulling **only records changed since last run**
(`last_modified_time` filter), paginated at 200 per page. Typical cost is 1–2 calls per run,
~100–150 a day for the whole factory.

`Raw_Material` gets `Inventory_Item_ID` and `Last_Synced`. **The store screen shows the age of the
figure.** A stale cache that looks live is the dangerous failure — if the scheduler dies nothing
visibly breaks, the numbers just quietly stop moving.

### Point check — at the moment of commitment only

When Issue is pressed, one call for *the specific materials in that handover* to confirm the
balance before decrementing. One to three calls per action rather than forty per render. This is
what protects against someone having adjusted stock in Inventory five minutes ago.

### Writes — immediate, never batched

Every post in the map above goes out at the moment the Creator record is written. A batch window
is a window in which Inventory does not know material moved, and any reconciliation running inside
it reports a false difference.

### Idempotency and failure

Deluge has no transactions. If the Creator record is written and the Inventory post then times
out, the two disagree and nobody knows. So:

- **Every post carries the Creator record id as its reference.** A retry that finds the reference
  already posted does nothing rather than posting twice.
- **A failed post is queued, not swallowed.** A new `Inventory_Post_Queue` form holds pending and
  failed posts with their payload, attempt count and last error; a scheduled function drains it.
- **The queue depth must be visible**, with an alert when it backs up.

> This is deliberately *not* the pattern used for the audit write at
> [issueMaterials.dg:773](../deluge/issueMaterials.dg#L773), which swallows its failure. Losing an
> audit row is bad but the handover still happened; losing a **stock post** means the two systems
> permanently disagree. Audit failures are logged, stock failures are retried.

### Reconciliation

A daily off-hours function checks the identity at the top of this document per SKU and **reports**
differences — it never silently corrects them. A silent correction hides the bug that caused the
drift, and the drift is always caused by something worth knowing about.

## Quotas, for sizing

**Inventory:** 100 requests/minute per organization — fixed, does not rise with the plan. Daily
cap by plan: Free 1,000 · Standard 2,500 · Professional 5,000 · Enterprise 10,000 · Premium
75,000 (Zoho's KB; the API intro page says 10,000 for Premium — confirm under Settings →
Subscription). Over the limit returns 429.

**Creator:** every `invokeurl` is one **External Call** against the Creator plan's external-calls
quota — a different bucket from Developer/Custom API. Throttle: 50 calls/minute per user, 6
concurrent per account. It counts executions, not statements, so an `invokeurl` inside a loop over
40 materials is 40 calls. Both quotas reset at 00:00 in the super admin's timezone.

Widget → Custom API calls remain unmetered, as established. It is only the outbound leg that costs.

Estimated steady-state usage: ~150 scheduled + ~50–100 event posts and point checks per day. Well
inside every plan, *provided no screen ever reads through*.

## Build order

Each phase is useful on its own and nothing breaks between them. **Phase 0 is `lots.md` and is
not optional** — the sync moves a SKU total that has to have somewhere to land.

0. **Lot management in Creator**, against existing data. See `lots.md`.
1. **Item mapping.** `Inventory_Item_ID` on `Raw_Material`, matched by SKU, plus a report of
   items that failed to match. Read-only, no posting. This is where we find out how clean the
   SKU data really is.
2. **The pull.** Scheduled delta sync of catalogue + on-hand into the replica, `Last_Synced`
   stamped, age shown on the store screen. Still no posting — Inventory is untouched.
3. **The queue.** `Inventory_Post_Queue` and its drain function, with a manual test post.
   Built before anything depends on it.
4. **Raw material consumption** — postings 3, 4 and 6, through the queue. The first real write.
5. **Reconciliation report.**
6. **Finished goods** — `Qty_Posted_To_Inventory` on `Plan_Item` and posting 9.
7. **Dispatch mirror** — pull `Dispatched` down from Inventory shipments.

Lots land alongside phase 1–2: the inward screen creates them, and phase 2's pull validates the
per-SKU total against their sum.

## Assumptions, pending confirmation

These are written into the plan above. Each one changes real work if it is wrong.

- ~~**A1**~~ — **settled.** Fabric items exist in Inventory (`RM-00050`…), classified by a custom
  field **`Product Type`** with exactly two values, `Raw Material` and `Finished Goods`. SKU codes
  match Creator's own convention, so **SKU is the join key**. A second custom field, `Type`
  (`Fabric` / `Printed fabric`), maps onto Creator's `Is_Fabric`.
- **A1b — every item reads `0.00` stock. Inventory has the catalogue but no quantities.** So the
  opening balances are in *Creator*, not Inventory, and there is a **seeding step** before
  Inventory can own the total: push each SKU's `Unwash + Wash + In_Transit + Disputed` up as an
  opening stock adjustment, once. **This must happen before the first consumption post**, or the
  first supervisor receipt deducts from zero. The alternative — a physical count entered in
  Inventory, with Creator's lots rebuilt to match — is more honest if today's Creator figures are
  suspect. Not yet chosen.
- **A2 — one Inventory item per fabric SKU**, with the unwash/wash split staying Creator-only. If
  washed and unwashed are two Inventory items, wash completion becomes a transfer posting and
  every raw-material post has to name which of the two it means.
- ~~**A3**~~ — **settled**, by the `Product Type` custom field above. Note it is *not* Zoho's
  native `product_type` (`goods`/`service`) despite the near-identical name — both will be present
  in the same payload, reading `"Finished Goods"` and `"goods"` respectively. **Custom fields come
  back only inside a `custom_fields` array of `{customfield_id, label, value}`; there are no `cf_`
  keys, and they are not filterable through the List Items API.** Match on `customfield_id`, never
  on the label, or renaming the field silently unclassifies every item.
- **A4 — dispatch happens in Inventory** and is mirrored down, as above.
- ~~**A5**~~ — **settled, in the larger direction: orders come from Inventory.** Creator's
  `Sales_Order` becomes a mirror, and [createProductionPlans.dg](../deluge/createProductionPlans.dg)
  — which today plans every Creator order sitting at `Pending` — gets its queue from the sync.
  This is a substantially larger change than the raw-material sync and is **not** costed in the
  build order above; it needs its own pass. Two things it turns on: which Inventory sales-order
  state means *ready to plan*, and how Inventory's commercial statuses coexist with Creator's
  production lifecycle (`Pending → In Progress → Production Complete → QC Passed → Packed →
  Dispatched`). One writer per status, as everywhere else.
- **A6 — batch tracking is not assumed.** Lots are Creator-side and Inventory sees SKU totals. If
  batch tracking is on the plan and wanted, lots can additionally be mirrored as Inventory
  batches, which affects phases 1, 2 and 4.

## What has not been verified

None of this has been run. Deluge cannot be executed here, and no call has been made against the
Inventory API from this repo yet. The quota figures are from Zoho's published documentation, not
measured. The hook points are read from the current source and are accurate as of this commit;
whether Inventory accepts the payloads we intend to send is unknown until the first real call.
