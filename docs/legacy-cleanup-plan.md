# Legacy cleanup — API migration + Issue_Lines form migration

Goal: remove the pre-migration issue/receive path entirely. No fallback flags, no
dead subform fields, no dead functions. One path only.

Nothing here runs until pasted into Creator. `.dg` = paste + Save. Widget = zip + upload.
**Creator form/field deletions are manual and called out separately.**

---

## The two migrations being finished

1. **API migration** — `issueMaterials` → `issueMaterialsApply` + `issueMaterialsHandover`;
   `receiveMaterials` (sweep/finalize) → `receiveHandover` + `receiveFanOut`. Both live paths
   run today behind `USE_SPLIT_ISSUE = true` / `USE_SPLIT_RECEIVE = true`. The old functions
   are still wired as the `else` branch.

2. **Issue_Lines form migration** — grain changed from per-requirement to per-material×lot.
   Legacy fields (`Requirement`, `Plan_Item`, `Lot_Override_From`, `Lot_Override_Note`) are
   written only by the retired `issueMaterials` and read only for pre-migration vouchers.
   Plus 3 never-used fields (`Waste_Piece`, `Piece_Count`, `Plan` subform) and 1 write-only
   (`Received_Pieces`).

---

## PART A — kill the fallback flags (widget JS)

### A1. `app/js/main.js` — issue path

- Delete `USE_SPLIT_ISSUE` var (line ~5061). Replace `ISSUE_API` (line 5062) with the literal
  `'issueMaterialsApply'` everywhere it's used (or keep the const, hard-set).
- Delete `var batchVoucher = '';` (line ~5090).
- `processNextChunk` (line ~5348): delete the `else { chunkPayload.voucherIn = batchVoucher; }`
  branch — always send `applyKey`.
- Line ~5406: the `if (USE_SPLIT_ISSUE) { ... } else if (parsed && !batchVoucher) { ... }` —
  drop the `else if` legacy batch-key capture. Keep the split branch body unconditional.
- `scheduleRetry` (line ~5449): `console.warn('issueMaterials rate-limited...` → rename string
  to `issueMaterialsApply`.
- `abortRun` (line ~5471): `console.error('issueMaterials error...` → same rename.
- Comments at lines ~5045-5060, 5088, 5099-5101 describe the legacy per-chunk-voucher model —
  rewrite to describe only the apply+handover model.

### A2. `app/supervisor/js/receive.js` — receive path

- Delete `var USE_SPLIT_RECEIVE = true;` (line ~1002).
- Delete `function sweepStep()` (lines ~1113-1138), `function finalizeStep()` (~1140-1161),
  `function post()` (~952-995) — all legacy `receiveMaterials`-only.
- `scheduleRetry` (line ~1094): drop the `if (USE_SPLIT_RECEIVE) { ... } else { ... }`, keep
  only `resume = stage === 'sweep' ? handoverStep : fanStep;`.
- Bottom of `submitReceipt` (line ~1226): `if (USE_SPLIT_RECEIVE) { handoverStep(); } else
  { sweepStep(); }` → just `handoverStep();`.
- Dead locals now: `sweepCursor`, `firstSweep`, `sweepN`, `finalizeN` (only `finalizeN` is
  still read by `fanStep`? check — `fanStep` uses `finalizeN++`, keep that one). Remove
  `sweepCursor`, `firstSweep`, `sweepN`.
- Comments at lines ~793-800, 997-1001, 1181-1184 mention the legacy sweep/finalize — rewrite.
- `isRateLimited` / the DELUGE-error handling in `splitInvoke` stays (still needed).

### A3. verify

- `node --check` both files.
- `node tools/issue-handover-path.test.js`, `tools/issue-handover-parity.test.js`,
  `tools/receive-settle-path.test.js`, `tools/receipt-split-ui.test.js` — these test the
  split path, must still pass.

---

## PART B — delete the legacy Deluge functions

Once PART A ships and is confirmed working in production:

### B1. `deluge/issueMaterials.dg` — DELETE

- No `thisapp.issueMaterials(` cross-call anywhere (verified).
- Only caller was `main.js` `ISSUE_API` — removed in A1.
- **Creator:** delete the Custom API `issueMaterials` and the function.

### B2. `deluge/receiveMaterials.dg` — DELETE

- No `thisapp.receiveMaterials(` cross-call (verified).
- Only caller was `receive.js` `post()` — removed in A2.
- **Creator:** delete the Custom API `receiveMaterials` and the function.
- NOTE `resolveDispute.dg` has *comments* referencing `receiveMaterials.dg:979` as the model
  for the Issue_Lines wind-back — comments only, no call. Leave or update the comment.

### B3. `deluge/createProductionPlans.dg` — already parked unused (per CLAUDE.md), leave as-is
   unless you want it gone too — it's the pre-batch-workflow plan builder. Separate decision.

---

## PART C — Issue_Lines subform field cleanup

### C1. Safe NOW (independent of A/B) — zero readers

| Field | Action |
|---|---|
| `Waste Piece` | delete in Creator. No code touches it. |
| `Piece Count` (subform) | delete in Creator. No code touches it. `Piece_Count` on Waste_Master/Movement is unrelated. |
| `Plan` (subform) | delete in Creator. Never written to the subform. Parent `Material_Issue.Plan` stays. |
| `Received Pieces` | 1 code edit then delete: remove `liRow.Received_Pieces=0;` from
  `issueMaterialsHandover.dg:241`, redeploy that `.dg`, then delete the field. |

### C2. Legacy fields — delete AFTER Part B (they only matter for pre-migration vouchers)

