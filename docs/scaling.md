# Scaling debt — queries that grow with history

**Status: found, deliberately NOT fixed.** Recorded 2026-08-16 while answering "how future
proof is the split-form model". Nothing here is broken today. Every item gets slowly worse as
records accumulate, and the failure they all lead to is the same one: the
**statement-execution limit, which is NOT catchable** — it kills the script, so the try/catch
never runs and the widget sees a bare HTTP 500 with no error card.

Fix these after the app is feature-complete. Read *What is already right* first, so nothing on
that list gets "fixed" by mistake.

---

## The volume, per sales order

| Form | Rows per order | Driver |
|---|---|---|
| `Production_Planning` | 1 | one order produces exactly one plan |
| `Plan_Item` | ~5 | order lines |
| `Material_Requirement` | ~30 | items × materials, plus reissues, remakes, alterations |
| `Stage_Log` | ~40 | items × stages |
| `Stage_Assignment` | 40+ | one per operator per stage — **no ceiling**, a stage split four ways is four rows |

`Material_Requirement` is not the fastest-growing form, though it is the one that looks
alarming. `Stage_Log` and `Stage_Assignment` grow faster, and `Stage_Assignment` is unbounded
per stage.

At 200 orders/month that is roughly 72k `Material_Requirement` and 96k `Stage_Log` per year.
Whether that approaches the account's record cap is a Subscription-page question, not a code
one.

---

## What is already right — do NOT "fix" these

**`Material_Requirement` is never scanned.** Every read is a criteria query on an indexed
lookup — `Material_Requirement[Plan == plan.ID]` or `[Plan_Item == itm.ID]`. Creator filters
before it fetches, so 500,000 rows in the form cost what 500 do. The form growing is not an
event.

**The hot path is bounded by open work, not by history.** The driving query in
`getStoreMaterialRequirements`, `getSupervisorMaterials`, `getAdminCalculation` and
`getProductionWidgetData` is:

```
Production_Planning[Order_Status == "Pending" || "Partially Received" || "In Progress"]
```

A plan leaves that set at `Production Complete` and **never comes back** — the plan picklist
ends there and the order mirror is forward-only. So the cost tracks WIP, which is roughly flat
in year ten as in year one. `Plan_Item[Item_Status == "Awaiting_Check"]` in `getCheckingQueue`
has the same property.

This is the property that makes the whole records-not-subforms architecture scale, and it was
designed in. A subform would force loading a parent and its entire history of lines to read one
open row.

**Master-data fetch-alls are fine.** `Employee[ID != 0]`, `Raw_Material[ID != 0]`,
`Third_Party[ID != 0]` appear in about ten functions. These are bounded by how many people and
materials the company has — tens to low hundreds, growing at the rate of hiring. Leave them.

**The paged history functions are the model to copy.** `getStoreIssueHistory`,
`getStoreWasteHistory` and `getSupervisorProductionHistory` already do it properly:
`range from A to B` on the query so Creator returns only the page, the date filter inside the
query rather than in code, `limit` clamped server-side because a Custom API is callable from
anywhere, and a `.count()` for the pager total. Cost per call is flat — page 1 and page 200 are
the same work. Anything fixed below should end up looking like these.

