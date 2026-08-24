# Front-half verification — order → plan → requirement → issue screen

**2026-08-23.** Scope: `syncSingleSalesOrder`, `createProductionPlans`,
`buildItemRequirements`, `getStoreMaterialRequirements`, `app/js/lot-allocator.js`,
`issueMaterials`. Stops at the handover write. Receipt/production/checking/finishing/packing
out of scope.

## Harnesses (all deterministic, all passing)

```
node tools/deluge-maths.test.js    43 passed   (user-extended B14b-g piece-validation set)
node tools/allocator.test.js       31 passed   (real widget allocator in a VM)
node tools/pipeline.test.js        34 passed   NEW - planner + sync ports, cap starvation,
                                               screen-to-ledger end-to-end parity sweep,
                                               per-order try/catch semantics (P18-P21)
node tools/dgscan.js deluge/*.dg   clean except the 3 known inline sorts
                                   in getProductionWidgetData (documented debt)
```

New coverage this pass: plan numbering (max-of-newest-10 seed, empty/dashless/non-numeric
`Plan_No`, width rollover 99999→100000), resume path incl. budget immunity and supervisor
mirror, every rejection path + Pending retry preserved, rejected orders consume no number,
priority key maths, rules-index build (empty-source / null-Employee skipping),
the TWO-LIMIT CAP including the starvation regression, `syncSingleSalesOrder`
(dup-check before API, draft/void skip, SKU resolution, exactly-one-BOM advisory,
source resolution incl. custom-field label precedence, customer miss advisory, mail guard),
an end-to-end parity sweep: server payload → real allocator → Issue payload → ledger,
and the PER-ORDER TRY/CATCH added to the planner loop (below).

## Verified 2026-08-23 (later pass): per-order try/catch in createProductionPlans

`createProductionPlans.dg:199` opens a `try` around the whole per-order body; `:634-666`
catches, logs `ERROR ->`, and counts into `failedCount`. Ported faithfully and covered by
four tests:

- **P18 — poison-pill containment**: one throwing order mid-queue; both healthy orders
  behind it planned in the SAME run. ERROR logged apart from REJECT (`ERROR -> SO …` vs
  `REJECT -> SO …`); the throwing order keeps Pending.
- **P19 — the regression this kills**: before the change a throw killed the whole run and,
  because failures stay Pending, every later run died at the identical order — one full
  scheduling window lost per occurrence, silently. Now two consecutive runs each complete:
  run 1 plans five orders past the throw, run 2 completes again with the same error reported.
- **P20 — post-insert recovery**: a throw between the header insert (:475) and the
  queue-exit write (:559-567) leaves plan + Pending order. Deluge has no transaction to roll
  back; next run the RESUME PATH finds the plan and moves the order to In Progress without
  planning twice or duplicating the header. Verified across two simulated runs.
- **P21 — accounting**: an error consumes NO plan number, and `failedCount` includes errors
  so an error-only run still sends the summary mail.

Notes on the shape (checked, not defects): the budget guard's `continue` sits inside the
`try` and is untouched by it; `errTxt`/`soNoTxt` are scalar-only names in that function (no
loop-variable clash — dgscan confirms); ERROR rows share the failure mail table but carry an
`ERROR:` prefix, matching the log separation. The catch cannot save a statement-limit kill
(uncatchable by design) — it covers genuine runtime throws such as bad data in one order.

## Fixed 2026-08-23: store Issue screen — waste checkbox / pcs input

