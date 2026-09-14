#!/usr/bin/env node
// Printed fabric "cut at issue" (Option B) - RETIRED, this suite now only
// guards that it stays retired.
//
// History: this suite once tested one chain end to end:
//
//   allocator mini-roll maths  ->  payload pieces[] with cutLengthCm
//   ->  store UI "Cut 18 m from 20 m piece"
//   ->  issueMaterials.dg token pipeline  ->  Fabric_Piece decrement
//
// Printing v2 (docs/printing-v2-plan.md) replaced Fabric_Piece with ordinary
// short Lot_Rolls, so printed cloth is just ordinary roll stock to the
// allocator now - no mini-roll branch, no cut-at-issue token pipeline.
//
//   WIDGET SIDE - retired first. lot.pieces[] is always empty, the allocator
//     has no mini-roll branch left (lotIsPieces / lotPieces / lotGreigePieces
//     deleted), lotLines[].pieces is hard-coded []. Parts A (allocator), B
//     (the UI instruction text) and E (end-to-end) were deleted then -
//     tools/roll-display.test.js covers what the row says now.
//
//   SERVER SIDE - retired here. issueMaterialsApply.dg's isPieces/pieces[]
//     branch (Fabric_Piece decrement + remainder insert) was dead code -
//     unreachable from any live caller once the widget stopped sending it -
//     and has now been removed. Parts C and D, which ported that branch's
//     logic, tested a chain that no longer exists and are deleted with it -
//     a test of a removed branch proves nothing about the branch that stays.
//
//   issueMaterials.dg (the retired single-function sibling, kept only as a
//     frozen reference - see CLAUDE.md - and never re-deployed) still carries
//     the old Fabric_Piece writer. That is expected and does not need fixing;
//     the guard below checks the LIVE file only.
//
//   usage: node tools/print-cut.test.js

'use strict';
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

const allocSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'lot-allocator.js'), 'utf8');
const applySrc = fs.readFileSync(path.join(__dirname, '..', 'deluge', 'issueMaterialsApply.dg'), 'utf8');

test('PC-RETIRED: the widget never emits cut pieces, and the live server no longer parses them', () => {
  // Widget side: the allocator hard-codes an empty pieces[] on every lot line.
  assert(/pieces:\s*\[\]/.test(allocSrc),
    'lot-allocator no longer hard-codes lotLines[].pieces = [] - if the mini-roll ' +
    'path is back, restore Parts A/B/E from git history rather than rewriting them');
  // Matched as a DEFINITION, not a mention: lot-allocator.js carries a "RETIRED:
  // lotIsPieces / lotPieces / lotGreigePieces" comment recording why they went,
  // and a bare name match reads its own documentation as the code coming back.
  assert(!/function\s+(lotIsPieces|lotGreigePieces)\s*\(/.test(allocSrc),
    'the retired mini-roll helpers are back in lot-allocator.js');

  // Server side: issueMaterialsApply.dg (the LIVE fan-out function) must carry
  // no trace of the Fabric_Piece cut-at-issue writer any more, OUTSIDE A
  // COMMENT - the file deliberately keeps a historical note mentioning both
  // names, so strip `//` lines before checking rather than a bare .includes().
  const applyCode = applySrc.replace(/\/\/.*$/gm, '');
  assert(!applyCode.includes('cutLengthCm'),
    'issueMaterialsApply.dg parses cutLengthCm again - the Fabric_Piece writer is back; ' +
    'restore Parts C/D from git history to test it, or remove it again');
  assert(!applyCode.includes('Fabric_Piece'),
    'issueMaterialsApply.dg references Fabric_Piece again outside a comment');
  assert(!/\bisPieces\b/.test(applyCode),
    'issueMaterialsApply.dg reads an isPieces flag again outside a comment');
});

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log('\n========================================');
console.log('print-cut: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