Deleting these means `getAdminCalculation`, `getSupervisorProductionHistory`,
`getSupervisorMaterials`, `receiveMaterials`(gone), `getExpectedWaste`, `receiveHandover`
lose the ability to read them on OLD `Material_Issue` records. Acceptable only if every
pre-migration voucher is fully closed (received + transferred) and no report needs to
reconstruct its detail.

| Field | Readers to clean first |
|---|---|
| `Requirement` | `getSupervisorMaterials.dg:326` (drop `lnReqTxt` + its use); `receiveMaterials.dg` — GONE after B2, no cleanup needed |
| `Plan Item` (subform) | `getAdminCalculation.dg:651` (drop `liItem`); `getSupervisorProductionHistory.dg:545-547` (drop `rln.Plan_Item` fallback — it already prefers other sources) |
| `Lot Override From` | `getAdminCalculation.dg:694,722` (drop `liFrom` / `overrideFrom` from the JSON) |
| `Lot Override Note` | **KEEP** — see C3 |

### C3. `Lot Override Note` — DO NOT DELETE

Read by CURRENT code for PRINTED_PIECE detection:
- `handover-detail.js` `assemble` — `note.indexOf('PRINTED_PIECE')`
- `receive-read.js` — same
- `getExpectedWaste.dg:536`, `getSupervisorMaterials.dg:422`, `receiveHandover.dg:126`

BUT the new `issueMaterialsHandover` **doesn't write it** — so printed-piece rows on the
JS-API path are already not detected. Printed-fabric end-to-end is a deferred sub-project
(`docs/issue-receive-model-migration.md` §"printed"). Two options:
  - **(a)** Fix `issueMaterialsHandover` to persist the marker (write `Lot_Override_Note` from
    the payload line's `note`, which `buildHandoverSummary` already carries as `printed:true`),
    then keep the field. Do this if printed fabric is coming soon.
  - **(b)** Leave the field, leave the readers — harmless, just unused on new data.
Either way: **not a deletion candidate now.**

---

## PART D — Batch_Voucher / Batch_Head (Material_Issue parent fields)

Written only by the retired `issueMaterials` (per-chunk voucher glue). The new
`issueMaterialsHandover` explicitly does NOT write them (one row per press).

Still READ by:
- `getStoreIssueHistory.dg:154,164,293,298` — pages on `Batch_Head == true || Source_System
  == "JS_API"`, merges siblings by `Batch_Voucher`
- `getSupervisorProductionHistory.dg:391,453,458` — same pattern

These two history functions handle BOTH old (Batch_Head) and new (Source_System=="JS_API")
records. Deleting `Batch_Voucher`/`Batch_Head` means:
1. Clean both history functions to page on `Source_System == "JS_API"` only, drop the
   sibling-merge-by-Batch_Voucher block entirely (new path has no siblings).
2. Then delete the two fields in Creator.

Do this in the SAME pass as C2 (all "old voucher detail is gone" changes together).

---

## PART E — Source_System

`Source_System == "JS_API"` is the migration discriminator. Once every legacy `Material_Issue`
is gone/irrelevant and Batch_Head logic is removed, the history functions could drop the
`Source_System` filter too (every row is JS_API). LOW priority — it's one harmless criterion.
Leave it. If you keep writing `Source_System="JS_API"` in `issueMaterialsHandover` it's a
useful provenance marker.

---

## PART F — tests

`.dg`-reading tests that break when `issueMaterials.dg` / `receiveMaterials.dg` are deleted:

| Test | Refs | Action |
|---|---|---|
| `tools/deluge-maths.test.js` | 5 (PORT of issueMaterials ledger) | re-point port at `issueMaterialsApply.dg` |
| `tools/pipeline.test.js` | 1 | re-point |
| `tools/print-cut.test.js` | 5 (reads `issueMaterials.dg` token pipeline) | re-point at `issueMaterialsApply.dg` |
| `tools/raw-quantity.test.js` | 6 (asserts on `issueMaterials.dg` fabric branch) | re-point |
| `tools/receive-lifecycle.test.js` | 2 (PORT of issueMaterials + receiveMaterials) | re-point at Apply + `receive-model.js` covers the split |
| `tools/receive-print.test.js` | 9 (asserts `issueMaterials.dg` / `receiveMaterials` no longer carry the marker) | rewrite assertions against Apply/Handover |
| `tools/waste-return.test.js` | 9 (PORT of issueMaterials pick validation + receiveMaterials waste) | re-point |
| `tools/issue-receive-e2e.test.js` | 2 (uses `receive-model.js` — a JS reference model, NOT the .dg) | probably fine — check it doesn't read the .dg |
| `tools/issue-receive-edge-cases.test.js` | 2 (same `receive-model.js`) | probably fine |

`tools/receive-model.js` is a hand-written JS reference model of the receive arithmetic — it
does NOT read `receiveMaterials.dg`. Keep it; it now models `receiveHandover` + `receiveFanOut`.

---

## Execution order

1. **PART C1** — 4 fields, 1 tiny `.dg` edit. Independent, do first, low risk.
2. **PART A** — kill fallback flags. Ship. Confirm in production for a few days.
3. **PART B** — delete the 2 legacy functions + their Custom APIs.
4. **PART F** — re-point the broken tests (same commit as B).
5. **PART C2 + D** — clean the legacy-field readers, delete `Requirement` / `Plan_Item` /
   `Lot_Override_From` / `Batch_Voucher` / `Batch_Head`. Only once you accept old-voucher
   detail is unrecoverable.
6. **PART C3** — decide printed-fabric: fix the writer or leave `Lot_Override_Note` dormant.

CLAUDE.md, MEMORY, and `docs/issue-receive-model-migration.md` updated at the end.
