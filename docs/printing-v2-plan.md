# Printing v2 — rebuild in the rolls world, no minting, no Inventory

Supersedes the send/receive halves of `docs/printing.md`. Same feature (plain cloth →
printer → printed cloth back → issued like any fabric), rebuilt on these decisions:

| Decision | v1 | v2 |
|---|---|---|
| Printed stock shape | `Fabric_Piece` rows | **`Lot_Rolls` rows** — each returned piece is one roll (`Origin = "Printed"`). `Fabric_Piece` deleted. |
| Minting a printed SKU | `sendToPrint` inserts a `Raw_Material` | **never.** Printed SKUs are created in Zoho Inventory and pushed to Creator. He picks an existing one. |
| Plain↔printed link | `Raw_Material.Print_Base` lookup | **no system link.** He picks source + target himself. `Print_Base` deleted. |
| Target picker | pattern dropdown → resolves the pair | **searchable list, filtered to width == source width.** (A `Type_field == "printed fabric"` filter is coded but OFF for now — server and widget both — flip both together to re-enable.) |
| Pattern | half of SKU identity, `PRINT_PATTERNS` const | **gone.** No pattern concept anywhere in the print flow. |
| Read side | `getPrintData.dg` custom API | **JS via `getRecords`** (new `print-data.js` module). `getPrintData.dg` deleted. |
| Which source rolls a job cut | not recorded (v1 had 1 `Print_Job.Source_Roll` dropdown) | **`Print_Job.Source_Rolls` subform** (`Roll_Label`, `Metres`), so cancel can wind them back. |
| Roll-cut automation | n/a (v1 typed metres per lot) | he types **(length × count) lines**; server auto-picks source rolls **shortest-first**, or he overrides with a roll plan. |
| Inventory | designed, deferred | still deferred — separate pass. This pass is Creator-only. |

This also completes **lot-rolls Phase A Steps 6–7** for the print path (`receiveFromPrint`
creates rolls; `sendToPrint`/`cancelPrintJob` name and wind back rolls).

---

## 1. Data model — final field list (manual Creator changes listed in §7)

### `Print_Job` — the run

| Field | Type | Notes |
|---|---|---|
| `Source_Material` | Lookup → Raw_Material | (renamed from `Plain_Material`) the fabric sent out |
| `Source_Lot` | Lookup → Raw_Material_Lot | (renamed from `Plain_Lot`) |
| `Printed_Material` | Lookup → Raw_Material | the existing printed SKU he chose as target |
| `Printed_Lot` | Lookup → Raw_Material_Lot | set at receipt |
| `Printer` | Lookup → Third_Party | |
| `Source_State` | Dropdown `Wash` / `Unwash` | which counter the cloth came off — the cancel wind-back target |
| `Metres_Sent` | Decimal 2dp default 0 | `Σ Send_Lines(len × count) / 100` |
| `Metres_Returned` | Decimal 2dp default 0 | set at receipt |
| `Sent_On` / `Returned_On` | Date | |
| `Job_Status` | Dropdown `At_Printer` / `Received` / `Cancelled` default `At_Printer` | |
| `Remarks` | Multi Line | cancel/receipt notes appended with `\n` |
| `Send_Lines` | Subform | `Piece_Length_Cm` (Decimal 2dp), `Piece_Count` (Decimal **0dp**) |
| `Receive_Lines` | Subform | `Piece_Length_Cm` (2dp), `Piece_Count` (0dp), `State` (Dropdown `Wash`/`Unwash`) |
| `Source_Rolls` | **NEW Subform** | `Roll_Label` (Single Line), `Metres` (Decimal 2dp) — which source rolls this job cut and how much off each |
| `Job_Ref` | Auto Number | optional, legibility for the lookups pointing here |

**Deleted:** `Source Roll` (the single dropdown), `Plain_Material`/`Plain_Lot` names (renamed).

### `Raw_Material_Lot`

- **Delete** `Form` (the `Roll`/`Pieces` dropdown — nothing reads it once `Fabric_Piece` is gone;
  allocator already treats absent as `Roll`).
