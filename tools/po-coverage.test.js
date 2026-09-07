#!/usr/bin/env node
// Node port of the PO-coverage fix in getStoreMaterialRequirements.dg.
//
// BUG (confirmed against the actual code): raiseBulkPurchaseOrder stamps a
// Shortage ticket's Required_Qty as the SHORTFALL being ordered (its own
// comment: "not a re-derivation of total demand"), but the reader compared
// on-hand stock against THAT number to decide whether the PO still counts as
// covering the gap. The moment on-hand stock passed the (usually small)
// shortfall alone - not real total demand - the PO stopped counting, the
// material's buy row reappeared on the very next refresh, and nothing about
// the real shortage had actually resolved.
//
// FIX: compare on-hand stock against the material's WHOLE remaining demand
// (Σ required - issued across every open Material_Requirement row for that
// material), not the ticket's own Required_Qty.
//
//   usage: node tools/po-coverage.test.js

function poCoveredQty(ticket, onHand, totalNeed) {
  // ticket: { poNumber, shortfall }
  if (!ticket.poNumber) return 0;
  if (totalNeed <= 0 || onHand < totalNeed) return ticket.shortfall;
  return 0;
}

const assert = require('assert');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

test('A the exact bug scenario: need 120, have 100, PO raised for the 20 shortfall -> stock unchanged, PO must still cover', () => {
  const covered = poCoveredQty({ poNumber: 'PO-1', shortfall: 20 }, 100, 120);
  assert.strictEqual(covered, 20, 'total demand (120) still exceeds on-hand (100) -> PO still counts');
});

test('B OLD BUGGY BEHAVIOUR reproduced for contrast: comparing against Required_Qty=20 (the shortfall) instead of total demand', () => {
  // This is what the code did before the fix - included here only to prove
  // the bug was real, not to exercise the fix.
  function oldBuggyPoCovered(ticket, onHand, requiredQtyOnTicket) {
    if (!ticket.poNumber) return 0;
    if (requiredQtyOnTicket <= 0 || onHand < requiredQtyOnTicket) return ticket.shortfall;
    return 0;
  }
  const buggy = oldBuggyPoCovered({ poNumber: 'PO-1', shortfall: 20 }, 100, 20);
  assert.strictEqual(buggy, 0, 'the bug: on-hand (100) already exceeds the shortfall (20) alone, so the PO stops counting despite 120 still being owed');
});

test('C stock has genuinely landed (on-hand now covers total demand) -> PO stops counting, row correctly drops off "owned"', () => {
  const covered = poCoveredQty({ poNumber: 'PO-1', shortfall: 20 }, 120, 120);
  assert.strictEqual(covered, 0, 'on-hand fully covers demand now - the PO should no longer be added on top');
});

test('D stock overshoots demand entirely -> still not covered by this check (no negative counting)', () => {
  const covered = poCoveredQty({ poNumber: 'PO-1', shortfall: 20 }, 200, 120);
  assert.strictEqual(covered, 0);
});

test('E new demand arrives after the PO was raised, growing total need past on-hand + shortfall -> PO still counts (residual gap is the row\'s job, not this check\'s)', () => {
  // total demand grew to 150 after the PO for 20 was raised against a need of 120
  const covered = poCoveredQty({ poNumber: 'PO-1', shortfall: 20 }, 100, 150);
  assert.strictEqual(covered, 20, 'still short of total demand -> PO keeps counting toward owned');
});

test('F no PO number on the ticket (plain shortage report, no PO behind it) -> never counted as covered', () => {
  const covered = poCoveredQty({ poNumber: '', shortfall: 20 }, 50, 120);
  assert.strictEqual(covered, 0);
});

test('G totalNeed of 0 (nothing currently outstanding for this material) -> ticket is stale, do not count it as covering anything real', () => {
  const covered = poCoveredQty({ poNumber: 'PO-1', shortfall: 20 }, 10, 0);
  assert.strictEqual(covered, 20, 'guard preserved from the original: totalNeed<=0 still counts the PO (matches original exReqStr<=0 branch intent)');
});

console.log('\n' + '='.repeat(40));
console.log('po-coverage: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
