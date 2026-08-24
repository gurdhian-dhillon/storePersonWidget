# Deluge code review — 2026-08-23

Full review of every `.dg` file (~29k lines, 88 files, including `finishingScripts/`,
`packingScripts/`, `anotherPageScripts/`), checked against the contracts in CLAUDE.md and
`docs/scaling.md`. Static checks ran via `node tools/dgscan.js deluge/*.dg`. Every finding
below was confirmed against actual file content; nothing is reported from a grep hit alone.

**Headline: the architecture holds.** Every documented invariant traced line-by-line came
back correct. What this pass found is one recurring *class* of bug — free text crossing JSON
without newline flattening — in four confirmed sites, plus one family of unguarded
`.toDecimal()` reads that needs a single Creator Execute to settle.

---

## CONFIRMED BUGS — free text into hand-built JSON without newline flattening

One class, four sites. A Multi Line field fed by a `<textarea>` carries `\n`; a raw newline
inside a JSON string literal is invalid JSON, Deluge does not throw, there is no error card
and no 9430 — the widget gets *"bad control character in string literal"* and the tab simply
does not render. This is exactly the "patched at one call site" pattern CLAUDE.md warns
about: sibling fields **in the same function** were fixed while these were left behind.

| # | Site | Emitted at | Problem |
|---|---|---|---|
| 1 | `getSupervisorDisputes.dg:93` — `storeNote` | :222 | Quote-only (`replaceAll("\"","'")`). No `\n`, no `\r`, no `\t`. The same function flattens `raisedNote` correctly at :168–169 |
| 2 | `getSupervisorDisputes.dg:168–169` — `raisedNote` | :222 | Handles `\n` and `\r` but **not `\t`** — a tab is also an illegal control character inside a JSON string |
| 3 | `getStoreDisputes.dg:84` — `denyNote` → emitted as `supervisorNote` | :226 | Quote-only, while sibling `Raised_Note` (:172–173) carries quotes + `\n` + `\r` and even carries the comment explaining why |
| 4 | `getOrderConsumption.dg:254` — `lnD.Note` appended into `lookedTxt` | :291 (`"looked":"…"` inside `reasons`) | Quote-only. Several denial notes already append with `" \| "`, so newlines are plausible here |

Fix shape for all four — apply the full chain on the READER side only:

```
.replaceAll("\"","'").replaceAll("\r","").replaceAll("\n"," | ").replaceAll("\t"," ")
```

Writers stay raw; the record keeps its line breaks.

### Partial-chain risks in the same class

- `getOrderConsumption.dg:355` — `dmNote` has `"→'` and `\n→" "` but no `\r` and no `\t`.
  Also uses `" "` where the house style is `" | "` for readability of appended notes.
- `postTransferOrders.dg:355` — `unmapped` detail built from raw `Material_Name`, escaped
  for quotes only at report time. No `\r`/`\n`. Low reach (names come from BOM masters), but
  inconsistent with `itemName`:310 which got the full chain.
- `postTransferOrders.dg:421` — `reasonTxt` goes into the transfer-order body unescaped.
  Machine-generated today (`SIV-…` or `"issue " + ID`), so it only breaks if somebody
  hand-creates a `Material_Issue` with a stray quote/newline in `Voucher_No`.
- `postTransferOrders.dg:616` — failure-report `shownBody` escaped quotes-only. Bodies are
  single-line by construction; acceptable, noted for consistency.

Deployment note: `.dg` changes only — paste each touched function into Creator and Save. No
Custom API argument lists change.

---

## RISK — `ifnull(field, N).toDecimal()` without the empty-string guard

Per the repo's own rule (*Creator fields never written are EMPTY not null; `ifnull()` does
not catch EMPTY; `.toDecimal()` throws on it*), every site below throws if the field was
never written. Whether they are live depends on whether the writers always seed the fields —
settled per-site below where possible. One Execute against a trial org settles all of them:
read an unwritten decimal field through `ifnull(f,0)` and try `.toDecimal()`.

| Site | Field read | Writer check |
|---|---|---|
| `anotherPageScripts/getDailyProductionTrend.dg:14` | `Stage_Log.Qty_Out` | **NOT seeded at insert** — `saveProductionPhase.dg:379–390` inserts the log row without `Qty_Out`, so every In_Progress stage carries EMPTY. If the rule holds, this throws on any day a stage is open. Highest-priority risk. |
| `getRawMaterialsList.dg:39,40,45,48` | `Raw_Material.Wash_Quantity` / `Unwash_Quantity` / `Quantity` / `Item_Price` | Throws on any Raw_Material row whose quantity or price was never written |
| `packingScripts/getPackingDetails.dg:250–254` | seven `Box_Master` dimension fields | Seeded rows safe (`seedBoxMaster`); a hand-added catalogue row without dims kills the packer screen |
| `packingScripts/getPackingHistory.dg:112` | same | Same exposure |

