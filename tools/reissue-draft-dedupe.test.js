#!/usr/bin/env node
// ---- ONE LOST-PIECE EVENT MUST PUT EXACTLY ONE CARD ON THE REISSUE TAB ----
//
// THE BUG THIS PINS. A stage closes short, so saveProductionPhase calls
// coverProductionLoss, which opens a Production_Loss batch sitting at
// Awaiting_Material. The widget then offers the damage dialog, and
// saveMaterialDamage writes a Material_Damage row whose Plan_Item is the ROOT
// item and whose Remake_Item is that BATCH.
//
// getReissueDrafts then drew the same event twice:
//
//   the damage card,  keyed planItemId = Material_Damage.Plan_Item = the ROOT
//   the remake card,  keyed planItemId = Plan_Item.ID          = the BATCH
//
// Different ids, so nothing downstream could tell they were one thing. The
// supervisor saw the same remake twice — one carrying the ship-short action
// (the Production_Loss card), one an ordinary reissue (the damage card).
//
// Raising BOTH would ask the store for the ruined material AND the whole BOM
// for one loss, which is the exact double-ask CLAUDE.md's Production_Loss guard
// exists to prevent — that guard just could not see this, because it tests
// Material_Requirement rows, which do not exist until a button is pressed.
//
// THE FIX, PINNED HERE:
//   1. the damage card keys on the resolved target — Remake_Item when present,
//      Plan_Item otherwise — which is exactly what raiseReissueRequest already
//      writes against (raiseReissueRequest.dg, "targetItem")
//   2. the derived Production_Loss card is suppressed for a batch an open
//      damage report already points at
//   3. the shortfall banner and the ship-short action MOVE onto the surviving
//      card rather than vanishing with the suppressed one — a production loss
//      he cannot see is the silent under-shipment the whole mechanism exists
//      to stop
//   4. the badge counts what the tab shows, and the button refuses the second
//      ask — the three sites CLAUDE.md requires to apply the same pair of tests
//
// Ported from the Deluge rather than executed: Deluge cannot run here. What is
// ported is the card-eligibility and counting logic of getReissueDrafts,
// getSupervisorCounts and raiseReissueRequest — the part the bug lived in.

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name + (detail ? '  — ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + '  — ' + detail); }
}

// ---- getReissueDrafts, ported ----
//
// db: { damage: [...], planItems: [...], requirements: [...] }
// A damage row: { id, supervisor, status, planItem, remakeItem, lines:[{status}] }
// A batch row:  { id, plan, status, reason, bom, remakeOf, qtyOrdered }
// A requirement:{ planItem, source }
function getReissueDrafts(db, supId) {
  const cards = [];

  // --- pass 1: damage, keyed on the item the material is actually for ---
  const damageCoversBatch = new Set();
  const byItem = new Map();

  for (const dmg of db.damage) {
    if (dmg.supervisor !== supId || dmg.status !== 'Open') continue;

    let itemKey = dmg.planItem == null ? '' : String(dmg.planItem);
    if (dmg.remakeItem != null) {
      itemKey = String(dmg.remakeItem);
      damageCoversBatch.add(itemKey);
    }
    if (itemKey === '') continue;

    const pending = (dmg.lines || []).filter((l) => l.status === 'Pending').length;
    byItem.set(itemKey, (byItem.get(itemKey) || 0) + pending);
  }

  // --- pass 2: the derived batches ---
  for (const rb of db.planItems) {
    if (rb.status !== 'Awaiting_Material') continue;
    if (rb.reason !== 'Check_Reject' && rb.reason !== 'Production_Loss') continue;
    if (db.planSup[rb.plan] !== supId) continue;
    if (!rb.bom) continue;

    let alreadyAsked = false;
    let mergedBatch = false;

    if (rb.reason === 'Production_Loss') {
      // ANY requirement, any Source — never a Source list.
      if (db.requirements.some((r) => String(r.planItem) === String(rb.id))) {
        alreadyAsked = true;
      }
      // AND an open damage report already standing for this batch.
      if (damageCoversBatch.has(String(rb.id))) {
        alreadyAsked = true;
        mergedBatch = true;
      }
    } else if (db.requirements.some(
      (r) => String(r.planItem) === String(rb.id) && r.source === 'Check_Remake')) {
      alreadyAsked = true;
    }

    if (!alreadyAsked) {
      cards.push({ kind: 'remake', planItemId: String(rb.id), remakeReason: rb.reason });
    } else if (mergedBatch && rb.reason === 'Production_Loss') {
      // The warning moves onto the damage card that absorbed it.
      const k = String(rb.id);
      if (byItem.has(k)) byItem.set(k + ':loss', true);
    }
  }

  for (const [k, v] of byItem) {
    if (k.endsWith(':loss')) continue;
    if (!v) continue;
    cards.push({
      kind: 'damage',
      planItemId: k,
      remakeReason: byItem.has(k + ':loss') ? 'Production_Loss' : ''
    });
  }
  return cards;
}

