# Order Audit widget (`app/admin/`) — audit & fix plan

The "Order audit" screen: pick a sales order, get every fabric line broken down
step by step (plan requirement → live allocation → expected waste → what actually
went out), plus a "Material used" tab. Backend: `getAdminCalculation.dg`,
`getExpectedWaste.dg` (lazy), `getOrderConsumption.dg` (Material used tab), and
`ApiExperiment.run()` (`app/js/api-experiment.js`, JS Data API — the store screen's
own port).

This screen was **heavily reworked on 2026-09-08** (see `docs/scaling.md` and
`live-linen-admin-audit-widget` memory): the `getStoreMaterialRequirements` cross-call
was removed, calc 2 moved to the client, `getExpectedWaste` went lazy. Those changes
fixed the worst statement-limit exposure. What remains is **item-scale**: the screen
still fetches and renders every item of an order at once, with no pagination — the same
problem `production.js` was paginated to solve, still open here.

Audit date: 2026-09-08. Verify every `file:line` and field name against the current
code before acting.

---

## STATUS AT 2026-09-08 (later the same day)

| # | Item | State |
|---|---|---|
| 1 | No item pagination | ⚠️ **still open** — the real work, own session |
| 2 | `Raw_Material` N+1 | ✅ **fixed** — `matSkuById`/`matDispById`/`matWidthById`, one read per distinct material (110 → 1 on a single-fabric order, ported and tested) |
| 3 | `api-experiment.js` scans `Material_Requirement` | ⚠️ **still open** — a store-screen decision; the doc lie is what to correct first |
| 4 | `bucketFor()` O(n·m) | ⏸️ low priority, bounded by open WIP |
| 5 | `Material_Display_Name` / `Name` fallback | ✅ **investigated** — `rm.Name` appears 13× across the repo, so it is a real field. Left alone. |
| 6 | `console.log` in the load path | ✅ **removed** (the failure log kept, deliberately) |
| 7 | Stale comment block | ✅ **rewritten** past-tense |

**Also done on this screen, beyond the audit:** the four glossary cards, the
per-step subtitles and the per-item column legend were cut (they printed the same
text on every order, item and row); agreement became a tick; steps that have
nothing to say for a line's stage no longer draw; and an order-level **verdict**
now states every finding the screen could already detect but buried behind a
chevron — including mixed-lot, which is unfixable once it has happened and was
the most deeply buried of the lot. See `tools/admin-audit-steps.test.js` (79).

### 2026-09-09 — "Material used" tab: reissue no longer reads as an overspend