Reported: uncheck left the box visually ticked while the count went to 0; typing did
nothing (count snapped to 0); re-checking then showed 1. Confirmed a BUG against the
documented intent (lot-allocator.js: "REMNANTS HE HAS DECLINED, or reduced the count on…
Untick it and the cloth has to make up the difference") — nothing describes the stuck-tick
behaviour as wanted. Three defects feeding each other, all in `app/js/main.js`:

| # | Site | Was | Is |
|---|---|---|---|
| A | render (`checked` hardcoded on the waste checkbox) | declined remnant rendered TICKED over a 0-pcs input | tick derived from the decline via new `wasteCheckedFor(pick)` |
| B | `onWasteInputChange` clamped against `pick.pieces` (0 while declined) and `max` attribute likewise | every keystroke snapped to 0; box unusable exactly when he is bringing pieces back | clamps against the RACK count via new `rackCountFor(m, pick)` |
| C | the change-test fell through to `delete wasteDeclined` when the clamped value equalled the pick | typing while declined silently restored the FULL allowance with no re-render | compares against the CURRENT effective take; only the full rack count withdraws a decline (same semantics `wasteAllowed` uses) |

Also hardened the same defect surface: `setWasteChecked` now updates `wasteDeclined`
(state, not just paint — the master checkbox reaches it), and `onSelectAllChange`
re-renders once after its sweep, since declines re-size the fresh metres. The submit path
needed no change: unchecked rows were already excluded from the payload, so the honest
render sends exactly what the buggy one accidentally did.

**Tests:** new `tools/store-ui.test.js` (7 tests, stub DOM + real allocator + the extracted
handlers via vm) — decline renders unticked at 0; typing accepted up to the rack; no silent
un-decline; full rack ≡ no decline; re-check restores. Suite counts now:
deluge-maths 43 · allocator 31 · pipeline 34 · store-ui 7.

---

## FINDINGS

### F1 — LIVE BUG: an order served by offcuts alone never closes its requirement
**Where:** `deluge/issueMaterials.dg:1045` (synthetic-pass condition), with :1541 (fan pin
filter) and :1699 (waste-credit block). Widget side: `app/js/lot-allocator.js:696`
(lot line emitted only when metres > 0) + :719 (picks always keyed remnant AND item).

**What breaks:** On one store card, order A is fully covered by a lot's own offcuts (zero
metres) while order B takes fresh cloth from the same lot. The widget submits picks pinned
to A's item and a lot line only for B. Every executed pass is pinned to B (`passIds` holds
one key), so the fan visits only B's rows: A's `Pieces_From_Waste` credit never lands, its
requirement stays open for ever, and the physically handed-over remnants book against
nothing. Next press: those remnants now fail validation ("no longer available"), so he is
asked for REAL cloth for pieces the offcuts already covered — silent loss, then over-issue.
The synthetic no-lot pass exists for exactly this family but its guard tests
`passIds.size() == 0`, which is false here because the LINE still has another item's lot line.

**Trigger input:** any multi-order card where one order is offcut-complete on a lot another
order also draws metres from. Reproduced deterministically in `pipeline.test.js` Z3;
**17 of 200 randomized racks hit it (~8.5%)** — ordinary shape, not exotic.

**Severity: HIGH, live** (needs ≥2 orders sharing a material+cut size on one card plus
offcuts covering one entirely — routine once remnants exist).

**Fix shape (not applied):** build `passIds` from `passOrder` UNION the distinct pins in
`wPinTot` that own no pass (each as an empty-lot pass). Z3 asserts the buggy behaviour and
inverts loudly the day the fix lands; Z2 counts occurrences instead of failing.

### F2 — Latent (unchanged): `canPiece` ignores `Required_Pieces`
`issueMaterials.dg:1075-1082`. Re-checked against the changed file — behaviour identical to
the finding recorded in `docs/automation-verification.md` (B16b). Not reachable through
current data; keep on the books.

### F3 — Documented asymmetry (not a regression): assignment is exact-match, ranking is not
`createProductionPlans.dg` — the rules map keys on the TRIMMED RAW source value while the
priority rank compares lowercase. An order stored as `shopify` ranks like Shopify yet finds
no supervisor rule (`Shopify`) and is REJECTED with a clear reason. The old criteria query
behaved identically; pinned by test P11 so nobody "fixes" one half without the other.

