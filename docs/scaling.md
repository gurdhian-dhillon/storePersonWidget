# Scaling — queries that grew with history, and what was done about them

**Status: 22 sites across 17 functions FIXED, 2026-08-23.** Rewritten from the 2026-08-16
version, which recorded the same debt as *"found, deliberately NOT fixed"*. That document is
superseded, and two of its rules were wrong — see **Corrections** below before trusting anything
you remember from it.

Everything here leads to one failure: the **statement-execution limit, which is NOT catchable**.
It kills the script, so the try/catch never runs and the widget sees a bare HTTP 500 with no
error card. These do not get slow. They die silently, and only once there is enough data.

---

## The scale this is now built for

Established 2026-08-23, and it is the reason the old document's advice no longer held.

| Form | Today | Planned | Driver |
|---|---|---|---|
| `Item_Master` | ~1,940 | **20,000–25,000** | one per finished SKU; 16k already on Shopify |
| `BOM` | — | **one per SKU** | `syncSingleSalesOrder` requires exactly one |
| `Raw_Material` | ~250 | **≤1,000** | fabric variety (pattern × colour), NOT the SKU count |
| `Raw_Material_Lot` | 308 for 23 materials | **~13 × materials** | one per purchase, and an emptied lot is never deleted |
| `Material_Issue` | — | one per press of Issue, for ever | trading volume |
| `Finishing_Data` | — | one per inspected batch, for ever | trading volume |

**`Raw_Material` scaling with *fabric* rather than with the catalogue is the fact that saved
eleven query sites.** A raw material is `Linen Fabric / Solid / Cinnamon Brown` — size and style
variants of a finished SKU cut from one cloth are one row here.

### Per sales order, unchanged from the old document

| Form | Rows per order |
|---|---|
| `Production_Planning` | 1 |
| `Plan_Item` | ~5 |
| `Material_Requirement` | ~30 |
| `Stage_Log` | ~40 |
| `Stage_Assignment` | 40+, **no ceiling** |

---

## Corrections to the 2026-08-16 document

**1. "Master-data fetch-alls are fine … `Raw_Material` … tens to low hundreds."**
Half right, and the wrong half was load-bearing. `Employee`, `Third_Party`, `Box_Master` and
`Raw_Material` are genuinely bounded and were left alone — 20 sites, no work. But the same
paragraph was being used to justify `Raw_Material_Lot[ID != 0]` in six functions, and
`getStoreIssueHistory` said so in as many words:

> *"lots are master data, a few hundred rows that do not grow with trading"*

**Lots grow with every purchase, and an emptied lot is never deleted** — it stays as a zero row so
history still resolves. That comment was deleted where it stood, because a wrong comment
re-justifies the mistake to the next reader.

**2. `Raw_Material_Lot` was ranked "slowest burn", seventh of eight.** It was the worst thing in
the app. The estimate behind that ranking assumed ~20 lots a month against 210 materials; at 1,000
materials it is ~13,000 rows, **fetched whole on every store screen load**, from day one rather
than in year ten. It is not driven by elapsed time at all — it is driven by how many materials
exist.

**3. `Finishing_Data` was not in the document at all.** Four unbounded scans, one of them in
`savePackingRecord`, a **write path**.

---

## The rule

> **A query's cost must track what is on screen, not how much history exists.**

`Form[criteria]` is evaluated server-side and returns only matches. `[ID != 0]` matches
everything, so the whole form is pulled in and every row costs statements.

**Filtering in code does not help.** `getStoreMaterialRequirements` had a comment proudly
explaining "THE CHEAP TEST FIRST" — a guard costing two statements per unwanted lot. The guard was
cheap; the fetch it guarded was not. You pay for the rows either way.

---

## The four techniques

Each fix is one of these. Reuse them rather than inventing a fifth.

### 1. Push the filter into the query

When the wanted set is already known and **bounded by open work**.

```
- allLotRows = Raw_Material_Lot[ID != 0] sort by Added_Time;   // 13,000 rows
- for each lotR in allLotRows { if(neededMats.contains(lrMat)) { … } }
+ for each  lotMatId in neededMats                             // ~30 materials on screen
+ {
+     matLotRows = Raw_Material_Lot[Material == lrMat.toLong()] sort by Added_Time;
```

Used in `getStoreMaterialRequirements`. **13,000 rows → ~390.**

### 2. Ask for only the rows you need

```
- allPlansDesc = Production_Planning[ID != 0] sort by Added_Time desc;
+ allPlansDesc = Production_Planning[ID != 0] sort by Added_Time desc range from 1 to 10;
```