- **Keep** `In_Print_Qty`, `Source_Lot`, `Print_Job` (back-pointer: printed lot → its job).
- `Lot_Rolls` subform unchanged — already has `Roll_Label`, `Roll_Length`, `Roll_Status`
  (`Available`/`Consumed`/`Blocked`), `Origin` (`Purchased`/`Printed`/`Remnant`/`Returned`),
  `Source_Receipt`.

### `Raw_Material`

- **Delete** `Print_Base`.
- **Keep** `In_Print_Qty` (parent mirror), `Type_field` (the printed-vs-plain signal),
  `Fabric_Width_Inches` (the width-match key).

### `Material_Issue.Issue_Lines`

- **Delete** `Fabric_Piece` (lookup) and `Pieces` (decimal) — the v1 pieces-issue path,
  already dead on the widget side.

### `Fabric_Piece` form

- **Delete the whole form** — after `receiveFromPrint` stops writing it (step order in §6).

---

## 2. Read side — `app/js/print-data.js` (NEW)

A small module, same shape as `api-experiment.js` (`getRecords`, cursor paging, the
`isNoRecords` → `[]` handling). Exposes `PrintData.load()` → a promise of:

```
{ source:  [ { id, name, sku, type, widthCm,
               lots: [ { lotId, lotNumber, wash, unwash, inPrint, blocked,
                         rolls: [ { rollId, label, length, status } ] } ] } ],
  target:  [ same shape ],          // Type_field ~ "printed fabric"
  printers:[ { id, name } ],
  jobs:    [ { jobId, sourceMaterialId, sourceName, sourceSku, sourceLotId, sourceLotNumber,
               printedMaterialId, printedName, printedSku, printerName,
               sourceState, metresSent, sentOn, jobStatus,
               sendLines: [ { lineIndex, lengthCm, count } ] } ] }
```

- `source` = every `Is_Fabric` material with ≥ 1 lot. `target` = the subset whose
  `Type_field.trim().toLowerCase() === 'printed fabric'`. (A material can be in both lists —
  a printed SKU is still a fabric and could itself be re-sent; the widget's own filters keep
  the two columns sensible.)
- Reports needed: `All_items_Report` (Raw_Material), `All_Material_Lots` (lots + nested
  `Lot_Rolls` via `field_config:'all'`), `Third_Party_Report`, **`Print_Job_Report` (NEW)** with
  `Send_Lines` nested. `jobs` filtered client-side to `Job_Status == "At_Printer"`.
- Rolls: only `Roll_Status == "Available"` with `Roll_Length > 0` are offered for a cut plan;
  all rolls returned for display.
- No `patterns`, no `Print_Base`, no `Fabric_Piece_Report` in this module.

`getPrintData.dg` — **deleted** (file + Creator custom API).

---

## 3. `sendToPrint.dg` — rewrite

### Payload

```
{ "sourceMaterialId":"123", "sourceLotId":"901", "sourceState":"Wash|Unwash",
  "targetMaterialId":"456",                 // an existing printed SKU
  "printerId":"77",
  "lines":[ {"lengthCm":300,"count":3}, {"lengthCm":275,"count":4} ],
  "rollPlan":[ {"rollId":"111","label":"L2-R1","metres":9.0}, {"rollId":"112","label":"L2-R2","metres":2.0} ],  // optional
  "remarks":"" }
```

### Response

```
{ "success":true, "jobId":"…", "metresSent":20.00,
  "rollPlan":[ {"rollId":"111","label":"L2-R1","metres":9.0}, ... ],   // what was actually cut
  "lotWash":22.60, "lotUnwash":0, "lotInPrint":20.00, "materialInPrint":20.00 }
```

### Logic (block order; keep the "one exit at the bottom / errTxt guard" shape)

1. **Parse + shallow validate.** `sourceMaterialId`, `sourceLotId`, `targetMaterialId`,
   `printerId` all numeric; `sourceState` ∈ {`Wash`,`Unwash`}; `lines` non-empty.
