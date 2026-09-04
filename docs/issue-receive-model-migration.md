# Issue / Receive model migration — plan

**Status — code written, NOTHING deployed to Creator yet.**

Built:
- `deluge/issueMaterialsApply.dg` — fan-out only (issueMaterials sections 1-4 verbatim, no Material_Issue write)
- `deluge/issueMaterialsHandover.dg` — one Material_Issue per press, Issue_Lines at material×lot
- `deluge/receiveHandover.dg` — settle material×lot Issue_Lines + waste + printed, drain stock, return perMaterial {arrived,short}
- `deluge/receiveFanOut.dg` — phases: fan → vouchers → items → transfer → notify
- `app/js/main.js` — issue path split (USE_SPLIT_ISSUE), buildHandoverSummary
- `app/supervisor/js/receive-read.js` — receive list from flat getRecords (USE_JS_RECEIVE_READ in receive.js)
- `app/supervisor/js/receive.js` — receive submit split (USE_SPLIT_RECEIVE): handoverStep → fanStep
- `tools/issue-handover-parity.test.js` (8), `tools/receive-read.test.js` (11),
  `tools/receive-model.js` + `.test.js` (8) — all green

### CREATOR CHANGES NEEDED (all deferred to one pass at the end)

**New Custom APIs** (POST, args as `string`):
| Name | Args |
|---|---|
| `issueMaterialsApply` | `supervisorId`, `issuesJson`, `applyKey` |
| `issueMaterialsHandover` | `supervisorId`, `handoverJson` |
| `receiveHandover` | `supervisorId`, `payloadJson` |
| `receiveFanOut` | `supervisorId`, `payloadJson` |

**Fields to ADD**

`Material_Issue.Issue_Lines`:
- `Received_Qty` — Decimal
- `Received_Pieces` — Number
- `Disputed_Qty` — Decimal
- `Line_Status` — Dropdown: `Issued`, `Partially_Received`, `Received`, `Disputed`
- `Fanned_Qty` — Decimal  *(watermark: how much of `Received_Qty` has been
  credited to `Material_Requirement`. Same idiom as `Transferred_Qty`.)*
- `Dispute_Raised_Qty` — Decimal  *(watermark: how much of `Disputed_Qty`
  already has a `Stock_Dispute`.)*

`Stock_Dispute`:
- `Voucher_No` — Single Line

**Fields already added by the user**: `Material_Issue`: `Source_System` (Deluge/JS_API),
`Line_Count`, `Total_Qty`, `Plan_Count`. `Issue_Lines`: `Pieces_From_Raw`,
`Pieces_From_Waste`, `Plan` (Plan unused — leave, delete later).

**Workflow**: `Material_Issue` on-validation, mints `Voucher_No` when blank — already built.

**Report link names used**: `Material_Issue_Report`, `Material_Requirement_Report`,
`Stock_Dispute_Report`, `Waste_Movement_Report`, `Employee_Report`,
`Production_Planning_Report`, `Sales_Order_Report`, `All_items_Report`,
`All_Material_Lots`, `Waste_Master_Report` — all confirmed to exist.

**Old functions kept as fallbacks** (flags default the new path ON):
`issueMaterials`, `getSupervisorMaterials`, `receiveMaterials`. Delete after
parity verification.

### DONE (code, this session — continued)
- `postTransferOrders.dg` — DUAL READ: new line (`Line_Status` set) moves
  `Received_Qty − Transferred_Qty`; legacy line moves `Settled_Qty −
  Transferred_Qty`. `stillOwed` = line still `"Issued"` (new) / `Settled_Qty <
  Qty` (legacy). One order per press for new rows.
- `getStoreIssueHistory.dg` / `getSupervisorProductionHistory.dg` — page query
  `(Batch_Head == true || Source_System == "JS_API")`; loop branches: JS_API →
  `batchChunks = [mi]`, else → Batch_Voucher sibling merge (unchanged).
- `saveWasteFromCutting.dg` — offcut lot provenance now
  `Material_Requirement[Plan_Item == item].Issued_Lot` (was an Issue_Lines walk
  by Plan_Item). Bounded, no date scan, both eras. Two rows pinned to different
  lots → ambiguous → blank (rule preserved).
- `getExpectedWaste.dg` — same repoint for the lot-per-material derivation.
  `supIssuesW` kept ONLY for Pass 1.5 printed pieces.
- **`app/js/api-experiment.js` + `app/js/main.js`** — JS read-path fixes, see
  **THIRD PASS** below (D10 empty-report codes; D11 fabric shortfall / PO
  figure). Widget-only, no Creator change.

### KNOWN GAPS after this session (deferred, documented)
- **`getExpectedWaste` Pass 1.5 (printed pieces)** — still walks `Issue_Lines`
  by `Plan_Item`; a JS_API handover's printed pieces will not pre-fill in the
  cutting-waste dialog (supervisor adds them by hand). Closes with the
  printed-fabric end-to-end work.
- **`getAdminCalculation` `issuedLots`** — the per-handover-line lot breakdown
  in the audit is empty for JS_API handovers (they have no `Plan_Item` on the
  line). Core numbers (issuedQty/receivedQty/pinLot) still come from
  `Material_Requirement`. Read-only diagnostic — acceptable, revisit if needed.
- **`resolveDispute`** — still does not wind back `Issue_Lines` `Received_Qty` /
  `Disputed_Qty` / `Line_Status` or re-derive `Issue_Status`, and does not move
  Inventory on `Store_Correction`. Pre-existing (CLAUDE.md). Now HAS the link to
  fix it: `Stock_Dispute.Voucher_No` is stamped by `receiveFanOut`. To do:
  `resolveDispute` on Found/Correction/Lost updates the matching `Issue_Lines`
  row (found via `Voucher_No` + `Material` + `Lot`) and re-derives its voucher's
  `Issue_Status`.

### DONE — dispute wind-back + cross-system check (this session)
- **`resolveDispute.dg` section 3a (NEW)** — outbound non-waste: finds the
  `Issue_Lines` row via `Stock_Dispute.Voucher_No` + `Material` (+ `Lot` when
  set), and:
  - **Found** → `Received_Qty += take`, `Disputed_Qty -= take`, `Line_Status`
    recomputed, and if the voucher's `Transfer_Status == "Done"` it is pulled
    back to `"Pending"` so `postTransferOrders` moves the newly-confirmed metres
    (it skips Done vouchers).
  - **Store_Correction / Lost** → `Line_Status = "Received"` (dispute closed,
    nothing more coming), Received/Disputed split kept as the historical record.
  - Guarded `inbound == false && isWaste == false` and only when the dispute
    carries a `Voucher_No` (legacy per-requirement disputes fall through to
    section 3 unchanged).
