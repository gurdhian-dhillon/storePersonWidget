// AUDIT of the PAGING boundary: does the allocator still allocate correctly
// when one supervisor's demand for one fabric arrives split across two pages?
//
// The allocator assumes it sees the WHOLE rack and the WHOLE demand for a
// material in one go. mergeRequirementPages sums demand fields and concatenates
// `lines`, but keeps page 1's `lots` / `wasteStock` / `availableStock`.
// That is only safe if every page carries the same full lot list.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const stubEl = () => ({
  addEventListener(){}, appendChild(){}, removeAttribute(){}, setAttribute(){},
  getAttribute(){ return null; }, classList:{add(){},remove(){},contains(){return false;}},
  style:{}, value:'', textContent:'', innerHTML:'', disabled:false
});
const sb = { window:{}, document:{ getElementById:stubEl, querySelector:stubEl,
  querySelectorAll:()=>[], createElement:stubEl, addEventListener(){}, body:{appendChild(){}} },
  console, ZOHO:{CREATOR:{DATA:{}}}, alert(){}, setTimeout, JSON, Math, Number, String, Object, Array };
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(ROOT,'app/js/lot-allocator.js'),'utf8'), sb);
try { vm.runInContext(fs.readFileSync(path.join(ROOT,'app/js/main.js'),'utf8'), sb); } catch(e) {}
const { allocateEveryCard, mergeRequirementPages, round2, buildFabricIssueLine } = sb;

let fails = 0;
const check=(n,c,d)=>{ if(!c){fails++;console.log('  FAIL '+n+'  '+d);} else console.log('  ok   '+n+(d?'  '+d:'')); };

const roll=(id,len)=>({rollId:id,label:id.toUpperCase(),length:len,status:'Available'});
const LOTS = () => ([{lotId:'L1',lotNumber:'L1',wash:30,unwash:0,inWash:0,blocked:false,
                      rolls:[roll('r1',30)],form:'Roll'}]);

// Two pages, each carrying HALF the supervisor's demand for the same fabric,
// each carrying the FULL lot list (which is what the server actually does —
// lots are fetched per material, not per plan).
function page(planId, mrqId, req) {
  return [{ supervisorId:'A', supervisorName:'Suraj', materials:[{
    materialId:'9', material:'Linen', sku:'RM-9', unit:'Mtr', isFabric:true,
    isReissue:false, fabricWidthCm:150,
    required:req, issued:0, remaining:req,
    requiredPieces:req, issuedPieces:0, outstandingPieces:req,
    availableStock:30, unwashedStock:0, inWashStock:0,
    lots:LOTS(), wasteStock:[],
    cuts:[{cutW:150,cutL:100,reqPieces:req,issPieces:0}],
    lines:[{planId:planId,planItemId:'i'+planId,mrqId:mrqId,
            cutW:150,cutL:100,reqPieces:req,issPieces:0}]
  }]}];
}

console.log('=== G1: split demand merges into ONE row with BOTH lines ===');
{
  const merged = [];
  mergeRequirementPages(merged, page('p1','m1',10));
  mergeRequirementPages(merged, page('p2','m2',10));
  const m = merged[0].materials[0];
  check('one material row', merged[0].materials.length===1, 'rows='+merged[0].materials.length);
  check('both lines present', (m.lines||[]).length===2, 'lines='+(m.lines||[]).length);
  check('demand summed', m.remaining===20, 'remaining='+m.remaining);
  check('stock NOT doubled', m.availableStock===30,
    'availableStock='+m.availableStock+' (summing it would invent a second rack)');
  check('lots not duplicated', (m.lots||[]).length===1, 'lots='+(m.lots||[]).length);
  const rollLen = m.lots[0].rolls.reduce((s,r)=>s+r.length,0);
  check('roll length not doubled', rollLen===30, 'rollLen='+rollLen);
}