// ---- getSupervisorCounts, ported ----
function getSupervisorCounts(db, supId) {
  let reissueWaiting = db.damage.filter(
    (d) => d.supervisor === supId && d.status === 'Open').length;

  const cntDmgBatch = new Set();
  for (const d of db.damage) {
    if (d.supervisor === supId && d.status === 'Open' && d.remakeItem != null) {
      cntDmgBatch.add(String(d.remakeItem));
    }
  }

  for (const drb of db.planItems) {
    if (drb.status !== 'Awaiting_Material') continue;
    if (drb.reason !== 'Check_Reject' && drb.reason !== 'Production_Loss') continue;
    if (db.planSup[drb.plan] !== supId) continue;
    if (!drb.bom) continue;

    let unasked = false;
    if (drb.reason === 'Production_Loss') {
      if (!db.requirements.some((r) => String(r.planItem) === String(drb.id))) unasked = true;
      if (cntDmgBatch.has(String(drb.id))) unasked = false;
    } else if (!db.requirements.some(
      (r) => String(r.planItem) === String(drb.id) && r.source === 'Check_Remake')) {
      unasked = true;
    }
    if (unasked) reissueWaiting++;
  }
  return reissueWaiting;
}

// ---- raiseReissueRequest, the remake path's guard, ported ----
function raiseRemake(db, itemId) {
  const batch = db.planItems.find((p) => String(p.id) === String(itemId));
  if (!batch) return { success: false, error: 'no such item' };
  if (batch.reason !== 'Check_Reject' && batch.reason !== 'Production_Loss') {
    return { success: false, error: 'not a remake batch' };
  }

  if (batch.reason === 'Production_Loss') {
    if (db.requirements.some((r) => String(r.planItem) === String(itemId))) {
      return { success: false, error: 'already asked' };
    }
    if (db.damage.some((d) => String(d.remakeItem) === String(itemId) && d.status === 'Open')) {
      return { success: false, error: 'merged into damage' };
    }
  } else if (db.requirements.some(
    (r) => String(r.planItem) === String(itemId) && r.source === 'Check_Remake')) {
    return { success: false, error: 'already asked' };
  }
  return { success: true };
}

// ---- THE SCENARIO: one stage closed short, one damage report ----
//
// Root item 100 on plan 7. Stitching lost 2 of 20, so coverProductionLoss
// opened batch 200 for those 2. The supervisor then reported the ruined cloth,
// and saveMaterialDamage stamped Remake_Item = 200 on it.
function lossScenario() {
  return {
    planSup: { 7: 5 },
    damage: [
      { id: 900, supervisor: 5, status: 'Open', planItem: 100, remakeItem: 200,
        lines: [{ status: 'Pending' }] }
    ],
    planItems: [
      { id: 100, plan: 7, status: 'In_Production', reason: '', bom: 1, qtyOrdered: 20 },
      { id: 200, plan: 7, status: 'Awaiting_Material', reason: 'Production_Loss',
        bom: 1, remakeOf: 100, qtyOrdered: 2 }
    ],
    requirements: []
  };
}

console.log('\nONE LOSS EVENT, ONE CARD');
{
  const db = lossScenario();
  const cards = getReissueDrafts(db, 5);

  ok('exactly one card for one event', cards.length === 1,
    'got ' + cards.length + ' -> ' + JSON.stringify(cards));

  ok('the surviving card is keyed on the BATCH, not the root',
    cards[0] && cards[0].planItemId === '200',
    'planItemId=' + (cards[0] || {}).planItemId);

  // The whole point of keying on the batch: raiseReissueRequest already writes
  // its rows against Remake_Item, so the card and the write now name one item.
  ok('the card names the same item raiseReissueRequest writes against',
    cards[0] && cards[0].planItemId === String(db.damage[0].remakeItem));

  ok('the shortfall banner survives the merge',
    cards[0] && cards[0].remakeReason === 'Production_Loss',
    'remakeReason=' + (cards[0] || {}).remakeReason);
}

console.log('\nTHE BADGE AGREES WITH THE TAB');
{
  const db = lossScenario();
  const cards = getReissueDrafts(db, 5);
  const badge = getSupervisorCounts(db, 5);
  ok('badge equals card count', badge === cards.length,
    'badge=' + badge + ' cards=' + cards.length);
}

