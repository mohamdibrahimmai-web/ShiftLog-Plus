// Branch snapshots use compare-and-swap. Conflicts remain local until reviewed.
const BRANCHES=['Motor City','Al Rigga','DIFC','Festival','Um Al Sheif','Al Qana'];
const cacheKey=b=>'shiftlog.plus.sync.v1:'+b;
let syncSession='',syncRevision=0,syncDirty=false,syncBusy=false,syncConflict=false,syncGeneration=0,syncCounter=0;
function syncStatus(message){document.getElementById('syncStatus').textContent=message;}
function persistSync(){if(!state.branch)return;localStorage.setItem(cacheKey(state.branch),JSON.stringify({data:state,revision:syncRevision,dirty:syncDirty,conflict:syncConflict}));}
function readCache(branch){try{return JSON.parse(localStorage.getItem(cacheKey(branch))||'null')}catch{return null}}
async function api(path,method='GET',data){
  const response=await fetch('/api/'+path,{method,credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-ShiftLog':'1'},...(data?{body:JSON.stringify(data)}:{})});
  const result=await response.json();if(!response.ok){const e=Error(result.error||'Request failed');e.status=response.status;throw e;}return result;
}
function lockEditing(){
  // Keep navigation, backup and login available; data editing requires a branch session.
  const active=!!state.branch&&syncSession===state.branch&&!syncConflict;
  document.querySelectorAll('[onclick]').forEach(el=>{
    if(/^(toggleUnavailable|toggleBreak|openManager|saveManagerAction|addStaff|editStaff|removeStaff|commitImport|confirmDeleteAction|requestClear|requestDelete)/.test(el.getAttribute('onclick')||''))el.disabled=!active;
  });
  document.getElementById('restore').disabled=!active;
}
const originalRenderAll=renderAll;
renderAll=function(){originalRenderAll();lockEditing();};
// Guard functions too: switching tabs rebuilds controls outside renderAll().
for(const name of ['toggleUnavailable','toggleBreak','openManager','saveManagerAction','addStaff','editStaff','removeStaff','commitImport','confirmDeleteAction']){
  const original=window[name];
  window[name]=function(...args){
    if(!state.branch||syncSession!==state.branch||syncConflict){toast('Sign in first; resolve any conflict');return;}
    return original(...args);
  };
}
const originalShowTab=showTab;
showTab=function(tab){originalShowTab(tab);lockEditing();};
save=function(){
  if(!state.branch||syncSession!==state.branch||syncConflict){toast('Sign in to this branch before changing data');return;}
  state.updatedAt=new Date().toISOString();syncDirty=true;syncCounter++;persistSync();renderAll();
  syncStatus('Saved on this device · waiting for sync');void synchronize();
};
reloadState=function(){void synchronize();};
setBranch=function(branch){
  if(!BRANCHES.includes(branch))branch='';
  syncGeneration++;syncCounter++;syncSession='';syncBusy=false;syncConflict=false;
  const cached=readCache(branch);state=normalize(cached?.data||{...emptyState(),branch});state.branch=branch;
  syncRevision=cached?.revision||0;syncDirty=!!cached?.dirty;syncConflict=!!cached?.conflict;
  localStorage.setItem('shiftlog.plus.selectedBranch',branch);renderAll();
  syncStatus(branch?'Sign in to '+branch:'Select a branch');
  document.getElementById('conflictControls').hidden=!syncConflict;
  void resumeSession();
};
async function resumeSession(){
  const generation=syncGeneration;
  try{const s=await api('session');if(generation!==syncGeneration)return;if(s.branch===state.branch){syncSession=s.branch;renderAll();void synchronize();}}
  catch{if(generation===syncGeneration)syncStatus(state.branch?'Sign in to '+state.branch:'Select a branch');}
}
async function signIn(){
  if(!state.branch){toast('Select a branch first');return;}
  const field=document.getElementById('branchPassword'),password=field.value;field.value='';
  const branch=state.branch,generation=syncGeneration;
  try{await api('login','POST',{branch,password});if(generation!==syncGeneration)return;syncSession=branch;renderAll();await synchronize();}
  catch(e){syncStatus(e.message);}
}
async function signOut(){
  try{await api('logout','POST');syncGeneration++;syncSession='';renderAll();syncStatus('Signed out · local backup retained');}
  catch(e){syncStatus(e.message);}
}
async function synchronize(){
  const branch=state.branch;
  if(!branch||syncSession!==branch||syncBusy||syncConflict)return;
  const generation=syncGeneration;syncBusy=true;
  try{
    if(syncDirty){
      const counter=syncCounter;
      const result=await api('state?branch='+encodeURIComponent(branch),'PUT',{revision:syncRevision,data:JSON.parse(JSON.stringify(state))});
      if(generation!==syncGeneration)return;
      syncRevision=result.revision;
      if(counter===syncCounter){state=normalize(result.data);syncDirty=false;}
      persistSync();renderAll();syncStatus(syncDirty?'New changes waiting for sync':'Synced · '+branch);
    }else{
      const counter=syncCounter,result=await api('state?branch='+encodeURIComponent(branch));
      if(generation!==syncGeneration||counter!==syncCounter||syncDirty)return;
      state=normalize(result.data);syncRevision=result.revision;persistSync();renderAll();syncStatus('Synced · '+branch);
    }
  }catch(e){
    if(generation!==syncGeneration)return;
    if(e.status===409){syncConflict=true;persistSync();renderAll();document.getElementById('conflictControls').hidden=false;syncStatus('Conflict: another device saved changes. Your local copy is retained.');}
    else if(e.status===401||e.status===403){syncSession='';renderAll();syncStatus('Sign in to this branch again');}
    else syncStatus('Not synced · '+e.message+' · local changes retained');
  }finally{if(generation===syncGeneration)syncBusy=false;}
}
async function useServerCopy(){
  if(syncBusy||syncSession!==state.branch)return;
  if(!confirm('Save your local copy as a recovery backup, then use the latest server data?'))return;
  const branch=state.branch,generation=syncGeneration,counter=syncCounter;
  syncBusy=true;
  try{
    const r=await api('state?branch='+encodeURIComponent(branch));
    if(generation!==syncGeneration||counter!==syncCounter)return;
    localStorage.setItem(cacheKey(branch)+':recovery:'+Date.now(),JSON.stringify(state));
    state=normalize(r.data);syncRevision=r.revision;syncDirty=false;syncConflict=false;persistSync();renderAll();
    document.getElementById('conflictControls').hidden=true;syncStatus('Synced · '+branch);
  }catch(e){syncStatus(e.message);}finally{if(generation===syncGeneration)syncBusy=false;}
}
restoreFile=function(e){
  const file=e.target.files?.[0];e.target.value='';if(!file)return;
  const branch=state.branch,generation=syncGeneration;
  if(!branch||syncSession!==branch||syncConflict){toast('Sign in first; resolve any conflict');return;}
  file.text().then(text=>{
    if(generation!==syncGeneration)return;
    try{const j=JSON.parse(text),data=j.data||j;if(data.branch!==branch){toast('Backup belongs to a different branch');return;}
      if(confirm('Replace this branch with the selected backup?')){state=normalize(data);save();}
    }catch{toast('Invalid backup file');}
  });
};
function importLegacy(){
  if(!state.branch||syncSession!==state.branch||syncConflict)return;
  const raw=load();
  if(raw.branch!==state.branch){toast('Legacy data has no matching branch. Use Backup to preserve it.');return;}
  if(!confirm('Import old local data into '+state.branch+'? This replaces the current branch data.'))return;
  localStorage.setItem(cacheKey(state.branch)+':recovery:'+Date.now(),JSON.stringify(state));
  state=raw;save();
}
setInterval(()=>void synchronize(),5000);
window.addEventListener('online',()=>void synchronize());
window.addEventListener('beforeunload',e=>{if(syncDirty){e.preventDefault();e.returnValue='';}});
setBranch(localStorage.getItem('shiftlog.plus.selectedBranch')||'');