**`piCache` in `getStoreMaterialRequirements`**
([getStoreMaterialRequirements.dg:167-181](../deluge/getStoreMaterialRequirements.dg#L167-L181))
is the right answer to an N+1: query once per *distinct* `Plan_Item`, not once per
requirement row. Reuse this shape rather than inventing another.

---

## A. Unbounded fetch on a transactional form

These fetch every record ever written. They grow monotonically and never recover.

### A1. `createProductionPlans` — every plan ever, to read one integer

[deluge/createProductionPlans.dg:70](../deluge/createProductionPlans.dg#L70)

```
allPlansDesc = Production_Planning[ID != 0] sort by Added_Time desc;
```

Fetches **every plan ever created**, sorts them, then reads `Plan_No` off the first row to work
out the next plan number. At 5,000 plans that is a 5,000-row fetch plus a full sort to obtain
one integer.

**Worst of the list** — it is on the hot path of the function that creates all the work, and it
is the one most likely to be put on a schedule.

*Fix:* a singleton counter record, or a `Plan_Seq` number field bumped on insert. Do not try to
date-bound it — a gap in planning would restart the numbering.

*Also here:* lines 72–77 use `break` inside a `for each`, which CLAUDE.md says is not reliable.
It is harmless today because the body is idempotent and only the first row matters, but it is
not doing what it looks like it is doing. Fold it into the fix.

### A2. `getRecentActivities` — every stage log ever, to show ten rows

[deluge/anotherPageScripts/getRecentActivities.dg:4](../deluge/anotherPageScripts/getRecentActivities.dg#L4)

```
recentLogs = Stage_Log[ID != 0] sort by Added_Time desc;
```

Then counts to 10 and stops. `Stage_Log` is the fastest-growing form in the app.

*Fix:* one line — `Stage_Log[Added_Time > zoho.currentdate.subDay(7)]`, or `range from 1 to 10`.

### A3. `getStoreRequests` — no pagination at all

[deluge/getStoreRequests.dg:34](../deluge/getStoreRequests.dg#L34) and
[:61](../deluge/getStoreRequests.dg#L61)

```
washes = Wash_Request[ID != 0] sort by Added_Time desc;
excs   = Material_Exception[ID != 0] sort by Added_Time desc;
```

Two unbounded fetches in one call, and `excs` is then iterated with a nested loop over
`ex.Exception_Lines`. Every wash ticket and every exception ever raised, on a screen that only
ever shows recent ones.

*Fix:* page it like `getStoreWasteHistory`. This is the closest of the lot to a real user-facing
screen, so it is the one that will bite first.

### A4. `getAdminCalculation` — two unbounded fetches

[deluge/getAdminCalculation.dg:57](../deluge/getAdminCalculation.dg#L57) —
`Sales_Order[ID != 0] sort by Added_Time desc` (for the order picker)
[deluge/getAdminCalculation.dg:76](../deluge/getAdminCalculation.dg#L76) —
`Production_Planning[ID != 0]`

An audit screen, used rarely, so low urgency — but it is also the function that already leans
hardest on cross-function calls and replays allocation globally, which makes it the least
comfortable place to be close to the statement limit.

*Fix:* date-bound or page the picker; the picker does not need orders from three years ago.

### A5. `getOrderConsumption` — every sales order for the picker

[deluge/getOrderConsumption.dg:41](../deluge/getOrderConsumption.dg#L41)

```
allOrders = Sales_Order[ID != 0] sort by Added_Time desc;
```

Same shape as A4, same fix.

### A6. `Raw_Material_Lot[ID != 0]` — four functions, grows with purchase history

- [getStoreMaterialRequirements.dg:365](../deluge/getStoreMaterialRequirements.dg#L365)
- [getSupervisorMaterials.dg:379](../deluge/getSupervisorMaterials.dg#L379)
- [getExpectedWaste.dg:75](../deluge/getExpectedWaste.dg#L75)
- [getStoreLots.dg:23](../deluge/getStoreLots.dg#L23)

Lots accumulate with every purchase for ever, and **an emptied lot is never deleted** — it stays
as a zero row so history still resolves. At ~20 lots/month that is 2,400 rows in ten years,
fetched on every store screen load.

Slowest-burning item on the list, but three of the four are in functions that already sit close
to the limit.

> **Careful with the obvious fix.** The map in `getStoreMaterialRequirements` is built
> **before** the Blocked/empty filters *on purpose*, so an old offcut can still name a lot that
> has dropped off the picker. Filtering to lots with stock breaks that. Filter by the set of
> materials actually in play instead.

### A7. Admin and one-off scripts

`backfillPriorityKey.dg:55`, `auditOrderSources.dg:36`, `migrateOpeningLots.dg:91/164`,
`seedTestLots.dg:57` all fetch whole transactional forms.

Correct as written — they are manual, run-once tools. **The rule is that they stay manual.**
Wiring any of them to a schedule or a widget button turns each into an A1.

---

## B. A set bounded by a policy that does not exist

### B1. `Waste_Master[Status == "Available"]` never drains

[getStoreMaterialRequirements.dg:276](../deluge/getStoreMaterialRequirements.dg#L276),
[getAdminCalculation.dg:189](../deluge/getAdminCalculation.dg#L189)

Sounds self-limiting — offcuts get consumed. They do not all get consumed. A remnant too small
or too odd for any order sits at `Available` for ever, and there is no ageing sweep and no
periodic scrap. `waste-master.md` records the decision that there is **no minimum usable size**
— the supervisor deletes what is not worth keeping — which is exactly the gap: nothing makes him
do it, and nothing does it for him.

This is a **business-policy gap surfacing as a query cost**, not an indexing problem. It also
quietly degrades the allocator, which scans available remnants per material.

*Fix:* a rack policy first — scrap below a size, or older than N months — then the query follows.
Worth raising with the client before it is worth coding.

---

## C. Loop-invariant query inside a loop

### C1. `getSupervisorMaterials` re-queries requirements per waste movement

[deluge/getSupervisorMaterials.dg:341](../deluge/getSupervisorMaterials.dg#L341)

```
for each wi in issuedMoves            // per plan
    for each mr2 in Material_Requirement[Plan == plan.ID]   // <- invariant
```

The inner query depends only on `plan.ID`, which does not change inside the loop, so it is
re-run once per issued waste movement per plan. Worst nesting found: plans × movements ×
requirements.

*Fix:* hoist it. The same function already fetches `Material_Requirement[Plan == plan.ID]` at
[:205](../deluge/getSupervisorMaterials.dg#L205) — build the material-owner map once there and
read it here.

### C2. The waste-movement pair, repeated in five functions

```
for each rv in Waste_Movement[Parent_Movement == wi.ID && Movement_Type == "Received"]
for each wmRec in Waste_Master[ID == wi.Waste_Piece]
```

Two queries per issued movement, in `getExpectedWaste` (:217, :229),
`getAdminCalculation` (:702, :709), `getProductionWidgetData` (:580, :588),
`getSupervisorMaterials` (:307, :330) and `getOrderConsumption` (:342).

Individually small — bounded by movements on one plan. Listed because it is five copies of one
shape, so it is one helper's worth of work to fix all five, and because it multiplies against
everything else in the same function.

*Fix:* fetch the plan's `Received` movements once, group by `Parent_Movement` into a Map; same
for the `Waste_Master` rows. The `piCache` pattern.

---

## Order to fix

1. **A1** — hot path, worst shape, and it carries the `break` bug with it
2. **A3** — the only one on a screen a user opens all day
3. **A2** — one line
4. **C1** — one hoist, meaningful nesting removed
5. **C2** — one helper, five call sites
6. **A4, A5** — rare screens, easy once the paging helper from A3 exists
7. **A6** — slowest burn, and needs care over the naming caveat
8. **B1** — needs a client decision before any code

## Rules to hold while the app is still being built

- **A new fetch-all on a transactional form is a bug**, even if it is fast today. Master data
  (`Employee`, `Raw_Material`, `Third_Party`) is the only exception.
- **Anything a user opens repeatedly gets `range from A to B`** and a server-side `limit` clamp,
  because a Custom API is callable from anywhere.
- **Filter in the query, never in the loop.** Dropping rows in code after the fetch also breaks
  paging — page 1 returns 17 of 20 and page 2 starts in the wrong place.
- **The one-off scripts stay one-off.** Scheduling one promotes it to A1.