2. **Source material.** Exists, `Is_Fabric` truthy. Read `Fabric_Width_Inches` (as text).
3. **Target material.** Exists, `Is_Fabric` truthy, and width == source width (compared as
   numbers, both > 0). The `Type_field == "printed fabric"` check is **OFF for now** — the
   line is still in the file, commented, and the widget filter must be re-added in the same
   pass when it goes back. *(No `Print_Base` check — there is no link.)*
4. **Printer.** `Third_Party[ID == printerId].count() > 0`.
5. **Source lot.** Belongs to `sourceMaterialId`, not `Blocked`. Read `Wash_Quantity`,
   `Unwash_Quantity`, `In_Print_Qty` (EMPTY-safe). `stateHave` = the chosen counter.
6. **Lines.** Each: length > 0, count > 0, count whole (`cnt.toLong().toDecimal() == cntDec`).
   `metresSent = Σ len×count / 100`. `piecesSent = Σ count`. Reject `metresSent <= 0`.
7. **Budget.** `metresSent > stateHave` → reject (never trim — a trimmed `Metres_Sent`
   disagreeing with `Send_Lines` reads as printer loss for ever).
8. **Roll plan.** Read the source lot's `Lot_Rolls` into a list of
   `{label, length, status}` for `Available` rows with `length > 0`.
   - **`rollPlan` given:** every `label` must exist in that list, each `metres > 0`,
     `metres <= that roll's current length` (re-read here inside the execution — the
     concurrency guard), and `Σ metres == metresSent` (± 0.01). Reject otherwise.
   - **`rollPlan` omitted:** auto. Sort `Available` rolls **shortest `Roll_Length` first**,
     tie on `Roll_Label` (string). Walk: take `min(rollLen, remaining)` off each until
     `remaining == 0`. If the rolls cannot cover `metresSent` (Σ available roll length <
     metresSent) → reject *"lot L2 has 18.0 Mtr across its rolls, 20.0 asked for"*.
   - If the lot has **no `Lot_Rolls` rows at all** → reject *"lot L2 has no rolls recorded —
     it must be received into rolls before cloth can be sent to print"*. Never fall back to a
     metres pool.
   - Result: `planLabels[]` / `planMetres[]` parallel lists.
9. **Move the ledger (before writing the job — same failure-mode reasoning as v1: a stuck
   `In_Print_Qty` beats an imaginary credit):**
   - For each planned roll: re-read its `Roll_Length`, `newLen = len - planMetres`; if
     `newLen < 0` cap at 0 and set `errTxt` (stale read — do not partially apply); else
     `roll.Roll_Length = newLen`; `roll.Roll_Status = "Consumed"` when `newLen == 0`.
   - Source lot: `<state>Quantity -= metresSent`; `In_Print_Qty += metresSent`.
   - Source parent `Raw_Material`: mirror both; recompute `Quantity = Wash + Unwash +
     Unallocated` (unchanged pattern from v1).
10. **Insert `Print_Job`** (scalars only: `Source_State`, `Metres_Sent`, `Metres_Returned=0`,
    `Sent_On`, `Job_Status="At_Printer"`, `Remarks`, `Added_User`). Then set lookups +
    subforms after the insert:
    - `Source_Material`, `Source_Lot`, `Printed_Material` = targetMaterialId, `Printer`.
    - `Send_Lines` collection (length, count).
    - `Source_Rolls` collection (`Roll_Label` = planLabels[i], `Metres` = planMetres[i]).
11. **Response** — ids as strings, `rollPlan` echoed.

Delete from the file: the whole commented-out mint block, `pattern`, `Print_Base`,
`printedMaterialId` "empty ⇒ mint", the SKU-scan.

---

## 4. `receiveFromPrint.dg` — rewrite (Fabric_Piece → Lot_Rolls)

### Payload

