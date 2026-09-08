// AUDIT of the ALLOCATOR -> PAYLOAD boundary (buildFabricIssueLine).
// The allocator can be perfect and still lose cloth here: this is where its
// answer becomes the instruction issueMaterials applies with point lookups.
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

const { allocateEveryCard, applyFabricOverride, buildFabricIssueLine, round2 } = sb;

let fails = 0;
const check = (n,c,d) => { if(!c){fails++;console.log('  FAIL '+n+'  '+d);} else console.log('  ok   '+n+(d?'  '+d:'')); };

const roll = (id,len) => ({ rollId:id, label:id.toUpperCase(), length:len, status:'Available' });
const mkMat = (o) => Object.assign({
  materialId:'9', material:'Linen', sku:'RM-9', unit:'Mtr', isFabric:true,
  fabricWidthCm:150, lots:[], wasteStock:[], lines:[]
}, o);

// Sum helper over the payload
const sumRolls = (arr) => {
  const by = {};
  (arr||[]).forEach(x => (x.rolls||[]).forEach(r => {
    by[x.lotId + '|' + r.rollId] = round2((by[x.lotId+'|'+r.rollId]||0) + r.metres);
  }));
  return by;
};

console.log('=== P1: lotMoves metres == sum of lotLines metres ===');
{
  const m = mkMat({
    lots:[{lotId:'L1',lotNumber:'L1',wash:1000,unwash:0,inWash:0,blocked:false,
           rolls:[roll('r1',50),roll('r2',30)],form:'Roll'}],
    lines:[{planId:'p1',planItemId:'i1',mrqId:'m1',cutW:150,cutL:100,reqPieces:20,issPieces:0}]
  });
  allocateEveryCard([{supervisorId:'A',supervisorName:'A',materials:[m]}]);
  const out = buildFabricIssueLine(m, []);
  const lotTotal = round2((m.lotLines||[]).reduce((s,l)=>s+l.qty,0));
  const moveTotal = round2((out.lotMoves||[]).reduce((s,l)=>s+l.qty,0));
  check('metres conserved into lotMoves', Math.abs(lotTotal-moveTotal)<0.01,
    'lotLines='+lotTotal+' lotMoves='+moveTotal);
}

console.log('\n=== P2: per-roll metres in lotMoves never exceed the roll ===');
{
  const m = mkMat({
    lots:[{lotId:'L1',lotNumber:'L1',wash:1000,unwash:0,inWash:0,blocked:false,
           rolls:[roll('r1',12),roll('r2',9)],form:'Roll'}],
    lines:[
      {planId:'p1',planItemId:'i1',mrqId:'m1',cutW:150,cutL:100,reqPieces:8,issPieces:0},
      {planId:'p2',planItemId:'i2',mrqId:'m2',cutW:150,cutL:100,reqPieces:8,issPieces:0}
    ]
  });
  allocateEveryCard([{supervisorId:'A',supervisorName:'A',materials:[m]}]);
  const out = buildFabricIssueLine(m, []);
  const by = sumRolls(out.lotMoves);
  check('r1 within 12', (by['L1|r1']||0) <= 12.0001, 'r1='+by['L1|r1']);
  check('r2 within 9',  (by['L1|r2']||0) <= 9.0001,  'r2='+by['L1|r2']);
}

