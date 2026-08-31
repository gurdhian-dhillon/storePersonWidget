#!/usr/bin/env node
// The three functions that CREATE printed stock, ported to Node and run as a
// lifecycle. Nothing else in tools/ touches them:
//
//   sendToPrint       deluge/sendToPrint.dg        (805 lines)
//   receiveFromPrint  deluge/receiveFromPrint.dg   (750 lines)
//   cancelPrintJob    deluge/cancelPrintJob.dg     (274 lines)
//
// The ports below mirror the .dg files block for block - same guard ORDER, same
// caps, same clamps, same hand-built JSON - so a failure here names a real
// Deluge line. Where a port deliberately reproduces a Deluge quirk (EMPTY is not
// null, a query result needs .count(), integer division truncates) the helper
// is named for it: ifnullStr / dec.
//
// Tests marked GAP-DOC pin down CURRENT behaviour that disagrees with
// docs/printing.md. They pass so the suite stays green while the gap is open and
// they flip the moment the fix lands. The convention is tools/receive-print.test.js:15.
//
//   usage: node tools/print-writers.test.js

'use strict';
const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; failures.push({ name, msg: e.message }); console.log('FAIL  ' + name + '\n      ' + e.message); }
}

// ---- Deluge semantics ---------------------------------------------------------
// A Creator field that was never written is EMPTY, not null. ifnull() does not
// catch empty and .toDecimal() throws on it, so every read in the .dg files is
// "normalise to string, test for '', convert" - which is exactly this.
function ifnullStr(v, dflt) {
  const s = (v === null || v === undefined) ? '' : String(v).trim();
  return s === '' ? dflt : s;
}
function str(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }
function dec(v) { const n = parseFloat(ifnullStr(v, '0')); return isNaN(n) ? 0 : n; }
function isNumberStr(s) { return /^-?\d+(\.\d+)?$/.test(String(s)); }
function r2(n) { return Math.round(n * 100) / 100; }

// ---- the world ----------------------------------------------------------------
// Four forms, held as arrays of plain records keyed by the Creator LINK NAMES so
// a reader can map a field straight back to the .dg. Ids are strings throughout:
// a Deluge lookup holds a record id and .toString() on one gives the id, so every
// comparison in the source is already string-vs-string.
function mkWorld() {
  return { seq: 5000, Raw_Material: [], Raw_Material_Lot: [], Print_Job: [],
           Fabric_Piece: [], Third_Party: [] };
}
function nid(W) { W.seq += 1; return String(W.seq); }
function byId(rows, id) { return rows.filter(r => String(r.ID) === String(id)); }

function addMaterial(W, o) {
  const rec = Object.assign({
    ID: nid(W), Name: '', Design_Name: '', Material_Display_Name: '', SKU: '',
    Is_Fabric: true, Pattern: '', Print_Base: '', Type_field: '', Color: '',
    Unit: 'Mtr', Fabric_Width_Inches: '', Fabric_Gsm: '', Quality: '',
    Quantity: 0, Wash_Quantity: 0, Unwash_Quantity: 0, In_Wash_Qty: 0,
    In_Print_Qty: 0, In_Transit_Qty: 0, Disputed_Qty: 0, Unallocated_Qty: 0,
  }, o || {});
  W.Raw_Material.push(rec);
  return rec;
}
function addLot(W, o) {
  const rec = Object.assign({
    ID: nid(W), Material: '', Lot_Number: '', Lot_Label: '', Form: 'Roll',
    Wash_Quantity: 0, Unwash_Quantity: 0, In_Wash_Qty: 0, In_Print_Qty: 0,
    In_Transit_Qty: 0, Disputed_Qty: 0, Status: 'Active', Source_Lot: '',
    Print_Job: '', Remarks: '',
  }, o || {});
  W.Raw_Material_Lot.push(rec);
  return rec;
}
function addPrinter(W, name) {
  const rec = { ID: nid(W), Party_Name: name };
  W.Third_Party.push(rec);
  return rec;
}

// THE RECONCILIATION IDENTITY, docs/printing.md:79 - with In_Print as the new term.
//   Raw_Material total = SUM over lots of (Unwash + In_Wash + In_Print + Wash + In_Transit + Disputed)
const STATES = ['Unwash_Quantity', 'In_Wash_Qty', 'In_Print_Qty', 'Wash_Quantity',
                'In_Transit_Qty', 'Disputed_Qty'];
function parentTotal(W, matId) {
  const m = byId(W.Raw_Material, matId)[0];
  return r2(STATES.reduce((a, f) => a + dec(m[f]), 0));
}
function lotTotal(W, matId) {
  return r2(W.Raw_Material_Lot
    .filter(l => String(l.Material) === String(matId))
    .reduce((a, l) => a + STATES.reduce((b, f) => b + dec(l[f]), 0), 0));
}
function assertIdentity(W, matId, where) {
  assert.strictEqual(parentTotal(W, matId), lotTotal(W, matId),
    'identity broken ' + where + ': parent ' + parentTotal(W, matId) +
    ' vs lots ' + lotTotal(W, matId));
}
// For a Pieces lot each metres figure is itself SUM(Piece_Length_Cm x Piece_Count)/100.
function pieceMetres(W, lotId) {
  return r2(W.Fabric_Piece
    .filter(p => String(p.Lot) === String(lotId) && p.Piece_Status === 'Available')
    .reduce((a, p) => a + (dec(p.Piece_Length_Cm) * dec(p.Piece_Count)) / 100, 0));
}