```
{ "jobId":"555",
  "lotId":"",                        // empty => create the printed lot
  "lotNumber":"P1", "lotLabel":"",   // new lot only, TYPED, unique within the printed material
  "lines":[ {"lineIndex":0,"count":3,"state":"Wash"}, ... ],
  "remarks":"" }
```

*(No `carton` — printed rolls are ordinary fresh raw-material rolls: lot + label + length.)*

### Response

```
{ "success":true, "printedLotId":"…", "lotNumber":"P1",
  "metresSent":20.00, "metresReturned":19.85, "loss":0.15,
  "piecesSent":7, "piecesReturned":6, "piecesLost":1,
  "lotWash":19.85, "lotUnwash":0, "rollRows":6 }
```

### Logic

1. Job exists, `Job_Status == "At_Printer"`. Read `Source_Material`, `Source_Lot`,
   `Printed_Material`, `Metres_Sent`, and `Send_Lines` → `sentLenList` / `sentCntList`
   (parallel, subform order = the `lineIndex` the widget uses). `piecesSent`.
2. **Lines** (validate all before writing — no partial receipt):
   per line — `lineIndex` in range, not seen twice, `count` whole ≥ 0, `count <=
   sentCntList[idx]` (over-return refused), `state` ∈ {`Wash`,`Unwash`} when count > 0,
   optional `lengthCm` echo must equal `sentLenList[idx]` (stale-screen guard).
   `lnMtr = sentLenList[idx] * count / 100`; accumulate `metresReturned`, `washMetres` /
   `unwashMetres`, `piecesReturned`.
3. Reject if `metresReturned <= 0` (whole run lost → say so on the job, don't receive).
4. **Target printed lot:**
   - `lotId` given: belongs to `Printed_Material`, not `Blocked`.
   - else create: `lotNumber` non-empty, unique within `Printed_Material` (upper-cased
     compare). Insert `Raw_Material_Lot` (all quantities 0, `Status="Active"`, `Lot_Label`,
     **no `Form`**), then set `Print_Job` = jobId and `Source_Lot` = the job's `Source_Lot`.
5. **Insert `Lot_Rolls` rows** — for each returned line with `count > 0`, insert **`count`
   rows** (one per physical piece):
   ```
   Roll_Length  = sentLenList[idx] / 100
   Roll_Label   = lotNumber + "-P" + <running seq across the whole receipt>
   Roll_Status  = "Available"
   Origin       = "Printed"
   Source_Receipt = jobId (as string)
   ```
   Rows go into the target lot's `Lot_Rolls` subform (collection insert after resolving the
   lot, same technique as `seedLotRolls`). A zero-count line writes no roll.
   `rollRows = Σ count`.
6. **Ledger:**
   - Source lot + source parent: `In_Print_Qty -= Metres_Sent` (clamp 0, info line).
   - Target lot + target parent: `Wash_Quantity += washMetres`, `Unwash_Quantity +=
     unwashMetres`; target parent `Quantity` recomputed.
   - *(No roll-sum maintenance on the source side — `verifyLotSync` will flag if the source
     lot's `Σ Roll_Length` vs its shelf columns drifts, which it should not: `sendToPrint`
     already decremented the rolls when the cloth left.)*
7. **Stamp the job:** `Receive_Lines` collection (one row per sent size incl. zeros — the
   subforms must line up), `Metres_Returned`, `Returned_On`, `Printed_Lot`,
   `Job_Status="Received"`, append `remarks`. `loss = Metres_Sent - Metres_Returned`,
   `piecesLost = piecesSent - piecesReturned` (info line; written off against the source SKU
   by the `In_Print_Qty` clear, exactly as v1).

Delete: the `Fabric_Piece` insert, `Piece_Width_Cm` width read/stamp, `carton`, `Form="Pieces"`.

---

## 5. `cancelPrintJob.dg` — change

