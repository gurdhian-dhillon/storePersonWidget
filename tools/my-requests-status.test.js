#!/usr/bin/env node
// Node port of the "My requests" PO-resolved status fix in getStoreRequests.dg.
//
// BUG (confirmed live): a Shortage ticket's own Required_Qty is the SHORTFALL
// THAT WAS ORDERED (raiseBulkPurchaseOrder's own comment: "not a
// re-derivation of total demand"), but the reader compared on-hand stock
// against THAT number to decide whether to show the ticket as "Resolved" on
// the My requests tab. Deleting the PO, re-raising it, and reloading still
// showed the ticket as Resolved — with the record's real Status column in
// Creator reading Open and nothing ever received — because on-hand stock
// (e.g. 3,000 m) trivially exceeded the small shortfall just ordered
// (e.g. 743.77 m), even though total demand (e.g. 3,729.54 m) was nowhere
// near covered.
//
// FIX: same as po-coverage.test.js's fix to getStoreMaterialRequirements.dg —
// compare on-hand stock against the material's WHOLE remaining demand
// (Σ required - issued across every open Material_Requirement row), not the
// ticket's own Required_Qty.
//
//   usage: node tools/my-requests-status.test.js

function myRequestsShowsResolved(ticket, onHand, totalNeed) {
  // ticket: { poNumber, status } — status is Creator's real Status column
  if (ticket.status !== 'Open' && ticket.status !== 'Pending') return false;
  if (!ticket.poNumber) return false;
  return (totalNeed <= 0 || onHand >= totalNeed);
}

const assert = require('assert');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

test('A the exact bug scenario: need 3,729.54, have 3,000, PO raised for the 743.77 shortfall -> must NOT show Resolved', () => {
  const resolved = myRequestsShowsResolved({ poNumber: 'PO-38', status: 'Open' }, 3000, 3729.54);
  assert.strictEqual(resolved, false, 'total demand (3,729.54) still exceeds on-hand (3,000) -> ticket must still read as open/outstanding');
});

test('B OLD BUGGY BEHAVIOUR reproduced for contrast: comparing against Required_Qty=743.77 (the shortfall) instead of total demand', () => {
  function oldBuggyResolved(ticket, onHand, requiredQtyOnTicket) {
    if (ticket.status !== 'Open' && ticket.status !== 'Pending') return false;
    if (!ticket.poNumber) return false;
    return (requiredQtyOnTicket <= 0 || onHand >= requiredQtyOnTicket);
  }
  const buggy = oldBuggyResolved({ poNumber: 'PO-38', status: 'Open' }, 3000, 743.77);
  assert.strictEqual(buggy, true, 'the bug: on-hand (3,000) trivially exceeds the shortfall alone (743.77), so the tab lied that the ticket resolved');
});

test('C stock genuinely lands (on-hand now covers total demand) -> ticket correctly shows Resolved', () => {
  const resolved = myRequestsShowsResolved({ poNumber: 'PO-38', status: 'Open' }, 3729.54, 3729.54);
  assert.strictEqual(resolved, true);
});

test('D no PO number on the ticket (plain shortage report) -> never shown as Resolved by this check', () => {
  const resolved = myRequestsShowsResolved({ poNumber: '', status: 'Open' }, 5000, 100);
  assert.strictEqual(resolved, false);
});

test('E a ticket whose real Status is already something other than Open/Pending is left alone (e.g. Wash_Needed path, or truly Resolved already)', () => {
  const resolved = myRequestsShowsResolved({ poNumber: 'PO-38', status: 'Resolved' }, 100, 100000);
  assert.strictEqual(resolved, false, 'this check only ever promotes Open/Pending — it never re-derives a status that is something else');
});

test('F totalNeed of 0 (nothing currently outstanding) -> ticket is stale and safe to show Resolved', () => {
  const resolved = myRequestsShowsResolved({ poNumber: 'PO-38', status: 'Open' }, 10, 0);
  assert.strictEqual(resolved, true);
});

console.log('\n' + '='.repeat(40));
console.log('my-requests-status: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