Downgraded to SAFE after checking the writers:

- `anotherPageScripts/getOperatorPerformance.dg:30–31,58–59` reads
  `Stage_Assignment.Qty_Out` — but both share writers seed it `=0` at insert
  (`saveStageAssignment.dg:227`, `sendToThirdParty.dg:429`). The field is always written;
  the pattern here is ugly but cannot throw.

The guard everywhere else in the app is:
`s = ifnull(f,"0").toString().trim(); if(s == ""){ s = "0"; }` then `.toDecimal()`.

---

## DOC DRIFT — stale comments that will mislead the next reader

1. **`postTransferOrders.dg:179–184` claims it is "deliberately NOT hooked into
   receiveMaterials".** False today. `receiveMaterials.dg:1065–1072` calls
   `thisapp.postTransferOrders("auto")` inside its own try/catch, and
   `postTransferOrders.dg:107–110` says exactly that ("CALLED INLINE BY receiveMaterials").
   The 179–184 block predates the hook and is the stale one — its rationale (the
   Issue_Status fan) was about an older receiveMaterials implementation.
2. **CLAUDE.md, notifications section** — says the createProductionPlans mail runs on EVERY
   run and the `if(createdCount > 0 || …)` guard must be put back before scheduling. It is
   back (`createProductionPlans.dg:633–641`).
3. **CLAUDE.md, deliberate gaps** — says `raiseMaterialException` still has its `sendmail`
   commented out. All three sends (:568, :585, :594) are live.

---

## UNCOMMITTED DIFF — `createProductionPlans.dg` (reviewed, sound)

Two changes in the working tree, neither committed:

**1. Capped batch, `maxPerRun = 25`.**
- Resume path verified: an order that already has a plan is detected (:177–198) and moved to
  In Progress, so a backlog drains across runs and nothing is planned twice.
- `pendingTotal = …count()` taken BEFORE the cap (:102) so the run log reports the real
  backlog, not the capped slice — right call.
- Variable in `range from 1 to maxPerRun` is established precedent in this repo
  (`postTransferOrders.dg:187` uses `scanLimit`; `getStoreIssueHistory.dg:133` uses
  `rFrom/rTo`).
- Skipped orders count against the cap's 25 slots but cost one query each — harmless.
- Not verifiable here: needs one Creator Execute before this is trusted on a schedule.

**2. Supervisor rules read once into `assignBySource` map instead of one query per order.**
- First-row-per-source-wins preserved: both old `.getAll().get(0)` and the new `[ID != 0]`
  walk resolve to the lowest-id matching row.
- Empty `Order_Source` rules skipped — matches the old criteria query, which could never
  match an empty field in either direction.
- Nuance 1 (behavior change, improvement): the map skips rules whose `Employee` lookup is
  empty. The old `.getAll().get(0)` could return null off such a row and reject the order;
  the new code takes the first rule that actually has an employee.
- Nuance 2 (slightly wider match): both sides of the source comparison are trimmed now; the
  old criteria matched raw values.
- Cosmetic: the mail block's body under the restored guard was not re-indented.

Also confirmed while reading the file: the mail guard CLAUDE.md asked for is back
(`createdCount > 0 || failedCount > 0`, :641), sendmails use `from :zoho.adminuserid`, and
all three sit in one try/catch that cannot fail the planning run.

---

## VERIFIED CLEAN

Everything below was checked line-by-line against its documented contract and passed. This
is the positive half of the review — these are the properties the app depends on, now on record.

### Static scan
`tools/dgscan.js` over all files: clean except three known inline-`sort by` hits in
`getProductionWidgetData.dg` (lines 53, 141, 619) — already recorded as deliberate debt in
`docs/scaling.md` ("fold it into the next change to that file").

### Dispute model — every ending, both directions (resolveDispute.dg et al.)
- Side enforcement server-side; `Lost` rejected as an input and manufactured only by the
  second denial.
- Outbound Store_Correction / Lost wind back ALL counters: measured `Issued_Qty` +
  `Pieces_From_Raw`, waste `Pieces_From_Waste`, AND the Issued `Waste_Movement` itself
  (reduced, with remark — which is the undo, since every reader derives pending from
  parent − children). Stock returns only on Correction.
- Outbound Found credits receipt only (Received child movement), zero requirement effects,
  zero stock movement.
- Inbound Supervisor_Correction drops the disputed count, empties to `Miscounted` (never
  `Scrapped`), reduces the Declared movement; Found puts pieces on the rack and leaves the
  declaration alone; Denied+Denied writes the loss off itself and reduces the declaration;
  Supervisor_Resending reuses an empty row or splits to a NEW Waste_Master row + own
  Declared movement with the original reduced by the same count (net-zero invariant holds).
