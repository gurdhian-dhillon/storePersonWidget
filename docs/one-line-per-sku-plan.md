# One line per SKU on the store screen — implementation plan

Status: **BUILT** (widget-side verified by tools/sku-row.test.js + full existing suite; Deluge
needs a real Execute against a multi-cut order). Admin (`app/admin/`, `getAdminCalculation.dg`)
is OUT OF SCOPE — fixed in a later pass, and WILL render wrong until then because it shares
`lot-allocator.js`.

## Deviation from the plan

`issueMaterials.dg` DID change (the plan said it would not): the `Waste_Movement` "Issued"
record stamps `Cut_Size_Width/Length`, and there is no single cut on the SKU wrapper any more,
so each `wastePicks[]` entry now carries its target item's `cutW`/`cutL` and issueMaterials
reads that (falling back to the wrapper for an older widget). Additive, no signature change.

## Files changed

- `deluge/getStoreMaterialRequirements.dg` — aggregation key drops cut size; `cuts[]` per
  entry; `lines[].cutW/cutL`; `freshMeters` summed over cuts. Serialisation updated.
- `deluge/issueMaterials.dg` — per-pick `cutW`/`cutL` for the waste movement (see Deviation).
- `app/js/lot-allocator.js` — demands read cut off the line; `res.owedByCut`/`wasteByCut`;
  lotLines carry `cutW`/`cutL`; write-back `need` summed over cuts; `applyFabricOverride` is now
  `(m, lotId, editedMetres)` — per-lot scope, per-line cut. Dead single-cut chain removed
  (`recommendLots`/`recommendedTotal`/`currentIssueMetres`/`fabricMetresEditable`/`editedMetresNote`).
- `app/js/main.js` — `renderFabricRows` draws one row per SKU; `lotLinesHtml(m,s,x,editable)`
  emits per-lot box + checkbox; new `onLotLineInput`/`onLotLineCheck`; `refreshCardState`,
  select-all, `validateRow`, `markRowSelected`, `issueForSupervisor` all handle per-lot boxes;
  `buildFabricIssueLine` reads cut per line; `renderQtyIssueRow` is non-fabric only now.
- `app/css/style.css` — `.lot-line-row` / `.lot-line-box` / `.lot-line-static` / `.lot-line-auto`.
- `tools/print-cut.test.js` — PART B updated to the new `lotLinesHtml` signature.
- `tools/sku-row.test.js` — NEW: 47 assertions over aggregation, render, payload, single-cut
  regression, partial-issue fan-out, per-lot edit.

## Goal

Store screen FABRIC section: **one row per raw-material SKU** (and one per printed-fabric SKU). A SKU never
repeats within a supervisor's issue window. Inside the one row:

- Headline "To be issued" = Σ of the allocator's per-lot metres for that SKU (reconciles with the lot sub-lines).
- Lot column = stacked lot sub-lines (`L1 · 2.1 m`, `L2 · 8.9 m`), **each with its own editable metres box + checkbox**.
- Waste = stacked offcut sub-lines for that SKU, each with its own pcs box + checkbox — as today.
- A SKU covered entirely by offcuts → one row, `0 m` headline, no lot sub-line, waste sub-lines only.

Cut size disappears from the store view. `issueMaterials.dg`, `receiveMaterials.dg`, the supervisor screen,
and the Custom API signatures are UNCHANGED — the payload still carries the full per-item fan.

Trims ("Other materials") untouched — already one row per material.

---

## Why this is smaller than it looks

`lot-allocator.js` `lotFill()` **already** reads `d.cutW` / `d.cutL` **per demand** (lines ~250, ~340), so it
already handles many cut sizes in one call. `allocateMaterial()` already gathers every cut-size entry for one
material and allocates them together. The per-cut split on screen is purely an artefact of the server
aggregation key emitting one `matEntry` per cut size.

So the change is: **merge the server key**, **carry cut size per-line instead of per-entry**, and adjust the
handful of spots that read `m.cutWidth` / `m.cutLength` directly.

---

## The "which order / which item starves" question — already handled, must be preserved

This is not new work; it is an existing invariant to keep intact:

