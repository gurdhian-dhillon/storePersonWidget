# Admin "Production & Stock Dashboard" — audit & fix plan

`app/admin/anotherPage/` (widget) + its backend in `deluge/anotherPageScripts/` and a
few loose `deluge/*.dg` files.

**Not built to this repo's conventions.** The widget JS is functional and its
date/time handling is careful; the backend is a mix of one well-hardened function
(`getEmployeeReport`) and several that predate the app's scaling work and never got
the same treatment. Nothing here is on fire *today* — but two functions will take the
screen down at real order volume, and one shows blank data right now.

Audit date: 2026-09-08. Verify every `file:line` and field name against the current
code and the Creator forms before acting — this is a point-in-time snapshot.

---

## STATUS AT 2026-09-08 (later the same day) — most of this is DONE

| # | Item | State |
|---|---|---|
| 1 | `getSalesOrderProgress` statement limit | ✅ **rebuilt** on the JS Data API (`app/admin/anotherPage/js/pipeline-data.js`). The `.dg` is left in the repo unused. 50 tests. |
| 2 | `getRawMaterialsList` scans every lot | ✅ **bounded** to lots holding stock |
| 3 | Wrong customer form (blank names) | ✅ **fixed** — `Customer_Master` / `Display_Name` |
| 4 | Three orphan scripts | ✅ **deleted from the repo** — still to delete in Creator |
| 5 | `workspace_name` half-applied | ✅ **settled** — not required; the misleading comment is corrected |
| 6 | Disputes tab read-only | ⚠️ **still open** — needs a product decision, see below |
| 7 | Fragile `getAdminCalculation` coupling | ✅ **documented** in the `.dg` beside the field |
| 8 | Dead `ifnull(x, ifnull(x))` | ✅ **fixed** in `getRawMaterialsList`; `getSalesOrderProgress`'s copy died with the rebuild |
| 9 | Non-repo Deluge idioms | ✅ **gone** with the rebuild |
| 10 | `getOrderPipelineCounts` duplication | ⏸️ **left alone** — 26 bounded lines, no risk, and it is the pipeline tiles' independent source |

**Also fixed, not in the original audit:** `load()` replaced the shared `DATA`
object wholesale and rescued only two of its four properties, so `pipelineError`
and `progressError` were silently dropped every time the employee-report day
changed — a failed pipeline lost its explanation and showed an empty state with
nothing saying why.

