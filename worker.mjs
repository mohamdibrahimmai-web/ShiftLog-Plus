export const BRANCHES = ['Motor City','Al Rigga','DIFC','Festival','Um Al Sheif','Al Qana'];
const encoder = new TextEncoder();
const json = (value, status = 200, headers = {}) => Response.json(value, {status, headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
export const blank = branch => ({version:5,branch,staff:[],staffMeta:{},unavailable:[],openBreaks:{},breakLog:[],extraAllowances:[],auditLog:[],updatedAt:new Date().toISOString()});
async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
function equal(a,b) { if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false; let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0; }
export function validate(s,branch) {
  const object = x => x && typeof x==='object' && !Array.isArray(x);
  if(!object(s)||s.branch!==branch||s.version!==5)throw Error('Invalid branch state');
  const fields=['version','branch','staff','staffMeta','unavailable','openBreaks','breakLog','extraAllowances','auditLog','updatedAt'];
  if(Object.keys(s).some(k=>!fields.includes(k)))throw Error('Unknown state field');
  if(!Array.isArray(s.staff)||s.staff.length>1000||s.staff.some(n=>typeof n!=='string'||!n||n.length>160||['__proto__','constructor','prototype'].includes(n))||new Set(s.staff).size!==s.staff.length)throw Error('Invalid staff');
  const known = n => s.staff.includes(n);
  if(!object(s.staffMeta)||!object(s.openBreaks)||!Array.isArray(s.unavailable)||s.unavailable.some(n=>!known(n)))throw Error('Invalid team fields');
  for(const [n,m] of Object.entries(s.staffMeta))if(!known(n)||!object(m)||Object.keys(m).some(k=>!['name','employeeNo','job'].includes(k))||['name','employeeNo','job'].some(k=>typeof m[k]!=='string'||m[k].length>160))throw Error('Invalid staff metadata');
  for(const [n,t] of Object.entries(s.openBreaks))if(!known(n)||s.unavailable.includes(n)||typeof t!=='string'||!Number.isFinite(Date.parse(t)))throw Error('Invalid active break');
  for(const field of ['breakLog','auditLog','extraAllowances']) {
    if(!Array.isArray(s[field])||s[field].length>10000)throw Error('Too many records');
    const ids=new Set();
    for(const r of s[field]) {
      if(!object(r)||typeof r.id!=='string'||!r.id||r.id.length>160||ids.has(r.id)||!known(r.staff))throw Error('Invalid record');
      ids.add(r.id);
      if(field==='breakLog'&&(!Number.isFinite(r.durationSeconds)||r.durationSeconds<0||r.durationSeconds>86400||!Number.isFinite(Date.parse(r.start))||!Number.isFinite(Date.parse(r.end))))throw Error('Invalid break');
      if(field==='auditLog'&&(!Number.isFinite(Date.parse(r.at))||typeof r.type!=='string'||typeof r.details!=='string'||typeof r.note!=='string'||r.note.length>2000))throw Error('Invalid audit');
      if(field==='extraAllowances'&&(!/^\d{4}-\d{2}-\d{2}$/.test(r.date)||!Number.isInteger(r.count)||r.count<1||r.count>20))throw Error('Invalid allowance');
    }
  }
  return s;
}
async function body(request,limit=1048576) {
  if(!request.headers.get('content-type')?.startsWith('application/json'))throw Error('JSON required');
  if(Number(request.headers.get('content-length'))>limit)throw Error('Payload too large');
  const reader=request.body?.getReader();if(!reader)throw Error('Body required');
  let chunks=[],size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw Error('Payload too large')}chunks.push(value);}
  const data=new Uint8Array(size);let offset=0;for(const c of chunks){data.set(c,offset);offset+=c.length;}return JSON.parse(new TextDecoder().decode(data));
}
async function session(request,env) {
  try {
    const raw=request.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-shiftlog='))?.slice(16);
    if(!raw)return null;const [payload,signature]=raw.split('.');
    if(!equal(signature,await hmac(env.SESSION_SECRET,payload)))return null;
    const s=JSON.parse(atob(payload));return BRANCHES.includes(s.branch)&&s.exp>Date.now()?s:null;
  }catch{return null}
}
const cookie = value => '__Host-shiftlog='+value+'; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800';
export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(!url.pathname.startsWith('/api/'))return env.ASSETS.fetch(request);
    if(!env.DB||!env.SESSION_SECRET||env.SESSION_SECRET.length<32||!env.BRANCH_PASSWORDS)return json({error:'Server authentication is not configured'},503);
    if(!['GET','POST','PUT'].includes(request.method))return json({error:'Method not allowed'},405);
    if(request.method!=='GET'&&(request.headers.get('origin')!==url.origin||request.headers.get('X-ShiftLog')!=='1'))return json({error:'Invalid origin'},403);
    try {
      if(url.pathname==='/api/login'&&request.method==='POST') {
        const {branch,password}=await body(request,4096);
        if(!BRANCHES.includes(branch)||typeof password!=='string'||password.length>256)return json({error:'Invalid credentials'},401);
        const window=Math.floor(Date.now()/900000);
        const bucket=await hmac(env.SESSION_SECRET,(request.headers.get('CF-Connecting-IP')||'local')+'|'+branch+'|'+window);
        const row=await env.DB.prepare('INSERT INTO login_attempts(bucket,attempts,expires_at) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts').bind(bucket,Date.now()+900000).first();
        if(row.attempts>10)return json({error:'Try again in 15 minutes'},429);
        const passwords=JSON.parse(env.BRANCH_PASSWORDS);
        // Store branch passwords as HMAC-SHA256 digests keyed by SESSION_SECRET.
        if(!equal(passwords[branch],await hmac(env.SESSION_SECRET,branch+'|'+password)))return json({error:'Invalid credentials'},401);
        await env.DB.prepare('DELETE FROM login_attempts WHERE expires_at < ?').bind(Date.now()).run();
        const payload=btoa(JSON.stringify({branch,exp:Date.now()+28800000}));
        return json({branch},200,{'Set-Cookie':cookie(payload+'.'+await hmac(env.SESSION_SECRET,payload))});
      }
      if(url.pathname==='/api/logout'&&request.method==='POST')return json({ok:true},200,{'Set-Cookie':'__Host-shiftlog=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'});
      const auth=await session(request,env);if(!auth)return json({error:'Sign in required'},401);
      if(url.pathname==='/api/session'&&request.method==='GET')return json({branch:auth.branch});
      if(url.pathname!=='/api/state')return json({error:'Not found'},404);
      if(url.searchParams.get('branch')!==auth.branch)return json({error:'Branch access denied'},403);
      const branch=auth.branch;
      if(request.method==='GET') {
        const row=await env.DB.prepare('SELECT revision,data FROM branch_state WHERE branch=?').bind(branch).first();
        return json(row?{revision:row.revision,data:JSON.parse(row.data)}:{revision:0,data:blank(branch)});
      }
      if(request.method==='PUT') {
        const {revision,data}=await body(request);
        if(!Number.isSafeInteger(revision)||revision<0)return json({error:'Invalid revision'},400);
        validate(data,branch);data.updatedAt=new Date().toISOString();
        // One atomic compare-and-swap prevents stale devices overwriting newer state.
        const row=await env.DB.prepare('INSERT INTO branch_state(branch,revision,data,updated_at) SELECT ?,?+1,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM branch_state WHERE branch=? AND revision=?) ON CONFLICT(branch) DO UPDATE SET revision=branch_state.revision+1,data=excluded.data,updated_at=excluded.updated_at WHERE branch_state.revision=? RETURNING revision').bind(branch,revision,JSON.stringify(data),data.updatedAt,revision,branch,revision,revision).first();
        if(!row) return json({error:'Conflict: another device changed this branch'},409);
        return json({revision:row.revision,data});
      }
      return json({error:'Method not allowed'},405);
    }catch(error) { return json({error:error.message.startsWith('Invalid')||['JSON required','Payload too large','Body required','Unknown state field','Too many records'].includes(error.message)?error.message:'Request failed'},400); }
  }
};