// ===============================================================================
// PORT: sendToPrint.dg
// ===============================================================================
function sendToPrint(W, payload) {
  let res = '', errTxt = '';
  try {
    const inp = payload;
    const plainMatId = str(inp.plainMaterialId);
    const plainLotId = str(inp.plainLotId);
    const printedIdIn = str(inp.printedMaterialId);
    const printerId = str(inp.printerId);
    const srcState = str(inp.sourceState);
    const remarks = str(inp.remarks).replace(/"/g, "'");
    // NOT escaped - it has to match the stored Dropdown value character for
    // character or the (Print_Base, Pattern) pair silently resolves to nothing.
    const patternIn = str(inp.pattern);
    const linesRaw = inp.lines || [];                          // a List: .size()

    if (plainMatId === '' || !isNumberStr(plainMatId)) errTxt = 'No plain material given';
    if (errTxt === '' && (plainLotId === '' || !isNumberStr(plainLotId)))
      errTxt = 'No lot given - printed tone depends on the lot that goes out';
    if (errTxt === '' && srcState !== 'Wash' && srcState !== 'Unwash')
      errTxt = 'Source state must be Wash or Unwash';
    if (errTxt === '' && patternIn === '')
      errTxt = "Choose a pattern - it is half of the printed SKU's identity";
    if (errTxt === '' && (printerId === '' || !isNumberStr(printerId)))
      errTxt = 'No printer given';
    if (errTxt === '' && linesRaw.length === 0)
      errTxt = 'Nothing to send - add at least one piece line';

    // ---- the plain material; everything the mint inherits is read here ----
    let plainName = '', plainSku = '', inhName = '', isFab = false, alreadyPrinted = false;
    let inhWidth = '', inhType = '', inhGsm = '', inhQuality = '', inhColor = '', inhUnit = '', inhDesign = '';

    if (errTxt === '') {
      const plainRecs = byId(W.Raw_Material, plainMatId);
      if (plainRecs.length === 0) errTxt = 'Plain material not found';
      else for (const rmChk of plainRecs) {
        plainSku = str(rmChk.SKU).replace(/"/g, "'");
        plainName = str(rmChk.Material_Display_Name).replace(/"/g, "'");
        if (plainName === '') plainName = str(rmChk.Name).replace(/"/g, "'");

        inhName = str(rmChk.Name).replace(/"/g, "'");
        inhDesign = str(rmChk.Design_Name).replace(/"/g, "'");
        if (inhName === '') {
          const cutAt = plainName.indexOf(' / ');
          inhName = cutAt > 0 ? plainName.substring(0, cutAt) : plainName;
        }
        // Tested AS TEXT: a Decision box gives a boolean, a yes/no dropdown the
        // string "Yes", an untouched field EMPTY.
        const fabTxt = str(rmChk.Is_Fabric).toLowerCase();
        isFab = (fabTxt === 'true' || fabTxt === 'yes' || fabTxt === '1' || fabTxt === 'y');
        if (str(rmChk.Print_Base) !== '') alreadyPrinted = true;

        inhWidth = str(rmChk.Fabric_Width_Inches);       // COPIED, never referenced
        inhType = str(rmChk.Type_field);
        inhGsm = str(rmChk.Fabric_Gsm);
        inhQuality = str(rmChk.Quality);
        inhColor = str(rmChk.Color);
        inhUnit = str(rmChk.Unit);
      }
    }

    if (errTxt === '' && isFab !== true)
      errTxt = plainSku + ' is not a fabric - printing applies to fabric only';
    if (errTxt === '' && alreadyPrinted === true)
      errTxt = plainSku + ' is already a printed material - print from the plain cloth it came from';

    if (errTxt === '') {
      if (byId(W.Third_Party, printerId).length === 0) errTxt = 'Printer not found';
    }

    // ---- the plain lot; one lot per job, Active, and belonging to THIS material ----
    let lotWashHave = 0, lotUnwashHave = 0, lotInPrintHave = 0, lotNumOut = '', targetLot = 0;

    if (errTxt === '') {
      const lotRecs = byId(W.Raw_Material_Lot, plainLotId);
      if (lotRecs.length === 0) errTxt = 'Lot not found';
      else for (const lchk of lotRecs) {
        if (str(lchk.Material) !== plainMatId) errTxt = 'That lot belongs to a different material';
        else if (ifnullStr(lchk.Status, 'Active') === 'Blocked')
          errTxt = 'That lot is blocked - nothing can be sent off it';
        else {
          targetLot = lchk.ID;
          lotNumOut = str(lchk.Lot_Number).replace(/"/g, "'");
          lotWashHave = dec(lchk.Wash_Quantity);
          lotUnwashHave = dec(lchk.Unwash_Quantity);
          lotInPrintHave = dec(lchk.In_Print_Qty);
        }
      }
    }
    if (errTxt === '' && targetLot === 0) errTxt = 'Could not resolve a lot to send off';

    // ---- the piece lines: positive length, WHOLE positive count ----
    let totalCm = 0, lineCount = 0, piecesSent = 0;
    if (errTxt === '') {
      for (const lnRaw of linesRaw) {
        if (errTxt !== '') continue;                 // no break in Deluge
        const ln = lnRaw;
        const lStr = ifnullStr(ln.lengthCm, '0');
        const cStr = ifnullStr(ln.count, '0');
        const lnLen = dec(lStr);
        const lnCntDec = dec(cStr);
        const lnCnt = Math.trunc(lnCntDec);           // .toLong() truncates

        if (lnLen <= 0) errTxt = 'Every send line needs a piece length in cm';
        else if (lnCntDec <= 0) errTxt = 'Every send line needs a piece count above zero';
        else if (lnCnt !== lnCntDec) errTxt = 'Piece count must be a whole number - ' + cStr + ' is not';
        else {
          totalCm = totalCm + (lnLen * lnCnt);
          piecesSent = piecesSent + lnCnt;
          lineCount = lineCount + 1;
        }
      }
    }

    let metresSent = 0;
    if (errTxt === '') {
      metresSent = totalCm / 100;
      if (metresSent <= 0) errTxt = 'Nothing to send - the lines add up to zero';
    }

    // ---- the budget: REJECT, never silently trim ----
    if (errTxt === '') {
      let stateHave = lotUnwashHave;
      if (srcState === 'Wash') stateHave = lotWashHave;
      if (metresSent > stateHave)
        errTxt = 'Lot ' + lotNumOut + ' has only ' + stateHave + ' Mtr ' + srcState +
                 ' - ' + metresSent + ' Mtr asked for';
    }

    // ---- resolve the printed SKU by the PAIR, or mint it ----
    let printedId = 0, printedSku = '', printedName = '', minted = false;

    if (errTxt === '') {
      // Deluge compares the Dropdown value exactly - no case folding here.
      const pairRecs = W.Raw_Material.filter(r =>
        String(r.Print_Base) === plainMatId && String(r.Pattern) === patternIn);
      if (pairRecs.length > 1) {
        errTxt = 'There is already more than one printed material for ' + plainSku + ' / ' +
                 patternIn + ' - fix the duplicates before printing';
      } else for (const rmPair of pairRecs) {
        printedId = rmPair.ID;
        printedSku = str(rmPair.SKU).replace(/"/g, "'");
        printedName = str(rmPair.Material_Display_Name).replace(/"/g, "'");
        if (printedName === '') printedName = str(rmPair.Name).replace(/"/g, "'");
      }
    }

    if (errTxt === '' && printedIdIn !== '') {
      if (printedId === 0)
        errTxt = 'No printed material exists for ' + plainSku + ' / ' + patternIn + ' - reload the screen';
      else if (printedIdIn !== String(printedId))
        errTxt = 'The printed material sent does not match ' + plainSku + ' / ' + patternIn + ' - reload the screen';
    }

    if (errTxt === '' && printedId === 0) {
      errTxt = 'Creating new printed SKUs is disabled - choose an existing one';
      /*
      // THE CODE: next free RM- number, zero-padded to the width already in use;
      // a code that does not match the prefix pattern is SKIPPED, never guessed at.
      let maxSeq = 0, padLen = 5;
      for (const rmScan of W.Raw_Material) {
        const skuTxt = str(rmScan.SKU).toUpperCase();
        if (skuTxt.length > 3 && skuTxt.substring(0, 3) === 'RM-') {
          const digTxt = skuTxt.substring(3);
          if (/^\d+$/.test(digTxt)) {
            if (digTxt.length > padLen) padLen = digTxt.length;
            const seqNum = parseInt(digTxt, 10);
            if (seqNum > maxSeq) maxSeq = seqNum;
          }
        }
      }
      if (padLen > 10) padLen = 10;
      const zeroPad = '0000000000';
      let seqTxt = String(maxSeq + 1);
      if (seqTxt.length < padLen) seqTxt = zeroPad.substring(0, padLen - seqTxt.length) + seqTxt;
      const wantSku = 'RM-' + seqTxt;

      // Re-checked against the FORM: the scan and the insert are not atomic.
      if (W.Raw_Material.filter(r => String(r.SKU) === wantSku).length > 0) {
        errTxt = 'SKU ' + wantSku + ' was taken while this was being prepared - press Send again';
      } else {
        // Appended part by part - a material missing one composes cleanly
        // instead of leaving a dangling separator.
        let wantName = inhName;
        if (inhDesign !== '') wantName = wantName + ' / ' + inhDesign;
        if (inhColor !== '') wantName = wantName + ' / ' + inhColor;
        if (patternIn !== '') wantName = wantName + ' / ' + patternIn;

        const rec = addMaterial(W, {
          Name: inhName, Design_Name: inhDesign, Material_Display_Name: wantName,
          SKU: wantSku, Is_Fabric: true, Pattern: patternIn, Type_field: inhType,
          Color: inhColor, Unit: inhUnit, Fabric_Width_Inches: inhWidth,
          Fabric_Gsm: inhGsm, Quality: inhQuality,
          Quantity: 0, Wash_Quantity: 0, Unwash_Quantity: 0, In_Wash_Qty: 0,
          In_Print_Qty: 0, Unallocated_Qty: 0,
        });
        printedId = rec.ID;
        printedSku = wantSku;
        printedName = wantName.replace(/"/g, "'");
        minted = true;
        // The lookup is set AFTER the insert.
        for (const rmNew of byId(W.Raw_Material, printedId)) rmNew.Print_Base = plainMatId;
      }
      */
    }

    if (errTxt === '' && printedId === 0) errTxt = 'Could not resolve a printed material to print into';

    // ---- move the ledger FIRST, write the job second ----
    let lotWashOut = 0, lotUnwashOut = 0, lotInPrintOut = 0, matInPrintOut = 0;

    if (errTxt === '') {
      for (const lotUpd of byId(W.Raw_Material_Lot, targetLot)) {
        lotWashOut = lotWashHave;
        lotUnwashOut = lotUnwashHave;
        lotInPrintOut = lotInPrintHave + metresSent;
        if (srcState === 'Wash') { lotWashOut = lotWashHave - metresSent; lotUpd.Wash_Quantity = lotWashOut; }
        else { lotUnwashOut = lotUnwashHave - metresSent; lotUpd.Unwash_Quantity = lotUnwashOut; }
        lotUpd.In_Print_Qty = lotInPrintOut;
      }
      // THE PARENT MIRRORS BOTH MOVES, so the SKU total is unchanged.
      for (const rmUpd of byId(W.Raw_Material, plainMatId)) {
        matInPrintOut = dec(rmUpd.In_Print_Qty) + metresSent;
        if (srcState === 'Wash') rmUpd.Wash_Quantity = dec(rmUpd.Wash_Quantity) - metresSent;
        else rmUpd.Unwash_Quantity = dec(rmUpd.Unwash_Quantity) - metresSent;
        rmUpd.In_Print_Qty = matInPrintOut;
      }
    }

    // ---- the job ----
    let jobId = 0;
    if (errTxt === '') {
      const job = {
        ID: nid(W), Source_State: srcState, Metres_Sent: metresSent, Metres_Returned: 0,
        Sent_On: '2026-08-25', Job_Status: 'At_Printer', Remarks: remarks,
        Plain_Material: '', Plain_Lot: '', Printed_Material: '', Printed_Lot: '',
        Printer: '', Send_Lines: [], Receive_Lines: [], Returned_On: '',
      };
      W.Print_Job.push(job);
      jobId = job.ID;

      for (const pjUpd of byId(W.Print_Job, jobId)) {
        pjUpd.Plain_Material = plainMatId;
        pjUpd.Plain_Lot = targetLot;
        pjUpd.Printed_Material = printedId;
        pjUpd.Printer = printerId;
        const sendRows = [];
        for (const sndRaw of linesRaw) {
          const sLen = dec(ifnullStr(sndRaw.lengthCm, '0'));
          const sCnt = Math.trunc(dec(ifnullStr(sndRaw.count, '0')));
          // Re-tested rather than trusted - this is a second walk over the raw list.
          if (sLen > 0 && sCnt > 0) sendRows.push({ Piece_Length_Cm: sLen, Piece_Count: sCnt });
        }
        pjUpd.Send_Lines = pjUpd.Send_Lines.concat(sendRows);
      }
    }
    if (errTxt === '' && jobId === 0) errTxt = 'The print job could not be created';

    if (errTxt === '') {
      const mintedTxt = minted === true ? 'true' : 'false';
      res = '{"success":true,"jobId":"' + jobId + '","printedMaterialId":"' + printedId +
            '","printedSku":"' + printedSku + '","printedName":"' + printedName +
            '","minted":' + mintedTxt + ',"metresSent":' + metresSent +
            ',"lotWash":' + lotWashOut + ',"lotUnwash":' + lotUnwashOut +
            ',"lotInPrint":' + lotInPrintOut + ',"materialInPrint":' + matInPrintOut + '}';
    }
  } catch (e) {
    errTxt = 'DELUGE: ' + e.message;
  }
  if (res === '') {
    if (errTxt === '') errTxt = 'Nothing was sent';
    res = '{"success":false,"error":"' + errTxt.replace(/"/g, "'") + '"}';
  }
  return JSON.parse(res);          // the hand-built JSON must actually parse
}

// ===============================================================================
// PORT: receiveFromPrint.dg
// ===============================================================================
function receiveFromPrint(W, payload) {
  let res = '', errTxt = '';
  try {
    const inp = payload;
    const jobIdTxt = str(inp.jobId);
    const lotIdTxt = str(inp.lotId);
    const lotNumIn = str(inp.lotNumber).replace(/"/g, "'");
    const lotLabel = str(inp.lotLabel).replace(/"/g, "'");
    const remarks = str(inp.remarks).replace(/"/g, "'");
    const linesRaw = inp.lines || [];

    if (jobIdTxt === '' || !isNumberStr(jobIdTxt)) errTxt = 'No print job given';
    if (errTxt === '' && linesRaw.length === 0) errTxt = 'Nothing to receive - no lines given';

    let plainMatTxt = '', plainLotTxt = '', printedMatTxt = '', metresSent = 0;
    const sentLenList = [], sentCntList = [];
    let piecesSent = 0;
    const takenIdx = [];               // List has no set(); append keys, test .contains()

    if (errTxt === '') {
      const jobRecs = byId(W.Print_Job, jobIdTxt);
      if (jobRecs.length === 0) errTxt = 'Print job not found';
      else for (const jchk of jobRecs) {
        const jStat = str(jchk.Job_Status);
        if (jStat !== 'At_Printer')
          errTxt = 'That job is ' + jStat + ' - only a job still at the printer can be received';
        else {
          plainMatTxt = str(jchk.Plain_Material);
          plainLotTxt = str(jchk.Plain_Lot);
          printedMatTxt = str(jchk.Printed_Material);
          metresSent = dec(jchk.Metres_Sent);
          for (const slChk of jchk.Send_Lines) {
            sentLenList.push(dec(slChk.Piece_Length_Cm));
            sentCntList.push(dec(slChk.Piece_Count));
            piecesSent = piecesSent + dec(slChk.Piece_Count);
          }
        }
      }
    }
    if (errTxt === '' && sentLenList.length === 0)
      errTxt = 'That job has no send lines - nothing to check the return against';
    if (errTxt === '' && printedMatTxt === '')
      errTxt = 'That job has no printed material on it - nothing to receive into';

    // ---- the lines, validated in full before anything is written ----
    let metresReturned = 0, washMetres = 0, unwashMetres = 0, pieceRows = 0, piecesReturned = 0;

    if (errTxt === '') {
      for (const lnRaw of linesRaw) {
        if (errTxt !== '') continue;
        const ln = lnRaw;
        const idxS = str(ln.lineIndex);
        const cntS = ifnullStr(ln.count, '0');
        const stTxt = str(ln.state);
        const lenEchoS = str(ln.lengthCm);          // EVIDENCE, never the source
        const cntQty = dec(cntS);
        const cntWhole = Math.trunc(cntQty) * 1.0;

        if (idxS === '' || !isNumberStr(idxS)) {
          errTxt = 'This receipt was sent by an older screen - reload the page and try again';
        } else {
          const lnIdx = parseInt(idxS, 10);
          if (lnIdx < 0 || lnIdx >= sentLenList.length)
            errTxt = 'A returned line does not match anything that was sent - reload the screen';
          else if (takenIdx.indexOf(lnIdx + '') >= 0)
            errTxt = 'The same sent size was returned twice in one receipt - reload the screen';
          else if (cntQty < 0) errTxt = 'A returned piece count cannot be negative';
          else if (cntWhole !== cntQty)
            errTxt = 'Returned piece count must be a whole number - got ' + cntS;
          else if (cntQty > sentCntList[lnIdx])
            errTxt = 'Only ' + sentCntList[lnIdx] + ' pieces of ' + sentLenList[lnIdx] +
                     ' cm went out - ' + cntS + ' cannot come back';
          else if (cntQty > 0 && stTxt !== 'Wash' && stTxt !== 'Unwash')
            errTxt = "Every returned line must say Wash or Unwash - got '" + stTxt + "'";
          else if (lenEchoS !== '' && dec(lenEchoS) !== sentLenList[lnIdx])
            errTxt = "A returned line's length does not match what was sent - reload the screen";
          else {
            takenIdx.push(lnIdx + '');
            // THE SENT LENGTH, not the payload's. 100.0 - integer division truncates.
            const lnMtr = (sentLenList[lnIdx] * cntQty) / 100.0;
            metresReturned = metresReturned + lnMtr;
            piecesReturned = piecesReturned + cntQty;
            if (cntQty > 0) {
              if (stTxt === 'Wash') washMetres = washMetres + lnMtr;
              else unwashMetres = unwashMetres + lnMtr;
              pieceRows = pieceRows + 1;
            }
          }
        }
      }
    }

    if (errTxt === '' && metresReturned <= 0)
      errTxt = 'Nothing came back on any size - if the whole run is lost, say so on the job rather than receiving it';

    // ---- the printed SKU's width, stamped onto the piece ----
    let widthCm = 0;
    if (errTxt === '') {
      const prmRecs = byId(W.Raw_Material, printedMatTxt);
      if (prmRecs.length === 0) errTxt = "The job's printed material no longer exists";
      else for (const prm of prmRecs) {
        const wIn = str(prm.Fabric_Width_Inches);
        if (wIn !== '') widthCm = dec(wIn) * 2.54;
      }
    }

    // ---- which lot ----
    let targetLot = 0, lotNumOut = '';
    if (errTxt === '') {
      if (lotIdTxt !== '') {
        const lotRecs = byId(W.Raw_Material_Lot, lotIdTxt);
        if (lotRecs.length === 0) errTxt = 'Lot not found';
        else for (const lchk of lotRecs) {
          if (str(lchk.Material) !== printedMatTxt) errTxt = 'That lot belongs to a different material';
          else if (ifnullStr(lchk.Status, 'Active') === 'Blocked') errTxt = 'That lot is blocked and cannot take stock';
          else { targetLot = lchk.ID; lotNumOut = String(lchk.Lot_Number).replace(/"/g, "'"); }
        }
      } else if (lotNumIn === '') {
        errTxt = 'Give the new printed lot a number';
      } else {
        // UNIQUE WITHIN THE MATERIAL, compared UPPER-CASED.
        const wantKey = lotNumIn.toUpperCase();
        let clash = false;
        for (const lseq of W.Raw_Material_Lot.filter(l => String(l.Material) === printedMatTxt)) {
          if (str(lseq.Lot_Number).toUpperCase() === wantKey) clash = true;   // no break
        }
        if (clash === true) errTxt = 'Lot ' + lotNumIn + ' already exists for that printed material';
        else {
          lotNumOut = lotNumIn;
          const nl = addLot(W, {
            Material: printedMatTxt, Lot_Number: lotNumOut, Lot_Label: lotLabel,
            Form: 'Pieces', Unwash_Quantity: 0, In_Wash_Qty: 0, Wash_Quantity: 0,
            In_Print_Qty: 0, In_Transit_Qty: 0, Disputed_Qty: 0, Status: 'Active',
            Remarks: remarks,
          });
          targetLot = nl.ID;
          for (const newLot of byId(W.Raw_Material_Lot, targetLot)) {
            newLot.Print_Job = jobIdTxt;
            if (plainLotTxt !== '') newLot.Source_Lot = plainLotTxt;
          }
        }
      }
    }
    if (errTxt === '' && targetLot === 0) errTxt = 'Could not resolve a printed lot to book against';

    // ---- the pieces, one row per line, never merged ----
    if (errTxt === '') {
      for (const pcRaw of linesRaw) {
        const pIdx = parseInt(ifnullStr(pcRaw.lineIndex, '0'), 10);
        const pCntS = ifnullStr(pcRaw.count, '0');
        const pState = str(pcRaw.state);
        const pCarton = str(pcRaw.carton).replace(/"/g, "'");
        if (dec(pCntS) > 0) {
          const piece = {
            ID: nid(W), Material: printedMatTxt, Lot: targetLot,
            Piece_Length_Cm: sentLenList[pIdx], Piece_Width_Cm: widthCm,
            Piece_Count: dec(pCntS), State: pState, Piece_Status: 'Available',
            Print_Job: jobIdTxt, Carton_Number: '',
          };
          W.Fabric_Piece.push(piece);
          if (pCarton !== '') for (const fpUpd of byId(W.Fabric_Piece, piece.ID)) fpUpd.Carton_Number = pCarton;
        }
      }
    }

    // ---- the ledger: the plain side clears In_Print by the FULL amount sent ----
    if (errTxt === '') {
      if (plainLotTxt !== '') for (const plotUpd of byId(W.Raw_Material_Lot, plainLotTxt)) {
        let lipNow = dec(plotUpd.In_Print_Qty) - metresSent;
        if (lipNow < 0) lipNow = 0;                                     // clamped, not refused
        plotUpd.In_Print_Qty = lipNow;
      }
      if (plainMatTxt !== '') for (const pmatUpd of byId(W.Raw_Material, plainMatTxt)) {
        let mipNow = dec(pmatUpd.In_Print_Qty) - metresSent;
        if (mipNow < 0) mipNow = 0;
        pmatUpd.In_Print_Qty = mipNow;
      }
    }

    // ---- the printed side: each state's metres onto its own counter ----
    let lotWashOut = 0, lotUnwashOut = 0;
    if (errTxt === '') {
      for (const plotNew of byId(W.Raw_Material_Lot, targetLot)) {
        lotWashOut = dec(plotNew.Wash_Quantity) + washMetres;
        lotUnwashOut = dec(plotNew.Unwash_Quantity) + unwashMetres;
        plotNew.Wash_Quantity = lotWashOut;
        plotNew.Unwash_Quantity = lotUnwashOut;
      }
      for (const pmatNew of byId(W.Raw_Material, printedMatTxt)) {
        pmatNew.Wash_Quantity = dec(pmatNew.Wash_Quantity) + washMetres;
        pmatNew.Unwash_Quantity = dec(pmatNew.Unwash_Quantity) + unwashMetres;
      }
    }

    // ---- stamp the job, last ----
    let lossQty = 0, piecesLost = 0;
    if (errTxt === '') {
      for (const jUpd of byId(W.Print_Job, jobIdTxt)) {
        const rows = [];
        for (const rlRaw of linesRaw) {
          const rIdx = parseInt(ifnullStr(rlRaw.lineIndex, '0'), 10);
          const rCntS = ifnullStr(rlRaw.count, '0');
          rows.push({ Piece_Length_Cm: sentLenList[rIdx], Piece_Count: dec(rCntS),
                      State: str(rlRaw.state) });
        }
        jUpd.Receive_Lines = jUpd.Receive_Lines.concat(rows);
        jUpd.Metres_Returned = metresReturned;
        jUpd.Returned_On = '2026-08-25';
        jUpd.Printed_Lot = targetLot;
        jUpd.Job_Status = 'Received';
        if (remarks !== '') {
          const oldR = str(jUpd.Remarks);
          let addR = '25-Aug 10:00 - received: ' + remarks;
          if (oldR !== '') addR = oldR + '\n' + addR;
          jUpd.Remarks = addR;
        }
      }
      lossQty = metresSent - metresReturned;
      piecesLost = piecesSent - piecesReturned;

      res = '{"success":true,"printedLotId":"' + targetLot + '","lotNumber":"' + lotNumOut +
            '","metresSent":' + metresSent + ',"metresReturned":' + metresReturned +
            ',"loss":' + lossQty + ',"piecesSent":' + piecesSent +
            ',"piecesReturned":' + piecesReturned + ',"piecesLost":' + piecesLost +
            ',"lotWash":' + lotWashOut + ',"lotUnwash":' + lotUnwashOut +
            ',"pieceRows":' + pieceRows + '}';
    }
  } catch (e) {
    errTxt = 'DELUGE: ' + e.message;
  }
  if (res === '') {
    if (errTxt === '') errTxt = 'Nothing was received';
    res = '{"success":false,"error":"' + errTxt.replace(/"/g, "'") + '"}';
  }
  return JSON.parse(res);
}

// ===============================================================================
// PORT: cancelPrintJob.dg
// ===============================================================================
function cancelPrintJob(W, payload) {
  let res = '', errTxt = '';
  try {
    const jobIdTxt = str(payload.jobId);
    const reason = str(payload.reason).replace(/"/g, "'");

    if (jobIdTxt === '' || !isNumberStr(jobIdTxt)) errTxt = 'No print job given';

    let plainMatTxt = '', plainLotTxt = '', srcState = '', metresSent = 0;

    if (errTxt === '') {
      const jobRecs = byId(W.Print_Job, jobIdTxt);
      if (jobRecs.length === 0) errTxt = 'Print job not found';
      else for (const jchk of jobRecs) {
        const jStat = str(jchk.Job_Status);
        if (jStat !== 'At_Printer')
          errTxt = 'That job is ' + jStat + ' - only a job still at the printer can be cancelled';
        else {
          plainMatTxt = str(jchk.Plain_Material);
          plainLotTxt = str(jchk.Plain_Lot);
          srcState = str(jchk.Source_State);
          metresSent = dec(jchk.Metres_Sent);
        }
      }
    }
    // Source_State refused when blank rather than guessed - neither default is safe.
    if (errTxt === '' && srcState !== 'Wash' && srcState !== 'Unwash')
      errTxt = 'That job does not say which counter the cloth came off - set Source_State on it before cancelling';
    if (errTxt === '' && metresSent <= 0)
      errTxt = 'That job has no metres against it - nothing to put back';

    let lotWashOut = 0, lotInPrintOut = 0;
    if (errTxt === '') {
      if (plainLotTxt !== '') for (const plotUpd of byId(W.Raw_Material_Lot, plainLotTxt)) {
        let lipNow = dec(plotUpd.In_Print_Qty) - metresSent;
        if (lipNow < 0) lipNow = 0;                      // clamped, not refused
        plotUpd.In_Print_Qty = lipNow;
        lotInPrintOut = lipNow;
        if (srcState === 'Wash') {
          lotWashOut = dec(plotUpd.Wash_Quantity) + metresSent;
          plotUpd.Wash_Quantity = lotWashOut;
        } else {
          plotUpd.Unwash_Quantity = dec(plotUpd.Unwash_Quantity) + metresSent;
          lotWashOut = dec(plotUpd.Wash_Quantity);
        }
      }
      if (plainMatTxt !== '') for (const pmatUpd of byId(W.Raw_Material, plainMatTxt)) {
        let mipNow = dec(pmatUpd.In_Print_Qty) - metresSent;
        if (mipNow < 0) mipNow = 0;
        pmatUpd.In_Print_Qty = mipNow;
        if (srcState === 'Wash') pmatUpd.Wash_Quantity = dec(pmatUpd.Wash_Quantity) + metresSent;
        else pmatUpd.Unwash_Quantity = dec(pmatUpd.Unwash_Quantity) + metresSent;
      }
    }

    if (errTxt === '') {
      for (const jUpd of byId(W.Print_Job, jobIdTxt)) {
        jUpd.Job_Status = 'Cancelled';
        let addR = '25-Aug 10:00 - cancelled';
        if (reason !== '') addR = addR + ': ' + reason;
        const oldR = str(jUpd.Remarks);
        if (oldR !== '') addR = oldR + '\n' + addR;
        jUpd.Remarks = addR;
      }
      res = '{"success":true,"restoredTo":"' + srcState + '","metres":' + metresSent +
            ',"lotWash":' + lotWashOut + ',"lotInPrint":' + lotInPrintOut + '}';
    }
  } catch (e) {
    errTxt = 'DELUGE: ' + e.message;
  }
  if (res === '') {
    if (errTxt === '') errTxt = 'Nothing was cancelled';
    res = '{"success":false,"error":"' + errTxt.replace(/"/g, "'") + '"}';
  }
  return JSON.parse(res);
}

// ===============================================================================
// FIXTURE - one plain fabric, one lot, one printer. Deliberately the doc's own
// numbers (docs/printing.md:328): 3 x 300 + 4 x 275 = 20.00 Mtr off 42.60.
// ===============================================================================
function fixture(opts) {
  opts = opts || {};
  const W = mkWorld();
  const plain = addMaterial(W, {
    Name: 'Grey Sheeting', Design_Name: 'Plain', Color: 'Grey',
    Material_Display_Name: 'Grey Sheeting / Plain / Grey',
    SKU: 'RM-00112', Is_Fabric: true, Pattern: opts.plainPattern || 'Plain',
    Type_field: 'Cotton', Fabric_Width_Inches: '60', Fabric_Gsm: '140',
    Quality: 'A', Unit: 'Mtr',
    Wash_Quantity: opts.matWash === undefined ? 42.6 : opts.matWash,
    Unwash_Quantity: opts.matUnwash === undefined ? 8 : opts.matUnwash,
  });
  const lot = addLot(W, {
    Material: plain.ID, Lot_Number: 'L1', Form: opts.lotForm || 'Roll',
    Wash_Quantity: opts.lotWash === undefined ? 42.6 : opts.lotWash,
    Unwash_Quantity: opts.lotUnwash === undefined ? 8 : opts.lotUnwash,
    Status: opts.lotStatus || 'Active',
  });
  const printer = addPrinter(W, 'Ace Printers');
  return { W, plain, lot, printer };
}
const LINES = [{ lengthCm: 300, count: 3 }, { lengthCm: 275, count: 4 }];
function send(f, over) {
  return sendToPrint(f.W, Object.assign({
    plainMaterialId: f.plain.ID, plainLotId: f.lot.ID, sourceState: 'Wash',
    pattern: 'BP Flower', printedMaterialId: '', printerId: f.printer.ID,
    lines: LINES, remarks: '',
  }, over || {}));
}

// ===============================================================================
console.log('\nsendToPrint - the two-step move');
// ===============================================================================

test('S1 the two-step move: Wash_Quantity falls by Metres_Sent and In_Print_Qty rises by the same', () => {
  const f = fixture();
  const out = send(f);
  assert.strictEqual(out.success, true, JSON.stringify(out));
  assert.strictEqual(r2(out.metresSent), 20, 'SUM(len x count)/100 = (900+1100)/100');
  assert.strictEqual(r2(f.lot.Wash_Quantity), 22.6, '42.60 - 20.00');
  assert.strictEqual(r2(f.lot.In_Print_Qty), 20);
  assert.strictEqual(r2(f.lot.Unwash_Quantity), 8, 'the other counter is untouched');
});

test('S2 the parent mirrors BOTH moves, so the SKU total is unchanged at send', () => {
  const f = fixture();
  const before = parentTotal(f.W, f.plain.ID);
  const out = send(f);
  assert.strictEqual(r2(f.plain.Wash_Quantity), 22.6);
  assert.strictEqual(r2(f.plain.In_Print_Qty), 20);
  assert.strictEqual(parentTotal(f.W, f.plain.ID), before, 'the SKU total must not change at send');
  assert.strictEqual(r2(out.materialInPrint), 20);
  assertIdentity(f.W, f.plain.ID, 'after send');
});

test('S3 sourceState Unwash draws the OTHER counter and leaves Wash alone', () => {
  const f = fixture();
  const before = parentTotal(f.W, f.plain.ID);
  const out = send(f, { sourceState: 'Unwash', lines: [{ lengthCm: 200, count: 3 }] });
  assert.strictEqual(out.success, true, JSON.stringify(out));
  assert.strictEqual(r2(f.lot.Unwash_Quantity), 2, '8.00 - 6.00');
  assert.strictEqual(r2(f.lot.Wash_Quantity), 42.6);
  assert.strictEqual(r2(f.lot.In_Print_Qty), 6);
  assert.strictEqual(r2(f.plain.Unwash_Quantity), 2);
  assert.strictEqual(parentTotal(f.W, f.plain.ID), before);
});

test('S4 Metres_Sent is SUM(lengthCm x count)/100 and is NOT integer-divided', () => {
  const f = fixture();
  // 3 x 55 cm = 165 cm. Integer division of 165/100 would truncate to 1.
  const out = send(f, { lines: [{ lengthCm: 55, count: 3 }] });
  assert.strictEqual(r2(out.metresSent), 1.65);
  assert.strictEqual(r2(f.lot.In_Print_Qty), 1.65);
});

test('S5 the budget limit: Metres_Sent cannot exceed the CHOSEN counter of the CHOSEN lot', () => {
  const f = fixture({ lotWash: 15 });
  const out = send(f);                                   // wants 20.00 off 15.00
  assert.strictEqual(out.success, false);
  assert.ok(/has only 15 Mtr Wash/.test(out.error), out.error);
  assert.strictEqual(r2(f.lot.Wash_Quantity), 15, 'REJECT, never silently trim - nothing moved');
  assert.strictEqual(r2(f.lot.In_Print_Qty), 0);
});

test('S6 the budget is the counter, not the material total - plenty of Unwash does not fund a Wash send', () => {
  const f = fixture({ lotWash: 5, lotUnwash: 500, matWash: 5, matUnwash: 500 });
  const out = send(f, { sourceState: 'Wash' });
  assert.strictEqual(out.success, false);
  assert.ok(/only 5 Mtr Wash/.test(out.error), out.error);
});

test('S7 exactly the balance is allowed; one centimetre more is not', () => {
  const f1 = fixture({ lotWash: 20 });
  assert.strictEqual(send(f1).success, true, 'exactly 20.00 off 20.00 must pass');
  const f2 = fixture({ lotWash: 20 });
  const out = send(f2, { lines: [{ lengthCm: 300, count: 3 }, { lengthCm: 276, count: 4 }] });
  assert.strictEqual(out.success, false, '20.04 off 20.00 must fail');
});

test('S8 a FRACTIONAL count is refused and nothing moves', () => {
  const f = fixture();
  const out = send(f, { lines: [{ lengthCm: 300, count: 2.5 }] });
  assert.strictEqual(out.success, false);
  assert.ok(/whole number/.test(out.error), out.error);
  assert.strictEqual(r2(f.lot.Wash_Quantity), 42.6);
  assert.strictEqual(f.W.Print_Job.length, 0, 'no job written');
});

test('S9 a zero or negative length is refused, and so is a zero count', () => {
  const a = fixture();
  assert.ok(/piece length/.test(send(a, { lines: [{ lengthCm: 0, count: 3 }] }).error));
  const b = fixture();
  assert.ok(/piece length/.test(send(b, { lines: [{ lengthCm: -300, count: 3 }] }).error));
  const c = fixture();
  assert.ok(/count above zero/.test(send(c, { lines: [{ lengthCm: 300, count: 0 }] }).error));
  assert.strictEqual(c.W.Print_Job.length, 0);
});

test('S10 one bad line poisons the whole run - a later good line cannot overwrite the complaint', () => {
  const f = fixture();
  const out = send(f, { lines: [{ lengthCm: 0, count: 3 }, { lengthCm: 300, count: 2 }] });
  assert.strictEqual(out.success, false);
  assert.ok(/piece length/.test(out.error), 'the FIRST fault is what comes out: ' + out.error);
  assert.strictEqual(r2(f.lot.In_Print_Qty), 0);
});

test('S11 an empty lines list, and a missing/blocked/foreign lot, are each refused', () => {
  assert.ok(/at least one piece line/.test(send(fixture(), { lines: [] }).error));
  assert.ok(/Lot not found/.test(send(fixture(), { plainLotId: '99999' }).error));
  const blocked = fixture({ lotStatus: 'Blocked' });
  assert.ok(/blocked/.test(send(blocked).error));
  const f = fixture();
  const other = addMaterial(f.W, { SKU: 'RM-00200', Name: 'Other', Is_Fabric: true });
  const foreign = addLot(f.W, { Material: other.ID, Lot_Number: 'X1', Wash_Quantity: 99 });
  assert.ok(/different material/.test(send(f, { plainLotId: foreign.ID }).error));
});

test('S12 GUARD 1 - Print_Base must be a fabric', () => {
  const f = fixture();
  f.plain.Is_Fabric = false;
  const out = send(f);
  assert.strictEqual(out.success, false);
  assert.ok(/is not a fabric/.test(out.error), out.error);
});

test('S12b Is_Fabric is read as TEXT, so the string "Yes" still counts as fabric', () => {
  const f = fixture();
  f.plain.Is_Fabric = 'Yes';
  assert.strictEqual(send(f).success, true, 'a yes/no dropdown must not refuse real fabric');
  const g = fixture();
  g.plain.Is_Fabric = '';                      // never touched
  assert.strictEqual(send(g).success, false, 'an untouched field is EMPTY, not true');
});

test('S13 GUARD 2 - Print_Base must not itself already have a Print_Base', () => {
  const f = fixture();
  const base = addMaterial(f.W, { SKU: 'RM-00001', Name: 'Base', Is_Fabric: true });
  f.plain.Print_Base = base.ID;
  const out = send(f);
  assert.strictEqual(out.success, false);
  assert.ok(/already a printed material/.test(out.error), out.error);
});

test('S14 an unknown printer is refused before anything moves', () => {
  const f = fixture();
  const out = send(f, { printerId: '99999' });
  assert.strictEqual(out.success, false);
  assert.ok(/Printer not found/.test(out.error), out.error);
  assert.strictEqual(r2(f.lot.In_Print_Qty), 0);
});

test('S15 the budget is checked BEFORE the mint - an over-draw must not leave a stray SKU behind', () => {
  const f = fixture({ lotWash: 5 });
  const before = f.W.Raw_Material.length;
  assert.strictEqual(send(f).success, false);
  assert.strictEqual(f.W.Raw_Material.length, before, 'no printed SKU minted by a refused send');
});

// ===============================================================================
console.log('\nsendToPrint - minting the printed SKU');
// ===============================================================================

test('M1 a new (Print_Base, Pattern) pair MINTS, and the pair is what identifies it', () => {
  const f = fixture();
  const out = send(f);
  assert.strictEqual(out.minted, true);
  const minted = f.W.Raw_Material.filter(r => String(r.ID) === String(out.printedMaterialId))[0];
  assert.ok(minted, 'the record exists');
  assert.strictEqual(String(minted.Print_Base), String(f.plain.ID));
  assert.strictEqual(minted.Pattern, 'BP Flower');
  assert.strictEqual(minted.Is_Fabric, true);
});

test('M2 Fabric_Width_Inches is COPIED from the plain SKU - the width invariant', () => {
  const f = fixture();
  const out = send(f);
  const minted = f.W.Raw_Material.filter(r => String(r.ID) === String(out.printedMaterialId))[0];
  assert.strictEqual(minted.Fabric_Width_Inches, '60', 'copied, never referenced');
  f.plain.Fabric_Width_Inches = '44';                   // somebody edits the plain SKU later
  assert.strictEqual(minted.Fabric_Width_Inches, '60',
    'editing the plain SKU must NOT rewrite the cutting maths for printed cloth already on the rack');
});

test('M3 Design_Name is INHERITED, not replaced by the pattern', () => {
  const f = fixture();
  const out = send(f);
  const minted = f.W.Raw_Material.filter(r => String(r.ID) === String(out.printedMaterialId))[0];
  assert.strictEqual(minted.Design_Name, 'Plain',
    'the base cloth is still plain; the print is a FIFTH fact, not a substitute for the third');
  assert.strictEqual(minted.Name, 'Grey Sheeting', 'Name is the name part alone, never the composed string');
});

test('M4 two prints off ONE base compose to DIFFERENT display names (what replacing the design broke)', () => {
  const f = fixture();
  const a = send(f, { pattern: 'BP Flower' });
  const b = send(f, { pattern: 'BP Leaf', lines: [{ lengthCm: 100, count: 1 }] });
  const na = f.W.Raw_Material.filter(r => String(r.ID) === String(a.printedMaterialId))[0].Material_Display_Name;
  const nb = f.W.Raw_Material.filter(r => String(r.ID) === String(b.printedMaterialId))[0].Material_Display_Name;
  assert.strictEqual(na, 'Grey Sheeting / Plain / Grey / BP Flower');
  assert.strictEqual(nb, 'Grey Sheeting / Plain / Grey / BP Leaf');
  assert.notStrictEqual(na, nb, 'the SKUs must be tellable apart on any screen');
});

test('M5 the display name is the plain one plus the print, four parts joined by " / "', () => {
  const f = fixture();
  const out = send(f);
  assert.strictEqual(out.printedName, f.plain.Material_Display_Name + ' / BP Flower');
});

test('M6 a missing part leaves NO dangling separator', () => {
  const f = fixture();
  f.plain.Design_Name = '';                              // no design on file
  const a = send(f, { pattern: 'BP Flower' });
  assert.strictEqual(a.printedName, 'Grey Sheeting / Grey / BP Flower');

  const g = fixture();
  g.plain.Color = '';
  const b = send(g, { pattern: 'BP Leaf' });
  assert.strictEqual(b.printedName, 'Grey Sheeting / Plain / BP Leaf');

  const h = fixture();
  h.plain.Design_Name = ''; h.plain.Color = '';
  const c = send(h, { pattern: 'BP Vine' });
  assert.strictEqual(c.printedName, 'Grey Sheeting / BP Vine');
});

test('M7 Name falls back to the FIRST segment of the display name only when Name was never filled', () => {
  const f = fixture();
  f.plain.Name = '';                                     // display name still composed
  const out = send(f);
  const minted = f.W.Raw_Material.filter(r => String(r.ID) === String(out.printedMaterialId))[0];
  assert.strictEqual(minted.Name, 'Grey Sheeting', 'everything before the first " / "');
  assert.strictEqual(minted.Material_Display_Name, 'Grey Sheeting / Plain / Grey / BP Flower');
});

test('M8 every quantity field on the minted SKU is 0 - stock only arrives through a print receipt', () => {
  const f = fixture();
  const out = send(f);
  const minted = f.W.Raw_Material.filter(r => String(r.ID) === String(out.printedMaterialId))[0];
  ['Quantity', 'Wash_Quantity', 'Unwash_Quantity', 'In_Wash_Qty', 'In_Print_Qty', 'Unallocated_Qty']
    .forEach(fld => assert.strictEqual(dec(minted[fld]), 0, fld + ' must be 0 on a mint'));
  assert.strictEqual(parentTotal(f.W, minted.ID), 0);
});

test('M9 an EXISTING pair is reused and never duplicated', () => {
  const f = fixture();
  const a = send(f);
  assert.strictEqual(a.minted, true);
  const count = f.W.Raw_Material.length;
  const b = send(f, { lines: [{ lengthCm: 100, count: 1 }] });
  assert.strictEqual(b.minted, false, 'second run of the same pair must not mint');
  assert.strictEqual(String(b.printedMaterialId), String(a.printedMaterialId));
  assert.strictEqual(f.W.Raw_Material.length, count, 'no second Raw_Material record');
});

test('M10 a pair that is ALREADY duplicated refuses rather than picking one arbitrarily', () => {
  const f = fixture();
  addMaterial(f.W, { SKU: 'RM-00113', Print_Base: f.plain.ID, Pattern: 'BP Flower', Is_Fabric: true });
  addMaterial(f.W, { SKU: 'RM-00114', Print_Base: f.plain.ID, Pattern: 'BP Flower', Is_Fabric: true });
  const out = send(f);
  assert.strictEqual(out.success, false);
  assert.ok(/more than one printed material/.test(out.error), out.error);
});

test('M11 a stale screen sending a printedMaterialId that is not the pair is refused', () => {
  const f = fixture();
  // The pair DOES resolve - but the screen is holding the SKU of another pattern.
  addMaterial(f.W, { SKU: 'RM-00113', Print_Base: f.plain.ID, Pattern: 'BP Flower', Is_Fabric: true });
  const wrong = addMaterial(f.W, { SKU: 'RM-00500', Print_Base: f.plain.ID, Pattern: 'BP Leaf', Is_Fabric: true });
  const out = send(f, { pattern: 'BP Flower', printedMaterialId: wrong.ID });
  assert.strictEqual(out.success, false);
  assert.ok(/does not match/.test(out.error), out.error);

  // And a screen holding a SKU for a pair that does not exist at all is told so,
  // rather than being allowed to mint under an id it made up.
  const g = fixture();
  const out2 = send(g, { printedMaterialId: '4242' });
  assert.strictEqual(out2.success, false);
  assert.ok(/No printed material exists/.test(out2.error), out2.error);
  assert.strictEqual(g.W.Raw_Material.length, 1, 'no mint behind a stale screen');
});

test('M12 the SKU code is the next free RM- number, zero-padded to the existing width', () => {
  const f = fixture();                                    // RM-00112 exists
  assert.strictEqual(send(f).printedSku, 'RM-00113');
});

test('M13 a WIDER existing code widens the padding', () => {
  const f = fixture();
  addMaterial(f.W, { SKU: 'RM-000123', Name: 'Wide' });
  assert.strictEqual(send(f).printedSku, 'RM-000124');
});

test('M14 codes that do not match the RM-<digits> pattern are SKIPPED, never guessed at', () => {
  const f = fixture();
  addMaterial(f.W, { SKU: 'FAB-9999', Name: 'Hand typed' });
  addMaterial(f.W, { SKU: 'RM-ABC', Name: 'Hand typed 2' });
  addMaterial(f.W, { SKU: 'RM-', Name: 'Hand typed 3' });
  addMaterial(f.W, { SKU: '', Name: 'No code' });
  assert.strictEqual(send(f).printedSku, 'RM-00113', 'one oddity must not invent a sequence number');
});

test('M15 the maximum wins, not the count - a gap in the sequence does not get refilled', () => {
  const f = fixture();
  addMaterial(f.W, { SKU: 'RM-00007', Name: 'A' });
  addMaterial(f.W, { SKU: 'RM-00400', Name: 'B' });
  assert.strictEqual(send(f).printedSku, 'RM-00401');
});

test('M16 a collision that appeared between the scan and the insert is refused, not overwritten', () => {
  const f = fixture();
  // Somebody else took RM-00113 with a code the scan skips as a duplicate source
  // of truth: the re-check is against the FORM, so it still sees it.
  addMaterial(f.W, { SKU: 'RM-00113', Name: 'Taken', Pattern: 'Something else' });
  addMaterial(f.W, { SKU: 'RM-00112x', Name: 'noise' });
  const out = send(f);
  // maxSeq is 113 here, so the next free is RM-00114 and the re-check passes.
  assert.strictEqual(out.printedSku, 'RM-00114');
  assert.strictEqual(f.W.Raw_Material.filter(r => r.SKU === 'RM-00113').length, 1,
    'the taken code is never reissued');
});

test('M17 the mint response is valid JSON with every id as a STRING', () => {
  const f = fixture();
  const out = send(f);
  assert.strictEqual(typeof out.jobId, 'string');
  assert.strictEqual(typeof out.printedMaterialId, 'string');
  assert.strictEqual(typeof out.minted, 'boolean', 'minted is a JSON boolean, not the text "true"');
  assert.strictEqual(typeof out.metresSent, 'number');
});

test('M18 Send_Lines is written exactly as given - it is the evidence the return is checked against', () => {
  const f = fixture();
  const out = send(f);
  const job = f.W.Print_Job.filter(j => String(j.ID) === String(out.jobId))[0];
  assert.strictEqual(job.Send_Lines.length, 2);
  assert.deepStrictEqual(job.Send_Lines.map(l => [l.Piece_Length_Cm, l.Piece_Count]),
    [[300, 3], [275, 4]]);
  assert.strictEqual(job.Job_Status, 'At_Printer');
  assert.strictEqual(job.Source_State, 'Wash');
  assert.strictEqual(dec(job.Metres_Returned), 0, 'starts at 0 so the loss reads as a real number');
  assert.strictEqual(String(job.Plain_Lot), String(f.lot.ID));
});

test('GAP-DOC S-own-pattern: sendToPrint accepts the plain material\'s OWN pattern and mints a nonsense SKU', () => {
  // docs/printing.md:647 - "plain carries its own pattern so the send form can
  // drop it from the options: offering to print Grey Sheeting / Plain / Grey in
  // Plain would mint a nonsense SKU." That drop is WIDGET-ONLY (patternsFor,
  // main.js:5262). sendToPrint has no equivalent guard, and the doc's own rule
  // (printing.md:274 "A Custom API is callable from anywhere") says a guard that
  // matters cannot live only in the widget.
  const f = fixture({ plainPattern: 'Plain' });
  const out = send(f, { pattern: 'Plain' });
  assert.strictEqual(out.success, true, 'CURRENT behaviour - no server guard');
  assert.strictEqual(out.printedName, 'Grey Sheeting / Plain / Grey / Plain',
    'pins the nonsense name the guard would prevent');
});

test('GAP-DOC S-pattern-case: the (Print_Base, Pattern) pair resolves CASE-SENSITIVELY server-side', () => {
  // The widget's printedFor()/patternsFor() (main.js:5259, 5280) fold case; the
  // Deluge query at sendToPrint.dg:424 does not. Two spellings of one pattern
  // therefore mint two SKUs - the exact split guard 1 exists to prevent.
  const f = fixture();
  const a = send(f, { pattern: 'BP Flower' });
  const b = send(f, { pattern: 'bp flower', lines: [{ lengthCm: 100, count: 1 }] });
  assert.strictEqual(a.minted, true);
  assert.strictEqual(b.minted, true, 'CURRENT behaviour - a second SKU for the same pattern');
  assert.notStrictEqual(String(a.printedMaterialId), String(b.printedMaterialId));
});

test('GAP-DOC S-empty-name: a material with neither Name nor Material_Display_Name composes a LEADING separator', () => {
  // sendToPrint.dg:549 starts wantName at inhName unguarded, so an empty name
  // part yields " / Plain / Grey / BP Flower". Every OTHER part is guarded
  // (:550, :554, :558) exactly to avoid this, which is what makes it a slip
  // rather than a decision.
  const f = fixture();
  f.plain.Name = '';
  f.plain.Material_Display_Name = '';
  const out = send(f);
  assert.strictEqual(out.printedName, ' / Plain / Grey / BP Flower', 'CURRENT behaviour');
});

test('GAP-DOC S-pieces-lot: sending off a Form=Pieces lot moves metres and leaves the Fabric_Piece rows behind', () => {
  // The header and its pieces disagreeing is the fault this whole design is
  // built around (printing.md:564), and resolveDispute REFUSES Store_Correction
  // on a pieces lot for exactly it. sendToPrint has no Form check, so it debits
  // a pieces lot by metres with nothing decrementing the rows underneath.
  // Unreachable today (only printed materials get Pieces lots and those are
  // refused by guard 2) - phase 4 makes it reachable.
  const f = fixture({ lotForm: 'Pieces' });
  f.W.Fabric_Piece.push({ ID: nid(f.W), Material: f.plain.ID, Lot: f.lot.ID,
    Piece_Length_Cm: 300, Piece_Count: 14, Piece_Width_Cm: 152.4,
    State: 'Wash', Piece_Status: 'Available' });
  assert.strictEqual(r2(pieceMetres(f.W, f.lot.ID)), 42, 'the pieces back 42.00 Mtr');
  const out = send(f);
  assert.strictEqual(out.success, true, 'CURRENT behaviour - accepted');
  assert.strictEqual(r2(f.lot.Wash_Quantity), 22.6);
  assert.strictEqual(r2(pieceMetres(f.W, f.lot.ID)), 42,
    'the pieces still claim 42.00 while the header says 22.60 - header and pieces now disagree');
});

// ===============================================================================
console.log('\nreceiveFromPrint');
// ===============================================================================

function sent(opts) {
  const f = fixture(opts);
  const out = send(f, opts && opts.sendOver);
  f.job = f.W.Print_Job.filter(j => String(j.ID) === String(out.jobId))[0];
  f.printed = f.W.Raw_Material.filter(r => String(r.ID) === String(out.printedMaterialId))[0];
  f.sendOut = out;
  return f;
}
function recv(f, over) {
  return receiveFromPrint(f.W, Object.assign({
    jobId: f.job.ID, lotId: '', lotNumber: 'P1', lotLabel: '',
    lines: [{ lineIndex: 0, lengthCm: 300, count: 3, state: 'Wash', carton: 'C-7' },
            { lineIndex: 1, lengthCm: 275, count: 4, state: 'Wash', carton: 'C-7' }],
    remarks: '',
  }, over || {}));
}

test('R1 a clean full return: 20.00 out, 20.00 back, no loss, one lot, two piece rows', () => {
  const f = sent();
  const out = recv(f);
  assert.strictEqual(out.success, true, JSON.stringify(out));
  assert.strictEqual(r2(out.metresSent), 20);
  assert.strictEqual(r2(out.metresReturned), 20);
  assert.strictEqual(r2(out.loss), 0);
  assert.strictEqual(out.pieceRows, 2);
  assert.strictEqual(out.lotNumber, 'P1');
  assert.strictEqual(f.W.Fabric_Piece.length, 2);
  assert.strictEqual(f.job.Job_Status, 'Received');
});

test('R2 THE LENGTH COMES FROM Send_Lines - the payload\'s copy is only COMPARED', () => {
  const f = sent();
  // A payload naming its own longer lengths must not book cloth no plain cloth paid for.
  const out = recv(f, { lines: [{ lineIndex: 0, lengthCm: 900, count: 3, state: 'Wash', carton: 'C-1' }] });
  assert.strictEqual(out.success, false, 'a mismatch is refused as a stale screen');
  assert.ok(/length does not match what was sent/.test(out.error), out.error);
  assert.strictEqual(f.W.Fabric_Piece.length, 0, 'nothing written');
  assert.strictEqual(f.job.Job_Status, 'At_Printer', 'the job stays receivable');
});

test('R3 with the length omitted entirely, the SENT length is what is used', () => {
  const f = sent();
  const out = recv(f, { lines: [{ lineIndex: 0, count: 3, state: 'Wash', carton: 'C-1' }] });
  assert.strictEqual(out.success, true, JSON.stringify(out));
  assert.strictEqual(r2(out.metresReturned), 9, '300 x 3 / 100, taken from Send_Lines');
  assert.strictEqual(f.W.Fabric_Piece[0].Piece_Length_Cm, 300);
});

test('R4 the count is CAPPED at what that send row sent - over-return is impossible', () => {
  const f = sent();
  const out = recv(f, { lines: [{ lineIndex: 0, lengthCm: 300, count: 4, state: 'Wash', carton: 'C-1' }] });
  assert.strictEqual(out.success, false);
  assert.ok(/3 pieces of 300 cm went out - 4 cannot come back/.test(out.error), out.error);
  assert.strictEqual(f.W.Fabric_Piece.length, 0);
});

test('R5 one send row cannot be answered twice in one receipt', () => {
  const f = sent();
  const out = recv(f, { lines: [
    { lineIndex: 0, lengthCm: 300, count: 3, state: 'Wash', carton: 'C-1' },
    { lineIndex: 0, lengthCm: 300, count: 3, state: 'Wash', carton: 'C-1' }] });
  assert.strictEqual(out.success, false);
  assert.ok(/returned twice/.test(out.error), out.error);
});

test('R6 a lineIndex that addresses nothing, or is missing, is refused', () => {
  const a = sent();
  assert.ok(/does not match anything that was sent/.test(
    recv(a, { lines: [{ lineIndex: 9, count: 1, state: 'Wash', carton: 'C' }] }).error));
  const b = sent();
  assert.ok(/older screen/.test(
    recv(b, { lines: [{ lengthCm: 300, count: 1, state: 'Wash', carton: 'C' }] }).error));
  const c = sent();
  assert.ok(/does not match anything that was sent/.test(
    recv(c, { lines: [{ lineIndex: -1, count: 1, state: 'Wash', carton: 'C' }] }).error));
});

test('R7 fractional and negative returned counts are refused', () => {
  const a = sent();
  assert.ok(/whole number/.test(
    recv(a, { lines: [{ lineIndex: 0, count: 1.5, state: 'Wash', carton: 'C' }] }).error));
  const b = sent();
  assert.ok(/cannot be negative/.test(
    recv(b, { lines: [{ lineIndex: 0, count: -1, state: 'Wash', carton: 'C' }] }).error));
});

test('R8 a ZERO row writes a Receive_Lines row at zero and NO Fabric_Piece', () => {
  const f = sent();
  const out = recv(f, { lines: [
    { lineIndex: 0, lengthCm: 300, count: 3, state: 'Wash', carton: 'C-7' },
    { lineIndex: 1, lengthCm: 275, count: 0, state: '', carton: '' }] });
  assert.strictEqual(out.success, true, JSON.stringify(out));
  assert.strictEqual(f.job.Receive_Lines.length, 2, 'the size was CHECKED, not skipped');
  assert.strictEqual(dec(f.job.Receive_Lines[1].Piece_Count), 0);
  assert.strictEqual(f.W.Fabric_Piece.length, 1, 'no Available row holding zero pieces');
  assert.strictEqual(out.pieceRows, 1);
  assert.strictEqual(out.piecesLost, 4);
});

test('R9 a zero row needs no state and no carton - it sits on no shelf', () => {
  const f = sent();
  const out = recv(f, { lines: [
    { lineIndex: 0, lengthCm: 300, count: 3, state: 'Wash', carton: 'C-7' },
    { lineIndex: 1, lengthCm: 275, count: 0, state: '', carton: '' }] });
  assert.strictEqual(out.success, true, 'a blank state on a zero row must not be refused: ' + out.error);
});

test('R10 a NON-zero row without a state IS refused', () => {
  const f = sent();
  const out = recv(f, { lines: [{ lineIndex: 0, lengthCm: 300, count: 3, state: '', carton: 'C' }] });
  assert.strictEqual(out.success, false);
  assert.ok(/must say Wash or Unwash/.test(out.error), out.error);
});

test('R11 a run where EVERY line is zero is REFUSED', () => {
  const f = sent();
  const out = recv(f, { lines: [
    { lineIndex: 0, lengthCm: 300, count: 0, state: '', carton: '' },
    { lineIndex: 1, lengthCm: 275, count: 0, state: '', carton: '' }] });
  assert.strictEqual(out.success, false);
  assert.ok(/Nothing came back on any size/.test(out.error), out.error);
  assert.strictEqual(f.W.Raw_Material_Lot.filter(l => String(l.Material) === String(f.printed.ID)).length, 0,
    'no empty lot written');
  assert.strictEqual(f.job.Job_Status, 'At_Printer');
});

test('R12 THE LOSS: In_Print clears by the FULL amount sent, the printed lot rises by what came back', () => {
  const f = sent();
  assert.strictEqual(r2(f.lot.In_Print_Qty), 20);
  // one 275 cm piece never came back: 20.00 out, 17.25 back, 2.75 lost.
  const out = recv(f, { lines: [
    { lineIndex: 0, lengthCm: 300, count: 3, state: 'Wash', carton: 'C-7' },
    { lineIndex: 1, lengthCm: 275, count: 3, state: 'Wash', carton: 'C-7' }] });
  assert.strictEqual(out.success, true, JSON.stringify(out));
  assert.strictEqual(r2(out.metresReturned), 17.25);
  assert.strictEqual(r2(out.loss), 2.75);
  assert.strictEqual(out.piecesLost, 1, 'the loss is stated in WHOLE PIECES');
  assert.strictEqual(r2(f.lot.In_Print_Qty), 0, 'the plain lot clears by 20.00, not by 17.25');
  assert.strictEqual(r2(f.plain.In_Print_Qty), 0);
  const plot = f.W.Raw_Material_Lot.filter(l => String(l.Material) === String(f.printed.ID))[0];
  assert.strictEqual(r2(plot.Wash_Quantity), 17.25);
  assert.strictEqual(r2(f.printed.Wash_Quantity), 17.25);
});

test('R13 the loss written off is the plain SKU\'s - its total falls by Metres_Sent', () => {
  const f = sent();
  const beforePlain = parentTotal(f.W, f.plain.ID);
  recv(f, { lines: [
    { lineIndex: 0, lengthCm: 300, count: 3, state: 'Wash', carton: 'C-7' },
    { lineIndex: 1, lengthCm: 275, count: 3, state: 'Wash', carton: 'C-7' }] });
  assert.strictEqual(r2(beforePlain - parentTotal(f.W, f.plain.ID)), 20,
    'the plain SKU gives up everything that was sent, loss included');
  assert.strictEqual(parentTotal(f.W, f.printed.ID), 17.25, 'the printed SKU gains only what arrived');
  assertIdentity(f.W, f.plain.ID, 'after receipt (plain)');
  assertIdentity(f.W, f.printed.ID, 'after receipt (printed)');
});

test('R14 Fabric_Piece.Piece_Width_Cm is stamped from the PRINTED SKU\'s own width', () => {
  const f = sent();
  recv(f);
  assert.strictEqual(f.printed.Fabric_Width_Inches, '60');
  f.W.Fabric_Piece.forEach(p =>
    assert.strictEqual(r2(p.Piece_Width_Cm), 152.4, '60 inches is 152.4 cm - the decimals matter'));
});

test('R15 a printed SKU with no width on file stamps 0 rather than refusing the receipt', () => {
  const f = sent();
  f.printed.Fabric_Width_Inches = '';
  const out = recv(f);
  assert.strictEqual(out.success, true, 'the cloth is physically in the building either way');
  assert.strictEqual(dec(f.W.Fabric_Piece[0].Piece_Width_Cm), 0);
});

test('R16 the piece rows carry length, count, state, carton and Available - one row per line, never merged', () => {
  const f = sent();
  recv(f, { lines: [
    { lineIndex: 0, lengthCm: 300, count: 3, state: 'Wash', carton: 'C-7' },
    { lineIndex: 1, lengthCm: 275, count: 4, state: 'Unwash', carton: 'C-8' }] });
  assert.strictEqual(f.W.Fabric_Piece.length, 2);
  const [a, b] = f.W.Fabric_Piece;
  assert.deepStrictEqual([a.Piece_Length_Cm, dec(a.Piece_Count), a.State, a.Carton_Number, a.Piece_Status],
    [300, 3, 'Wash', 'C-7', 'Available']);
  assert.deepStrictEqual([b.Piece_Length_Cm, dec(b.Piece_Count), b.State, b.Carton_Number, b.Piece_Status],
    [275, 4, 'Unwash', 'C-8', 'Available']);
  assert.strictEqual(String(a.Print_Job), String(f.job.ID), 'provenance');
});

test('R17 Wash and Unwash in one receipt land on their OWN counters and neither absorbs the other', () => {
  const f = sent();
  const out = recv(f, { lines: [
    { lineIndex: 0, lengthCm: 300, count: 3, state: 'Wash', carton: 'C-7' },
    { lineIndex: 1, lengthCm: 275, count: 4, state: 'Unwash', carton: 'C-8' }] });
  assert.strictEqual(r2(out.lotWash), 9);
  assert.strictEqual(r2(out.lotUnwash), 11);
  const plot = f.W.Raw_Material_Lot.filter(l => String(l.Material) === String(f.printed.ID))[0];
  assert.strictEqual(r2(plot.Wash_Quantity), 9);
  assert.strictEqual(r2(plot.Unwash_Quantity), 11);
  assert.strictEqual(r2(f.printed.Wash_Quantity), 9);
  assert.strictEqual(r2(f.printed.Unwash_Quantity), 11);
  assertIdentity(f.W, f.printed.ID, 'mixed-state receipt');
});

test('R18 a NEW lot is Form=Pieces, Active, Source_Lot = the plain lot, Print_Job = the job', () => {
  const f = sent();
  recv(f);
  const plot = f.W.Raw_Material_Lot.filter(l => String(l.Material) === String(f.printed.ID))[0];
  assert.strictEqual(plot.Form, 'Pieces',
    'Roll here is the silent failure the whole design exists to avoid');
  assert.strictEqual(plot.Status, 'Active');
  assert.strictEqual(String(plot.Source_Lot), String(f.lot.ID));
  assert.strictEqual(String(plot.Print_Job), String(f.job.ID));
  assert.strictEqual(plot.Lot_Number, 'P1');
});

test('R19 the lot metres are the maintained sum of the lot\'s pieces', () => {
  const f = sent();
  recv(f);
  const plot = f.W.Raw_Material_Lot.filter(l => String(l.Material) === String(f.printed.ID))[0];
  assert.strictEqual(r2(dec(plot.Wash_Quantity) + dec(plot.Unwash_Quantity)),
                     pieceMetres(f.W, plot.ID),
                     'for a Pieces lot each metres figure is SUM(len x count)/100');
});

test('R20 lot number uniqueness within the printed material is CASE-FOLDED', () => {
  const f = sent();
  recv(f);                                             // creates P1
  const send2 = send(f, { lines: [{ lengthCm: 400, count: 2 }] });
  const job2 = f.W.Print_Job.filter(j => String(j.ID) === String(send2.jobId))[0];
  const out = receiveFromPrint(f.W, { jobId: job2.ID, lotId: '', lotNumber: 'p1',
    lines: [{ lineIndex: 0, lengthCm: 400, count: 2, state: 'Wash', carton: 'C-9' }] });
  assert.strictEqual(out.success, false);
  assert.ok(/already exists for that printed material/.test(out.error), out.error);
});

test('R21 the same lot number on a DIFFERENT material is fine - unique within the material, not globally', () => {
  const f = sent();
  recv(f);                                             // P1 on the printed SKU
  addLot(f.W, { Material: f.plain.ID, Lot_Number: 'P1' });   // does not collide
  const send2 = send(f, { pattern: 'BP Leaf', lines: [{ lengthCm: 400, count: 2 }] });
  const job2 = f.W.Print_Job.filter(j => String(j.ID) === String(send2.jobId))[0];
  const out = receiveFromPrint(f.W, { jobId: job2.ID, lotId: '', lotNumber: 'P1',
    lines: [{ lineIndex: 0, lengthCm: 400, count: 2, state: 'Wash', carton: 'C-9' }] });
  assert.strictEqual(out.success, true, out.error);
});

test('R22 a new lot with no number is refused', () => {
  const f = sent();
  const out = recv(f, { lotNumber: '' });
  assert.strictEqual(out.success, false);
  assert.ok(/Give the new printed lot a number/.test(out.error), out.error);
});

test('R23 TOPPING UP an existing printed lot adds to it instead of creating a second one', () => {
  const f = sent();
  recv(f);                                             // P1 now holds 20.00
  const plot = f.W.Raw_Material_Lot.filter(l => String(l.Material) === String(f.printed.ID))[0];
  const lotsBefore = f.W.Raw_Material_Lot.length;

  const send2 = send(f, { lines: [{ lengthCm: 400, count: 2 }] });
  const job2 = f.W.Print_Job.filter(j => String(j.ID) === String(send2.jobId))[0];
  const out = receiveFromPrint(f.W, { jobId: job2.ID, lotId: plot.ID, lotNumber: '',
    lines: [{ lineIndex: 0, lengthCm: 400, count: 2, state: 'Wash', carton: 'C-9' }] });

  assert.strictEqual(out.success, true, out.error);
  assert.strictEqual(f.W.Raw_Material_Lot.length, lotsBefore, 'no second lot minted per job');
  assert.strictEqual(r2(plot.Wash_Quantity), 28, '20.00 + 8.00');
  assert.strictEqual(r2(out.lotWash), 28);
  assert.strictEqual(String(out.printedLotId), String(plot.ID));
  assert.strictEqual(r2(pieceMetres(f.W, plot.ID)), 28, 'the pieces still back the header');
});

test('R24 an existing lot belonging to ANOTHER material, or blocked, is refused', () => {
  const f = sent();
  const foreign = addLot(f.W, { Material: f.plain.ID, Lot_Number: 'Z1' });
  assert.ok(/different material/.test(recv(f, { lotId: foreign.ID }).error));

  const g = sent();
  const blocked = addLot(g.W, { Material: g.printed.ID, Lot_Number: 'B1', Status: 'Blocked', Form: 'Pieces' });
  assert.ok(/blocked/.test(recv(g, { lotId: blocked.ID }).error));
});

test('R25 AT_PRINTER ONLY - a Received job cannot be received again', () => {
  const f = sent();
  recv(f);
  const pieces = f.W.Fabric_Piece.length;
  const out = recv(f, { lotNumber: 'P2' });
  assert.strictEqual(out.success, false);
  assert.ok(/only a job still at the printer can be received/.test(out.error), out.error);
  assert.strictEqual(f.W.Fabric_Piece.length, pieces, 'the pieces are not minted a second time');
  assert.strictEqual(r2(f.lot.In_Print_Qty), 0, 'In_Print is not driven negative');
});

test('R26 a Cancelled job cannot be received', () => {
  const f = sent();
  cancelPrintJob(f.W, { jobId: f.job.ID, reason: 'unprinted' });
  const out = recv(f);
  assert.strictEqual(out.success, false);
  assert.ok(/only a job still at the printer/.test(out.error), out.error);
});

test('R27 an unknown job, and an empty lines list, are refused', () => {
  const f = sent();
  assert.ok(/Print job not found/.test(receiveFromPrint(f.W, { jobId: '99999', lines: [{ lineIndex: 0, count: 1 }] }).error));
  assert.ok(/no lines given/.test(recv(f, { lines: [] }).error));
});

test('R28 the response is valid JSON, ids as strings, and carries the piece figures the screen states', () => {
  const f = sent();
  const out = recv(f, { lines: [
    { lineIndex: 0, lengthCm: 300, count: 3, state: 'Wash', carton: 'C-7' },
    { lineIndex: 1, lengthCm: 275, count: 2, state: 'Wash', carton: 'C-7' }] });
  assert.strictEqual(typeof out.printedLotId, 'string');
  assert.strictEqual(out.piecesSent, 7);
  assert.strictEqual(out.piecesReturned, 5);
  assert.strictEqual(out.piecesLost, 2);
});

test('GAP-DOC R-coverage: a payload that omits a sent size writes NO Receive_Lines row for it', () => {
  // receiveFromPrint.dg:665 - "EVERY sent size gets a receive row, including the
  // ones that came back as nothing... drop it and the two subforms no longer line
  // up." The loop at :654 walks the PAYLOAD, not Send_Lines, and nothing checks
  // takenIdx against sentLenList.size(), so the invariant holds only because the
  // widget happens to send every row.
  const f = sent();
  const out = recv(f, { lines: [{ lineIndex: 0, lengthCm: 300, count: 3, state: 'Wash', carton: 'C-7' }] });
  assert.strictEqual(out.success, true, 'CURRENT behaviour - accepted');
  assert.strictEqual(f.job.Send_Lines.length, 2);
  assert.strictEqual(f.job.Receive_Lines.length, 1,
    'the 275 cm size reads as one nobody looked for, not as one that was checked');
  assert.strictEqual(out.piecesLost, 4, 'the metres ARE still written off correctly');
});

test('GAP-DOC R-form: topping up an existing lot never forces Form = "Pieces"', () => {
  // receiveFromPrint.dg:366-394 sets Form only on the NEW-lot branch (:453). A
  // pre-existing Roll lot on a printed SKU takes the pieces and stays a Roll, so
  // the allocator divides its metres by the cut length - the exact silent failure
  // printing.md:12-23 is written around.
  const f = sent();
  const roll = addLot(f.W, { Material: f.printed.ID, Lot_Number: 'BOUGHT-IN', Form: 'Roll' });
  const out = recv(f, { lotId: roll.ID, lotNumber: '' });
  assert.strictEqual(out.success, true, 'CURRENT behaviour - accepted');
  assert.strictEqual(roll.Form, 'Roll', 'still a Roll');
  assert.strictEqual(r2(roll.Wash_Quantity), 20);
  assert.strictEqual(f.W.Fabric_Piece.filter(p => String(p.Lot) === String(roll.ID)).length, 2,
    'with Fabric_Piece rows underneath it');
});

test('GAP-DOC R-clamp: a damaged In_Print_Qty is clamped at 0 while the printed side is still credited in full', () => {
  // receiveFromPrint.dg:565-571 / :584-590. The clamp is deliberate ("the cloth
  // has physically come back either way") but it is one-sided: the printed SKU
  // gains Metres_Returned regardless, so the pair of SKUs together ends up
  // holding more cloth than existed. Only the info line records it.
  const f = sent();
  f.lot.In_Print_Qty = 5; f.plain.In_Print_Qty = 5;      // somebody edited it by hand
  const totalBefore = parentTotal(f.W, f.plain.ID) + parentTotal(f.W, f.printed.ID);
  const out = recv(f);
  assert.strictEqual(out.success, true);
  assert.strictEqual(r2(f.plain.In_Print_Qty), 0, 'clamped, not -15');
  const totalAfter = parentTotal(f.W, f.plain.ID) + parentTotal(f.W, f.printed.ID);
  assert.strictEqual(r2(totalAfter - totalBefore), 15,
    'CURRENT behaviour - 15.00 Mtr appears out of nothing across the two SKUs');
});

// ===============================================================================
console.log('\ncancelPrintJob');
// ===============================================================================

test('C1 cancel reverses the send EXACTLY - In_Print down by Metres_Sent, metres back to the source counter', () => {
  const f = sent();
  const out = cancelPrintJob(f.W, { jobId: f.job.ID, reason: 'printer returned it unprinted' });
  assert.strictEqual(out.success, true, JSON.stringify(out));
  assert.strictEqual(out.restoredTo, 'Wash');
  assert.strictEqual(r2(out.metres), 20);
  assert.strictEqual(r2(f.lot.In_Print_Qty), 0);
  assert.strictEqual(r2(f.lot.Wash_Quantity), 42.6, 'back to exactly what it was before the send');
  assert.strictEqual(r2(out.lotWash), 42.6);
  assert.strictEqual(r2(out.lotInPrint), 0);
  assert.strictEqual(f.job.Job_Status, 'Cancelled');
});

test('C2 the parent mirrors the reversal and the SKU total never moved', () => {
  const f = fixture();
  const before = parentTotal(f.W, f.plain.ID);
  const beforeWash = r2(f.plain.Wash_Quantity);
  const s = send(f);
  const job = f.W.Print_Job.filter(j => String(j.ID) === String(s.jobId))[0];
  cancelPrintJob(f.W, { jobId: job.ID, reason: '' });
  assert.strictEqual(r2(f.plain.Wash_Quantity), beforeWash);
  assert.strictEqual(r2(f.plain.In_Print_Qty), 0);
  assert.strictEqual(parentTotal(f.W, f.plain.ID), before);
  assertIdentity(f.W, f.plain.ID, 'after cancel');
});

test('C3 the metres go back to THE COUNTER THEY CAME OFF, not to Wash by default', () => {
  const f = fixture();
  const s = send(f, { sourceState: 'Unwash', lines: [{ lengthCm: 200, count: 3 }] });
  const job = f.W.Print_Job.filter(j => String(j.ID) === String(s.jobId))[0];
  const out = cancelPrintJob(f.W, { jobId: job.ID, reason: '' });
  assert.strictEqual(out.restoredTo, 'Unwash');
  assert.strictEqual(r2(f.lot.Unwash_Quantity), 8, 'greige cloth goes back greige');
  assert.strictEqual(r2(f.lot.Wash_Quantity), 42.6, 'a wash that never happened is never claimed');
  assert.strictEqual(r2(f.plain.Unwash_Quantity), 8);
});

test('C4 NO printed lot is created and NO printed SKU stock appears', () => {
  const f = sent();
  const matCount = f.W.Raw_Material.length;
  cancelPrintJob(f.W, { jobId: f.job.ID, reason: '' });
  assert.strictEqual(f.W.Raw_Material_Lot.filter(l => String(l.Material) === String(f.printed.ID)).length, 0);
  assert.strictEqual(f.W.Fabric_Piece.length, 0);
  assert.strictEqual(f.W.Raw_Material.length, matCount, 'the SKU minted at send stays, at zero');
  assert.strictEqual(parentTotal(f.W, f.printed.ID), 0);
});

test('C5 AT_PRINTER ONLY - a Received job cannot be cancelled', () => {
  const f = sent();
  recv(f);
  const washBefore = r2(f.lot.Wash_Quantity);
  const out = cancelPrintJob(f.W, { jobId: f.job.ID, reason: 'oops' });
  assert.strictEqual(out.success, false);
  assert.ok(/only a job still at the printer can be cancelled/.test(out.error), out.error);
  assert.strictEqual(r2(f.lot.Wash_Quantity), washBefore, 'no plain cloth invented out of printed');
});

test('C6 an already-Cancelled job cannot be cancelled again - no double credit', () => {
  const f = sent();
  cancelPrintJob(f.W, { jobId: f.job.ID, reason: '' });
  const out = cancelPrintJob(f.W, { jobId: f.job.ID, reason: '' });
  assert.strictEqual(out.success, false);
  assert.ok(/That job is Cancelled/.test(out.error), out.error);
  assert.strictEqual(r2(f.lot.Wash_Quantity), 42.6, 'still 42.60, not 62.60');
});

test('C7 a blank Source_State is REFUSED rather than guessed', () => {
  const f = sent();
  f.job.Source_State = '';
  const out = cancelPrintJob(f.W, { jobId: f.job.ID, reason: '' });
  assert.strictEqual(out.success, false);
  assert.ok(/does not say which counter/.test(out.error), out.error);
  assert.strictEqual(r2(f.lot.In_Print_Qty), 20, 'nothing moved');
});

test('C8 a job with no metres, and an unknown job, are refused', () => {
  const f = sent();
  f.job.Metres_Sent = 0;
  assert.ok(/no metres against it/.test(cancelPrintJob(f.W, { jobId: f.job.ID }).error));
  assert.ok(/Print job not found/.test(cancelPrintJob(f.W, { jobId: '99999' }).error));
  assert.ok(/No print job given/.test(cancelPrintJob(f.W, { jobId: '' }).error));
});

test('C9 the reason is APPENDED to Remarks, never written over them', () => {
  const f = fixture();
  const s = send(f, { remarks: 'urgent run' });
  const job = f.W.Print_Job.filter(j => String(j.ID) === String(s.jobId))[0];
  cancelPrintJob(f.W, { jobId: job.ID, reason: 'printer machine down' });
  assert.ok(job.Remarks.indexOf('urgent run') === 0, 'the send note survives: ' + job.Remarks);
  assert.ok(/printer machine down/.test(job.Remarks));
  assert.ok(job.Remarks.indexOf('\n') > 0, 'the field reads as a log');
});

test('GAP-DOC C-clamp: a damaged In_Print_Qty is clamped at 0 while the counter is still credited in full', () => {
  // cancelPrintJob.dg:162-180. In_Print is clamped but Wash_Quantity gains the
  // whole of Metres_Sent, so a cancel against a damaged ledger INVENTS cloth -
  // the opposite of sendToPrint.dg:628's own rule, "stock that is stuck beats
  // stock that is imaginary".
  const f = sent();
  f.lot.In_Print_Qty = 5; f.plain.In_Print_Qty = 5;
  const before = parentTotal(f.W, f.plain.ID);
  const out = cancelPrintJob(f.W, { jobId: f.job.ID, reason: '' });
  assert.strictEqual(out.success, true);
  assert.strictEqual(r2(f.lot.In_Print_Qty), 0, 'clamped, not -15');
  assert.strictEqual(r2(f.lot.Wash_Quantity), 42.6, 'credited the full 20.00 anyway');
  assert.strictEqual(r2(parentTotal(f.W, f.plain.ID) - before), 15,
    'CURRENT behaviour - 15.00 Mtr of plain cloth appears out of nothing');
});

test('GAP-DOC C-nolot: a job with no plain lot reports lotWash/lotInPrint as 0 as though they were read', () => {
  // cancelPrintJob.dg:133-134 initialises both to 0 and only the plain-lot branch
  // fills them, so the screen is told "0 on the lot" for a job that never had one.
  const f = sent();
  f.job.Plain_Lot = '';
  const out = cancelPrintJob(f.W, { jobId: f.job.ID, reason: '' });
  assert.strictEqual(out.success, true);
  assert.strictEqual(r2(out.lotWash), 0, 'CURRENT behaviour - indistinguishable from an empty lot');
  assert.strictEqual(r2(f.plain.Wash_Quantity), 42.6, 'the PARENT is still settled correctly');
});

// ===============================================================================
console.log('\nlifecycle - the reconciliation identity end to end');
// ===============================================================================

test('X1 send -> receive with loss: the identity holds at every step, on BOTH SKUs', () => {
  const f = fixture();
  assertIdentity(f.W, f.plain.ID, 'at rest');
  const openingTotal = parentTotal(f.W, f.plain.ID);      // 42.60 + 8.00 = 50.60

  const s = send(f);
  assertIdentity(f.W, f.plain.ID, 'after send');
  assert.strictEqual(parentTotal(f.W, f.plain.ID), openingTotal, 'send moves nothing out of the SKU');

  const job = f.W.Print_Job.filter(j => String(j.ID) === String(s.jobId))[0];
  const printed = f.W.Raw_Material.filter(r => String(r.ID) === String(s.printedMaterialId))[0];
  const out = receiveFromPrint(f.W, { jobId: job.ID, lotId: '', lotNumber: 'P1', lines: [
    { lineIndex: 0, lengthCm: 300, count: 3, state: 'Wash', carton: 'C-7' },
    { lineIndex: 1, lengthCm: 275, count: 3, state: 'Wash', carton: 'C-7' }] });
  assert.strictEqual(out.success, true, out.error);

  assertIdentity(f.W, f.plain.ID, 'after receipt (plain)');
  assertIdentity(f.W, printed.ID, 'after receipt (printed)');
  assert.strictEqual(parentTotal(f.W, f.plain.ID), r2(openingTotal - 20));
  assert.strictEqual(parentTotal(f.W, printed.ID), 17.25);
  assert.strictEqual(r2(openingTotal - 20 + 17.25 + 2.75), openingTotal,
    'plain + printed + loss = what we started with, to the centimetre');
  const plot = f.W.Raw_Material_Lot.filter(l => String(l.Material) === String(printed.ID))[0];
  assert.strictEqual(pieceMetres(f.W, plot.ID), 17.25, 'and the pieces back the lot header');
});

test('X2 send -> cancel: the identity holds and every counter is back where it started', () => {
  const f = fixture();
  const snapshot = JSON.stringify([f.lot.Wash_Quantity, f.lot.Unwash_Quantity, f.lot.In_Print_Qty,
                                   f.plain.Wash_Quantity, f.plain.Unwash_Quantity, f.plain.In_Print_Qty]);
  const s = send(f);
  const job = f.W.Print_Job.filter(j => String(j.ID) === String(s.jobId))[0];
  cancelPrintJob(f.W, { jobId: job.ID, reason: 'unprinted' });
  assert.strictEqual(JSON.stringify([f.lot.Wash_Quantity, f.lot.Unwash_Quantity, f.lot.In_Print_Qty,
                                     f.plain.Wash_Quantity, f.plain.Unwash_Quantity, f.plain.In_Print_Qty]),
                     snapshot, 'a cancelled run leaves no trace on any counter');
  assertIdentity(f.W, f.plain.ID, 'after cancel');
});

test('X3 two sends off one lot, one received and one cancelled, still reconcile', () => {
  const f = fixture();
  const opening = parentTotal(f.W, f.plain.ID);
  const s1 = send(f, { lines: [{ lengthCm: 300, count: 3 }] });          // 9.00
  const s2 = send(f, { lines: [{ lengthCm: 250, count: 4 }] });          // 10.00
  assert.strictEqual(r2(f.lot.In_Print_Qty), 19);
  assert.strictEqual(r2(f.lot.Wash_Quantity), 23.6);
  assertIdentity(f.W, f.plain.ID, 'two jobs out');

  const j1 = f.W.Print_Job.filter(j => String(j.ID) === String(s1.jobId))[0];
  const j2 = f.W.Print_Job.filter(j => String(j.ID) === String(s2.jobId))[0];
  const printed = f.W.Raw_Material.filter(r => String(r.ID) === String(s1.printedMaterialId))[0];

  const r = receiveFromPrint(f.W, { jobId: j1.ID, lotId: '', lotNumber: 'P1',
    lines: [{ lineIndex: 0, lengthCm: 300, count: 3, state: 'Wash', carton: 'C-1' }] });
  assert.strictEqual(r.success, true, r.error);
  cancelPrintJob(f.W, { jobId: j2.ID, reason: 'wrong pattern' });

  assert.strictEqual(r2(f.lot.In_Print_Qty), 0, 'both jobs settled');
  assert.strictEqual(r2(f.lot.Wash_Quantity), 33.6, '42.60 - 9.00 received away');
  assertIdentity(f.W, f.plain.ID, 'after mixed settlement (plain)');
  assertIdentity(f.W, printed.ID, 'after mixed settlement (printed)');
  assert.strictEqual(r2(parentTotal(f.W, f.plain.ID) + parentTotal(f.W, printed.ID)), opening,
    'nothing was lost and nothing was invented');
});

test('X4 a receipt into a SECOND printed lot keeps each lot backed by its own pieces', () => {
  const f = fixture();
  const s1 = send(f, { lines: [{ lengthCm: 300, count: 3 }] });
  const s2 = send(f, { lines: [{ lengthCm: 250, count: 4 }] });
  const j1 = f.W.Print_Job.filter(j => String(j.ID) === String(s1.jobId))[0];
  const j2 = f.W.Print_Job.filter(j => String(j.ID) === String(s2.jobId))[0];
  const printed = f.W.Raw_Material.filter(r => String(r.ID) === String(s1.printedMaterialId))[0];

  receiveFromPrint(f.W, { jobId: j1.ID, lotId: '', lotNumber: 'P1',
    lines: [{ lineIndex: 0, lengthCm: 300, count: 3, state: 'Wash', carton: 'C-1' }] });
  const r2out = receiveFromPrint(f.W, { jobId: j2.ID, lotId: '', lotNumber: 'P2',
    lines: [{ lineIndex: 0, lengthCm: 250, count: 4, state: 'Wash', carton: 'C-2' }] });
  assert.strictEqual(r2out.success, true, r2out.error);

  const lots = f.W.Raw_Material_Lot.filter(l => String(l.Material) === String(printed.ID));
  assert.strictEqual(lots.length, 2, 'one lot per run - tone depends on the ink batch too');
  lots.forEach(l => assert.strictEqual(r2(dec(l.Wash_Quantity) + dec(l.Unwash_Quantity)),
                                       pieceMetres(f.W, l.ID), 'lot ' + l.Lot_Number));
  assertIdentity(f.W, printed.ID, 'two printed lots');
  assert.strictEqual(parentTotal(f.W, printed.ID), 19);
});

// ---- summary -------------------------------------------------------------------

console.log('\n========================================');
console.log('print-writers: ' + passed + ' passed, ' + failed + ' failed');
if (failures.length) {
  failures.forEach(f => console.log('  FAIL ' + f.name + '\n       ' + f.msg.split('\n')[0]));
  process.exit(1);
}
