import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
function device(){
  const storage=new Map(),elements=new Map(),pending=[];
  const element=id=>{if(!elements.has(id))elements.set(id,{textContent:'',hidden:true,disabled:false,value:''});return elements.get(id);};
  const c={console,JSON,Date,Promise,encodeURIComponent,AbortController,setTimeout,clearTimeout,setInterval(){},fetch:async()=>{throw Error('offline')},confirm:()=>true,
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
    document:{getElementById:element,querySelectorAll:()=>[]},
    normalize:x=>JSON.parse(JSON.stringify(x)),emptyState:()=>({version:5,branch:'',staff:[],staffMeta:{},unavailable:[],openBreaks:{},breakLog:[],extraAllowances:[],auditLog:[]}),
    renderAll(){},showTab(){},toast(){},load(){return this.emptyState()},addEventListener(){},
    state:{branch:''},...Object.fromEntries(['toggleUnavailable','toggleBreak','openManager','saveManagerAction','addStaff','editStaff','removeStaff','commitImport','confirmDeleteAction'].map(k=>[k,()=>{pending.push(k)}]))};
  c.window=c;vm.createContext(c);vm.runInContext(fs.readFileSync(new URL('./public/sync.js',import.meta.url),'utf8'),c);
  return {c,storage,element,pending,run:s=>vm.runInContext(s,c)};
}
test('branch switch never carries another branch staff; anonymous mutations guarded',()=>{
  const d=device();d.run("setBranch('Motor City');state.staff=['A'];syncSession='Motor City';syncDirty=true;persistSync();setBranch('DIFC')");
  assert.deepEqual([...d.run('state.staff')],[]);d.run('addStaff()');assert.equal(d.pending.length,0);
  d.run("setBranch('Motor City')");assert.deepEqual([...d.run('state.staff')],['A']);
});
test('offline saves retained; conflicts lock edits and preserve local state',async()=>{
  const d=device();d.run("setBranch('Motor City');syncSession='Motor City';state.staff=['A'];save()");
  await new Promise(r=>setImmediate(r));
  assert.equal(JSON.parse(d.storage.get('shiftlog.plus.sync.v1:Motor City')).dirty,true);
  d.c.fetch=async()=>({ok:false,status:409,json:async()=>({error:'Conflict'})});
  await d.run('synchronize()');assert.equal(d.run('syncConflict'),true);d.run('addStaff()');assert.equal(d.pending.length,0);
  assert.deepEqual([...d.run('state.staff')],['A']);
});
test('late response after branch switch cannot overwrite selected branch',async()=>{
  const d=device();d.run("setBranch('Motor City');syncSession='Motor City'");
  const requests=[];d.c.fetch=()=>new Promise(resolve=>requests.push(resolve));
  const waiting=d.run('synchronize()');d.run("setBranch('DIFC')");
  requests[0]({ok:true,json:async()=>({revision:5,data:{branch:'Motor City',staff:['wrong']}})});
  await waiting;assert.equal(d.run('state.branch'),'DIFC');assert.deepEqual([...d.run('state.staff')],[]);
});
test('restore refuses cross-branch backup',async()=>{
  const d=device();d.run("setBranch('Motor City');syncSession='Motor City'");
  d.c.restoreEvent={target:{files:[{text:async()=>JSON.stringify({data:{branch:'DIFC',staff:['other']}})}],value:'file'}};
  d.run('restoreFile(restoreEvent)');await new Promise(r=>setImmediate(r));assert.deepEqual([...d.run('state.staff')],[]);
});

test('login shows pending and failure, prevents duplicate requests and allows retry',async()=>{
  const d=device();d.run("setBranch('DIFC')");await new Promise(r=>setImmediate(r));
  d.element('branchPassword').value='existing-password';
  let resolve,count=0;d.c.fetch=()=>{count++;return new Promise(r=>resolve=r)};
  const first=d.run('signIn()');assert.equal(d.element('syncStatus').textContent,'Signing in to DIFC…');
  await d.run('signIn()');assert.equal(count,1);
  resolve({ok:false,status:401,json:async()=>({error:'Invalid credentials'})});await first;
  assert.equal(d.element('syncStatus').textContent,'Sign in failed · Invalid credentials');
  assert.equal(d.run('loginBusy'),false);assert.equal(d.element('branchPassword').value,'existing-password');
});

test('successful login clears password and syncs branch data',async()=>{
  const d=device();d.run("setBranch('DIFC')");await new Promise(r=>setImmediate(r));
  d.element('branchPassword').value='existing-password';
  d.c.fetch=async(path)=>({ok:true,json:async()=>path.includes('login')?{branch:'DIFC'}:{revision:0,data:{branch:'DIFC',staff:[]}}});
  await d.run('signIn()');assert.equal(d.element('branchPassword').value,'');
  assert.equal(d.element('syncStatus').textContent,'Synced · DIFC');assert.equal(d.run('syncSession'),'DIFC');
});