- `allocations[]` in the payload is **one entry per `planItemId`**, each with `giveQty` (→ `Issued_Qty`),
  `giveRaw` (→ `Pieces_From_Raw`), `giveWaste` (→ `Pieces_From_Waste`), capped at `owedByItem[it]`
  (`reqPieces − issPieces` from `m.lines[]`).
- `issueMaterials.dg` writes each allocation onto **that item's own `Material_Requirement` row**.
- A **partial issue or a hand-edit that lowers metres** → `giveRaw` < `owed` for the items the allocator
  could not fully cover → those `Material_Requirement` rows stay open (`Pieces_From_Raw + Pieces_From_Waste
  < Required_Pieces`) → `getStoreMaterialRequirements` re-sends them next window and `getProductionWidgetData`
  shows those items still `Awaiting_Material`.
- **Which sales order / which item starves** = exactly the `Material_Requirement` rows still short on pieces.
  Already queryable, already drives every downstream screen. No new mechanism.
- **The fan order** (who gets filled first when cloth is short): `lotFill` fills demands in scan order until
  `metres` runs out; demand/order processing order is `orderSeq` = server plan-walk order = oldest plan
  first (`Production_Planning sort by Added_Time`). **Do not change this ordering.**

The store person edits ONE lot sub-line box. `applyFabricOverride` redistributes that lot's lines and
re-derives `fromRaw` per line **using that line's own `cutL`** (today it uses `m.cutLength`). The per-item
`allocations[]` then fall out of `m.lotLines[]` exactly as they do now — capped per item — so a short edit
naturally leaves the uncovered items' requirement rows open. Nothing extra to write for the fan-out; it is a
consequence of the existing per-item allocation + per-item cap.

---

## Server: `deluge/getStoreMaterialRequirements.dg`

### 1. Aggregation key (line 277)

```
// FROM
key = supId + "|" + matId + "|" + cutW + "x" + cutL + "|" + srcTxt;
// TO
key = supId + "|" + matId + "|" + srcTxt;
```

### 2. `lines[]` gains cut size per line (lnMap, ~line 350)

Add:
```
lnMap.put("cutW", cutW);
lnMap.put("cutL", cutL);
```
(`cutW` / `cutL` are already computed per `mr` at lines 241-242.)

### 3. `cur` no longer per-cut — carry a `cuts[]` summary

When creating `cur` (line ~282), add `cur.put("cuts", Map())`.
On every row, roll into it keyed `cutW + "x" + cutL`:
```
ckey = cutW + "x" + cutL;
cc = cur.get("cuts").get(ckey);
if(cc == null){ cc = Map(); cc.put("cutW",cutW); cc.put("cutL",cutL);
                cc.put("reqPieces",0); cc.put("issPieces",0); }
cc.put("reqPieces", cc.get("reqPieces") + reqPieces);
cc.put("issPieces", cc.get("issPieces") + issPieces);
cur.get("cuts").put(ckey, cc);
```
`required` / `issued` / `reqPieces` / `issPieces` / `wasteIssPieces` on `cur` keep accumulating as SKU totals
(already `+=`).

### 4. The fabric block (lines 1107-1283) stops reading a single `cutW` / `cutL`

- Remove `matEntry.put("cutWidth", cutW)` / `("cutLength", cutL)`.
- Add `matEntry.put("cuts", <list of {cutW,cutL,reqPieces,issPieces} from cur.get("cuts")>)`.
- `freshMeters` (the pre-waste headline estimate) becomes **Σ over `cuts[]`**:
  ```
  freshMeters = 0.0;
  for each ck in cutsList {
      pr = (fabricWidthCm / ck.cutW).floor();
      remain = ck.reqPieces - ck.issPieces;
      if(pr > 0 && ck.cutW > 0 && ck.cutL > 0 && remain > 0){
          rows = ((remain * 1.0) / pr).ceil();
          freshMeters = freshMeters + (rows * ck.cutL) / 100;
      }
  }
  ```
  When no cut in `cuts[]` is countable (all `0x0` / missing width) → fall back to `req - iss` exactly as the
  current `else` branch does, and set the same `noPieceData`-style signal.