console.log('\nTHE STORE IS NEVER ASKED TWICE FOR ONE LOSS');
{
  const db = lossScenario();
  const r = raiseRemake(db, 200);
  ok('the remake path refuses a batch a damage report covers',
    r.success === false && r.error === 'merged into damage',
    JSON.stringify(r));
}

// ---- A LOSS WITH NO DAMAGE REPORT IS UNTOUCHED ----
//
// Nothing about this fix may narrow the ordinary case: a stage that lost pieces
// with no material ruined still gets its own card, its banner and its button.
console.log('\nA LOSS WITH NO DAMAGE REPORT STILL GETS ITS CARD');
{
  const db = lossScenario();
  db.damage = [];
  const cards = getReissueDrafts(db, 5);

  ok('one card', cards.length === 1, 'got ' + cards.length);
  ok('it is the derived remake card', cards[0].kind === 'remake');
  ok('it carries the loss reason', cards[0].remakeReason === 'Production_Loss');
  ok('badge agrees', getSupervisorCounts(db, 5) === 1);
  ok('and it can be raised', raiseRemake(db, 200).success === true);
}

// ---- THE PRODUCTION_LOSS GUARD IS STILL "ANY SOURCE" ----
//
// CLAUDE.md is explicit: a loss batch tests for ANY Material_Requirement row,
// never a Source list, because a damage report writes rows of Source "Reissue"
// against it. Narrowing that back to "Production_Remake" would offer the full
// BOM on top of them.
console.log('\nTHE LOSS GUARD STAYS ANY-SOURCE');
{
  const db = lossScenario();
  db.damage = [];
  db.requirements = [{ planItem: 200, source: 'Reissue' }];

  const cards = getReissueDrafts(db, 5);
  ok('a Reissue row against the batch suppresses the card', cards.length === 0,
    JSON.stringify(cards));
  ok('badge agrees', getSupervisorCounts(db, 5) === 0);
  ok('and the button refuses', raiseRemake(db, 200).success === false);
}

// ---- A CHECK REJECTION IS UNAFFECTED ----
//
// Its guard is the NARROW one — Source == "Check_Remake" — and it must stay
// narrow: a Reissue row against a rejected batch must NOT hide its BOM.
console.log('\nA CHECK REJECTION KEEPS THE NARROW GUARD');
{
  const db = lossScenario();
  db.damage = [];
  db.planItems[1].reason = 'Check_Reject';
  db.requirements = [{ planItem: 200, source: 'Reissue' }];

  const cards = getReissueDrafts(db, 5);
  ok('a Reissue row does NOT hide a rejected batch', cards.length === 1,
    JSON.stringify(cards));
  ok('it can still be raised', raiseRemake(db, 200).success === true);

  db.requirements = [{ planItem: 200, source: 'Check_Remake' }];
  ok('a Check_Remake row does hide it', getReissueDrafts(db, 5).length === 0);
  ok('and the button refuses', raiseRemake(db, 200).success === false);
}

// ---- A DAMAGE REPORT WITH NO BATCH STILL KEYS ON THE ITEM ----
//
// A torn label ruins no garment, so no stage closed short and no batch exists.
// That report must still appear, keyed on the item it was reported against.
console.log('\nDAMAGE WITH NO BATCH IS KEYED ON THE ITEM');
{
  const db = lossScenario();
  db.damage = [{ id: 901, supervisor: 5, status: 'Open', planItem: 100,
    remakeItem: null, lines: [{ status: 'Pending' }] }];
  db.planItems = [db.planItems[0]];

  const cards = getReissueDrafts(db, 5);
  ok('one damage card', cards.length === 1 && cards[0].kind === 'damage');
  ok('keyed on the reported item', cards[0].planItemId === '100');
  ok('with no shortfall banner', cards[0].remakeReason === '');
}

// ---- TWO REPORTS ON ONE BATCH STILL MAKE ONE CARD ----
//
// He ruined cloth at Cutting on Monday and more at Stitching on Wednesday, both
// against the same loss batch. Grouping is per item, so that is one card.
console.log('\nTWO REPORTS ON ONE BATCH MAKE ONE CARD');
{
  const db = lossScenario();
  db.damage.push({ id: 902, supervisor: 5, status: 'Open', planItem: 100,
    remakeItem: 200, lines: [{ status: 'Pending' }] });

  const cards = getReissueDrafts(db, 5);
  ok('still one card', cards.length === 1, 'got ' + cards.length);
  ok('keyed on the batch', cards[0].planItemId === '200');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail === 0 ? 0 : 1);