- Inbound resolutions touch NO requirement, NO Item_Status, NO Order_Status — every such
  write sits behind an `inbound == false` gate.
- Empty Direction defaults to Outbound consistently in `resolveDispute`,
  `getSupervisorDisputes`, `getStoreDisputes`, `getStoreCounts` (by subtraction),
  `getSupervisorCounts` (direction-neutral on purpose), and the widget tab.
- `receiveMaterials` nets OPEN disputes per plan+material and per waste piece with the SAME
  key and draw-down as `getSupervisorMaterials` — screen and receipt cannot diverge.
- `receiveWastePieces` raises Inbound disputes and writes nothing on requirements.
- `resolveStockDispute.dg` confirmed legacy: form workflow, zero callers, widgets call the
  Custom API; `Processed=true` stamps protect against double-application. Still delete it in
  Creator — hand-added resolution lines would bypass the current arithmetic otherwise.

### Reissue drafts — three sites, two rules, identical predicates
`getReissueDrafts` (tab), `getSupervisorCounts` (badge), `raiseReissueRequest` (button):
- Check-remake guard: `Material_Requirement[Plan_Item == id && Source == "Check_Remake"]`
  — same at all three.
- Production-loss guard: `Material_Requirement[Plan_Item == id].count() == 0` — ANY source,
  no Source list anywhere — same at all three.
- Strict `== "Check_Reject"` skips legacy `QC_Reject` and empty reasons; nothing in the repo
  writes `QC_Reject` any more. Alteration batches excluded everywhere.
- Known asymmetries, both documented-intentional in the files: the button has no
  Item_Status precondition (a Custom API is callable from anywhere; status only ever moves
  backwards from Ready_For_Production), and the badge counts a batch whose BOM yields no
  material lines while the tab suppresses it (opposite direction of the badge's failure
  class — badge-over-tab, never tab-over-badge).

### coverProductionLoss / damage / short close
- `coverProductionLoss(planItemId)` derives everything: lost from root-family Stage_Log
  (Done stages only), covered from Production_Loss batches under the root; writes
  `lost − covered` onto the unstarted batch (top-up) or a new batch — set-to-derived, so
  two callers cannot double it. Started batches never resized.
- `saveMaterialDamage` opens no batches; calls `coverProductionLoss` idempotently; still
  writes `Remake_Item`, which `raiseReissueRequest` follows to point replacement cloth at
  the BATCH (Source "Reissue"/"Alteration" derived from the resolved target).
- `shortCloseOrder`: mandatory reason refused first; cancels only unstarted Production_Loss
  batches (status + `Stage_Log.count() == 0`); refuses Packed/Dispatched and re-shorting;
  calls `recheckOrderComplete` in its own try/catch.

### Post-checking flow — finishing, packing, order statuses
- "Finished" test identical in all six readers: `Finishing_Data[Item_Check == id]` +
  `Finishing_Status == "Done"` (`getFinishingItems`, `getFinishingHistory` post-page filter,
  `recheckOrderComplete`, `getPackingQueue`, `getPackingDetails`, `savePackingRecord`).
  Writers treat anything non-"Done" as open; zero uses of `!= "In_Progress"` repo-wide.
- Finishing touches NOTHING on Production_Planning or Plan_Item (every reference in
  finishingScripts is a read).
- Single forward-only writers: Checking Passed (`recheckOrderComplete`, from Production
  Complete / In Progress), Finishing Complete (same pass, from Checking Passed), Packed
  (`savePackingRecord`, doubly guarded from Finishing Complete).
- `recheckOrderComplete` owns both statuses in ONE pass; the finishing test runs on EVERY
  pass; `Short_Closed` forgives the quantity test in both halves but NOT the still-making
  test (deliberate). All five direct callers exactly one `thisapp` level deep;
  `recheckFinishingComplete` is gone. Three functions reach it transitively through
  `saveProductionPhase` (receiveFromThirdParty, saveStageAssignment, sendToThirdParty) —
  worth remembering when touching that call.
- `savePackingRecord` recomputes finished counts from Item_Check + Done finishing data
  server-side; enforces boxed == finished in BOTH directions; validates payload dimensions
  (outer > 0 always, inner > 0 when used; unused inner stored as zeroes); refuses duplicate
  Box_No; volumetric = L×W×H/5000 from packer-entered dimensions; estimated weight =
  `Item_Master.Weight × pieces` with no tare.

### issueMaterials.dg (2,124 lines)
- Fabric budget derives from OUTSTANDING PIECES with `* 1.0` before `.ceil()`, applied
  raise-only (`if(pieceBudget > outstanding)`); the "nothing outstanding" test requires
  BOTH metres and pieces spent.