- `requiredPieces` / `outstandingPieces` stay SKU totals.
- `lotsJson`, `wasteStock`, `printBase*`, `lines[]` — unchanged (already per-material).
- `matEntry.put("required", freshMeters)` / `("remaining", freshMeters)` / `("requiredTotal", req)` — unchanged
  semantics, just fed by the summed `freshMeters`.

### 5. Row-budget paging (lines 195-213)

`thisPlanRowCount` counts raw `Material_Requirement` rows walked — merging entries does NOT change that.
**No change**, but re-verify the tally still increments per `mr`, not per `cur`.

---

## Widget: `app/js/lot-allocator.js`

### `allocateMaterial` (line 565)

- `rows` is now length 1 (or 2 with a Reissue entry) per material — fine, the loop already handles N.
- **PASS 2 demand build (lines 661-686)**: change
  ```
  cutW: rw.m.cutWidth,
  cutL: rw.m.cutLength,
  ```
  to
  ```
  cutW: Number(ln.cutW) || 0,
  cutL: Number(ln.cutL) || 0,
  ```
  Demands are now per `(planItemId, cutW, cutL)` — one line can yield several demands if an item somehow has
  two cut sizes (it won't normally, but the code must not assume).
- `lotFill` / `remnantYield` / `perRowFor` — **no change**, already per-demand.
- `spend()` write-back (lines 762-878): `r.lotLines.push({... })` at line ~813 must carry the demand's cut
  size so the payload builder can stamp `Cut_Size_*` per line:
  ```
  r.lotLines.push({ lotId: lot.lotId, lotNumber: lot.lotNumber,
                    qty: fill.metresPer[i], planItemId: d.planItemId,
                    planId: d.planId, cutW: d.cutW, cutL: d.cutL,   // <-- ADD
                    pieces: lnPieces, cutSummary: cSumm,
                    fromRaw: fill.fromFresh[i], fromWaste: fill.fromWaste[i],
                    note: noteOn, overrideFrom: fromOn });
  ```
- **`res[rw.idx]` per-cut tracking for the `need` calc**: today `r.owed` and `r.fromWaste` are scalars and
  the write-back (lines 1163-1188) computes `need` from `m.cutWidth` / `m.cutLength`. With multiple cuts this
  must become **Σ over cuts**. Cleanest: track `r.owedByCut` and `r.wasteByCut` maps keyed `cutW+"x"+cutL`,
  incremented in `spend()` alongside `r.owed` / `r.fromWaste`. Then:
  ```
  var need = 0;
  (m.cuts || []).forEach(function (ck) {
      var pr = perRowFor({ fabricWidthCm: m.fabricWidthCm }, ck.cutW);
      var cl = Number(ck.cutL) || 0;
      var key = ck.cutW + 'x' + ck.cutL;
      var owedCut = (r.owedByCut && r.owedByCut[key]) || 0;   // set from demands
      var wasteCut = (r.wasteByCut && r.wasteByCut[key]) || 0;
      var freshCut = Math.max(0, owedCut - wasteCut);
      if ((Number(m.requiredPieces) || 0) > 0 && pr > 0 && cl > 0 && freshCut > 0) {
          need += round2((Math.ceil(freshCut / pr) * cl) / 100);
      }
  });
  if (need === 0 && /* no countable cut */) { need = round2(Math.max(0, Number(m.freshMeters) || 0)); r.noPieceData = true; }
  ```
  `r.owedByCut` is seeded from the demands loop (line 883 `res[d.rowIdx].owed += d.pieces` → also
  `res[d.rowIdx].owedByCut[d.cutW+'x'+d.cutL] += d.pieces`).
- `m.autoMetres` / `m.autoLotLines` / `m.autoRemaining` (lines 1233-1238) — unchanged, computed from
  `m.lotLines`.

### `applyFabricOverride` (line ~1242)

Today it re-derives `fromRaw` per line using `m.cutLength` and one `perRow`. Change to **per line's own cut**:
```
var cutLcm = (Number(ln.cutL) || 0) * 100;
var perRow = perRowFor({ fabricWidthCm: m.fabricWidthCm }, Number(ln.cutW) || 0);
var rows = (cutLcm > 0) ? Math.floor((lineMetresCm + 0.5) / cutLcm) : 0;
```
`owedBy[it]` cap still from `m.lines[]` reqPieces/issPieces (already per item). Because a SKU row now has lot
lines of several cut sizes, the "distribute proportionally" step stays, but the per-line floor uses that
line's cut. The Pieces-lot guard (`ln.pieces && ln.pieces.length` → refuse) is unchanged.

**NOTE:** the editable box is moving from the main row to per-lot-line. `applyFabricOverride(m, editedMetres)`
currently takes ONE total for the whole `m`. It becomes `applyFabricOverride(m, lotId, editedMetres)` —
redistribute across only THAT lot's lines. Signature change; only caller is `onIssueInputChange`.

---

## Widget: `app/js/main.js`

### ID scheme

Per-lot-line boxes: `fab-lot-<supIdx>-<matIdx>-<lotIdx>` + `fab-lot-check-<supIdx>-<matIdx>-<lotIdx>`.
Waste boxes keep `waste-input-<supIdx>-<matIdx>-<pickIdx>`. `matIdx` now indexes one-per-SKU (short array).

### `renderFabricRows` (line 1807)

- Headline "To be issued" cell: `fmt(m.remaining)` (SKU total) + stacked waste `pc` sub-labels — as today.
- Lot cell (`col-lot-issue`): for each `m.lotLines` grouped by lot, render one sub-line:
  `L2 · <editable box> m  [✓]` plus the existing "which pieces to fetch" text from `lotLinesHtml`.
- Issue cell (`col-issue`): drop the single main-row metres box + checkbox. Keep per-waste-pick box + checkbox
  stacked. (The lot checkboxes live in the lot cell now.)
- Waste-only SKU: `m.lotLines` empty → no lot sub-line, headline `—`/`0`, waste sub-lines present.

### `lotLinesHtml` / `lotLinesFor` — extend to emit the editable box + checkbox per lot line.

### `recommendedTotal` / `currentIssueMetres` — unchanged (Σ `m.lotLines[].qty`).

### `onIssueInputChange` → split into `onLotLineInput(supIdx, matIdx, lotId)`

Reads that lot's box, calls `applyFabricOverride(m, lotId, val)`, `refreshFabricRowLots`, `validateRow`,
`refreshCardState`.

### `refreshFabricRowLots` — repaint the lot cell's sub-lines + hidden inputs + `auto:` note. Already close.

### `buildFabricIssueLine` (line 2741)

- Remove top `var cutW = m.cutWidth`, `var cutL = m.cutLength`.
- `lotMoves` grouping — unchanged (by lot).
- `allocations` per `planItemId` — unchanged logic; `owedByItem` from `m.lines[]` (already per item).
- `issueLines[]` — set `cutW` / `cutL` **from the matching `lotLine`** (`ln.cutW` / `ln.cutL`), not from `m`.
  The PRINTED_PIECE branch already reads `ln`.
- `wastePicks` yield: `remnantYield(..., cutW, cutL)` — needs the **target item's** cut size. Resolve via the
  pick's `planItemId` → find that item's cut from `m.lines[]` (`ln.cutW`/`ln.cutL`). Fall back to the pick's
  own recorded dims if the item can't be found.
- Return object: `cutWidth` / `cutLength` at the top level are no longer meaningful for a multi-cut SKU —
  keep them as `0` (server reads per issue line, not the wrapper) OR drop them. **Check `issueMaterials.dg`
  reads `im.get("cutWidth")` at line 106** — it uses it only as a fallback for issue lines that omit `cutW`.
  Since every issue line now carries its own, sending `0` at the wrapper is safe. Keep as `0` and comment why.

### `issueForSupervisor` (line ~2960)

- Fabric branch: gather typed metres from each `fab-lot-*` box for this `m`, not one row box.
- `hasLots` check, the "choose which lot" alert — keep, adapted to per-lot boxes.
- Everything else (`buildFabricIssueLine(m, picks)`, chunking, `invokeCustomApi`) — unchanged.

### `refreshCardState` (line 615) — fabric branch counts `fab-lot-*` + `waste-*` boxes per section.

### `onSelectAllChange` / select-all — tick every `fab-lot-*` + `waste-*` in the section.

### `buildShortfallSummary` (line ~1944) — already keyed by `materialId`; merging entries simplifies it.
Verify it reads `m.remaining` (SKU total) and `m.washLots` correctly with one entry per SKU.

### `stockStatus` / `isFullyIssued` / `needsFreshFabric` — operate on `m`; verify they still hold with SKU
totals (they read `m.remaining`, `m.outstandingPieces`, `m.freshPieces`, all SKU-level now).

---

## Widget: `app/css/style.css`

- `.col-lot-issue` sub-line: flex row — `lot label · number box · unit · checkbox` — reusing
  `.issue-input-group`, one per lot line, vertical stack.
- Match sub-line heights between the lot cell and any waste sub-lines so rows read straight across.
- `.issue-edited-note` ("auto: X") moves under the relevant lot sub-line.

---

## Testing (Node + stub-DOM, like the fabric-edit feature)

1. **Server aggregation** (port arithmetic to Node): 5 cut sizes of one fabric across 3 plans → one
   `matEntry`, `cuts[]` length 5, `required` = Σ per-cut `ceil` metres, `lines[]` length = Σ requirement rows,
   each line carrying `cutW`/`cutL`.
2. **Allocator**: one `m` per material → demands built from `lines[]` per `(planItemId,cutW,cutL)`;
   `m.lotLines[]` spans all cuts, each tagged correct `cutW`/`cutL`/`planItemId`; `fromRaw` per line = whole
   marker rows for THAT cut; `m.remaining` = Σ per-cut fresh need.
3. **Render**: one `<tr>` per SKU; N lot sub-lines each with a box+checkbox; M waste sub-lines; headline =
   Σ lot boxes; waste-only SKU → no lot sub-line.
4. **Payload — REGRESSION**: for a supervisor whose fabrics are all single-cut, `buildFabricIssueLine` output
   must be **byte-identical** to pre-change (diff the JSON). This is the safety gate.
5. **Payload — multi-cut**: one allocation per `planItemId` with correct per-cut `giveRaw`; one `lotMove` per
   lot; `issueLines[].cutW/cutL` per line; wrapper `cutWidth/cutLength` = 0.
6. **Partial issue fan-out**: allocator given metres enough for 2 of 3 orders → `allocations` for the 2
   covered items have `giveRaw` = owed; the 3rd item gets `giveRaw` = 0 (or is absent) → its requirement row
   stays open. Assert the payload does NOT credit the starved item.
7. **Hand-edit one lot down**: `applyFabricOverride(m, lotId, lowerVal)` → only that lot's lines re-derived
   with per-line `cutL`; other lots untouched; starved items' requirement rows still open;
   `giveRaw` never exceeds `owedByItem`.
8. **Waste + fabric coexist**: a SKU with both fresh cuts and offcuts → `wastePicks` yield uses the target
   item's cut size; total pieces credited per item ≤ owed.
9. **Edge**: `0x0` cut (missing width) SKU → `noPieceData` path, `need` = server `req-iss`, row still visible
   and issuable.

---

## Redeploy checklist

- `deluge/getStoreMaterialRequirements.dg` → paste into Creator, **Execute** against a real multi-cut order.
- `app/js/lot-allocator.js`, `app/js/main.js`, `app/css/style.css` → widget bundle.
- **No** Creator form/field change. **No** `issueMaterials.dg` change. **No** Custom API signature change.
- `getStoreMaterialRequirements` return contract changes shape (`cutWidth`/`cutLength` per entry → `cuts[]`);
  the widget is updated in lockstep. Nothing else consumes that response.

## Explicitly deferred

- `app/admin/` + `getAdminCalculation.dg` — the calculation audit replays the allocator and reads
  `m.cutWidth` directly; it WILL render wrong or break after this. Fixed in the next pass, not now.
- Trims / "Other materials" — already one row per material, untouched.