console.log('\n=== P3: THE rollsShared PATH — a hand edit must not double-charge rolls ===');
{
  const m = mkMat({
    lots:[{lotId:'L1',lotNumber:'L1',wash:1000,unwash:0,inWash:0,blocked:false,
           rolls:[roll('r1',50)],form:'Roll'}],
    lines:[
      {planId:'p1',planItemId:'i1',mrqId:'m1',cutW:150,cutL:100,reqPieces:5,issPieces:0},
      {planId:'p2',planItemId:'i2',mrqId:'m2',cutW:150,cutL:100,reqPieces:5,issPieces:0}
    ]
  });
  allocateEveryCard([{supervisorId:'A',supervisorName:'A',materials:[m]}]);
  applyFabricOverride(m, 'L1', 14);        // one edit spanning BOTH lines
  const out = buildFabricIssueLine(m, []);
  const by = sumRolls(out.lotMoves);
  const moveTotal = round2((out.lotMoves||[]).reduce((s,l)=>s+l.qty,0));
  const shared = (m.lotLines||[]).some(l=>l.rollsShared);
  console.log('     rollsShared=' + shared + '  lotLines=' +
    JSON.stringify((m.lotLines||[]).map(l=>({mrq:l.mrqId,qty:l.qty,rolls:(l.rolls||[]).map(r=>r.rollId+':'+r.metres)}))));
  check('lotMoves qty == typed metres', Math.abs(moveTotal-14)<0.01, 'lotMoves qty='+moveTotal);
  check('roll charged ONCE, not per line', (by['L1|r1']||0) <= 14.0001,
    'r1 charged='+by['L1|r1']+' (double-charge would read 28)');
}

console.log('\n=== P4: giveRaw/giveWaste never exceed what the mrq owes ===');
{
  const m = mkMat({
    lots:[{lotId:'L1',lotNumber:'L1',wash:1000,unwash:0,inWash:0,blocked:false,
           rolls:[roll('r1',500)],form:'Roll'}],
    wasteStock:[{wasteId:'w1',lotId:'L1',width:150,length:400,pieces:5}],
    lines:[{planId:'p1',planItemId:'i1',mrqId:'m1',cutW:150,cutL:100,reqPieces:6,issPieces:0}]
  });
  allocateEveryCard([{supervisorId:'A',supervisorName:'A',materials:[m]}]);
  const picks = (m.wastePicks||[]).map(p=>({wasteId:p.wasteId,pieces:p.pieces,
    planItemId:p.planItemId,mrqId:p.mrqId}));
  const out = buildFabricIssueLine(m, picks);
  (out.allocations||[]).forEach(a=>{
    const owed = 6;
    const got = (Number(a.giveRaw)||0)+(Number(a.giveWaste)||0);
    check('mrq '+a.mrqId+' not over-credited', got<=owed,
      'giveRaw='+a.giveRaw+' giveWaste='+a.giveWaste+' owed='+owed);
  });
}

console.log('\n=== P5: every allocation names a real mrqId ===');
{
  const m = mkMat({
    lots:[{lotId:'L1',lotNumber:'L1',wash:1000,unwash:0,inWash:0,blocked:false,
           rolls:[roll('r1',500)],form:'Roll'}],
    lines:[
      {planId:'p1',planItemId:'i1',mrqId:'m1',cutW:150,cutL:100,reqPieces:4,issPieces:0},
      {planId:'p1',planItemId:'i1',mrqId:'m2',cutW:75, cutL:200,reqPieces:4,issPieces:0}
    ]
  });
  allocateEveryCard([{supervisorId:'A',supervisorName:'A',materials:[m]}]);
  const out = buildFabricIssueLine(m, []);
  const known = ['m1','m2'];
  const ids = (out.allocations||[]).map(a=>String(a.mrqId||''));
  check('no blank mrqId', ids.every(x=>x!==''), 'ids='+JSON.stringify(ids));
  check('all known', ids.every(x=>known.indexOf(x)>-1), 'ids='+JSON.stringify(ids));
  check('BOTH requirement rows present', ids.indexOf('m1')>-1 && ids.indexOf('m2')>-1,
    'ids='+JSON.stringify(ids)+' (merging the two loses one requirement for ever)');
}

console.log('\n=== P6: a fully-issued row produces an EMPTY payload ===');
{
  const m = mkMat({
    lots:[{lotId:'L1',lotNumber:'L1',wash:1000,unwash:0,inWash:0,blocked:false,
           rolls:[roll('r1',500)],form:'Roll'}],
    lines:[{planId:'p1',planItemId:'i1',mrqId:'m1',cutW:150,cutL:100,reqPieces:5,issPieces:5,
            issuedLot:'L1',issuedLotNo:'L1'}]
  });
  allocateEveryCard([{supervisorId:'A',supervisorName:'A',materials:[m]}]);
  const out = buildFabricIssueLine(m, []);
  check('no allocations', (out.allocations||[]).length===0, 'n='+(out.allocations||[]).length);
  check('no lotMoves', (out.lotMoves||[]).length===0, 'n='+(out.lotMoves||[]).length);
}