**`rm.Name` (#2's sub-point) was investigated and left alone:** it appears 13
times across the repo, so it is an established field, not a typo here.

**Pre-existing `dgscan` findings, deliberately untouched** (unrelated files, one
of them the store's hot path mid-migration): `getStoreMaterialRequirements.dg:859`
and `sendProductionPlanSummary.dg:52` both have `sort by` inline in a `for each`
header.

---

## The widget and what it calls

| Tab | Widget fn | Custom API | Backend file | State |
|---|---|---|---|---|
| Sales order pipeline | `loadPipeline` | `getOrderPipelineCounts` | `anotherPageScripts/getOrderPipelineCounts.dg` | OK, but duplicated (see #10) |
| — pipeline fallback | `loadPipelineFromOrderAudit` | `getAdminCalculation` | `deluge/getAdminCalculation.dg` | fragile coupling (#7) |
| — order rows | `loadSalesOrderProgress` | `getSalesOrderProgress` | `anotherPageScripts/getSalesOrderProgress.dg` | **statement-limit risk (#1)** |
| — Pending card | `loadPendingOrders` | `getPendingSalesOrders` | `deluge/getPendingSalesOrders.dg` | **wrong customer form (#3)** |
| — Convert to plan | `convertOrder` | `convertSalesOrderToPlan` | `deluge/convertSalesOrderToPlan.dg` | OK |
| Employee report | `load` | `getEmployeeReport` | `deluge/getEmployeeReport.dg` | ✅ the good one |
| Raw materials | `loadMaterials` | `getRawMaterialsList` | `deluge/getRawMaterialsList.dg` | **scans every lot ever (#2)** |
| All Disputes | `loadAdminDisputes` | `getStoreCounts` + `getStoreDisputes` | `deluge/getStoreCounts.dg`, `deluge/getStoreDisputes.dg` | OK (shared w/ store widget), read-only (#6) |

**Orphans — called by nothing:** `anotherPageScripts/getOperatorPerformance.dg`,
`getDailyProductionTrend.dg`, `getRecentActivities.dg` (#4).

---

## 🔴 Must fix

### 1. `getSalesOrderProgress.dg` — statement-limit risk (uncatchable)

**630 lines, 3–4 nested loops, unbounded per-order work.** Per page of 25 orders, for
each order → for each plan on it:

- `Stage_Log[Plan == plan.ID] sort by Sequence_No desc` — **every stage log for the
  plan** (`getSalesOrderProgress.dg:180`). A 110-item Faire order with ~8 stages =
  ~880 rows, fetched and sorted, per plan.
- `Item_Check[Plan == plan.ID]` with a **nested** `Finishing_Data[Item_Check == chkRec.ID
  && Finishing_Status == "Done"]` per check (`:226`, `:234`).
- `Plan_Item[Plan == plan.ID]` (110 rows) with per-item map building and grouping
  (`:247`).

One large order anywhere on a page can push a single execution past the
statement-execution limit. That limit is **not catchable** — it kills the script, the
`try/catch` at `:10` never runs, and the widget gets a **bare HTTP 500 with no error
card** (`CLAUDE.md`: *"A 500 with no error card usually means the statement limit"*).

This is the exact class `getStoreMaterialRequirements`, `getProductionWidgetData` and
`getEmployeeReport` were all rebuilt to avoid. This function was never touched.

**Fix — bound the per-plan work.** Options, pick per how the screen is actually used:

- **A. Only fetch the detail for the ONE expanded order.** The pipeline list needs per
  order: status, planNo, supervisor, ordered/produced totals, item count, current
  stage. The batch-level `items[]` / `itemBreakdown` / `stages[]` are only rendered
  when a row is expanded (`renderPipeline` in `main.js` — confirm). Split into:
  - `getSalesOrderProgress` (list): one page of orders, header fields only, **no
    Stage_Log / Item_Check / Plan_Item child walks** — derive totals from
    `Plan_Item` aggregates only, or from fields already on `Sales_Order` /
    `Production_Planning` if they exist.
  - `getSalesOrderDetail(salesOrderId)`: the full per-plan walk, for **one** order, on
    expand. Bounded by one order = one plan (`createProductionPlans` inserts one plan
    per order, inside its per-order loop — see `CLAUDE.md`).
- **B. If the list genuinely needs per-item detail for all 25 rows**, drop page size to
  the point where the worst realistic order fits, and add the row-budget walk pattern
  `getStoreMaterialRequirements` uses (`skipCountTxt` in, `plansConsumed` out) — cost
  tracks `Plan_Item` row count, not order count.

**A is almost certainly right** — the list view doesn't need 110 batch objects per
order to draw a progress bar.

Also in the same pass:
- `Stage_Log[Plan == plan.ID]` → if only the current/last stage is needed for the list,
  `... sort by Sequence_No desc range from 1 to 1` for the open one and same for done.
- The `for each so in orders { if (...) continue; }` at `:83`, `:85`, `:94`, `:98` —
  `continue` in a `for each` is used nowhere else in this repo and `CLAUDE.md` warns
  `break` is unreliable in `for each`. Restructure so the filter is in the query
  criteria (it already is at `:74`/`:78`) and drop the redundant in-body `continue`
  guards, or guard the body with an `if` like the rest of the codebase does.

---

### 2. `getRawMaterialsList.dg` — scans every `Raw_Material_Lot` ever created

`getRawMaterialsList.dg:6` — `Raw_Material_Lot[ID != 0] sort by Added_Time`, **no
material filter**, on every open of the Raw Materials tab.

`docs/scaling.md` flags this exact shape: lots *"grow with every purchase and an
emptied lot is never deleted"*. `getAdminCalculation` was rewritten specifically to
stop doing this (its header: *"this audit screen paid for the whole purchase history
of the factory to print a few lot numbers"*).

`Raw_Material[ID != 0]` at `:59` is fine — master data, ≤1,000, `docs/scaling.md`
confirms it.

**Fix — one lot query per material, like `getAdminCalculation` now does.** Walk
`Raw_Material` first, collect ids, then `Raw_Material_Lot[Material == rmId]` per
material inside the same loop. Or filter the lot scan to non-empty lots
(`Wash_Quantity > 0 || Unwash_Quantity > 0 || In_Transit_Qty > 0 || In_Wash_Qty > 0`)
if that's an acceptable business rule — but per-material is the safer shape.

**Also clean while there:**
- `:79-82` — `if(matColor == "") { matColor = ifnull(rm.Color,"")... }` re-reads the
  **same field** `rm.Color` as its own fallback. Dead code — decide what the real
  fallback field is (there may not be one) and either fix or delete.
- `:70` — `ifnull(rm.Name, ...)` as a fallback for `Material_Display_Name`. Confirm
  `Raw_Material` actually has a `Name` field; the repo elsewhere uses `Material_Name`.
- `:76` — `rm.Type_field`. Confirm that's the real link name (Creator suffixes
  reserved words, so it might be) — a wrong name returns empty silently.

---

### 3. Wrong customer form — customer name is blank on the Pending tab **right now**

`getPendingSalesOrders.dg:48` queries **`Customer[ID == custId.toLong()]`** and reads
`Customer_Name` / `Name` (`:50`, `:53`).

The repo's canonical customer form is **`Customer_Master`** with a **`Display_Name`**
field — see `syncSingleSalesOrder.dg:54` (`Customer_Master[Display_Name == custName]`),
`seedSalesOrders.dg:10`, `create_so_00020.dg:8`. A query against a form that doesn't
exist returns nothing **silently**, so `custTxt` stays `""` and every Pending row shows
a blank customer.

`getSalesOrderProgress.dg:125` uses the right form (`Customer_Master[ID == so.Customer]`)
but reads `Company_Name` (`:127`) — also probably wrong (canonical is `Display_Name`),
**and** `:127` reads the same field as its own `ifnull` fallback (dead code, same
pattern as #2).

**Fix:**
- `getPendingSalesOrders.dg` — `Customer_Master[ID == custId.toLong()]`, read
  `Display_Name` (confirm the exact field on the form; there may be a `Company_Name`
  *and* a `Display_Name` — use whichever the other admin screens show).
- `getSalesOrderProgress.dg:127` — same field name, and collapse the
  `ifnull(x, ifnull(x, ""))` to `ifnull(x, "")`.
- Whatever field wins, use it in **both** functions so the Pending tab and the pipeline
  tab agree.

---

### 4. Three orphan backend scripts — delete

None are called by any widget. `getEmployeeReport.dg`'s header says it *"Replaces
getOperatorPerformance, getDailyProductionTrend, getRecentActivities and
getOrderPipelineCounts with a single call"* (the first three fully; `getOrderPipelineCounts`
is still used — see #10).

| File | Problem beyond being dead |
|---|---|
| `anotherPageScripts/getOperatorPerformance.dg` | Still computes **"Efficiency" / "Target" / Active-On Break-Offline** — the exact model `getEmployeeReport` documents abandoning (yield mislabelled as productivity, capped at 100 by `saveProductionPhase`). `return operatorList.toString()` on a List-of-Maps → **invalid JSON** (`deluge-gotchas`: `[{k=v}]` not `[{"k":"v"}]`). |
| `anotherPageScripts/getDailyProductionTrend.dg` | `return trendList.toString()` — same invalid-JSON bug. |
| `anotherPageScripts/getRecentActivities.dg` | `log.Added_Time.toString(...)` with **no `ifnull`** → throws on a null. `.Operator` (a lookup) `.toString()` → ships the **18-digit record id**, not a name. `return activityList.toString()` — invalid JSON. |

**Fix:**
1. Delete the three `.dg` files from the repo.
2. **In Creator:** delete the Custom APIs / standalone functions if any still point at
   them. A dead Custom API is a live endpoint anyone could call.
3. Grep the repo once more for the names before deleting, in case a test or doc
   references them.

---

## 🟡 Should fix

### 5. `workspace_name` applied to only 5 of 9 calls

Has it: `getPendingSalesOrders` (`main.js:1683`), `getOrderPipelineCounts` (`:1812`),
`getSalesOrderProgress` (`:1903`), `getStoreCounts` (`:2664`), `getStoreDisputes`
(`:2670`).

Missing it: `convertSalesOrderToPlan` (`:1719`), `getAdminCalculation` (`:1854`),
`getEmployeeReport` (`:2196`), `getRawMaterialsList` (`:2274`).

The comment at `:1810` says it's *"Required for this externally hosted widget"*. If
that's true, the four without it fail when the widget is served from outside Creator's
own domain. If the widget works today, either it's not required (the SDK infers the
workspace) or those four paths haven't been exercised in the hosted build.

**Fix:** settle whether it's needed (test the hosted build, or check the other admin
widget — `app/admin/js/main.js` — which does the same kind of calls). Then apply it to
**all nine or none**. Don't leave it half-applied.

### 6. Disputes tab is read-only — no resolve action

`renderAdminDisputes` (`main.js:2705`) shows every dispute — direction, denial state,
remaining qty, both-denied "Lost" — but there is **no button to resolve one**. The
store widget (`app/js/main.js`) and supervisor widget both call `resolveDispute`.

**Decide the intent:**
- If admin is **oversight only** (the store person and supervisor adjudicate between
  themselves), this is correct — but say so in the widget (a note on the tab) and in
  this doc, so it's not "fixed" later by someone who thinks it's a gap.
- If the admin is meant to **break deadlocks** (both sides denied → someone has to call
  it Lost; a stuck dispute nobody's touching), then a resolve action wired to
  `resolveDispute` is missing. Note that `resolveDispute`'s authorisation matrix is
  enforced server-side per side (`CLAUDE.md` dispute model) — an admin path would need
  its own branch or a role check, which doesn't exist yet (no roles — `CLAUDE.md`
  "Deliberate gaps").

### 7. Fragile fallback coupling to `getAdminCalculation`

`loadPipelineFromOrderAudit()` (`main.js:1852`) is the fallback when
`getOrderPipelineCounts` fails. It calls `getAdminCalculation` with `salesOrderId: ''`
and counts `data.orders[].status` client-side (`:1866`).

Still works after the 2026-09-08 gutting of `getAdminCalculation` (the `orders[]` list
for the picker survived — see `docs/scaling.md`). But it's an **undocumented
dependency**: a future change to `getAdminCalculation`'s picker payload (e.g. dropping
`status` from the order list, or paging it) silently breaks this fallback with no test
covering it.

**Fix:** either
- give `getOrderPipelineCounts` its own try/catch that returns zeroed counts + an error
  string (so the fallback is never needed), or
- add a one-line comment in `getAdminCalculation.dg` next to the order-list JSON
  saying *"`status` is read by anotherPage's pipeline fallback — keep it"*, and a note
  here.

### 8. Dead-code `ifnull(x, ifnull(x, ...))` fallbacks

Covered inline above (#2 `getRawMaterialsList.dg:79-82`, #3
`getSalesOrderProgress.dg:127`). Both read a field as its own fallback — a copy-paste
artifact where a *different* field was presumably intended. Fix both when touching
those functions; don't leave them as "harmless" — they hide the fact that no real
fallback exists.

### 9. `getSalesOrderProgress` uses non-repo Deluge idioms

- `continue;` in a `for each` (`:83`, `:85`, `:94`, `:98`) — see #1.
- `qRmk = if(isRm == true, qOrd, 0)` and `batchObj.put("qtyAltered", if(isAlt, qOrd, qAlt))`
  (`:318`, `:403`, `:405`, `:482`, `:483`) — the `if(cond, a, b)` expression form.
  Works in Deluge but appears nowhere else in this repo, which uses explicit
  `if/else` blocks. Not a bug; a consistency and reviewability cost. Convert if the
  function is being rewritten for #1 anyway.

### 10. `getOrderPipelineCounts` duplicates work `getEmployeeReport` already does

`getEmployeeReport.dg:75-81` computes all seven `Sales_Order` status counts.
`getOrderPipelineCounts.dg` computes the **same seven**, called separately by the
widget (`main.js:1808`). Both loaded on the pipeline tab.

The widget's own comment (`:1804`) defends this: *"intentionally loaded from its own
small custom function… remains available even when the day-specific employee report is
slow"*. That's a reasonable call **if** #1 is fixed (right now `getSalesOrderProgress`
is the slow one, not `getEmployeeReport`).

**Fix (optional):** once #1 is done, consider whether `getEmployeeReport`'s counts can
feed the pipeline tiles and `getOrderPipelineCounts` can be retired — one fewer
Custom API, one fewer thing to keep in sync when a status is added to the picklist
(three places today: the picklist, `getOrderPipelineCounts`, `getEmployeeReport`).
Low priority.

---

## ✅ Solid — do not "fix"

- **`getEmployeeReport.dg`** — the reference implementation. Bounded by `Log_Date`
  (`Stage_Assignment[Log_Date == dDay]`, `Stage_Log[Log_Date == dDay]`), `Employee`
  fetched **once**, every lookup cached, handles the stage-split model correctly
  (`Stage_Assignment` shares vs `Stage_Log` header, `splitLogs` map), and its header
  documents *why* "efficiency" was removed. Copy this shape for #1.
- **`convertSalesOrderToPlan.dg`** — clean wrapper around `createPlanForOneOrder`,
  idempotent by delegation, parses the plain-text return into JSON, proper error
  handling. No changes.
- **`getStoreCounts.dg` / `getStoreDisputes.dg`** — shared with the store widget,
  per-row try/catch, empty-string guards on every numeric read. Battle-tested. No
  changes (and any change here hits the store widget too).
- **Widget date/time handling** — `toMinutes` (handles `09:00` / `09:00:00` /
  `09:00 AM`), `spanMinutes` (wraps past-midnight, rejects >960min as a likely
  typo'd pair), ISO-string dates never parsed with `new Date(str)`. Careful and
  correct.
- **`isLocalStandalone()`** (`main.js:2598`) — mock-data gate keyed on
  `window.self === window.top`, so it only fires when `widget.html` is opened directly,
  never inside Creator's iframe. Reasonable dev affordance.

---

## Suggested order of work

1. **#3 customer form** — smallest fix, currently shows blank data. ~20 min.
2. **#4 delete orphans** — no risk, removes three invalid-JSON / id-leaking endpoints.
3. **#1 `getSalesOrderProgress`** — the one that takes the screen down at volume. Split
   list vs detail (option A). This is the real work — budget for a proper rewrite +
   Execute against a 100-item order.
4. **#2 `getRawMaterialsList`** — per-material lot query. Straightforward once #1's
   pattern is established.
5. **#5 `workspace_name`** — settle and make consistent.
6. **#6 disputes** — decide intent first (oversight-only vs deadlock-breaker), then
   either document or build.
7. **#7, #10** — cleanup, low priority.

## Deploy checklist (per `CLAUDE.md`)

Every `.dg` change → paste into the matching Custom API / function in Creator, **Save**,
then **Execute** with real inputs to see the actual error (the widget only ever sees
`code 9430` or a bare 500).

- **#1** — if split into `getSalesOrderProgress` + `getSalesOrderDetail`, the new
  function needs its **own Custom API** created in Creator, and the widget's
  `invokeCustomApi` arg list must match. Execute the list function against a page that
  includes a 100+ item order; Execute the detail function against that order alone.
- **#3** — no signature change; paste + Execute both functions, confirm a customer name
  comes back.
- **#4** — delete the `.dg` files here; delete the Custom APIs / functions in Creator
  separately (call it out — it's a manual Creator step).
- **#2** — no signature change; Execute and confirm lot data still attaches per
  material.
- No Creator **form** changes are required by any of this. Confirm the `Customer_Master`
  field name (#3) by opening the form.
