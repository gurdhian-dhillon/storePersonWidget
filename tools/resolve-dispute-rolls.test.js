#!/usr/bin/env node
// Node port of resolveDispute.dg's roll-wind-back logic, lot-rolls-model.md
// Step 7 (outbound Store_Correction / Found restore path only - inbound
// disputes touch Waste_Master, never Raw_Material_Lot / Lot_Rolls, so there
// is nothing to port on that leg).
//
//   usage: node tools/resolve-dispute-rolls.test.js
//
// resolveDispute is Deluge, so nothing here runs the real function - this
// mirrors the two pieces of logic by hand:
//   parseLastRollLabel - Issue_Lines.Roll_Label is one label, or several
//     joined "L2-R1 5m, L2-R2 1.05m" when that handover line drained more
//     than one roll. There is no record of which portion of a multi-roll
//     line the DISPUTED metres came from, so the restore targets the LAST
//     roll named - drain order is shortest-first, so the last-named roll is
//     the one most recently drawn from (the same "unwind newest-drain-first"
//     rule applyFabricOverride already uses for an edit-down).
//   restoreToRoll - adds the corrected/found metres back to that roll, UNLESS
//     it is Consumed (may have been physically discarded), in which case a
//     NEW row is inserted (Origin="Returned") rather than reviving the old
//     one. Same rule for a roll that no longer exists at all.
//
// Verified: A/B label parsing, C in-place bump, D/E new-row cases, F overall
// conservation (Σ Roll_Length after a restore == what it was before the
// dispute).

function parseLastRollLabel(rlLabel) {
  if (!rlLabel) return '';
  const parts = rlLabel.split(',');
  if (parts.length <= 1) return rlLabel.trim();
  let lastSeg = parts[parts.length - 1].trim();
  if (lastSeg.endsWith('m')) lastSeg = lastSeg.slice(0, -1);
  const lastSp = lastSeg.lastIndexOf(' ');
  if (lastSp > 0) return lastSeg.slice(0, lastSp).trim();
  return lastSeg.trim();
}

function restoreToRoll(lot, rollLabel, takeL, dispId) {
  if (!rollLabel) return lot;
  const upLabel = rollLabel.toUpperCase();
  // FIRST MATCH WINS, and only a non-Consumed row is eligible. Several rows
  // can carry one label (the still-Consumed original, plus one Returned row
  // per earlier restore on it) - matching every row would both grow the
  // existing Available row AND insert another Returned row for the
  // still-there Consumed original on a second dispute against the same
  // label, inventing metres. A Blocked roll keeps its status (quarantine may
  // be unrelated to this dispute); only a bare/empty status is promoted to
  // Available, since the allocator only cuts Available rolls.
  let hit = false;
  for (const r of lot.rolls) {
    if (hit) break;
    if (r.label.toUpperCase() === upLabel && r.status !== 'Consumed') {
      hit = true;
      r.length += takeL;
      if (r.status === '') r.status = 'Available';
    }
  }
  if (!hit) {
    lot.rolls.push({ label: rollLabel, length: takeL, status: 'Available', origin: 'Returned', source: 'DISPUTE-' + dispId });
  }
  return lot;
}

const assert = require('assert');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

test('A single-roll label parses to itself', () => {
  assert.strictEqual(parseLastRollLabel('L2-R1'), 'L2-R1');
});

test('B multi-roll label picks the LAST segment, strips "m", strips metres', () => {
  assert.strictEqual(parseLastRollLabel('L2-R1 5m, L2-R2 1.05m'), 'L2-R2');
  assert.strictEqual(parseLastRollLabel('L2-R1 5m, L2-R2 3m, L2-R3 2m'), 'L2-R3');
});

test('B2 leading space after comma is trimmed correctly', () => {
  // main.js joins with ", " - confirm the space does not leak into the label
  assert.strictEqual(parseLastRollLabel('A-R1 10m,  A-R2 5m'), 'A-R2');
});

test('C restoring to an Available roll bumps length in place, no new row', () => {
  const lot = { rolls: [{ label: 'L1-R1', length: 10, status: 'Available' }] };
  restoreToRoll(lot, 'L1-R1', 5, 'D1');
  assert.strictEqual(lot.rolls.length, 1);
  assert.strictEqual(lot.rolls[0].length, 15);
  assert.strictEqual(lot.rolls[0].status, 'Available');
});