**The pieces were physically cut from the source rolls at send. You cannot un-cut them, so
cancel does NOT wind the original rolls back up.** Instead the returned bundle re-enters the
source lot as **one new `Lot_Rolls` row** — full-width cloth, same width, just shorter, which
is raw material by CLAUDE.md's "width unchanged = raw material" rule. NOT `Waste_Master`:
these pieces are fully usable, and booking them as waste corrupts `Pieces_From_Waste` and the
scrap report (CLAUDE.md "What NOT to do" #2).

One lump row, not one per piece — nothing needs per-piece detail on a bounced bundle, and a
20 m job of 3 m pieces would otherwise add 7 rows. The allocator's shortest-first drain
consolidates the rack over the next few issues anyway.

After the existing `In_Print_Qty -= Metres_Sent` on lot + parent, and `<state>Quantity +=
Metres_Sent` on the **parent only**:

- **Do NOT add `Metres_Sent` back to the source lot's `Wash_Quantity`/`Unwash_Quantity`
  directly** — the lot's shelf columns must equal `Σ Roll_Length`, so the metres return by
  way of the new roll.
- Actually simplest and consistent: the lot's `<state>Quantity += Metres_Sent` AND a new
  `Lot_Rolls` row of `Roll_Length = Metres_Sent` — so `Σ Roll_Length` and the column move
  together, exactly the invariant `verifyLotSync` checks.
  ```
  Roll_Length    = Metres_Sent
  Roll_Label     = <SourceLot.Lot_Number> + "-C" + <jobId>     (unique, traceable to the job)
  Roll_Status    = "Available"
  Origin         = "Returned"
  Source_Receipt = jobId (string)
  ```
- The `Source_Rolls` subform is **not read by cancel** — it's only for the record/audit of
  what was cut. (Still worth writing at send.)
- Rename the two lookups read: `Plain_Material` → `Source_Material`, `Plain_Lot` →
  `Source_Lot`. `Source_State` still decides which lot/parent column gets the metres back.
- `Job_Status = "Cancelled"`, append reason to `Remarks` (unchanged).

Response: `{ success, restoredTo, metres, newRollLabel, lotWash, lotInPrint }`.

> The widget's confirm text changes: not *"put X Mtr back on lot L2 as washed cloth"* but
> *"X Mtr of cut pieces go back onto lot L2 as a new roll — use this only if the printer
> returned it unprinted."*

---

## 6. Widget — `app/js/main.js` Print tab (lines ~8563–9613) + `app/widget.html` + CSS

Rewrite the tab region. Structure stays two-list (jobs at top, then the send list), but:

### `loadPrint()` → uses `PrintData.load()` instead of `invokeCustomApi('getPrintData')`.

### Send form — two columns

- **Source column (left):** searchable list of `PRINT_DATA.source` (every fabric with lots).
  Card header: name / sku / width / washed+unwashed totals. Filter box: sku or name substring.
- On opening a source card, the body shows:
  - the source lot table (lot / washed / unwashed / at-printer / status) — unchanged shape.
  - **Target picker:** a `<select>` (or searchable list) of `PRINT_DATA.target` filtered to
    `widthCm == source.widthCm` (rounded compare, tolerance 0 — exact). Label each option
    `sku — name`. If none: *"No printed fabric on record at this width. Create the SKU in
    Inventory first."*
  - Lot `<select>` (source lot, non-blocked), State `<select>` (Washed/Unwashed), Printer
    `<select>`.
  - (length × count) line editor — **unchanged** from today (`printLinesHtml`, `addSendLine`,
    `removeSendLine`, `refreshSendTotals`). Drop the width column's tie to a minted SKU;
    width shown = source width.
  - **Roll plan preview** (NEW, below the lines): auto-computed from the chosen source lot's
    `rolls[]`, shortest-first, against `sendMetres`. Renders *"Cut 9.0 m off L2-R1, 2.0 m off
    L2-R2"*. Each metres value is an editable input (`ps-roll-<matId>-<rollId>`); editing
    re-checks `Σ == sendMetres` and shows a mismatch warning. If left untouched, the payload
    omits `rollPlan` and the server auto-plans identically.
  - "Fabric used (Mtr)" disabled box — unchanged.
- **Drop:** `patternsFor`, `printedFor`, `printSkuNoteHtml`, `onSendPatternChange`,
  `PRINT_PATTERNS`, the pattern `<select>`, the mint confirm.
- `submitSendToPrint` payload → `{ sourceMaterialId, sourceLotId, sourceState,
  targetMaterialId, printerId, lines, rollPlan?, remarks }`.

### Receive form

- Rows are the send lines, fixed (unchanged).
- **Drop the width column** and the **carton column** (`pr-car-*`), `recvFooterHtml`'s carton
  logic, `submitReceivePrint`'s carton validation. Printed rolls need no carton.
- Lot picker (existing printed lots of the target, or + New lot with a typed number) —
  unchanged.
- `submitReceivePrint` payload → drop `lotLabel` stays, drop `carton` per line, keep
  `{ jobId, lotId, lotNumber, lines:[{lineIndex,count,state}], remarks }`.

### `openPrintForBase` (arrives from a short issue row)

The Issue tab's `shortReasonFor` `kind:'noPrinted'` and its **Print…** button
(`main.js:2574`, `2582`) currently rely on `Print_Base` (`why.base`, `why.baseId`).
**With `Print_Base` gone there is no base to resolve.** Options:
- (a) Drop the `noPrinted` short-reason entirely — the row just reads "No printed stock" with
  no button (the allocator already can't chain to a plain base — `api-experiment.js:33` says
  print-base chaining was never ported). **Recommended** — it's already a no-op path.
- (b) Keep a button that just opens the Print tab unfiltered.

→ **Recommend (a).** Remove `kind:'noPrinted'`, `openPrintForBase`, the `printBase` fields in
`api-experiment.js` (already empty), and the `print-shortreason.test.js` suite (or invert it
to assert the row shows no button).

### `widget.html`

Tab button + `#panel-print` stay. Add `<script src="js/print-data.js"></script>` before
`main.js`.

### CSS

`.print-derived`, `.print-form`, `.recv-short` stay. Add a small `.roll-plan` block style.
Remove nothing that Issue-tab shares.

---

## 7. Tests

| File | Action |
|---|---|
| `tools/print-writers.test.js` | **rewrite** — port the new `sendToPrint` (roll auto-plan shortest-first, budget cap, rollPlan override, no-rolls reject), `receiveFromPrint` (Lot_Rolls rows, `count` rows per line, over-return reject), `cancelPrintJob` (roll wind-back, consumed-roll new row). Lifecycle: send → cancel restores rolls; send → receive creates N rolls. |
| `tools/print-tab-ui.test.js` | **rewrite** — new send form (target picker filtered by width, roll-plan preview), receive form (no carton/width), `PrintData` shape. Load the tab region verbatim in a stub DOM as today. |
| `tools/print-data.test.js` | **NEW** — `print-data.js` assembly from stub `getRecords` rows: source/target split by `Type_field`, lots+rolls nesting, jobs filtered to `At_Printer`, empty-report handling. |
| `tools/print-cut.test.js` | **delete** — tests the `Fabric_Piece` "cut at issue" token pipeline that's being removed. Leave a one-line guard test asserting `issueMaterials` no longer parses `pieces[]` (or fold into print-writers). |
| `tools/print-shortreason.test.js` | **invert or delete** — `noPrinted` reason removed (§6). |
| `tools/receive-print.test.js` | **review** — it ports `getSupervisorMaterials` / `receiveMaterials` printed-piece branches. Those `PRINTED_PIECE` branches are already dead (rev 9 notes). Keep the `M3b` guard that pins the dead set; drop assertions about live pieces behaviour. |
| `tools/allocator-*` / `roll-display` / `store-ui` | **run, expect green** — printed lots are already just short rolls to the allocator. No allocator change in this pass. |
| `tools/dgscan.js` | run on all 3 touched `.dg` |

Verification: `node --check` on `main.js` + `print-data.js`; `node tools/*.test.js` full
sweep; `dgscan` + hand brace/paren + loop-var/scalar scan on the `.dg` files. **No Deluge
Execute possible here** — every `.dg` needs a Creator Execute after paste.

---

## 8. Exact Creator changes (manual — do after code is reviewed)

### Forms / fields

**`Print_Job`**
- Rename `Plain_Material` → `Source_Material` (link name).
- Rename `Plain_Lot` → `Source_Lot`.
- Delete `Source Roll` (the dropdown).
- Add subform `Source_Rolls`: `Roll_Label` (Single Line), `Metres` (Decimal, 2 dp, default 0).
- (optional) Add `Job_Ref` (Auto Number).
- Confirm `Metres_Sent` exists (Decimal 2dp default 0) — add if missing.
- `Send_Lines.Piece_Count` and `Receive_Lines.Piece_Count` → Decimal **0 dp** (not Number).

**`Raw_Material_Lot`**
- Delete `Form`.
- Keep `In_Print_Qty`, `Source_Lot`, `Print_Job`.

**`Raw_Material`**
- Delete `Print_Base`.
- Confirm `Type_field` choices include exactly `printed fabric` (or `Printed Fabric` — the
  code compares case-insensitively, but pick one and be consistent).

**`Material_Issue.Issue_Lines`**
- Delete `Fabric_Piece`, `Pieces`.

**`Fabric_Piece`**
- Delete the whole form — only after the new `receiveFromPrint` is deployed and confirmed.

### Reports

- Create **`Print_Job_Report`** — a report on `Print_Job`, all fields, `Send_Lines` /
  `Receive_Lines` / `Source_Rolls` subforms included. Permissions: readable by the widget user.
- Confirm `All_items_Report`, `All_Material_Lots` (with `Lot_Rolls`), `Third_Party_Report` exist
  and are readable (they already are — the store widget uses them).

### Custom APIs

- Delete `getPrintData`.
- Re-paste `sendToPrint`, `receiveFromPrint`, `cancelPrintJob` (args unchanged: one string
  `payloadJson`, POST). **Execute-test each** — order: `sendToPrint` (existing target, real
  rolled lot) → `cancelPrintJob` (rolls come back) → `sendToPrint` again → `receiveFromPrint`
  (creates the printed lot + rolls).

### Widget

- Zip `app/` and upload: `widget.html`, `js/main.js`, `js/print-data.js`, `css/style.css`.

### Cleanup (later, separate)

- `packingAutoPopulate` deletion, `resolveStockDispute` deletion — already tracked elsewhere,
  not part of this.
- The `issueMaterials` / `issueMaterialsApply` `Fabric_Piece` writers + `getSupervisorMaterials`
  / `getExpectedWaste` `PRINTED_PIECE` dead branches — a separate cleanup pass (out of scope).

---

## 9. Build order

1. `print-data.js` + `tools/print-data.test.js`.
2. `sendToPrint.dg` rewrite + port in `print-writers.test.js`.
3. `receiveFromPrint.dg` rewrite + port.
4. `cancelPrintJob.dg` change + port.
5. `main.js` Print tab rewrite + `widget.html` + CSS + `print-tab-ui.test.js`.
6. Remove `noPrinted` short-reason + `openPrintForBase` + `print-shortreason.test.js`;
   trim `api-experiment.js` print-base remnants.
7. Delete `print-cut.test.js` (leave guard), `getPrintData.dg`; update `docs/printing.md`
   header to point at this doc.
8. Full test sweep + dgscan. Write the final "what was and wasn't verified" note.

---

## 10. Audit round 1 — what was found and fixed

An external code audit of the uncommitted changes (checked against this doc, `node --check`
+ the three test suites + `dgscan`, no Deluge Execute) found:

**Critical / High — fixed:**
- **`receiveFromPrint` used `for pIter in 1 to pCnt`** — Deluge has no counted for-loop.
  Rewritten: the widget now sends `pieces:[{lineIndex,state}]` (one entry per physical
  piece, the same flatten `saveStockInward` uses for its rolls), and the server iterates
  that plain list with `for each`. A cross-check refuses a payload whose `pieces` and
  `lines` disagree.
- **`sendToPrint` partial-write on the concurrency path** — a roll coming up short at write
  time set `errTxt` but still decremented that roll and kept walking. Split into two passes:
  pass 1 re-reads every planned roll and verifies the whole plan fits; pass 2 writes only
  if pass 1 was clean.

**Medium — fixed:**
- Width check compares numbers now (`60` == `60.0`), and refuses two width-less materials.
  Widget `targetsFor` already compared numerically.
- Blank `Roll_Status` normalised to `Available` server-side (was excluded by `ifnull` not
  catching EMPTY), matching `print-data.js`.
- Send-form default lot is the first **non-blocked** lot, not `lots[0]`.
- `Long + String` concatenation in `receiveFromPrint` forced through `.toString()`.
- Duplicate `rollId` in a hand-built `rollPlan` is rejected.
- `receiveFromPrint` requires one `lines` row per sent size (`linesRaw.size() ==
  sentLenList.size()`).
- `print-data.js` probes near-miss subform keys (`Lot_Rolls`/`Send_Lines`), like
  `api-experiment.js`; `truthy()` accepts `y`/`TRUE` spellings.
- New printed lots seed `Width1` from the printed SKU's width.
- Roll labels are job-scoped: `<Lot>-P<jobId>-<seq>` (a second receipt into one lot no
  longer reuses `-P1`).
- Auto-plan tie-break is list position (stable), not a string `<` (unverified in Deluge),
  in both the `.dg` and the widget.
- Widget: all-zero receive blocked before the round trip; existing-lot number trimmed.

**Not done (deliberate, deferred):**
- `noPrinted` short-reason / `openPrintForBase` shim / `api-experiment.js` `printBase`
  fields / `print-shortreason.test.js` / `print-cut.test.js` — all still present and
  harmless (the feed never sets `printBase`, so the allocator branch is dead; `print-cut`
  still guards the live `issueMaterials` `Fabric_Piece` writers). Cleared with the §8
  `Fabric_Piece` server-side retirement, a separate pass.

**Still needs a Creator Execute** — every `.dg` finding above is a text-level fix only.
The `for each pIter` construct, `Long + String`, the `range from` / string-relational
questions, and the whole ledger flow need `Execute` against real forms. The
`Print_Job.Source_Rolls` subform, the `Print_Job_Report`, the renames and deletes in §8
are all still owed.

---

## 11. Round 2 change — roll labels are entered, not generated

The store person writes a roll label on each printed piece and types it at
receive. `receiveFromPrint` no longer builds `<Lot>-P<jobId>-<n>`.

**New `receiveFromPrint` payload** — `pieces[]` only, `lines[]` dropped:

```
{ "jobId":"555", "lotId":"", "lotNumber":"P1", "lotLabel":"",
  "pieces":[ {"lineIndex":0,"label":"L2-P1","state":"Wash"}, ... ],
  "remarks":"" }
```

- One entry per physical piece that came back. A piece the printer lost has no
  entry.
- `label` is required, unique within the receipt (case-insensitive), and must
  not already be on a `Lot_Rolls` row of the printed material.
- `lineIndex` says which sent size; length comes from `Send_Lines`; count per
  size is capped at what was sent.
- All pieces of one size must share one state (the `Receive_Lines` row has a
  single `State`).
- `Receive_Lines` is derived server-side: one row per sent size, `Piece_Count`
  and `State` computed from the pieces.
- `Lot_Rolls.Roll_Label` = the typed label, verbatim.

**Widget receive form** — one row per physical piece (not per size). Columns:
piece length (read-only) · Roll label (text input) · State · Back? A row with a
blank label renders dimmed and counts as lost. `submitReceivePrint` sends
`pieces[]`, filtering out the blank-label rows.

**Not changed:** `sendToPrint` (still auto-plans / accepts a roll plan for the
SOURCE rolls it cuts), `cancelPrintJob` (still one lump `Origin="Returned"`
roll, auto-labelled `<Lot>-C<jobId>` — that label is on cloth nobody re-labels).