- **`receiveHandover.dg`** — now also reports `dispLotByMat` (the lot carrying
  the largest shortfall per material) in `perMaterial.lot`.
- **`receiveFanOut.dg`** — stamps `Stock_Dispute.Lot` from that; and does NOT
  write any shortfall field on `Material_Requirement` (it has no `Disputed_Qty`
  — the `Issued_Qty − Received_Qty` gap plus the open `Stock_Dispute` IS the
  record, matching the old `receiveMaterials`).
- **`debugIssueVouchers.dg`** — dual read (`Received_Qty` when `Line_Status`
  set, else `Settled_Qty`).

### CROSS-SYSTEM CHECK — verified UNAFFECTED (read unchanged fields / payload):
- **Disputes inbound** — about offcuts (`Waste_Movement`), never touches
  `Issue_Lines` / requirements. `resolveDispute` inbound paths + `receiveHandover`
  waste-dispute raise are verbatim from old code.
- **`getStoreDisputes` / `getSupervisorDisputes`** — pure `Stock_Dispute`
  readers, ignore the new `Voucher_No` / `Lot`.
- **`raiseMaterialException`** (shortage + wash) — takes `required`/`issued`/
  `planId` from the widget payload, no `Issue_Lines` read.
- **`raiseReissueRequest` / `getReissueDrafts`** — insert / count
  `Material_Requirement` rows on unchanged fields; the "no Check_Remake row"
  draft test is intact.
- **`raiseBulkPurchaseOrder` / `resolvePurchaseShortages` / purchase inflow /
  `completeWashRequest` / `cancelWashRequest`** — no `Issue_Lines` /
  `Material_Issue` / changed-field reads.
- **`getReceiveItemBreakdown`** — reads `Material_Requirement.Issued_Qty /
  Received_Qty / Required_Pieces / Pieces_From_*` (all unchanged, written
  correctly by the new path).
- **`getSupervisorCounts`** — `Material_Issue[... && Issue_Status != "Received"]`
  works (`issueMaterialsHandover` writes `Issue_Status="Issued"` explicitly).
- **`getStoreWasteHistory` / `getSupervisorWasteReturns` / getStoreCounts /
  getOrderConsumption / getStoreLots / getStoreRequests** — no `Issue_Lines`
  touch.
- **Store History widget** (`main.js` `histMaterialRows` / `sivNumbers`) — one
  card per JS_API row, `sivNumbers=[Voucher_No]`, material×lot lines merge by
  SKU naturally.
- **Supervisor production-history widget** (`tabs.js` `supReceiptRows`) — JS_API
  lines have blank item fields → collapse into the existing "unnamed bucket" →
  no per-item breakdown shown (graceful, already coded for legacy).

---

## FULL-MIGRATION AUDIT — 7 real defects found and fixed

Read every new/changed file line by line and traced issue → receive → transfer →
dispute end to end. These were all live bugs, not hypotheticals.

**1. Voucher number depended on a form workflow that Deluge does not fire.**
The `Material_Issue` on-validation workflow was tested with
`ZOHO.CREATOR.DATA.addRecords` (JS API — Zoho docs confirm it fires workflows).
`issueMaterialsHandover` is a Deluge `insert into`, and this repo's own
`issueMaterials` header states an "on add" workflow does NOT fire for that path.
A blank `Voucher_No` breaks the transfer-order document number, the
`Waste_Movement.Voucher` stamp and every history card — silently.
→ **`issueMaterialsHandover` now mints `SIV-NNNNN` itself** with the proven
`sort by ID desc range 1 to 10` logic, written in the insert block. The
workflow's own "only when blank" guard makes it a harmless no-op backup.
*(Writes are Deluge by design — the workflow was left over from an abandoned
JS-API-write plan and can be deleted.)*

**2. A part-failed press wrote NO handover record at all — stock stranded.**
`abortRun` never called `sendHandover`, so a press dying at chunk 3 of 5 had
chunks 0-2's stock moved and requirement counters written with no
`Material_Issue`. The supervisor's receive screen reads `Issue_Lines`, so that
material could never be received and sat in `In_Transit_Qty` for ever. The old
per-chunk voucher got this for free; one-record-per-press must do it
deliberately.
→ **`abortRun` now records the handover for the applied chunks first**, and the
summary is built from `appliedIssues()` (the chunks that landed) rather than the
whole press, so it never claims cloth that did not leave the shelf.

**3. A failed fan was UNRECOVERABLE.** `receiveHandover` reported *deltas*. If
`receiveFanOut` died, pressing Confirm again re-ran the settle, every line read
owed 0, `perMaterial` came back empty — so `Material_Requirement.Received_Qty`
was never credited and no dispute was ever raised. Items could never reach
`Ready_For_Production`; only manual DB surgery would fix it.
→ **`receiveHandover` now reports TOTALS** (the whole settled state, including
what an earlier call settled) and **`receiveFanOut` applies the DIFFERENCE**
against what the requirements and open disputes already hold, clamped at 0. Both
halves are now idempotent and self-healing. Stock-drain accumulators stay
deltas — draining twice would invent movement.

**4. `owed = Qty − Received_Qty` made a short line look unsettled for ever.**
A second Confirm would silently mark the missing metres as received.
→ **`owed = Qty − Received_Qty − Disputed_Qty`** — the old `Qty − Settled_Qty`
test expressed in the new fields. `Settled_Qty` is written too, so a legacy line
settled by the new path converges in place and can never be settled twice by
either test.

**5. The material-level dispute netting was redundant AND harmful.** It was
carried over from the old model, where pending came from the requirement
aggregate. With `Disputed_Qty` now recorded *per line*, netting a material total
on top suppressed the genuinely-pending metres of a *later* handover and broke
`Qty == Received + Disputed`.
→ **Netting removed from `receiveHandover` and `receive-read.js`.** Duplicate
disputes are prevented in the fan instead (`toDispute = short total − already
open`). The invariant now holds exactly.