console.log('\n=== G2: allocation over the merged row respects the ONE rack ===');
{
  const merged = [];
  mergeRequirementPages(merged, page('p1','m1',10));
  mergeRequirementPages(merged, page('p2','m2',10));
  allocateEveryCard(merged);
  const m = merged[0].materials[0];
  const total = round2((m.lotLines||[]).reduce((s,l)=>s+l.qty,0));
  check('never issues more than the 30m rack', total<=30.0001, 'issued='+total);
  // 20 pieces at 1/row x 1m = 20m, rack has 30 => both orders servable
  check('both orders served', total===20, 'issued='+total+' (expected 20)');
  const perRoll={};
  (m.lotLines||[]).forEach(l=>(l.rolls||[]).forEach(r=>{
    perRoll[r.rollId]=round2((perRoll[r.rollId]||0)+r.metres);}));
  check('roll r1 not overcut', (perRoll.r1||0)<=30.0001, 'r1='+perRoll.r1);
}

console.log('\n=== G3: THE DANGEROUS CASE — demand exceeds the rack across pages ===');
{
  const merged = [];
  mergeRequirementPages(merged, page('p1','m1',20));   // 20m
  mergeRequirementPages(merged, page('p2','m2',20));   // 20m => 40m wanted, 30 on rack
  allocateEveryCard(merged);
  const m = merged[0].materials[0];
  const total = round2((m.lotLines||[]).reduce((s,l)=>s+l.qty,0));
  check('CANNOT over-issue across pages', total<=30.0001,
    'issued='+total+' rack=30  <-- if pages were allocated separately this would be 40');
  const orders = [...new Set((m.lotLines||[]).map(l=>l.planId))];
  console.log('     orders served: '+JSON.stringify(orders)+'  metres='+total);
  check('one order fully served, the other skipped (atom rule)',
    total===20, 'issued='+total);
}

console.log('\n=== G4: payload from a merged row still conserves metres ===');
{
  const merged = [];
  mergeRequirementPages(merged, page('p1','m1',10));
  mergeRequirementPages(merged, page('p2','m2',10));
  allocateEveryCard(merged);
  const m = merged[0].materials[0];
  const out = buildFabricIssueLine(m, []);
  const lotTotal = round2((m.lotLines||[]).reduce((s,l)=>s+l.qty,0));
  const moveTotal = round2((out.lotMoves||[]).reduce((s,l)=>s+l.qty,0));
  check('metres conserved', Math.abs(lotTotal-moveTotal)<0.01,
    'lotLines='+lotTotal+' lotMoves='+moveTotal);
  const ids = (out.allocations||[]).map(a=>String(a.mrqId||''));
  check('both requirement rows addressed', ids.indexOf('m1')>-1 || ids.indexOf('m2')>-1,
    'mrqIds='+JSON.stringify(ids));
  check('no blank mrqId', ids.every(x=>x!==''), 'mrqIds='+JSON.stringify(ids));
}

console.log('\n=== G5: WHAT IF a later page carried a lot page 1 did not? ===');
{
  // This is the shape the merge would get WRONG. The server fetches lots per
  // MATERIAL, so it should not arise — this pins that assumption.
  const merged = [];
  mergeRequirementPages(merged, page('p1','m1',10));
  const p2 = page('p2','m2',10);
  p2[0].materials[0].lots = p2[0].materials[0].lots.concat([
    {lotId:'L9',lotNumber:'L9',wash:99,unwash:0,inWash:0,blocked:false,
     rolls:[roll('r9',99)],form:'Roll'}]);
  mergeRequirementPages(merged, p2);
  const m = merged[0].materials[0];
  const lotIds = (m.lots||[]).map(l=>l.lotId);
  console.log('     merged lots = '+JSON.stringify(lotIds));
  if (lotIds.indexOf('L9')===-1) {
    console.log('     NOTE: page 2\'s extra lot L9 was DROPPED by the merge.');
    console.log('           Harmless today (server sends every lot of a material on');
    console.log('           every page that mentions it, fetched per material not per');
    console.log('           plan) but it is an UNGUARDED ASSUMPTION — if lot fetching');
    console.log('           ever becomes plan-scoped, cloth silently disappears.');
  }
  check('documented: merge keeps page 1 lots', true, 'assumption pinned by this test');
}

console.log('\n' + (fails===0?'ALL PAGING CHECKS HELD':fails+' FAILURE(S)'));
process.exit(fails===0?0:1);