Used in `createProductionPlans` (every plan ever → 10), `getRecentActivities` (every `Stage_Log`
ever → 10), and both `Sales_Order` pickers (→ 200).

### 3. Lazy per-id cache

When ids are only discovered as the function runs. Replaces a prefetch with one indexed query per
**distinct** id actually used.

```
if(lotNumById.get(lotKey) == null)
{
    lotNumById.put(lotKey,"");            // cache the MISS too
    for each  lotRef in Raw_Material_Lot[ID == lotKey.toLong()]
    {
        lotNumById.put(lotKey,ifnull(lotRef.Lot_Number,"").toString());
    }
}
```

**Caching the miss is not optional.** Without it an unreadable lot is re-queried by every line
naming it, turning the fix into an N+1. Used in `getStoreIssueHistory`,
`getSupervisorMaterials`, `getExpectedWaste` (×3), `getAdminCalculation` (×3), `getPrintData`.

### 4. Bound by open work plus a fixed window

```
excs = Material_Exception[Status == "Open" || Added_Time > washCutoff] sort by Added_Time desc;
```

**An OR, never a date window alone.** A request still outstanding must appear however old it is —
that is the tab's whole job. The date half only supplies the recently-closed tail so a completed
request does not vanish and read as lost. Used in `getStoreRequests`.

### Choosing between 1/3 and a single fetch

Techniques 1 and 3 swap one big fetch for N small queries. **Only a win when N is bounded by what
is displayed rather than by history**, and a loss otherwise.

`getStoreLots` is the counter-example and its header says so: it lists **every** fabric material,
so per-material querying would be hundreds of queries. It got a row filter instead. Do not
"consistency-fix" it into the shape used elsewhere.

---

## What is already right — do NOT "fix" these

**`Material_Requirement` is never scanned.** Every read is a criteria query on an indexed lookup.
Creator filters before it fetches, so 500,000 rows cost what 500 do.

**The hot path is bounded by open work.** The driving query in `getStoreMaterialRequirements`,
`getSupervisorMaterials`, `getAdminCalculation` and `getProductionWidgetData` is
`Production_Planning[Order_Status == "Pending" || "Partially Received" || "In Progress"]`. A plan
leaves that set at `Production Complete` and **never comes back**, so cost tracks WIP, which is
flat in year ten as in year one. This is why the records-not-subforms architecture scales, and it
was designed in.

**Master-data fetch-alls on `Employee`, `Third_Party`, `Box_Master`, `Raw_Material`.** 20 sites,
bounded by headcount, vendors, carton types and fabric variety. `Raw_Material` at ≤1,000 is
confirmed, not assumed. Leave them.

**The paged history functions are the model.** `getStoreIssueHistory`, `getStoreWasteHistory`,
`getSupervisorProductionHistory`: `range from A to B` on the query, date filter inside the query
rather than in code, `limit` clamped server-side because a Custom API is callable from anywhere,
`.count()` for the pager total.

**`piCache` in `getStoreMaterialRequirements`** is the original of technique 3.

**The one-off scripts stay one-off.** `auditOrderSources`, `backfillPriorityKey`,
`migrateOpeningLots`, `seedTestLots`, `seedOpeningLots`, `reconcileRawMaterial`,
`mapInventoryItemIds` all fetch whole forms and are correct as written. **Scheduling one, or
wiring it to a widget button, promotes it to the worst item on this list.**

---

## Three traps that shaped the fixes

**A Creator criteria comparison matches NO empty field, in either direction.** `Status == "Open"`
misses an empty row; `Status != "Open"` misses it too. So "find the unmapped/unfinished ones"
cannot be expressed as a query against an unwritten field — it needs a **positive marker written
at insert**. `postTransferOrders` records the two rounds this cost with `Transfer_Status`.

**`Material_Issue.Plan` names only ONE plan.** One press of Issue can cover several plans and the
voucher is stamped with the older one. It looks like the natural bound for "handovers for this
plan" and would silently drop every other plan's lines.

**`Issue_Status` is flipped for every open handover on the plan**, not just the one being
received (`receiveMaterials` STEP 4) — so a voucher can read `Received` with lines still
unsettled. `postTransferOrders` refuses to trigger on it for this reason. Filtering the
settlement walk on it would silently stop settling those lines.

---

## The handover walk, and why the bound is provable

