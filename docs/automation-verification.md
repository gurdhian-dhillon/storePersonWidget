# Initial automation verified — plan creation → material allocation

**Date: 2026-08-23. Method: executable tests, not reading.** The Deluge arithmetic was
ported line-for-line into Node (`tools/deluge-maths.test.js`, same truncation-before-ceil
semantics) and the widget allocator — which is already JavaScript — is executed directly
inside a VM sandbox (`tools/allocator.test.js`). No app code was changed.

```
node tools/deluge-maths.test.js     37 passed, 0 failed
node tools/allocator.test.js        32 passed, 0 failed
```

The pipeline under test, layer by layer:

| Layer | File | Role |
|---|---|---|
| 1. Plan time | `buildItemRequirements.dg` | pieces/row, rows (`*1.0` before ceil), metres |
| 2. Screen server | `getStoreMaterialRequirements.dg` | outstanding PIECES; fresh-metres re-round |
| 3. Widget allocator | `app/js/lot-allocator.js` | lot + offcuts as ONE decision; pins; greige tiers |
| 4. Issue ledger | `issueMaterials.dg` | validate-all-then-consume; per-pass budgets; fan |

---

## What the tests prove (all PASS)

### Plan-time maths (`buildItemRequirements`)
- `100 pcs @ 3/row, 55 cm cut -> 18.70 Mtr` — the documented example, exact.
- Ceil boundaries both sides: exactly-divisible adds no row; +1 piece adds one.
- `pieces <= perRow` still plans exactly one row; zero pieces plan zero metres.
- Cut width == fabric width gives **1 per row**, never 0.
- **Cut wider than cloth is refused with a visible 0 + ERROR log — never "1 per row"** (grain rule).
- Missing width / zero cut sizes → visible 0 + WARN, no throw.
- Fractional inches (44.5"), large quantities (2500 pcs) exact.
- Non-fabric: `perUnit × qty` with fractions; cut size ignored entirely.
- **A15 regression**: the old integer-division bug (`100/3→33 rows→99 laid`) cannot recur.
- Property sweep (3000 cases): rows×perRow always ≥ pcs AND (rows−1)×perRow < pcs —
  **no stranded piece and no wasted row is arithmetically possible**.

### Screen ↔ plan parity
- Server `freshMeters` for untouched requirements == plan-time requirement exactly
  (2000 randomized cases).
- Widget `need` formula == server formula over all degenerate inputs (zero widths,
  cuts wider than cloth, zero pieces): both fall back to `max(0, Required_Qty − Issued_Qty)`
  and neither ever quotes 0 for an uncountable row (the vanish-from-the-shortfall-summary bug).

### Issue ledger (`issueMaterials`) — the documented silent-loss regressions
- **B3/B4 stranded-piece case**: 100 pcs @3/row; odd first handover of 10.00m books 54;
  second press RAISES the budget to the piece truth (8.80 > the 8.70 metres balance)
  and closes all 100. The last piece cannot strand any more.
- **Whole-marker-row snapping DOWN**: a 5.00m ask against a 55cm cut moves 4.95 and leaves
  5cm on the shelf where the next issue can use it.
- **Offcut surplus clamp**: remnants yielding more cuts than owed credit only what is owed.
- **Zero-yield pick**: a remnant too small for the cut is handed over physically but credits
  ZERO pieces — it can never close a requirement nobody can cut.
- **Pinned-pass isolation (the A/B bleed bug)**: two items of one order each get exactly
  their own demand from their own passes; nothing bleeds across.
- **Residue direction**: offcut-covered rows cap at their true remaining metres so a second
  lot's cloth is not swallowed by stale estimate residue (and its tone never mis-stamps).
- **`Issued_Lot` stamped once**; later presses never rewrite history.
- One order refusing to straddle two lots; blocked lots refused outright; duplicate lines on
  one lot validated against the SUMMED want (no half-applied issues anywhere).
- **Pieces-lot yield truth**: three 3.00m pieces at a 55cm cut credit 30 pieces (5 per piece),
  not the 32 that dividing 9.00m would invent; whole-piece metres leave unsnapped.
- Split-lot lifecycle (20m + 7.70m for 100 @2/row): closes exactly, tails stay on the shelves.
- Reissue `Source` isolation: a Plan-source pass cannot land on Reissue rows.
- Non-fabric walks the single synthetic pass with plain balance; no snapping, no pieces.
- Offcuts-only fabric line books its waste credits through the synthetic no-lot pass.
- Property sweep (800 random multi-row presses): every row closes EXACTLY at
  `fromWaste + fromRaw == reqPieces`; Σ Issued_Qty never exceeds cloth moved.

### Widget allocator (real file executed)
- Yield maths: floor-across × floor-along; narrower-than-cut = 0 however long (grain fixed).
- Waste before fresh; least-waste-per-cut scoring spends the snug remnant first.
- Roll rows capped by cloth; shortfall reported in pieces; EMPTY `Form` means Roll.
- Pieces lots simulated per piece; greige excluded even after-wash (documented phase-2 gap).
- Lot choice: smallest covering lot wins; ready tier beats after-wash tier; blocked never a
  candidate; an order nothing covers whole is SKIPPED, never split.
- **Pin guarantees**: pinned orders never drift to cheaper lots; the pin is read from SETTLED
  lines too (remake matches its original's shade); a dry pin allocates NOTHING until a human
  overrides, and the override records BOTH tones; a BLOCKED pin is unusable even when full;
  a pin whose lot holds only in-Wash cloth survives (waiting beats mixing shades).
- Card ledgers: two orders on one card cannot promise the same metres/pieces/remnants twice,
  while two supervisors are both offered the full rack (contention settled server-side).
- afterWash commits move ledgers but emit no handover; wash demand aimed at THE committed lot.
- Declined remnant frees the allocation, raises the fresh need, keeps its row at zero.
- Pieces-lot payloads name the physical pieces per line (the 16th-row lie cannot recur).
- Randomized sweep (400 racks × multi-order cards): one-lot-per-order invariant held in
  every case; picks never exceed rack counts; skipped/served/committed states mutually
  consistent.

## FINDING (one, low severity, latent)

**B16b — `canPiece` ignores whether rows are actually piece-tracked**
(`issueMaterials.dg:911–920`). `canPiece` tests only cut size and fabric width, never
`Required_Pieces`. A pre-pieces-era row (`Required_Pieces == 0`) that carries a valid cut
size AND a fabric width enters the piece-cap branch, computes `pcsLeft == 0`, caps at 0 —
and the metres-balance fallback at :1209–1221 is unreachable. The screen still SHOWS such a
row (its own fallback quotes `Required_Qty − Issued_Qty`), so he presses Issue on a visible
requirement and **nothing happens, silently** — the exact UX failure family CLAUDE.md
records. Not reachable through current data (every live row gets `Required_Pieces` at
insert), so this is latent, not live. Fix shape if ever needed: add
`&& <some row has reqPieces> 0>` to `canPiece`, or fall back per-row when `rowPcsReq == 0`
(the fan already does exactly that at :1440–1459).

## Design notes confirmed while testing (not defects)

- On a pieces-lot issue, metres moved are the WHOLE pieces' metres (9.00), while
  `Issued_Qty` books against the marker-row ceiling (8.25). Deliberate: a piece goes out
  whole, its tail returns as an offcut, completion is counted in pieces.
- `Issued_Qty` may legitimately land below `Required_Qty` when offcuts covered pieces
  (fewer fresh rows needed than the pre-waste estimate assumed) and may exceed it when
  split handovers round up — both documented model behaviour, both exercised.
- Single-piece remnants serve ONE item wholly; surplus capacity is never promised away
  (the tail comes back as offcut). Two-item splits happen with ≥2 physical pieces, which is
  why payload picks are keyed by remnant AND item.

## Re-running / extending

Both harnesses are plain `node` scripts with seeded PRNGs (deterministic output):
`node tools/deluge-maths.test.js && node tools/allocator.test.js`.
When changing any arithmetic in `buildItemRequirements`, `getStoreMaterialRequirements`,
`issueMaterials` or `lot-allocator.js`, update the corresponding port here FIRST, then the
Deluge — the port mirrors the `.dg` line numbers cited in its comments.