### F4 — Residual starvation beyond the scan window (accepted, surfaced)
With > `scanLimit` (100) permanently-stuck orders oldest-first, plannable ones behind them
are never scanned. No query design fixes this — only fixing the stuck orders does. The
BACKLOG log line names the condition; P16 documents the boundary. Consider an admin screen
for "oldest Pending rejections" if it ever bites.

### F5 — Payload weight at target volume (risk, see scale table)
At the stated extreme (1,000 distinct fabrics demanded concurrently) the
`getStoreMaterialRequirements` response is roughly **3.5-4.5 MB**: the per-material lots
array (~13 lots x ~0.2 KB) is rebuilt into EVERY entry of EVERY supervisor carrying that
material. Fine at today's WIP; would need a split-by-supervisor fetch or lazy lots before
that scenario is real. No action now; flagged so nobody is surprised.

---

## SCALE TABLE (target volumes per CLAUDE.md / docs/scaling.md)

Ops = Creator statements (queries + loop statements + writes), estimated from the code paths
and measured on the planner port where marked m.

| Function | Per invocation at target volume | Tracks | Verdict |
|---|---|---|---|
| `syncSingleSalesOrder` | ~12 queries (dup 1, customer 1, per line: Item_Master+BOM ~2x5) + 1 insert + subform rows. Independent of the 20-25k catalogue (all indexed lookups) | one order | OK |
| `createProductionPlans` | fixed ~4 queries; scan window 100 x ~6 (resume + BOM checks when rejecting); budgeted 25 x ~160 created (m: measured 115 writes + ~45 queries) -> full mixed run ~4,000 ops worst case | OPEN WORK (Pending queue + scanLimit + maxPerRun) | OK, margin IS the scan window - raising scanLimit multiplies linearly |
| `buildItemRequirements` | ~7 queries/item (BOM re-fetch + Raw_Material per row), ~35/order | one order | OK |
| `getStoreMaterialRequirements` | pendingPlans (WIP-bounded) + per-plan SO lookups + piCache misses + **Waste_Master[Available] FULL FETCH** + Fabric_Piece[Available] full fetch + per-needed-material lot queries + per-key Raw_Material | mostly OPEN WORK; Waste_Master Available-set grows until a rack-ageing policy exists | RISK (pre-existing, documented in scaling.md as needing client policy) |
| `lot-allocator.js` | pure CPU over the payload; guard-capped loops (400 passes); O(orders x remnants) per lot fill | payload size | OK |
| `issueMaterials` | index build P queries (P=open plans/sup ~20) + rows walk; per material 3 x |plans actually carrying it| (typically 1-3) instead of the old 3 x P; validation 1 query per pick/lot/piece; writes ~115/created voucher equivalent. M=13,P=20: was ~780 queries -> now ~100 | OPEN WORK (payload + open plans) | OK - the matPlanIdx change removed the worst multiplicative structure |

**Throughput answer:** the planner creates at most 25 plans/run. The summary mail footer
says runs are twice daily => capacity **50 plans/day**. A steady arrival under that drains
fine; a 500-order Shopify import takes ~10 days to clear at twice-daily, or 20 runs.
If bulk imports are real, move the schedule to hourly (24 x 25 = 600/day) - a Creator
schedule change, not code. Capacity is consumed only by SUCCESSES; stuck orders cost scan
slots, never budget (P14).

**Payload size answer:** see F5 - ~3.5-4.5 MB at 1,000 concurrently-demanded materials,
dominated by duplicated lots arrays; comfortable at today's WIP.

---

## Needs a Creator action (manual, unchanged)

- Schedule frequency decision (twice-daily vs hourly) after the first bulk import.
- Standing deletions: `resolveStockDispute` workflow, `packingAutoPopulate`.
- The three inline `sort by` in `getProductionWidgetData.dg` fold into its next edit.

## What is NOT verified here

Deluge cannot execute locally. Everything above proves the logic AS READ via faithful ports
(line references cite the .dg). Before trusting any changed function in production:
paste into Creator and use Execute - especially `createProductionPlans` (variable-in-range
plus count()) and the new `matPlanIdx` / piece-validation block in `issueMaterials`.