**6. `receive-read.js` showed fully-received LEGACY handovers as fully pending**
(it read the new fields, which are empty on a legacy line).
→ **Dual read**, the same `Line_Status`-is-set test `postTransferOrders` uses.
`receiveFanOut`'s "vouchers" phase got the same treatment, so a legacy voucher
is not stuck reading `Partially_Received` for ever (which would have pinned
`getSupervisorCounts`' badge on).

**7. The fan could credit a stale requirement on a CLOSED plan**, starving the
plan actually received for and leaving its item at `Awaiting_Material` for ever.
The old code credited the one requirement its `Issue_Line` named; a material×lot
line names none.
→ **Fan bounded to open plans** (Pending / Partially Received / In Progress /
Material Ready) via a lazily-filled per-plan cache.

### Audit test coverage added
`receive-model.test.js` 8 → **13**: idempotency (whole receipt run twice changes
nothing), fan recovery (settled lines + uncredited requirement → re-run applies
exactly what never landed), closed-plan skip, earlier-dispute does not suppress
a later line, no duplicate dispute, older-dispute-plus-short raises only the new
gap.
`receive-read.test.js` 11 → **15**: disputed part not pending, earlier dispute
does not hide a new line, legacy line reads `Settled_Qty`, legacy part-settled.
`issue-handover-parity.test.js` 8 → **11**: partial press records only applied
chunks and still balances, zero chunks records nothing, whole press equals the
full summary.

**Regression check:** `print-tab-ui` (52/2), `print-writers` (12/72) and
`receive-print` (25/2) fail identically before and after this work — verified by
stashing. Everything else is green.

---

## SECOND AUDIT — end-to-end lifecycle test, 2 more defects found

Built `tools/issue-receive-e2e.test.js`: a full lifecycle harness (issue →
handover record → receive → transfer → dispute resolution) asserting **global
conservation invariants after every single step** — the test that catches a
wrong `+=` anywhere in the chain, which the per-function tests cannot.

**C1** stock is never created or destroyed
(`onHand + inTransit + disputed + consumed + writtenOff == opening`) ·
**C2** handover lines total the issue fan ·
**C3** `Σ line Received_Qty == Σ requirement Received_Qty` ·
**C4** `Qty == Received + Disputed` on every settled line ·
**C5** never over-credit a requirement ·
**C6** never transfer more than was confirmed ·
**C7** nothing negative, anywhere.

It failed on first run and exposed **two more real bugs, same root cause:**

**8. Confirming handovers SEPARATELY under-credited the requirement.** The
idempotency delta compared a *scope-limited* line total against the *all-time*
`Material_Requirement.Received_Qty`. Receive voucher 2 (25 m) → requirement 25.
Then receive voucher 1 (15 m): the scope only saw voucher 1's 15, the
requirement already held 25, so `toCredit = 15 − 25` clamped to **0** — the 15
was never credited and the item could never go ready. Receiving handovers one
at a time is completely normal, so this would have bitten immediately.

**9. The same clamp broke re-issue after a `Store_Correction`.** The correction
lowers `Issued_Qty`, so the next handover's fresh line total came in *below* the
already-credited requirement total and was clamped away.

→ **Fixed with a per-line watermark, the codebase's own proven idiom** (the
`Settled_Qty − Transferred_Qty` pattern from `postTransferOrders`):
`Issue_Lines.Fanned_Qty` and `Issue_Lines.Dispute_Raised_Qty`. The fan applies
`Received_Qty − Fanned_Qty` and `Disputed_Qty − Dispute_Raised_Qty` summed over
the scope lines, then stamps both **last**. Each line is self-accounting, so no
cross-voucher or cross-time aggregate comparison is needed at all. Correct in
all four cases: fan died (unstamped → redone), receipt repeated (stamped →
nothing), handovers confirmed separately (each press fans its own lines), and
`Issued_Qty` since reduced by a correction (the watermark does not care).

Stamping last is deliberate: a failure before it leaves the lines unstamped and
the next press redoes the work, which is safe — the credit is capped by each
requirement's own room and the dispute upsert lands on the same open ticket.

### Second-audit test coverage
`issue-receive-e2e.test.js` — **11 scenarios**, all with C1–C7 after every step:
plain issue→receive→transfer; short→dispute→Found→transfer picks up the rest;
short→Store_Correction→re-issue on a new voucher; both-deny→Lost write-off; one
press across three plans; two lots of one material; **two presses received
separately**; whole receipt run twice; fan-died repair; 37 awkward-decimal
allocations with no drift; closed-plan row never steals a credit.
`receive-model.test.js` 13 → **14** (re-run does not re-raise a dispute).

**Totals through the two write-model audits: 9 defects found and fixed, 51 new
tests.** (Two more JS read-path defects and 8 more tests in the THIRD PASS
below → **11 defects, 59 tests** overall.)

---

## THIRD PASS — JS read-path (`ApiExperiment`) vs Deluge read-path divergence

Found while testing the store Issue screen on the **JS Data API read path**
(`app/js/api-experiment.js`, the `getStoreMaterialRequirements` replacement).
These are **JS-widget-only** bugs — the Deluge `getStoreMaterialRequirements`
was never wrong. They surfaced because the JS port reads the same data through a
different door (reports via `getRecords`, then a client-side assembly) and two
things did not carry across.

### D10 — `getRecords` empty-result codes not all caught → `loadRequirements` crash