test('D restoring to a CONSUMED roll creates a NEW row, never revives the old one', () => {
  const lot = { rolls: [{ label: 'L1-R1', length: 0, status: 'Consumed' }] };
  restoreToRoll(lot, 'L1-R1', 8, 'D2');
  assert.strictEqual(lot.rolls.length, 2, 'expected the consumed row to stay AND a new one to appear');
  assert.strictEqual(lot.rolls[0].length, 0, 'the consumed row must not be touched');
  assert.strictEqual(lot.rolls[0].status, 'Consumed');
  assert.strictEqual(lot.rolls[1].length, 8);
  assert.strictEqual(lot.rolls[1].status, 'Available');
  assert.strictEqual(lot.rolls[1].origin, 'Returned');
  assert.strictEqual(lot.rolls[1].source, 'DISPUTE-D2');
});

test('E a roll that no longer exists at all also creates a new row', () => {
  const lot = { rolls: [{ label: 'L1-R2', length: 4, status: 'Available' }] };
  restoreToRoll(lot, 'L1-R1', 6, 'D3'); // L1-R1 was never on this lot's rolls
  assert.strictEqual(lot.rolls.length, 2);
  assert.strictEqual(lot.rolls[1].label, 'L1-R1');
  assert.strictEqual(lot.rolls[1].length, 6);
  assert.strictEqual(lot.rolls[1].origin, 'Returned');
});

test('F invariant: Σ Roll_Length after restore == pre-dispute total (conservation)', () => {
  // Simulate: lot had one roll of 20m. 8m issued+disputed (roll drops to 12).
  // Store_Correction restores 8m -> roll should be back to 20m total.
  const lot = { rolls: [{ label: 'L1-R1', length: 12, status: 'Available' }] };
  restoreToRoll(lot, 'L1-R1', 8, 'D4');
  const total = lot.rolls.reduce((t, r) => t + r.length, 0);
  assert.strictEqual(total, 20);
});

test('G repeat dispute on the same label does NOT compound - second restore lands on the Available row, Consumed original untouched', () => {
  // Roll consumed to 0, first dispute restores 5m -> new Returned row.
  const lot = { rolls: [{ label: 'L2-R1', length: 0, status: 'Consumed' }] };
  restoreToRoll(lot, 'L2-R1', 5, 'D5a');
  assert.strictEqual(lot.rolls.length, 2);
  // Second, later dispute restores another 3m on the SAME label.
  restoreToRoll(lot, 'L2-R1', 3, 'D5b');
  assert.strictEqual(lot.rolls.length, 2, 'must not spawn a second Returned row');
  assert.strictEqual(lot.rolls[0].length, 0, 'Consumed original still untouched');
  assert.strictEqual(lot.rolls[0].status, 'Consumed');
  assert.strictEqual(lot.rolls[1].length, 8, '5 + 3, on the one Available row');
  const total = lot.rolls.reduce((t, r) => t + r.length, 0);
  assert.strictEqual(total, 8, 'no invented metres across the two disputes');
});

test('H restoring to a BLOCKED roll adds the metres but does not lift the quarantine', () => {
  const lot = { rolls: [{ label: 'L3-R1', length: 4, status: 'Blocked' }] };
  restoreToRoll(lot, 'L3-R1', 6, 'D6');
  assert.strictEqual(lot.rolls.length, 1, 'no new row - Blocked is revivable in place');
  assert.strictEqual(lot.rolls[0].length, 10, '4 + 6');
  assert.strictEqual(lot.rolls[0].status, 'Blocked', 'quarantine must survive the restore');
});

test('I restoring to a bare/empty-status roll promotes it to Available (allocator only cuts Available)', () => {
  const lot = { rolls: [{ label: 'L4-R1', length: 2, status: '' }] };
  restoreToRoll(lot, 'L4-R1', 3, 'D7');
  assert.strictEqual(lot.rolls[0].length, 5);
  assert.strictEqual(lot.rolls[0].status, 'Available');
});

test('J label match is case-insensitive - a case-drifted label still lands in place, no spurious twin', () => {
  const lot = { rolls: [{ label: 'l3-r1', length: 4, status: 'Available' }] };
  restoreToRoll(lot, 'L3-R1', 6, 'D8');
  assert.strictEqual(lot.rolls.length, 1, 'must not spawn a twin over case difference');
  assert.strictEqual(lot.rolls[0].length, 10);
});

console.log('\n' + '='.repeat(40));
console.log('resolve-dispute-roll-port: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