console.log('\n=== P7: waste-only order still carries the LOT (the tone record) ===');
{
  // Covered entirely by offcuts => no lotLine at all. issuedLot must still be set
  // or the remake is free to be cut off any lot (CLAUDE.md: the pin defect).
  const m = mkMat({
    lots:[{lotId:'L2',lotNumber:'L2',wash:0,unwash:0,inWash:0,blocked:false,rolls:[],form:'Roll'}],
    wasteStock:[{wasteId:'w1',lotId:'L2',width:150,length:400,pieces:5}],
    lines:[{planId:'p1',planItemId:'i1',mrqId:'m1',cutW:150,cutL:100,reqPieces:4,issPieces:0}]
  });
  allocateEveryCard([{supervisorId:'A',supervisorName:'A',materials:[m]}]);
  const picks = (m.wastePicks||[]).map(p=>({wasteId:p.wasteId,pieces:p.pieces,
    planItemId:p.planItemId,mrqId:p.mrqId}));
  console.log('     wastePicks=' + JSON.stringify((m.wastePicks||[]).map(p=>({w:p.wasteId,pc:p.pieces,lot:p.lotId}))));
  const out = buildFabricIssueLine(m, picks);
  const withLot = (out.allocations||[]).filter(a=>String(a.issuedLot||'')!=='');
  check('the tone is recorded even with no fresh cloth',
    (out.allocations||[]).length===0 || withLot.length>0,
    'allocations=' + JSON.stringify((out.allocations||[]).map(a=>({mrq:a.mrqId,lot:a.issuedLot,gw:a.giveWaste}))));
}

console.log('\n=== P8: TOTAL CONSERVATION — payload metres == what left the rack ===');
{
  let seed=7; const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};
  const ri=(a,b)=>a+Math.floor(rnd()*(b-a+1));
  let bad=0;
  for(let t=0;t<400;t++){
    const rolls=[]; for(let i=0,n=ri(1,3);i<n;i++) rolls.push(roll('r'+i,round2(ri(3,40))));
    const lines=[]; for(let i=0,n=ri(1,3);i<n;i++)
      lines.push({planId:'p'+i,planItemId:'i'+i,mrqId:'m'+i,
        cutW:ri(40,150),cutL:ri(40,150),reqPieces:ri(1,20),issPieces:0});
    const m = mkMat({ lots:[{lotId:'L1',lotNumber:'L1',wash:round2(ri(0,300)),unwash:0,
      inWash:0,blocked:false,rolls,form:'Roll'}], lines });
    allocateEveryCard([{supervisorId:'A',supervisorName:'A',materials:[m]}]);
    const out = buildFabricIssueLine(m, []);
    const by = sumRolls(out.lotMoves);
    rolls.forEach(r=>{
      if((by['L1|'+r.rollId]||0) > r.length+0.0001){
        bad++; if(bad<4) console.log('     roll over-issued t='+t+' '+r.rollId+
          ' len='+r.length+' charged='+by['L1|'+r.rollId]);
      }
    });
    const lotTotal=round2((m.lotLines||[]).reduce((s,l)=>s+l.qty,0));
    const moveTotal=round2((out.lotMoves||[]).reduce((s,l)=>s+l.qty,0));
    if(Math.abs(lotTotal-moveTotal)>0.02){ bad++; if(bad<4) console.log('     metres lost t='+t+' '+lotTotal+' vs '+moveTotal); }
  }
  check('400 randomised payloads conserve metres', bad===0, bad+' violations');
}

console.log('\n' + (fails===0?'ALL PAYLOAD CHECKS HELD':fails+' FAILURE(S)'));
process.exit(fails===0?0:1);