`ApiExperiment.getAll()` only treated **`code 9280`** ("no records match the
criteria") as a valid empty result. Creator also returns:

- **`9220`** — "No records exist in this report." (the report's form has zero
  rows), and
- **`3100`** — "no data available" (older builds).

`Plan_Item_Report` came back `9220`; `getAll` `reject`ed it, which killed the
whole `Promise.all` in `ApiExperiment.run()` and the Issue tab showed
`loadRequirements error: … {"code":9220,…}`.

→ **Fixed** in `api-experiment.js` `isNoRecords()`: parse the code out of
`err.responseText` / `err.responseJSON` (Creator nests it there, not on
`err.code`), and match `9280 | 9220 | 3100` plus the message text
`"no records exist"` / `"no data available"`. Any of them resolves that report
to `[]` and `run()` carries on. An empty `Plan_Item_Report` then degrades
cleanly — item names fall back to `''`.

### D11 — fabric shortfall (PO figure) computed wrong, and moved as material was issued

On the JS path, RM-00001 for one supervisor showed **"1 short"** on the card
with **no wash / no PO breakdown** in "What is missing", while the Deluge path
showed "TO WASH 1.5 from L2". Worse: issuing material for *any* supervisor made
the shortfall shrink.

**Root cause — `buildShortfallSummary` fabric BUY calc.** It was:

```
owned  = washed + greige + inWash + poCovered      // raw metres, all lots
buyQty = needed − owned                            // needed = m.remaining
```

Two faults:

1. **Stranded cloth counted as owned.** Under the one-lot rule an order is
   issued off ONE lot. Greige spread thin across lots — 4.3 m on L2, 3.2 m on
   L1 — is real metres that cannot complete any 7.5 m / 10-piece order. Summed
   as raw `owned`, it made `needed − owned = 0` over an order that can never
   issue → no PO, and the card's per-material `stockStatus` still read the row
   as short with nothing behind it.
2. **`needed` was `m.remaining`** — the allocator's live fresh-metres figure,
   which shrinks as orders are placed / issued. So the shortfall moved every
   time a card cleared, and a fully-issued fabric material dropped out of
   `byMat` entirely (`isFullyIssued` / `remaining<=0` skip), taking its demand
   out of the denominator.

**The correct shortfall is a property of demand vs stock and does not change
when material is issued** — issuing moves cloth from the shelf to in-transit and
drops demand by the same amount. So:

```
demandMetres    = Σ per cut: ceil(outstandingPieces / perRow) × cutLength / 100
                  // WHOLE marker row-sets, from server Required_Pieces −
                  // (Pieces_From_Raw + Pieces_From_Waste); matches issue-time
                  // rounding so a PO yields complete cut-piece sets
placeableMetres = Σ m.lotLines[].qty
                  // what the allocator actually committed to lots, computed
                  // once at load over the WHOLE requirement set
buyQty          = demandMetres − placeableMetres − poCovered
```

The gap between `demandMetres` and `placeableMetres` **is** the stranded greige
plus every order no single lot could seat (`orderOutcomes` `why:'skipped'`, which
never make it into `lotLines`). Issue-invariant by construction: handing an
order over drops `demandMetres` and `placeableMetres` by the same amount.

→ **Fixed** in `app/js/main.js`:

- **`buildShortfallSummary`** — fabric materials no longer skipped on
  `isFullyIssued` / `remaining<=0` (they contribute zero but stay in the
  denominator); fabric BUY switched to the `demandMetres − placeableMetres`
  formula above; `e.needed` for fabric set to `demandMetres` (drives the raise
  dialog's "Still needed" and payload). Non-fabric BUY (`needed − owned`) and
  all WASH logic **unchanged** — a trim has no lots and no marker rows, so the
  raw metres balance is right for it.
- **`byMat[key]`** now carries `orderOutcomes`, `placeableMetres`,
  `fabricWidthCm` — taken once (same array on every row of a material).
- **`render()`** feeds `renderShortfallSummary(data)` (the full list), not
  `actionable` — a fully-issued supervisor is still demand that came off the
  same shelf.
- **Session PO drops the row immediately.** `requestState(e, 'buy', '') ===
  'open'` — the local `openExceptions` `{type:'Shortage', planIds:[…]}` that
  `submitSummaryException` already appends on a successful raise now also hides
  the buy row, without waiting for `poCoveredQty` to come back on the next load.
  A ticket that misses a plan stays visible (stale).

**Wash is not involved when no lot can complete an order.** Washing L2's 4.3 m
greige still does not give a lot that can finish a 7.5 m order — so the
unplaceable case goes to **PO**, not to the wash list. (The genuine
"this lot CAN finish the order once its own greige is washed" case still
produces `lotLines` + a `washLots` entry and shows on the wash list as before.)

**Deluge `getStoreMaterialRequirements` left as-is** — it already surfaces a
figure via its own aggregate formula, and the old widget is the fallback. The
two paths' PO numbers can differ slightly until the JS path is the only one.

### Third-pass test coverage
`tools/shortfall-summary.test.js` — **8 cases**, `buildShortfallSummary` +
the real allocator in a `vm` sandbox: unplaceable order → PO for its metres;
stranded greige not netted into owned; **PO figure unchanged after an order is
issued** (issue-invariance); a rack that seats every order raises no PO; an open
Shortage ticket covering every plan hides the row; a ticket that misses a plan
keeps it; trim BUY still `needed − owned`; fully-issued fabric adds no
shortfall. All existing store / allocator suites green
(`allocator` 31, `api-experiment-parity` 15, `store-ui`, `store-history-merge`
10, `print-shortreason` 22, `order-overview-ui` 19).

**Deploy: widget only — rezip `app/`. No Creator change for D10 / D11.**

---

### STILL TO DO
- End-to-end parity run on real data before flipping any flag off-fallback.
- Printed-fabric end-to-end (separate project) — see the notes block at top.

---

## PRINTED FABRIC — integration notes for later (do NOT solve now)

Printed fabric is partly built (`sendToPrint`, `Fabric_Piece` rows,
`Form == "Pieces"` lots, the `PRINTED_PIECE` marker path in `issueMaterials` /
`receiveMaterials` / `getSupervisorMaterials`). The client has since asked for it
end to end **with billed Inventory** (they do the printing via an outside
vendor). That is a separate sub-project. What matters here is that the
material-x-lot `Issue_Lines` grain this migration introduces must not box it in:

1. **Printed-piece `Issue_Lines` rows stay PER PHYSICAL PIECE, not per
   material-x-lot.** The supervisor confirms each printed piece individually.
   The handover-summary builder (widget, Step 2) keys printed lines by
   `materialId | lot | pieceId`; everything else by `materialId | lot`.
   `issueMaterialsHandover` must NOT merge rows carrying the `PRINTED_PIECE`
   marker in `Lot_Override_Note`.

2. **A printed-piece `Issue_Lines` row carries BOTH:**
   - `Qty` = metres equivalent (`Piece_Length_Cm * count / 100`, the widget
     already computes this for printed `issueLines`)
   - `Pieces_From_Raw` = the piece count (what the supervisor confirms via
     `Received_Pieces`)
   So when billed printed Inventory lands, `postTransferOrders` reads `Qty` and
   the transfer "just works"; today the per-piece receipt reads
   `Received_Pieces`.

3. **When billed Inventory lands:** printed SKU gets a real `Inventory_Item_ID`
   + cost; `postTransferOrders` stops refusing vouchers containing it
   (`postTransferOrders.dg` — the `unmapped` / `printedSkuByMat` refusal path);
   the printed `Issue_Lines` rows become transferable like any other because
   `Qty` is already populated.

4. **Open field question, deferred:** per-piece printed `Issue_Lines` need to
   identify WHICH `Fabric_Piece` each row is. Today it's implicit (expansion
   order + marker). Cleaner: add a `Fabric_Piece` lookup on `Issue_Lines`.
   Decide when printed fabric is built end to end.

5. **`issueMaterialsApply` already handles printed-piece ISSUE** — the
   `Fabric_Piece` split block (isPieces / pcList loop) is copied verbatim from
   `issueMaterials`. Only the handover-record grain is the open question.

---

**Original status:** planning. Nothing built yet.

**Why this is dangerous:** the issue→receive→transfer chain is fully automatic.
One wrong `+=` / `-=` / rounding step and stock silently desyncs — an item stuck
at `Awaiting_Material` for ever, cloth issued twice, a transfer order moving the
wrong metres. Every step below has a **parity check against the current Deluge**
before it ships. No step ships without its check passing on real data.

---

## The end state

### Two grains, both maintained, neither derivable from the other

| | `Material_Requirement` | `Material_Issue.Issue_Lines` |
|---|---|---|
| **Grain** | one row per requirement (per plan-item demand) | one row per handover **× material × lot** |
| **Answers** | "for THIS requirement: needed / issued / reissued / received / still owed" | "on THIS handover: what left the counter, what came back, what's disputed, what's transferred" |
| **Read by** | issue screen (`getStoreMaterialRequirements`), supervisor receive list (`getSupervisorMaterials`), **readiness** (`Item_Status`/`Order_Status`), reissue drafts, `resolveDispute` | store history, supervisor production history, **`postTransferOrders`** |

Why both:
- `Issue_Lines` is aggregated across requirements — it **cannot** say
  "requirement #777 is fully received" when two requirements share one lot.
  Readiness *must* read `Material_Requirement`.
- `Material_Requirement` has no handover identity — it **cannot** say
  "SIV-00042 received 38 of 40, transfer 38". Transfer *must* read `Issue_Lines`.

### One `Material_Issue` per press (chunking gone)

Today one press is split into ~100-line `Material_Issue` chunks because readers
walk a fat `Issue_Lines` subform and hit the uncatchable statement limit. After
the migration **nothing walks `Issue_Lines` for bulk state** — it is
material×lot grain (~5–30 rows/press, ~250 absolute worst case: every raw
material, split across lots). So one voucher per press, no `Batch_Voucher` /
`Batch_Head`.

Transport is still chunked by the widget (a huge `issuesJson` string is trimmed
by Creator) — but every chunk writes to **one** `Material_Issue`: chunk 0 creates
it and returns its record id; later chunks append material×lot rows to that same
row's `Issue_Lines` and accumulate the header tallies.

### Reads via JS Data API, writes via Deluge

- **Reads** (issue screen, supervisor receive screen): JS `getRecords` — fast,
  no statement limit, already proven on the store screen.
- **Writes** (issue, receive, transfer, dispute): **Deluge custom functions**.
  The Data API has no client-callable "apply N different values to N existing
  rows" — a press can touch 1000+ `Material_Requirement` rows, which Deluge does
  in one bulk execution and the Data API cannot do without 1000 round trips and
  no transaction.

---

## Field changes (ADD only — nothing deleted until every path is migrated)

### `Material_Requirement` — ADD

| Field | Type | Written by | Meaning |
|---|---|---|---|
| `Settled_Qty` | Decimal | receive | Σ of owed metres/units **accounted for** (arrived + disputed). Still owed = `Issued_Qty − Settled_Qty > 0`. |
| `Received_Pieces_From_Raw` | Number | receive | fabric pieces from fresh cloth confirmed |
| `Received_Pieces_From_Waste` | Number | receive | fabric pieces from remnants confirmed |
| `Transferred_Qty` | Decimal | postTransferOrders | Σ moved Main→Production in Inventory (requirement-grain mirror; see note) |
| `Last_Voucher` | Single Line | issue | `SIV-NNNNN` of the most recent issue against this row — the link to the handover |
| `Requirement_Status` | Dropdown (underscored) | issue + receive | `Awaiting_Material` / `Partially_Issued` / `Fully_Issued` / `Partially_Received` / `Received` |

> **Confirm before building:** does `Material_Requirement` already carry
> `Received_Qty` and `Disputed_Qty`? `receiveMaterials.dg` reads `Received_Qty`
> today, so it exists. Check `Disputed_Qty`. If either is missing, add it.

> `Transferred_Qty` on the requirement is a **mirror for reconciliation /
> resolveDispute wind-back**, not the transfer trigger. The trigger is on
> `Issue_Lines` (below). Keeping both lets `resolveDispute` wind back everything
> a `Store_Correction` touched on one row.

### `Material_Issue.Issue_Lines` — ADD

| Field | Type | Written by | Meaning |
|---|---|---|---|
| `Received_Qty` | Decimal | receive | how much the supervisor **actually confirmed** for this material×lot |
| `Received_Pieces` | Number | receive | pieces confirmed |
| `Disputed_Qty` | Decimal | receive | `Qty − Received_Qty` — the gap that raises a `Stock_Dispute` |
| `Transferred_Qty` | Decimal | postTransferOrders | Σ moved to Production. Transfer moves `Received_Qty − Transferred_Qty`. |
| `Line_Status` | Dropdown (underscored) | receive + transfer | `Issued` / `Partially_Received` / `Received` / `Disputed` |

Already added by the user (Step-1 field creation): `Pieces_From_Raw`,
`Pieces_From_Waste`, `Plan`. **`Plan` on the line is now unused** (line is
material×lot, no per-plan meaning) — leave it, ignore it, delete later.

### `Material_Issue` (parent) — already added by the user

`Source_System` · `Line_Count` · `Total_Qty` · `Plan_Count`.

- `Source_System` — the value for a new one-per-press row is **`________`**
  (user to confirm the exact dropdown string). Legacy chunked rows have the old
  value / blank. **Every reader branches on this.**

### Workflow (already built)

On-validation form workflow on `Material_Issue` mints `Voucher_No` (`SIV-NNNNN`)
when blank. Confirmed firing on a JS-API insert and visible within 500 ms.
`getRecords` `max_records` must be `200` / `500` / `1000` (code 9250 otherwise).

### Reports

`Material_Issue_Report` (returns `Issue_Lines` inline), `Waste_Movement_Report`,
`Material_Requirement_Report`, `All_items_Report`, `All_Material_Lots`,
`Fabric_Piece_Report`, `Waste_Master_Report` — all exist.

---

## Data flow (target)

### Issue

```
Store presses Issue
  widget builds issues[]  (buildFabricIssueLine / accessory — UNCHANGED)
  splitIssuesByAllocation  (transport chunking — UNCHANGED)
  processNextChunk  — SEQUENTIAL, threads issueId (was batchVoucher)

  chunk 0 -> issueMaterials(supId, chunkJson, issueIdIn="")
     A. INSERT one Material_Issue
          Voucher_No <- blank (workflow mints SIV-NNNNN on validation)
          Issue_Status="Issued", Transfer_Status="Pending"
          Source_System=<new value>, Line_Count/Total_Qty/Plan_Count = chunk tally
          NO Batch_Voucher, NO Batch_Head, NO Plan
        re-read row -> Voucher_No
     B. INSERT Issue_Lines — ONE ROW PER MATERIAL × LOT
          Material, Lot, Qty=Σ giveQty, Pieces_From_Raw/Waste=Σ, Unit, cut size
          Received_Qty=0, Disputed_Qty=0, Transferred_Qty=0, Line_Status="Issued"
     C. APPLY to Material_Requirement — one point lookup per requirement:
          Issued_Qty += giveQty
          Pieces_From_Raw/Waste += (fabric)
          Issued_Lot = issuedLot  (only if empty)
          Last_Voucher = SIV-NNNNN
          Requirement_Status = Partially_Issued / Fully_Issued
     D. MOVE STOCK  (UNCHANGED):
          Waste_Master  Piece_Count-, In_Transit_Count+, Status="Issued" if empty
          Waste_Movement insert "Issued", Voucher=SIV-NNNNN  (have it now)
          Raw_Material_Lot  Wash_Quantity-, In_Transit_Qty+
          Raw_Material  Wash_Quantity/Quantity-, In_Transit_Qty+
          Fabric_Piece  split for printed remnants
     returns { voucher, issueId, issued[], errors[] }

  chunk k -> issueMaterials(supId, chunkJson, issueIdIn=<issueId>)
     A'. issueIdIn set -> DO NOT create. Fetch Material_Issue by id.
     B'. APPEND / MERGE material×lot rows into its Issue_Lines
         ACCUMULATE Line_Count/Total_Qty/Plan_Count
     C'. APPLY this chunk's slice to Material_Requirement  (same as C)
     D'. MOVE this chunk's stock slice  (same as D)
```

### Store history

```
getStoreIssueHistory  (JS getRecords read, or Deluge)
  page on Material_Issue directly (Issue_Date range, Added_Time desc)
    Source_System=<new>  : ONE card = ONE row; lines[] = its Issue_Lines
                           (material,lot,qty,received,disputed); ~5–30 rows
                           waste[] = Waste_Movement[Voucher==SIV,"Issued"]
    Source_System=legacy : old Batch_Head merge path (pre-migration rows only)
```

### Supervisor receive screen

```
getSupervisorMaterials  (JS getRecords read)
  reads Material_Requirement[Assigned_To==sup]   — NO Issue_Lines walk
    still owed = Issued_Qty - Settled_Qty > 0
  aggregate per material (one physical thing = one line):
    pending, lot (Issued_Lot), isReissue (Source), per-order rows carry Plan/Plan_Item
    net off open Stock_Dispute (per plan+material)
  waste: Waste_Movement[Moved_By==sup,"Issued"] - Received children  (UNCHANGED)
```

### Receive confirm

```
receiveMaterials(supId, receiptsJson)   — Deluge write
  SWEEP (resumable slices) — over his OPEN Material_Requirement rows AND
  the handover's Issue_Lines rows for the confirmed vouchers:

    per material×lot Issue_Line on a confirmed voucher:
        arrived = full  OR  the short figure he typed for that material
        Received_Qty      += arrived
        Received_Pieces   += (fabric)
        Disputed_Qty       = Qty - Received_Qty
        Line_Status        = Received / Partially_Received / Disputed

    FAN arrived back across the requirement rows it covers (oldest-first,
    same rule as today), per requirement:
        Settled_Qty              += owed        (whole owed leaves in-transit)
        Received_Qty             += arrived_share
        Received_Pieces_From_*   += (fabric)
        Disputed_Qty             += short_share
        Requirement_Status        = Partially_Received / Received

    drain stock: Raw_Material / Raw_Material_Lot In_Transit-, Disputed+
    upsert ONE Stock_Dispute per (plan,material) gap, Direction="Outbound",
      stamp it with the voucher (SIV) so resolveDispute can find the Issue_Line

  WASTE / PRINTED — per physical piece, UNCHANGED

  FINALIZE (phased):
    status   : Material_Issue.Issue_Status from its Issue_Lines' Line_Status
    items    : readiness — Plan_Item -> Ready_For_Production when every
               requirement row is Received (metres) AND pieces covered (fabric);
               roll Production_Planning.Order_Status forward (forward-only)
    transfer : postTransferOrders("auto")
    notify   : dispute digest mails
```

### Transfer order

```
postTransferOrders("auto" | manual)   — Deluge write
  scan recent Material_Issue (Transfer_Status != Done/Failed)
  per voucher:
    walk its Issue_Lines (material×lot, ~5–30 rows — cheap):
      move = Σ (Received_Qty - Transferred_Qty)  per Inventory item
             ^ ACTUAL received, not issued. A short receipt transfers only what arrived.
    build ONE transfer order, Main -> Production, number = SIV-NNNNN (-2 for a
      second partial run), one line per Inventory item
    POST to Zoho Inventory  (mechanics UNCHANGED)
    on success:
      Issue_Lines.Transferred_Qty += moved   (idempotency)
      Material_Requirement.Transferred_Qty += moved  (mirror, fanned oldest-first)
      Material_Issue.Transfer_Order_IDs append; Transfer_Status=Done when nothing owed
```

### Dispute resolution

```
resolveDispute(payload)   — Deluge write

  Store_Correction / Lost  (never reached production):
    Material_Requirement rows for (dsp.Plan, dsp.Material), newest-short-first:
      Issued_Qty -= q ; Pieces_From_Raw/Waste -= (fabric, converted) ;
      Settled_Qty -= q ; Transferred_Qty -= q if already moved ;
      Requirement_Status recomputed
    the handover's Issue_Line (found via dsp voucher + material + lot):
      Disputed_Qty -= q ; (Received_Qty unchanged — it never arrived)
      if q was already transferred -> Transferred_Qty -= q, and QUEUE AN
        INVENTORY WIND-BACK  (see "gap 2" below)
    stock: on-hand + (Store_Correction only), Disputed -
    Waste_Movement "Issued" wound back
    readiness sweep -> Item_Status / Order_Status
    Lost + non-waste + outbound -> queue Inventory Write_Off

  Found  (it DID reach production):
    Material_Requirement rows: Received_Qty += q oldest-first, Disputed_Qty -= q
    the handover's Issue_Line: Received_Qty += q, Disputed_Qty -= q,
      Line_Status recomputed
    -> next postTransferOrders run moves it (Received_Qty - Transferred_Qty > 0)

  Re-issue (store issues the disputed part again):
    a NEW Material_Issue handover is created by the ordinary issue path.
    The original Issue_Line keeps its recorded Disputed_Qty; Received_Qty never grew.

  inbound legs (offcuts coming back): UNCHANGED — no requirement side-effects
```

---

## Known gaps to design around (do NOT ship without deciding these)

1. **Short-receipt attribution across a shared lot.** One `Issue_Line` is
   material×lot, summed over several requirements. A 2 m shortfall on
   Donna/LOT-88 that fed two items cannot be pinned to one item from the
   `Issue_Line` alone. **Decision:** the fan to `Material_Requirement` is
   oldest-requirement-first (same as today's `receiveMaterials`); the
   `Stock_Dispute` is per (plan, material) (same as today). The shortfall lands
   on the newest requirement rows, which is the current, accepted behaviour.
   No change — just confirming the fan rule is preserved exactly.

2. **`resolveDispute` + Inventory after a `Store_Correction` on transferred
   stock.** Pre-existing gap (CLAUDE.md): `postTransferOrders` may have already
   moved the disputed metres to Production; `resolveDispute` only queues a
   `Write_Off` on `Lost`, not on `Store_Correction`. This migration does NOT
   have to fix it, but it MUST NOT make it worse. With `Transferred_Qty` now on
   both grains, the wind-back is at least *expressible*. Flag: decide whether to
   fix in this pass or leave as documented debt.

3. **`Issue_Lines` "found" update needs to locate the exact material×lot row.**
   The `Stock_Dispute` must carry enough to find it: `Plan` + `Material` +
   `Lot` + the voucher (`SIV`). Today a dispute carries `Plan`, `Material`,
   `Lot`, `Plan_Item`, `Supervisor`. **ADD: stamp the SIV** (`Material_Issue`
   voucher) on the `Stock_Dispute` when `receiveMaterials` raises it — a new
   `Voucher_No` text field on `Stock_Dispute`, or reuse an existing one. Without
   it, "found" cannot update the right `Issue_Line`.

4. **`getExpectedWaste` / `saveWasteFromCutting` / `getAdminCalculation` offcut
   provenance.** These walk `Issue_Lines` by `Plan_Item` + `Lot` to answer
   "which lot was item X's cloth cut from". Material×lot `Issue_Lines` has no
   `Plan_Item`. **Repoint to `Material_Requirement[Plan_Item == X].Issued_Lot`**
   — already populated (the tone pin). One hop, no subform walk. Must produce
   the identical answer (including the "two lots -> blank, supervisor picks"
   ambiguity rule) — parity check required.

5. **`getSupervisorProductionHistory` per-item card breakdown.** Currently from
   `Issue_Lines.Plan_Item`. After: from
   `Material_Requirement[Last_Voucher == SIV]` grouped by `Plan_Item`. Parity
   check.

6. **Voucher numbering race.** Workflow reads max on validation; two presses in
   the same instant could collide. One store person today — accepted. The widget
   already disables Issue on click. Not fixing now; noted.

7. **Non-atomic multi-chunk press.** Chunk k applies stock then a later chunk
   fails. Deluge has no transaction — same as today ("a chunk that half-applied
   leaves what it wrote"). The widget's "press Issue again to send the rest"
   recovery and the `btn.dataset.busy` guard stay. `Material_Requirement`
   writes are idempotent per allocation (point lookup + `+=` of a specific
   give), so a re-press does NOT double an already-applied chunk **only if** the
   widget resends exactly the un-applied chunks. Confirm the resume logic.

---

## Build order — each step ships only after its parity check passes

> A/B before C: the readers must be off `Issue_Lines` before it changes grain,
> or a big press breaks `getSupervisorMaterials` in the window between.

### Step 0 — fields + reports (Creator, manual)
Add the `Material_Requirement` and `Issue_Lines` fields above. Add `Voucher_No`
(text) to `Stock_Dispute` if not present. Confirm `Received_Qty` /
`Disputed_Qty` on `Material_Requirement`. Confirm the `Source_System` value.
**No code. Nothing reads or writes the new fields yet.**

### Step A — `getSupervisorMaterials` reads off `Material_Requirement`
- Rewrite to derive "still owed" from `Issued_Qty - Settled_Qty` on the
  requirement, bounded by `[Assigned_To == sup]`. No `Issue_Lines` walk, no
  line-row paging.
- **Reads move to JS Data API** (new module, pattern of `api-experiment.js`),
  Deluge kept as fallback behind a flag.
- **Parity check:** for a set of real supervisors, the JS output and the
  current `getSupervisorMaterials` output must match field-for-field — pending
  qty per material, per-order rows, lots, reissue flag, waste list, dispute
  netting. Automated test over the pure assembly + a live `compare()` like the
  read migration. **Ship only when identical on real data.**
- At this point `Settled_Qty` is still 0 everywhere (receive hasn't moved yet),
  so "still owed" = `Issued_Qty` = today's `Qty - Settled_Qty` sum. The check
  must confirm that equivalence holds.

### Step B — `receiveMaterials` settles `Material_Requirement` + `Issue_Lines`
- Rewrite the sweep to:
  - settle the material×lot `Issue_Lines` rows of the confirmed vouchers
    (`Received_Qty`, `Disputed_Qty`, `Line_Status`)
  - fan `arrived` back to the requirement rows (`Settled_Qty`, `Received_Qty`,
    pieces, `Disputed_Qty`, `Requirement_Status`) — oldest-first, EXACTLY the
    current fan rule
  - stamp the SIV on every `Stock_Dispute` it raises
- Finalize `status` phase reads `Issue_Lines.Line_Status`, not a subform re-walk.
- Readiness (`items` phase) reads `Material_Requirement` — same tests as today
  (metres: `Received_Qty >= Issued_Qty`; fabric pieces:
  `Pieces_From_Raw+Waste >= Required_Pieces`).
- **Reads for the receive screen move to JS** (Step A already did
  `getSupervisorMaterials`; also `getReceiveItemBreakdown` if it's a pure read).
  Writes stay Deluge.
- **Parity check:** replay a batch of real receipts (full, short, partial,
  waste, printed) through BOTH the old and new `receiveMaterials` against a
  copied dataset. Compare every counter afterwards:
  `Material_Requirement.Issued_Qty / Received_Qty / Settled_Qty /
  Pieces_From_* / Received_Pieces_*`, `Raw_Material.In_Transit_Qty /
  Disputed_Qty`, `Raw_Material_Lot` same, `Stock_Dispute` rows, `Item_Status`,
  `Order_Status`. **Zero differences or it does not ship.**
- Port the arithmetic to a Node reference script (like the fabric-rollback and
  double-count checks in `tools/`) and run the lifecycle: issue -> receive full
  -> receive short -> dispute -> resolve each way. Assert invariants:
  - `Σ Issue_Lines.Received_Qty (per material) == Σ requirement Received_Qty
    fanned from it`
  - `Issue_Lines.Qty == Received_Qty + Disputed_Qty` always
  - `requirement Issued_Qty >= Received_Qty >= 0`, `Settled_Qty <= Issued_Qty`
  - nothing goes negative

### Step C — `issueMaterials`: one `Material_Issue` per press
- New 3rd arg `issueIdIn` (was `voucherIn`): "" -> create; id -> append.
- Chunk 0 creates the `Material_Issue`, re-reads for `Voucher_No`, returns
  `issueId`.
- `Issue_Lines` written at material×lot grain (merge on same material+lot within
  a press).
- Writes `Last_Voucher`, `Requirement_Status` on `Material_Requirement`;
  `Line_Count` / `Total_Qty` / `Plan_Count` on the header; `Source_System`.
- Stops writing `Batch_Voucher` / `Batch_Head` / `Plan`.
- `Material_Requirement` counter writes (`Issued_Qty`, `Pieces_From_*`,
  `Issued_Lot`) — **BYTE-IDENTICAL to today**. This is the line where a mistake
  desyncs everything. Diff the old and new apply blocks statement by statement.
- **Parity check:** issue the same real backlog through old and new against a
  copied dataset. After: every `Material_Requirement` counter identical; stock
  moves (`Waste_Master`, `Raw_Material_Lot`, `Raw_Material`, `Fabric_Piece`,
  `Waste_Movement`) identical; the only intended difference is
  `Material_Issue` = 1 row vs N chunk rows, and `Issue_Lines` = material×lot
  vs per-requirement. Assert `Σ new Issue_Lines.Qty == Σ old Issue_Lines.Qty`
  per material, and `Σ == Σ requirement Issued_Qty delta`.

### Step D — widget `main.js` issue path
- `processNextChunk`: thread `issueId` instead of `batchVoucher`. Keep transport
  chunking, the progress modal, rate-limit retry, the "press again to resume"
  abort path.
- Confirm the resume path resends only un-applied chunks (gap 7).
- Behind `USE_NEW_ISSUE` flag; old chunk loop stays as the else branch.

### Step E — history readers branch on `Source_System`
- `getStoreIssueHistory`, `getSupervisorProductionHistory`: new rows -> one
  card each off material×lot `Issue_Lines`; legacy rows -> existing
  `Batch_Head` merge. `getSupervisorProductionHistory` per-item breakdown from
  `Material_Requirement[Last_Voucher == SIV]`.
- **Reads move to JS** where they're pure (both are).
- Parity check: same cards, same numbers, on a dataset holding both legacy and
  new `Material_Issue` rows.

### Step F — `postTransferOrders` off `Issue_Lines.Received_Qty`
- `move = Σ (Received_Qty - Transferred_Qty)` per Inventory item, per voucher.
- Stamp `Issue_Lines.Transferred_Qty` (trigger/idempotency) and
  `Material_Requirement.Transferred_Qty` (mirror, oldest-first).
- One order per press.
- **Parity check:** run `("true")` dry-run old vs new on real received
  vouchers — the request bodies (item ids, quantities, order numbers) must
  match. Then `("one")` against a live org and eyeball the order.
- Verify a 250-line `Issue_Lines` voucher walk stays well under the statement
  limit (it will — but measure).

### Step G — offcut provenance repoint
- `getExpectedWaste`, `saveWasteFromCutting`, `getAdminCalculation`: read
  `Material_Requirement[Plan_Item == X].Issued_Lot` instead of walking
  `Issue_Lines` by `Plan_Item`.
- **Parity check:** the lot each dialog resolves for a set of real items must
  match the current derivation, INCLUDING the "issued off two lots -> blank"
  ambiguity case.

### Step H — cleanup (later, separate session)
Once every path is on the new model and has run in production for a while:
delete `Batch_Voucher`, `Batch_Head`, `Issue_Lines.Plan`,
`Issue_Lines.Requirement`, `Issue_Lines.Plan_Item`, `Issue_Lines.Settled_Qty`,
`Issue_Lines.Transferred_Qty`, `Material_Issue.Plan`. Remove the Deluge
fallbacks and the `USE_NEW_*` flags. Update CLAUDE.md.

---

## Testing infrastructure to build first (before Step A)

1. **A dataset snapshot / restore** so a parity run can be repeated. Either a
   Creator sandbox app, or export the relevant forms and a script that reloads
   them.
2. **`tools/issue-receive-lifecycle.test.js`** — a Node port of the issue +
   receive + transfer + resolveDispute arithmetic, running the full lifecycle
   and asserting the invariants listed under Step B. This is the cheapest place
   to catch a wrong `+=` and it runs in seconds.
3. **`compare()` helpers** in each new JS read module (like
   `ApiExperiment.compare()`) that call both paths and diff.

No write step ships without: (a) the lifecycle test green, (b) a real-data
parity run showing zero counter differences.