Five functions walked **every handover ever made to a supervisor**, plus its `Issue_Lines`
subform, to find the few lines carrying one plan or item: `receiveMaterials`,
`saveWasteFromCutting`, `getSupervisorMaterials`, `getExpectedWaste`, `getAdminCalculation`. Two
are write paths. This class is invisible to a grep for `[ID != 0]`.

`Material_Issue.Issue_Date` and `Production_Planning.Plan_Start_Date` are both plain dates written
with `zoho.currentdate`. So:

> A handover can only carry a line for an item of plan P if that item existed, and the item cannot
> predate the plan that created it. **No wanted line sits on a voucher issued before
> `Plan_Start_Date`.**

Nothing the existing `Plan_Item` test would have kept is filtered out, and `getExpectedWaste`'s
oldest-first ordering is untouched — the bound removes only vouchers that predate the plan.
**Every site falls back to the old unbounded query when the date is missing.**

**`receiveMaterials` and `getSupervisorMaterials` deliberately use the SAME bound.** The quantity
the supervisor types comes off that screen; settling it against vouchers older than any open plan
would spend his confirmation on cloth the screen never showed him — the same class of divergence
the dispute-netting note in `receiveMaterials` was written about. `receiveMaterials` uses the
**wider** four-status plan set (including `Material Ready`), never its own three, so the receive
can never see fewer vouchers than the screen did.

---

## Two changes that are visible on screen

Everything else preserves output exactly. These two do not.

**`getStoreLots` no longer lists fully emptied lots** (all five quantities zero), and the lot count
beside each material drops. It was the only bound available — see *Choosing* above. It also makes
the two store screens agree: `getStoreMaterialRequirements` already applies this rule to the issue
picker (*"An empty lot is not a choice"*). Cloth at the wash, in transit or disputed still shows.
Revert instructions are in the comment at the query.

**`getExpectedWaste` now shows lot numbers where they were blank.** Two of its three lot lookups
sit outside the `wSupId != 0 && itemIdTxt != ""` guard that used to fill the map, so they rendered
an empty string whenever that guard was false. The lazy resolve does not care about the guard.
This is a fix, but it is a change.

---

## Still open

**`Waste_Master[Status == "Available"]` never drains** — `getStoreMaterialRequirements`,
`getAdminCalculation`. A remnant too small or too odd for any order sits at `Available` for ever;
there is no ageing sweep and no periodic scrap. This is a **business-policy gap surfacing as a
query cost**, and it also quietly degrades the allocator. *Needs a rack policy from the client —
scrap below a size, or older than N months — before any code.*

**`getProductionWidgetData` has three inline `sort by` in `for each` headers** (lines 53, 141,
619), which CLAUDE.md forbids. All on master data, works today, so it is a rule violation rather
than a scaling problem. Fold it into the next change to that file.

**`getSupervisorCounts` counts with `Issue_Status != "Received"`.** A `.count()`, so not a scaling
problem — but per the empty-field trap above, if the `Issue_Status` dropdown ever lacks `Issued`
as a choice, `issueMaterials` stores empty and **this badge reads 0 with handovers pending**.
Exactly the `Transfer_Status` bug. If that badge is ever wrongly 0, this is why.

**The real fix for the handover walk is `Issue_Lines` as its own form.** The date bound is sound
but it is a bound, not an index: "handovers touching item X" is not expressible because the lines
live in a subform. Making them records is the same records-not-subforms migration already done for
`Plan_Item`, `Stage_Log` and `Material_Requirement`. Not before the catalogue work, and not
before there is a reason.

---

## Rules to hold

- **A new fetch-all on a transactional form is a bug**, even if it is fast today. `Employee`,
  `Third_Party`, `Box_Master` and `Raw_Material` are the only exceptions.
- **Anything a user opens repeatedly gets `range from A to B`** and a server-side `limit` clamp,
  because a Custom API is callable from anywhere.
- **Filter in the query, never in the loop.** Filtering in code also breaks paging — page 1
  returns 17 of 20 and page 2 starts in the wrong place.
- **Cache the miss as well as the hit** in any lazy lookup.
- **A signature change is a Creator config change.** Adding an argument to a Custom API breaks
  every caller until the argument list is edited by hand. Prefer a bounded criteria over a new
  `limit` parameter when the deadline is short.
- **Verify with `node tools/dgscan.js deluge/**/*.dg`** — brace/paren balance, comments inside `insert into` field lists,
  loop-variable/scalar clashes, inline `sort by`, `break`. It is comment- and string-aware, and it
  found two pre-existing faults on its first run. **It proves none of this executes**; only a
  Creator Execute does that.
