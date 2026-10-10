import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker,{blank,validate} from './worker.mjs';
import {createHmac} from 'node:crypto';
function setup(){
  const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('./0001_branch_sync.sql',import.meta.url),'utf8'));
  const secret='unit-test-only-secret-never-deploy-this-value';
  const digest=branch=>createHmac('sha256',secret).update(branch+'|test-password').digest('hex');
  return {DB:{prepare(sql){return{bind(...args){return{async first(){return db.prepare(sql).get(...args)||null},async run(){return db.prepare(sql).run(...args)}}}}}},SESSION_SECRET:secret,BRANCH_PASSWORDS:JSON.stringify({'Motor City':digest('Motor City'),'DIFC':digest('DIFC')}),ASSETS:{fetch:()=>new Response('asset')}};
}
function request(path,method='GET',data,cookie,origin='https://test.example'){
  return new Request('https://test.example/api/'+path,{method,headers:{Origin:origin,'X-ShiftLog':'1','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(data?{body:JSON.stringify(data)}:{})});
}
async function login(env,branch='Motor City'){const response=await worker.fetch(request('login','POST',{branch,password:'test-password'}),env);assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];}
test('API fails closed without secrets; anonymous access rejected',async()=>{
  assert.equal((await worker.fetch(request('state?branch=Motor%20City'),{})).status,503);
  assert.equal((await worker.fetch(request('state?branch=Motor%20City'),setup())).status,401);
});
test('two devices synchronize additions, active/completed breaks and manager records',async()=>{
  const env=setup(),a=await login(env),b=await login(env),path='state?branch=Motor%20City';
  const state=blank('Motor City');state.staff=['Test 101'];state.staffMeta={'Test 101':{name:'Test',employeeNo:'101',job:'Waiter'}};
  state.openBreaks={'Test 101':new Date().toISOString()};
  let response=await worker.fetch(request(path,'PUT',{revision:0,data:state},a),env);assert.equal(response.status,200);
  let read=await (await worker.fetch(request(path,'GET',null,b),env)).json();assert.equal(read.revision,1);assert.ok(read.data.openBreaks['Test 101']);
  read.data.openBreaks={};read.data.breakLog=[{id:'b1',staff:'Test 101',start:new Date().toISOString(),end:new Date().toISOString(),durationSeconds:60,breakNumber:1}];
  read.data.auditLog=[{id:'a1',staff:'Test 101',type:'edit',details:'1 min',note:'test',at:new Date().toISOString()}];
  response=await worker.fetch(request(path,'PUT',{revision:1,data:read.data},b),env);assert.equal(response.status,200);
  read=await(await worker.fetch(request(path,'GET',null,a),env)).json();assert.equal(read.revision,2);assert.equal(read.data.breakLog.length,1);assert.equal(read.data.auditLog.length,1);
});
test('stale device cannot overwrite changes, including revision zero',async()=>{
  const env=setup(),cookie=await login(env),path='state?branch=Motor%20City',data=blank('Motor City');
  assert.equal((await worker.fetch(request(path,'PUT',{revision:0,data},cookie),env)).status,200);
  assert.equal((await worker.fetch(request(path,'PUT',{revision:0,data},cookie),env)).status,409);
  assert.equal((await worker.fetch(request(path,'PUT',{revision:1,data},cookie),env)).status,200);
  assert.equal((await worker.fetch(request(path,'PUT',{revision:1,data},cookie),env)).status,409);
});
test('branch authorization, isolation, and body branch enforcement',async()=>{
  const env=setup(),a=await login(env),b=await login(env,'DIFC');
  assert.equal((await worker.fetch(request('state?branch=DIFC','GET',null,a),env)).status,403);
  assert.equal((await worker.fetch(request('state?branch=Motor%20City','PUT',{revision:0,data:blank('DIFC')},a),env)).status,400);
  const result=await(await worker.fetch(request('state?branch=DIFC','GET',null,b),env)).json();assert.equal(result.revision,0);assert.deepEqual(result.data.staff,[]);
});
test('cross-origin writes, forged cookies and invalid records rejected',async()=>{
  const env=setup(),cookie=await login(env),path='state?branch=Motor%20City';
  assert.equal((await worker.fetch(request(path,'PUT',{revision:0,data:blank('Motor City')},cookie,'https://evil.example'),env)).status,403);
  assert.equal((await worker.fetch(request(path,'GET',null,cookie+'x'),env)).status,401);
  const data=blank('Motor City');data.staff=['__proto__'];assert.throws(()=>validate(data,'Motor City'));
  const invalid=blank('Motor City');invalid.breakLog=[{id:'b',staff:'unknown',durationSeconds:-1}];assert.throws(()=>validate(invalid,'Motor City'));
});
test('persistent login rate limiting and payload limits',async()=>{
  const env=setup();for(let i=0;i<10;i++)assert.equal((await worker.fetch(request('login','POST',{branch:'Motor City',password:'wrong'}),env)).status,401);
  assert.equal((await worker.fetch(request('login','POST',{branch:'Motor City',password:'wrong'}),env)).status,429);
  const other=setup(),cookie=await login(other);
  assert.equal((await worker.fetch(request('state?branch=Motor%20City','PUT',{revision:0,data:{padding:'x'.repeat(1048576)}},cookie),other)).status,400);
});