`getOrderConsumption.dg` computed `variance = spent − PLANNED` and
`cuttingAllowance = variance − lost`. Neither subtracted `reissued`. On an order
that raised a reissue whose cloth had not gone out yet (a checker rejection, an
alteration), and whose plan cloth had over-issued by roughly the same amount of
marker-row rounding, one row told two conflicting stories: the account ledger
(client-side, always right) showed `planned + raised later = asked for`, balanced;
the reason trail below it (from the server's `reasons[]`) showed
`Cutting allowance: <that same number>`. SO-2000's Yarn Dyed fabric was the live
example — `+1.35` "vs plan" and `1.35` "Reissued" side by side, the same 1.35.

Fixed server-side to match what the widget's `materialAccount` already did:
`demand = planned + reissued`, `variance = spent − demand`,
`cuttingAllowance = variance − lost` (clamped ≥ 0). Payload gains a `demand`
field. The "vs plan" column is relabelled **"vs asked"** — spent against
everything the order was told it needs, plan plus every reissue — so a legitimately
raised reissue reads as 0, not as a surplus, and a genuine marker-row allowance on
top still shows. As a bonus the closed-order shortfall finding now fires when a
reissue was raised and never issued (previously hidden behind the reissue's own
`Required_Qty`). `tools/admin-material-used.test.js` +9 (57).

**Redeploy:** `deluge/getOrderConsumption.dg` (paste + **Execute** on SO-2000 to
confirm), admin widget `app/admin/js/main.js`. No Custom API arg-list change.
Arithmetic not ported to Node — the change is one subtraction; verify at Execute.

---

## What it calls

| When | Widget fn | Custom API / call | Backend | State |
|---|---|---|---|---|
| Order picker fill + calc load | `load` | `getAdminCalculation` | `deluge/getAdminCalculation.dg` | **item-scale risk (#1)**, N+1 (#2) |
| Live allocation (calc 2) | `loadLive` | `ApiExperiment.run()` → many `getRecords` | `app/js/api-experiment.js` | inherits full-form scans (#3) |
| Working step 3, on expand | `ensureExpectedWaste` | `getExpectedWaste` | `deluge/getExpectedWaste.dg` | ✅ lazy, one per click |
| "Material used" tab, on open | `loadUsed` | `getOrderConsumption` | `deluge/getOrderConsumption.dg` | ✅ bounded, well-written |
| Pipeline fallback (other widget) | — | `getAdminCalculation` | — | see `docs/admin-dashboard-audit.md` #7 |

---

## 🔴 Should fix

### 1. `getAdminCalculation.dg` + `render()` — no item pagination

A Faire order is **one plan with ~110 `Plan_Item` rows** (`CLAUDE.md`,
`docs/production-pagination-plan.md`). This screen fetches and renders **all of them at
once**:

**Server (`getAdminCalculation.dg`)** — the per-item loop
(`for each pi in planItems`, `:334`) does, per item:
- `Item_Master[ID == piSkuId.toLong()]` — **cached** (`itemSkuById` etc., added
  2026-09-08). Fine.
- `BOM[ID == pi.BOM]` + walk `Material_Required` subform (`:370`) — one per item, **not
  cached** across items. Many items share one BOM (`CLAUDE.md`: *"every size of one
  style does"*), so the same BOM + subform is re-read ~110 times.
- `Material_Requirement[Plan_Item == pi.ID]` (`:386`) — indexed, fine per item.
- nested `Raw_Material[ID == mMat]` **per requirement row per item** (`:399`) — see #2.
- `Waste_Movement[Plan_Item == pi.ID]` + nested `Waste_Movement[Parent_Movement ==
  wi.ID]` + `Waste_Master[ID == wi.Waste_Piece]` per movement (in the "waste issued"
  block).

`getProductionWidgetData` was given a 3rd arg `itemPageJson` (`{skip,limit:10,...}`)
for exactly this shape. `getAdminCalculation` returns the whole `plans[].items[]` array
uncapped. On a 110-item order that's ~110 × (BOM walk + 3 requirement rows ×
Raw_Material + waste walks) in one execution — the uncatchable statement limit is in
range, and even short of it the payload is large.

**Client (`render()`, `main.js:1436`)** — `DATA.plans.forEach` → `plan.items.forEach`
→ `renderItemMaterials(item)` for **every** item, building the full answer table +
collapsed `work-row` (`renderFabricLine` / `renderNonFabric`, four HTML steps each)
into one `content.innerHTML` string. 109 of 110 are `open === false` and never looked
at, but all are in the DOM. Same "110 cards is an unusable scroll" problem
`docs/production-pagination-plan.md` describes for the Production tab.

**Fix — port the `getProductionWidgetData` pagination pattern:**
- Add `itemPageJson` (JSON blob: `{"skip":0,"limit":10,"focusItemId":"","search":""}`)
  as a 3rd arg to `getAdminCalculation`. **Manual Creator step:** add it to the Custom
  API argument list in the same pass as the `.dg` paste, or every call fails "Number of
  params/datatype mismatch".
- Server returns one page of the order's items + `itemTotal` / `itemSkip` /
  `itemLimit`. The order picker payload (`orders[]`, no `salesOrderId`) is unchanged.
- Client: a pager under the plan header (port `pagerHtml` / `pageListFor` from the store
  widget, same as `production.js` did), plus the item-name/SKU search box.
- `render()` builds cards for the current page only.

This is the real work on this screen. Budget for it as its own session — it's listed
in `docs/production-pagination-plan.md`'s "still to do" alongside `getCheckingQueue`
and `getFinishingItems`, and `getAdminCalculation` should join that list.

Until then: the screen works for normal orders (a handful of items) and only degrades
on the big Faire-style ones.

---

### 2. `getAdminCalculation.dg` — `Raw_Material` re-queried per requirement row (N+1)

`getAdminCalculation.dg:399` — `for each rm2 in Raw_Material[ID == mMat]` inside the
`Material_Requirement` loop inside the `Plan_Item` loop. It reads `SKU`,
`Material_Display_Name`, `Fabric_Width_Inches`.

The **same fabric** appears on many items of one order (a duvet set: cover + shams, all
one cloth). This re-fetches that `Raw_Material` row once per item that uses it —
~110 times for a single-fabric order.

Every other hot function in this repo caches this: `getStoreMaterialRequirements`,
`getExpectedWaste`, `getProductionWidgetData` all key a `Map` by material id and read
each `Raw_Material` once. `getAdminCalculation` got the `Item_Master` cache on
2026-09-08 but not this one.

**Fix — one `matInfoById = Map()` cache**, filled lazily on first sight of a material
id (SKU + display name + width-cm), same shape as `itemSkuById`. Trivial once #1 is
being worked, and it removes ~100 queries from a common order even before pagination.

---

### 3. `ApiExperiment.run()` scans the whole `Material_Requirement` + `Plan_Item` reports

`app/js/api-experiment.js:151-153` — `getAll(RPT.reqs, null)` and
`getAll(RPT.planItems, null)`: **no criteria**, full-report cursor walk (1000/page).

`docs/scaling.md` states as a load-bearing invariant: *"`Material_Requirement` is never
scanned"* — every Deluge read is a criteria query on an indexed lookup. `ApiExperiment`
is a **client-side** port and breaks that invariant: it pulls every requirement and
every plan item ever created, then filters to open plans in `assemble()`.

This is **inherited from the store screen**, not introduced here — the store's
`loadRequirements` runs the same `ApiExperiment.run()`. It's a JS-side `getRecords`
walk so there's no statement limit, but:
- `Material_Requirement` grows with every plan and is never pruned. Today it's fine;
  in year three the Raw Materials... sorry, the *audit* screen's live-allocation column
  waits on a multi-thousand-row fetch on every order change.
- The audit widget pays this cost **on every order the admin clicks**, because
  `loadLive` runs after every `getAdminCalculation`.

**Fix — not this widget's to make alone.** It's an `api-experiment.js` question shared
with the store screen:
- Filter `RPT.reqs` and `RPT.planItems` by the open-plan set the same way `RPT.plans`
  is already filtered (`getRecords` `criteria` supports `Plan.in(...)` style? — verify;
  if not, fetch plans first, then requirements filtered by the plan ids in batches).
- Or accept it as documented debt in `docs/scaling.md` (it's currently *undocumented*
  debt — the doc says requirements are never scanned, and this is the exception).

At minimum: **add a line to `docs/scaling.md`** noting `api-experiment.js` is the one
place `Material_Requirement` *is* scanned, and why (client-side, whole open-plans
dataset, no statement limit).

---

## 🟡 Minor

### 4. `bucketFor()` is O(n·m) per material row

`main.js` `bucketFor(key)` walks all of `LIVE` (every supervisor × every material ×
every `orderOutcomes` entry) to find one match. `matAnswerRow` calls it once per
material per item — ~330 calls on a 110-item order, each a nested triple loop over
`LIVE`.

`LIVE` is bounded by open WIP (not history), so this isn't a scaling cliff, but it's
avoidable work. **Fix:** build a `Map` keyed `supId|matId|src` once when `LIVE` lands
(in `loadLive`'s `.then`), have `bucketFor` and `liveFor` read it. Low priority — do it
if #1 touches this area anyway.

### 5. `Material_Display_Name` / `Name` fallback — confirm `Name` exists

`getAdminCalculation.dg:410-413`, `getOrderConsumption.dg:502-506` both do
`ifnull(rm.Material_Display_Name, "")` then fall back to `rm.Name`. Same question as
`docs/admin-dashboard-audit.md` #2: does `Raw_Material` have a `Name` field, or is the
canonical one `Material_Name`? A wrong link name returns empty silently. Check the form;
fix both files (and `getRawMaterialsList.dg`) to the same real field.

### 6. `console.log` left in the load path

`main.js:1934` `console.log('raw response:', response)`, `:1944`
`console.log('parsed:', parsed)`. Debug logging on every order load. Harmless but noisy
in a shipped widget — the other widgets don't do this. Remove or gate behind a
`DEBUG` flag.

### 7. Stale comment block at the top of `main.js`

`main.js:24-30` — *"AND THAT INSTRUCTION WAS NOT FOLLOWED, WHICH IS WHY THE MIRROR IS
NOW CHECKED…"* describes a bug that was fixed. It reads as a live warning. Fold it into
a past-tense one-liner or drop it — the `serverWasteCheck` mechanism it describes is
the current design, documented at `:32-36`.

---

## ✅ Solid — do not "fix"

- **`getOrderConsumption.dg`** — the "Material used" tab. Bounded (one order → its
  plans → per-plan child queries all filtered `Plan == plan.ID`; one order = one plan
  by `createProductionPlans`' design). Every numeric read `ifnull`-guarded, every
  entry-creation path initialises all keys (the header comments explain each guard and
  the bug it prevents). Damage/waste "reported, never netted" is a deliberate,
  documented decision (`CLAUDE.md` deliberate-gaps). The `Waste_Master[ID ==
  wg.Waste_Piece]` per-movement query is the one loose query, bounded by an order's
  cutting activity, `isNumber()`-guarded against a bad SKU taking the report down.
- **`getExpectedWaste.dg`** — scoped to one item on one plan. Called lazily by the
  widget now (`ensureExpectedWaste`, guarded by `EXP_WASTE` so it fires once per item).
- **The 2026-09-08 rework** — removing the `getStoreMaterialRequirements` cross-call,
  synthesising `bucketFor` from `LIVE`, lazy `getExpectedWaste`. That killed the
  ~110-cross-call statement-limit bug. Covered by `tools/api-experiment-parity.test.js`
  (16 checks). Don't undo it to "simplify".
- **`render()` / `wire()` listener handling** — `content.innerHTML = h` drops old
  nodes and their listeners before `wire()` re-binds; `wireWaste()` is
  `dataset.wired`-guarded. No leak on re-render.
- **Widget date label, number formatting** (`num()` trailing-zero trim, `same()`
  tolerance) — careful, matches the other widgets.

---

## Suggested order of work

1. **#2 `Raw_Material` cache** — small, removes ~100 queries from a common order, safe.
2. **#5 confirm the name field** — one form check, fix three files.
3. **#3 document the `api-experiment.js` scan** in `docs/scaling.md` (the fix itself is
   a store-screen decision, but the doc lie should be corrected now).
4. **#1 item pagination** — the real work. Own session. Port `getProductionWidgetData`'s
   `itemPageJson` pattern server-side and the store widget's pager client-side. Add
   `getAdminCalculation` to `docs/production-pagination-plan.md`'s "still to do" list.
5. **#4, #6, #7** — cleanup, low priority.

## Deploy checklist (per `CLAUDE.md`)

- **#1** — `getAdminCalculation.dg` gets a new 3rd arg. **Manual Creator step:** add
  `itemPageJson` to the Custom API's argument list in the same pass as the `.dg` paste,
  or every call fails "Number of params/datatype mismatch". Execute against a real
  100+ item order to confirm it stays under the statement limit.
- **#2, #5** — no signature change. Paste + Execute `getAdminCalculation.dg` (and
  `getOrderConsumption.dg`, `getRawMaterialsList.dg` for #5). Confirm material names and
  widths still come back.
- **#3** — doc-only, no deploy.
- No Creator **form** changes required. Confirm the `Raw_Material` name field (#5) by
  opening the form.
- Re-run `node tools/api-experiment-parity.test.js` after any `api-experiment.js` touch.