- Waste picks validated then consumed: aggregate over rows sharing
  (supervisor, material, cut size, source); only `Status == "Available"` remnants picked;
  consumption decrements Piece_Count, moves to In_Transit_Count, empties to `Issued`; one
  Issued Waste_Movement per issue stamped with the first Plan_Item that took credit (the
  documented single-stamp limitation, unchanged).
- SIV numbering off `sort by ID desc range from 1 to 10` keeping the largest PARSED number
  with an `isNumber()` guard — never a text sort of Voucher_No.
- Plan-status guard is exactly Pending / Partially Received / In Progress.
- Insert hygiene clean (no comments in field lists; lookups set after re-query).
- All loops ID-keyed or bounded; watch item: the passes × plans requirement scan structure
  is multiplicative if lots-per-issue grows (WIP-bounded today).

### postTransferOrders.dg
- Trigger is `Settled_Qty − Transferred_Qty` per line; `Issue_Status` never read in code.
- Location ids correct (Main Warehouse → Production), warehouse-naming fallback ONLY on 9163.
- Mandatory `transfer_order_number` with `-2/-3` suffixes derived from Transfer_Order_IDs;
  `line_items[].name` present beside item_id; `is_intransit_order:false`.
- Missing Inventory_Item_ID refuses the WHOLE voucher (no posting, no stamp, no Done);
  escalates to Failed after 5 attempts.
- Idempotency: Transferred_Qty stamped in the same pass as posting; Done only when nothing
  owed and nothing left.
- Modes honored (`true` dry-run builds every body, posts nothing; `one`; `auto` bounded to
  10 vouchers / 3 orders); invokeurl defensive throughout.

### Cross-cutting hygiene sweeps
- **sendmail**: 12 blocks across 5 files, every `from :zoho.adminuserid`, every block inside
  its own non-rethrowing try/catch placed AFTER records are written. The once-missing
  nothing-happened guard in createProductionPlans is back.
- **Picklist spellings**: every write/comparison matches the canonical table (spaces vs
  underscores per field). Zero hits for the known-poison values (`Not_Started`, `Reserved`,
  `QC_Reject`, underscored Order_Status variants, `Finishing Done`). Suspicious-looking
  values (`Resolved`, `Closed`, `Occupied`) all attributed to their own forms' Status fields.
- **size() vs count()**: all 78 `.size()` calls operate on Lists (getAll results, toJSONList,
  payload arrays); query results consistently use `.count()`.
- **Mixed-type id comparisons**: joins stringify both sides; the two bare comparisons found
  compare number-to-number via `.toLong()`. No raw lookup id reaches JSON output.
- **Empty-field reads**: outside the RISK table above, all `.toDecimal()` sites follow the
  string-normalise guard.

### Minor observations (no action forced)
- `getOrderConsumption.dg:193–298` aggregates Lost resolution lines per plan without a
  Direction filter — an inbound Lost remnant lands among the order's loss figures.
  Reporting-only; consistent with its pieces-vs-metres split being by Is_Waste.
- Resend netting caps at what the original declaration still holds; after an earlier partial
  correction the split can net slightly above the original cut. Defensive capping beats
  negative counts.
- A Zoho response of `code 0` with no parsable `transfer_order_id` would stamp quantities
  and append an empty id, so the next partial receipt reuses the unsuffixed number and fails
  on uniqueness. Self-limiting; a `newToId == ""` guard would close it.
- `Transfer_Order_IDs` stored comma-space separated but counted via `toList(",")` — size
  correct; leading spaces could surprise future consumers.
- Stray debug `info` lines remain in production paths (`issueMaterials.dg:55,62,441,1736`).
- `issueMaterials` mixes two null-guard idioms: full string-normalise for metres fields,
  bare numeric `ifnull(...,0)` for piece/cut-size fields. Survives because those columns are
  seeded at insert and never go through `.toDecimal()` — but a legacy row with EMPTY
  `Cut_Size_*` makes the equality tests suspect.

---

## Verification status

Per the house rule, none of this is "verified" in the Deluge sense:

- **Settled by static analysis and reading:** everything in VERIFIED CLEAN and DOC DRIFT.
- **Needs one Creator Execute:** the four JSON fixes after pasting (press Enter into a
  dispute note, reload the tab); the `ifnull(...).toDecimal()` question behind the whole
  RISK table (one tryout-script answer settles all sites); the uncommitted cap diff before
  it runs on a schedule.
- **Manual Creator actions outstanding (unchanged from before):** delete
  `resolveStockDispute` workflow and `packingAutoPopulate`; the three known inline sorts in
  `getProductionWidgetData` fold into its next change.
