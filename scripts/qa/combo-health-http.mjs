#!/usr/bin/env node
/** Mock-only real standalone HTTP QA. No production imports/config/credentials. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
const root = process.cwd();
const run = path.join(root, '.http-qa', new Date().toISOString().replaceAll(':','-'));
fs.mkdirSync(run,{recursive:true});
const data = path.join(run,'data'), runtime=path.join(run,'standalone');
fs.mkdirSync(path.join(data,'auth'),{recursive:true});
const raw='qa-'+crypto.randomUUID(), secret=crypto.randomBytes(32).toString('hex');
fs.writeFileSync(path.join(data,'machine-id'),raw); fs.writeFileSync(path.join(data,'auth/cli-secret'),secret,{mode:0o600});
const token=crypto.createHash('sha256').update(raw+'9r-cli-auth'+secret).digest('hex').slice(0,16);
const report={run,started:new Date().toISOString(),assertions:[],http:[],upstream:[],fixtures:[],cleanup:[],limitations:[]};
let child, db, mock, appPort, mockPort, base, failing=true, delay=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function check(name,ok,evidence){ report.assertions.push({name,passed:!!ok,evidence}); if(!ok) report.passed=false; }
async function port(){ const s=net.createServer(); s.listen(0,'127.0.0.1'); await once(s,'listening'); const p=s.address().port; await new Promise(r=>s.close(r)); return p; }
async function closed(p){ return new Promise(r=>{const s=net.connect(p,'127.0.0.1');s.once('error',()=>r(true));s.once('connect',()=>{s.destroy();r(false);});}); }
async function stop(){if(!child)return; const c=child;child=null;if(c.exitCode===null){ c.kill('SIGTERM'); await Promise.race([once(c,'exit'),sleep(5000)]);if(c.exitCode===null){c.kill('SIGKILL');await once(c,'exit');}}}
async function start(){const log=fs.openSync(path.join(run,`server-${report.cleanup.length}-${Date.now()}.log`),'a');
 const env={PATH:process.env.PATH,HOME:path.join(run,'home'),TMPDIR:path.join(run,'tmp'),NODE_ENV:'production',DATA_DIR:data,HOSTNAME:'127.0.0.1',PORT:String(appPort),EGRESS_PROBE_MODE:'off',NEXT_TELEMETRY_DISABLED:'1',NODE_OPTIONS:`--require=${path.join(run,'guard.cjs')}`};
 fs.mkdirSync(env.HOME,{recursive:true});fs.mkdirSync(env.TMPDIR,{recursive:true});
 child=spawn(process.execPath,['custom-server.js'],{cwd:runtime,env,stdio:['ignore',log,log]});fs.closeSync(log);
 for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error('Standalone exited '+child.exitCode);try{const r=await fetch(base+'/api/settings',{headers:{'x-9r-cli-token':token},signal:AbortSignal.timeout(1000)});if(r.ok)return;}catch{}await sleep(100);} throw Error('server readiness timeout'); }
async function api(url,method='GET',body,allowError=false){ const r=await fetch(base+url,{method,headers:{'content-type':'application/json','x-9r-cli-token':token},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const text=await r.text();let result;try{result=JSON.parse(text);}catch{result=text;}report.http.push({url,method,body,status:r.status,result});if(!r.ok&&!allowError)throw Error(`${method} ${url}: ${r.status} ${text}`);return result; }
const count=m=>report.upstream.filter(x=>x.model===m).length;
const health=()=>db.prepare("SELECT key,value FROM kv WHERE scope='comboState' ORDER BY key").all().map(r=>({...r,value:JSON.parse(r.value)}));
const state=(combo,model)=>health().find(r=>r.key===`health:${JSON.stringify([combo,model])}`)?.value;
function resetLocks(){const before=[];for(const row of db.prepare('SELECT id,data FROM providerConnections').all()){const v=JSON.parse(row.data);before.push({id:row.id,locks:Object.fromEntries(Object.entries(v).filter(([k])=>k.startsWith('modelLock_')||['rateLimitedUntil','backoffLevel','testStatus'].includes(k)))});for(const k of Object.keys(v))if(k.startsWith('modelLock_'))delete v[k];Object.assign(v,{rateLimitedUntil:null,backoffLevel:0,testStatus:'active',lastError:null,errorCode:null});db.prepare('UPDATE providerConnections SET data=? WHERE id=?').run(JSON.stringify(v),row.id);}report.fixtures.push({type:'reset isolated account locks (not combo health)',before});}
function expire(combo,model){const key=`health:${JSON.stringify([combo,model])}`,v=state(combo,model);check('failure exists before expiry',v?.failures>0,v);const after={...v,cooldownUntil:Date.now()-1000};db.prepare("UPDATE kv SET value=? WHERE scope='comboState' AND key=?").run(JSON.stringify(after),key);report.fixtures.push({type:'QA-only five-minute cooldown expiry',key,before:v,after});}
async function chat(model){return api('/v1/chat/completions','POST',{model,stream:false,messages:[{role:'user',content:'QA mock only hello'}]});}
let combo, nested;const p='qa/primary', f='qa/fallback';
const strategies={};
async function settings(enabled=true,name='qa-direct'){strategies[name]={strategy:'fallback',lkgpEnabled:enabled};strategies['qa-nested']={strategy:'fallback',lkgpEnabled:true};return api('/api/settings','PATCH',{requireApiKey:false,outboundProxyEnabled:false,comboStrategy:'fallback',comboStrategies:strategies});}
async function fresh(name){resetLocks();const c=await api('/api/combos','POST',{name,models:[p,f]});await settings(true,name);report.fixtures.push({type:'independent fresh combo via HTTP API',name});return c;}
try{
 check('built standalone exists',fs.existsSync(path.join(root,'.next/standalone/server.js')));
 fs.cpSync(path.join(root,'.next/standalone'),runtime,{recursive:true,filter:s=>!s.includes('/node_modules')});
 fs.symlinkSync(path.join(root,'.next/standalone/node_modules'),path.join(runtime,'node_modules'),'dir');
 // Guard all TCP connects, including undici. Only this run's mock and local server ports are allowed.
 mockPort=await port();appPort=await port();base=`http://127.0.0.1:${appPort}`;
 fs.writeFileSync(path.join(run,'guard.cjs'),`const net=require('node:net');const orig=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...a){const n=Array.isArray(a[0])?a[0]:net._normalizeArgs(a);const o=n[0];if(o.path)throw Error('QA blocks unix outbound');const h=o.host||'localhost';if(!['127.0.0.1','::1','localhost'].includes(h)||![${mockPort},${appPort}].includes(Number(o.port))){require('node:fs').appendFileSync(${JSON.stringify(path.join(run,'blocked-egress.log'))},JSON.stringify({host:h,port:o.port})+'\\n');throw Error('QA blocked outbound '+h+':'+o.port);}return orig.apply(this,a);};`);
 mock=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text||'{}');report.upstream.push({url:req.url,model:body.model,body,time:Date.now()});if(delay)await sleep(delay);res.setHeader('content-type','application/json');if(body.model==='primary'&&failing){res.statusCode=503;res.end(JSON.stringify({error:{message:'QA mock primary unavailable',type:'server_error'}}));}else res.end(JSON.stringify({id:'qa-mock',object:'chat.completion',created:1,model:body.model,choices:[{index:0,message:{role:'assistant',content:'mock '+body.model},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:2,total_tokens:3}}));});
 mock.listen(mockPort,'127.0.0.1');await once(mock,'listening');await start();
 const node=(await api('/api/provider-nodes','POST',{name:'QA mock',prefix:'qa',apiType:'chat',baseUrl:`http://127.0.0.1:${mockPort}/v1`,type:'openai-compatible'})).node;
 await api('/api/providers','POST',{provider:node.id,name:'QA fake credential',apiKey:'qa-not-a-real-key'});
 combo=await api('/api/combos','POST',{name:'qa-direct',models:[p,f]});nested=await api('/api/combos','POST',{name:'qa-nested',models:['qa-direct']});await settings();
 db=new Database(path.join(data,'db/data.sqlite')); db.pragma('busy_timeout=5000');
 let r=await chat('qa-direct');check('primary fails fallback works',r.choices?.[0]?.message?.content==='mock fallback'&&count('primary')>=1&&count('fallback')===1,{counts:[count('primary'),count('fallback')],health:health()});
 check('persistent combo failure distinct from account lock',state('qa-direct',p)?.failures===1,state('qa-direct',p));
 resetLocks();let n=count('primary');await chat('qa-direct');check('subsequent primary skipped after account lock reset',count('primary')===n,{primaryBefore:n,primaryAfter:count('primary'),health:health()});
 await stop();check('restart old port closed',await closed(appPort));await start();resetLocks();n=count('primary');await chat('qa-direct');check('health persistence across restart',count('primary')===n&&state('qa-direct',p)?.failures===1,health());
 r=await chat('qa-nested');check('nested real HTTP uses child combo health',r.choices?.[0]?.message?.content==='mock fallback'&&count('primary')===n,health());
 failing=false;expire('qa-direct',p);resetLocks();await chat('qa-direct');for(let i=0;i<100&&state('qa-direct',p)?.failures;i++)await sleep(50);check('expired cooldown recovery probe clears failure',state('qa-direct',p)?.failures===0,health());
 // Promotion can trail the failure clear; wait up to 5s for the pin, then assert the next request.
 const pinModel=()=>health().find(row=>row.key==='lkgp:qa-direct')?.value?.model??null;const pinWaitStart=Date.now();let pin=pinModel();for(let i=0;i<100&&pin!==p;i++){await sleep(50);pin=pinModel();}const pinWaitMs=Date.now()-pinWaitStart;report.recoveryPin={expected:p,observed:pin,waitMs:pinWaitMs};check('recovery promotion pin returns to primary',pin===p,{waitMs:pinWaitMs,pin:pinModel(),health:health()});
 n=count('fallback');r=await chat('qa-direct');check('recovery restores original primary priority',r.choices?.[0]?.message?.content==='mock primary'&&count('fallback')===n,{waitMs:pinWaitMs,pin:pinModel(),health:health()});
 // Independent scenarios never modify pins or conceal the recovery assertion above.
 await fresh('qa-concurrent');failing=true;await chat('qa-concurrent');expire('qa-concurrent',p);resetLocks();failing=false;delay=300;n=count('primary');await Promise.all(Array.from({length:5},()=>chat('qa-concurrent')));for(let i=0;i<100&&state('qa-concurrent',p)?.failures;i++)await sleep(50);delay=0;check('concurrent recovery single probe',count('primary')-n===1&&state('qa-concurrent',p)?.failures===0,{delta:count('primary')-n,health:health()});
 await fresh('qa-toggle');failing=true;await chat('qa-toggle');resetLocks();await settings(false,'qa-toggle');n=count('primary');await chat('qa-toggle');check('toggle off ignores health skip',count('primary')>n,health());
 const membership=await fresh('qa-members');failing=true;await chat('qa-members');resetLocks();failing=false;await api('/api/combos/'+membership.id,'PUT',{name:'qa-members',models:[f,p]});n=count('primary');r=await chat('qa-members');check('membership reorder uses healthy first member',r.choices?.[0]?.message?.content==='mock fallback'&&count('primary')===n,health());
 await api('/api/combos/'+membership.id,'PUT',{name:'qa-members',models:[p]});expire('qa-members',p);resetLocks();await api('/v1/chat/completions','POST',{model:'qa-members',stream:false,messages:[{role:'user',content:'QA mock only hello'}]},true);for(let i=0;i<100&&state('qa-members',p)?.failures;i++)await sleep(50);n=count('fallback');r=await chat('qa-members');check('removed fallback never used',r.choices?.[0]?.message?.content==='mock primary'&&count('fallback')===n,health());
 report.finalHealth=health();
}catch(e){report.passed=false;report.error=e.stack;process.exitCode=1;
}finally{
 try{await stop();if(appPort){const ok=await closed(appPort);report.cleanup.push({appPort,closed:ok});if(!ok)process.exitCode=1;}}catch(e){report.cleanup.push({error:String(e)});process.exitCode=1;}
 db?.close();if(mock){mock.closeAllConnections();await new Promise(r=>mock.close(r));}if(mockPort){const ok=await closed(mockPort);report.cleanup.push({mockPort,closed:ok});if(!ok)process.exitCode=1;}
 report.passed=!report.error&&report.assertions.length>0&&report.assertions.every(a=>a.passed)&&report.cleanup.length===2&&report.cleanup.every(c=>c.closed===true);if(!report.passed)process.exitCode=1;
 report.finished=new Date().toISOString();report.requestCounts=Object.fromEntries(['primary','fallback'].map(m=>[m,count(m)]));fs.writeFileSync(path.join(run,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({report:path.join(run,'report.json'),passed:report.passed,assertions:report.assertions,cleanup:report.cleanup,error:report.error},null,2));
}
