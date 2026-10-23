import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, loadConfig, withLock } from '../dist/io.js';
import { setFocus, readFocus, activeFocus, changeFocus } from '../dist/focus.js';
import { hook, record, drain, proposals, reject, exportMarkdown } from '../dist/workflow.js';
const direction = { id: 'speed', status: 'active', layer: 'targeted', projects: ['app'], question: 'Find measured repeated UI setup', lookFor: ['Repeated build'], evidenceRequired: ['Run timing'], exclude: ['Unmeasured claims'], exitWhen: 'Owner reviews measured targets' };
const evidence = [{ source: 'controlled-run', summary: 'Same setup repeated twice' }];
const candidate = { title: 'Investigate repeated setup', project: 'app', kind: 'investigation', certainty: 'hypothesis', evidence, rationale: 'Potential avoidable latency', acceptance: 'Reproduce and measure', nextStep: 'Inspect timings', focusIds: ['speed'] };
async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(),'followups-focus-')); t.after(()=>rm(root,{recursive:true,force:true})); const app=join(root,'app'), other=join(root,'other'); await mkdir(app);await mkdir(other);
 const config=join(root,'config.json');await atomicJson(config,{version:1,stateDir:join(root,'state'),beadsDir:join(root,'planning','.beads'),projects:[{id:'app',root:app},{id:'other',root:other}]});return {c:await loadConfig(config),app,other};
}
function output(candidates) { return async (binary,args,options)=>{await writeFile(args[args.indexOf('-o')+1],JSON.stringify({outcome:candidates.length?'candidates_found':'no_findings',candidates}));return '';}; }
test('project-scoped startup guidance includes general and active applicable directions only',async t=>{
 const {c,app,other}=await fixture(t);const doc={version:1,directions:[direction,{...direction,id:'general',layer:'general',projects:[]},{...direction,id:'paused',status:'paused'}]};await setFocus(c,doc);
 const start=await hook(c,{hook_event_name:'SessionStart',session_id:'s',cwd:app});const text=start.hookSpecificOutput.additionalContext;assert.ok(text.includes('"id":"speed"'));assert.ok(text.includes('"id":"general"'));assert.ok(!text.includes('"id":"paused"'));
 const outside=await hook(c,{hook_event_name:'SessionStart',session_id:'s',cwd:other});assert.ok(!outside.hookSpecificOutput.additionalContext.includes('"id":"speed"'));
});
test('explicit pause, archive and activation preserve immutable historical definitions',async t=>{
 const {c}=await fixture(t);const first=await setFocus(c,{version:1,directions:[direction]});const bytes=await readFile(join(c.stateDir,'focus-history',first.revision+'.json'),'utf8');
 const paused=await changeFocus(c,'speed','paused');assert.notEqual(paused.revision,first.revision);assert.equal((await readFocus(c,first.revision)).directions[0].status,'active');assert.deepEqual((await activeFocus(c)).directions,[]);
 await changeFocus(c,'speed','archived');assert.equal((await readFocus(c)).directions[0].status,'archived');const back=await changeFocus(c,'speed','active');assert.equal(back.revision,first.revision);assert.equal(await readFile(join(c.stateDir,'focus-history',first.revision+'.json'),'utf8'),bytes);
 await assert.rejects(changeFocus(c,'missing','active'));await withLock(c,async()=>{await assert.rejects(changeFocus(c,'speed','paused'),/owns the state lock/);});
});
test('invalid scope, duplicate IDs and oversized active context cannot replace valid focus',async t=>{
 const {c}=await fixture(t);const first=await setFocus(c,{version:1,directions:[direction]});
 for(const directions of [[direction,direction],[{...direction,projects:['unknown']}],[{...direction,projects:[]}],Array.from({length:9},(_,i)=>({...direction,id:`id${i}`}))]) await assert.rejects(setFocus(c,{version:1,directions}));
 assert.equal((await readFocus(c)).revision,first.revision);
});
test('extraction carries active focus into schema and records exact match provenance',async t=>{
 const {c}=await fixture(t);const focus=await setFocus(c,{version:1,directions:[direction]});const id=await record(c,'app',evidence);
 await drain(c,1,async (b,a,o)=>{assert.ok(o.input.includes(focus.revision));assert.ok(o.input.includes(direction.question));const schema=JSON.parse(await readFile(a[a.indexOf('--output-schema')+1],'utf8'));assert.ok(schema.properties.candidates.items.required.includes('focusIds'));return output([candidate])(b,a,o);});
 const [task]=await proposals(c);assert.deepEqual(task.focusRuns,[{eventId:id,revision:focus.revision,matchedIds:['speed']}]);assert.equal(task.status,'proposed');assert.ok((await exportMarkdown(c)).includes(focus.revision));
});
test('unrecognized, paused and wrong-target matches fail the entire batch without partial proposals',async t=>{
 for(const bad of [{...candidate,focusIds:['unknown']},{...candidate,project:'other'},{...candidate,focusIds:['speed','speed']}]){
 const {c}=await fixture(t);await setFocus(c,{version:1,directions:[direction]});await record(c,'app',evidence);assert.equal((await drain(c,1,output([candidate,bad])))[0].state,'failed');assert.deepEqual(await proposals(c),[]);
 }
 const {c}=await fixture(t);await setFocus(c,{version:1,directions:[{...direction,status:'paused'}]});await record(c,'app',evidence);assert.equal((await drain(c,1,output([candidate])))[0].state,'failed');
});
test('focus changes apply on next analysis and duplicates retain decisions and separate historical associations',async t=>{
 const {c}=await fixture(t);const first=await setFocus(c,{version:1,directions:[direction]});await record(c,'app',evidence);await drain(c,1,output([candidate]));const [original]=await proposals(c);await reject(c,original.id,'Already considered');
 const second=await setFocus(c,{version:1,directions:[{...direction,id:'accuracy',question:'Find measured mismatches'}]});await record(c,'app',[{...evidence[0],source:'next-run'}]);await drain(c,1,output([{...candidate,focusIds:['accuracy']}]));
 const [same]=await proposals(c);assert.equal(same.status,'rejected');assert.deepEqual(same.candidate.focusIds,['speed']);assert.deepEqual(same.focusRuns.map(r=>r.revision),[first.revision,second.revision]);
});
test('no findings and unmatched independent findings remain allowed; legacy state still loads',async t=>{
 const {c}=await fixture(t);assert.deepEqual((await activeFocus(c)).directions,[]);await setFocus(c,{version:1,directions:[direction]});await record(c,'app',evidence);assert.equal((await drain(c,1,output([])))[0].outcome,'no_findings');
 await record(c,'app',[{...evidence[0],source:'unmatched'}]);await drain(c,1,output([{...candidate,focusIds:[]}]));assert.deepEqual((await proposals(c))[0].focusRuns[0].matchedIds,[]);
 const path=join(c.stateDir,'proposals',(await proposals(c))[0].id+'.json');const old=JSON.parse(await readFile(path,'utf8'));delete old.focusRuns;delete old.candidate.focusIds;await atomicJson(path,old);assert.deepEqual((await proposals(c))[0].focusRuns,[]);
});

test('CLI export supports round-trip editing and explicit refresh rejects unknown projects',async t=>{
 const {c}=await fixture(t);await setFocus(c,{version:1,directions:[direction]});
 const config=join(c.stateDir,'cli-config.json');await atomicJson(config,c);const {command}=await import('../dist/io.js');const cli=join(import.meta.dirname,'../dist/cli.js');
 const exported=await command(process.execPath,[cli,'focus','export','--config',config],{cwd:tmpdir()});const doc=JSON.parse(exported);assert.equal(doc.revision,undefined);doc.directions[0].status='paused';const input=join(c.stateDir,'edited-focus.json');await atomicJson(input,doc);
 await command(process.execPath,[cli,'focus','set','--input',input,'--config',config],{cwd:tmpdir()});assert.equal((await readFocus(c)).directions[0].status,'paused');await assert.rejects(command(process.execPath,[cli,'focus','context','--project','unknown','--config',config],{cwd:tmpdir()}));
});
test('watch reloads focus after explicit pause between cycles without reclassifying earlier proposals',async t=>{
 const {c}=await fixture(t);await setFocus(c,{version:1,directions:[direction]});await record(c,'app',evidence);const {watch}=await import('../dist/runner.js');let calls=0;
 const result=await watch(c,{maxCycles:2,maxEvents:2,intervalSeconds:1,limit:1},{exec:async(b,a,o)=>{calls++;if(calls===1){assert.ok(o.input.includes(direction.question));return output([candidate])(b,a,o);}assert.ok(!o.input.includes(direction.question));return output([])(b,a,o);},onCycle:async cycle=>{if(cycle.cycle===1){await changeFocus(c,'speed','paused');await record(c,'app',[{...evidence[0],source:'after-pause'}]);}}});
 assert.equal(result.reason,'event_limit');assert.equal(calls,2);assert.deepEqual((await proposals(c))[0].candidate.focusIds,['speed']);
});
test('starter directions fit context budget and history tampering cannot rewrite attribution',async t=>{
 const {FocusDocument}=await import('../dist/focus.js');const sample=FocusDocument.parse(JSON.parse(await readFile(join(import.meta.dirname,'../examples/focus.json'),'utf8')));assert.equal(sample.directions.filter(d=>d.status==='active').length,6);
 const {c}=await fixture(t);const first=await setFocus(c,{version:1,directions:[direction]});const path=join(c.stateDir,'focus-history',first.revision+'.json');await atomicJson(path,{version:1,directions:[{...direction,question:'tampered'}]});await assert.rejects(readFocus(c,first.revision),/hash mismatch/);await assert.rejects(setFocus(c,{version:1,directions:[direction]}),/hash mismatch/);assert.equal((await readFocus(c)).revision,first.revision);
});

test('removed target projects remain inspectable but cannot create external tasks',async t=>{
 const {c}=await fixture(t);await record(c,'app',evidence);await drain(c,1,output([{...candidate,focusIds:[]}]));const [task]=await proposals(c);c.projects=c.projects.filter(p=>p.id!=='app');const {accept}=await import('../dist/workflow.js');let calls=0;
 await assert.rejects(accept(c,task.id,async()=>{calls++;return '[]';}),/no longer configured/);assert.equal(calls,0);assert.equal((await proposals(c))[0].status,'proposed');
});
test('mismatched restored proposal IDs cannot mutate local state or call Beads',async t=>{
 const {c}=await fixture(t);await record(c,'app',evidence);await drain(c,1,output([{...candidate,focusIds:[]}]));const [task]=await proposals(c);const path=join(c.stateDir,'proposals',task.id+'.json');const wrong={...task,id:'f'.repeat(64)};await atomicJson(path,wrong);const before=await readFile(path,'utf8');const {accept,reconcile}=await import('../dist/workflow.js');let calls=0;const beads=async()=>{calls++;return '[]';};
 await assert.rejects(accept(c,task.id,beads),/identity mismatch/);await assert.rejects(reject(c,task.id,'wrong restore'),/identity mismatch/);assert.equal(await readFile(path,'utf8'),before);
 await atomicJson(path,{...wrong,status:'accepting'});await assert.rejects(reconcile(c,task.id,'existing',beads),/identity mismatch/);assert.equal(calls,0);
 await record(c,'app',[{...evidence[0],source:'duplicate'}]);assert.equal((await drain(c,1,output([{...candidate,focusIds:[]}])))[0].state,'failed');assert.equal(JSON.parse(await readFile(path,'utf8')).id,wrong.id);
});
test('duplicate provenance crossing the read bound cannot replace a readable proposal',async t=>{
 const {c}=await fixture(t);await record(c,'app',evidence);await drain(c,1,output([{...candidate,focusIds:[]}]));const [task]=await proposals(c);const {MAX_JSON_BYTES}=await import('../dist/io.js');const bytes=v=>Buffer.byteLength(JSON.stringify(v,null,2)+'\n');const base=bytes(task);const unit=bytes({...task,eventIds:[...task.eventIds,'0'.repeat(64)]})-base;
 const n=Math.floor((MAX_JSON_BYTES-base-80)/unit);task.eventIds.push(...Array.from({length:n},(_,i)=>i.toString(16).padStart(64,'0')));const path=join(c.stateDir,'proposals',task.id+'.json');await atomicJson(path,task);const before=await readFile(path,'utf8');assert.ok(Buffer.byteLength(before)>MAX_JSON_BYTES-200);
 await record(c,'app',[{...evidence[0],source:'one-more'}]);assert.equal((await drain(c,1,output([{...candidate,focusIds:[]}])))[0].state,'failed');assert.equal(await readFile(path,'utf8'),before);assert.equal((await proposals(c))[0].id,task.id);
});

test('queued source revocation prevents provider calls while preserving original evidence',async t=>{
 const {c}=await fixture(t);const id=await record(c,'app',evidence);const path=join(c.stateDir,'events',id+'.json');const original=await readFile(path,'utf8');c.projects=c.projects.filter(p=>p.id!=='app');let calls=0;
 const result=await drain(c,1,async()=>{calls++;throw new Error('must not send revoked evidence');});assert.equal(result[0].state,'failed');assert.equal(calls,0);assert.equal(await readFile(path,'utf8'),original);assert.deepEqual(await proposals(c),[]);
});
test('large import descriptions use stdin rather than oversized process arguments',async t=>{
 const {c}=await fixture(t);await record(c,'app',evidence);await drain(c,1,output([{...candidate,focusIds:[]}]));const [task]=await proposals(c);task.eventIds.push(...Array.from({length:3000},(_,i)=>i.toString(16).padStart(64,'0')));await atomicJson(join(c.stateDir,'proposals',task.id+'.json'),task);const {accept}=await import('../dist/workflow.js');
 const done=await accept(c,task.id,async(b,a,o)=>{if(a[0]==='list')return '[]';assert.equal(a[a.indexOf('--body-file')+1],'-');assert.ok(Buffer.byteLength(o.input)>128*1024);assert.ok(a.every(v=>Buffer.byteLength(v)<32768));return '{"id":"imported-1"}';});assert.equal(done.status,'accepted');
});
test('near-limit legacy reconciliation preserves full provenance and publishes a writable receipt',async t=>{
 const {c}=await fixture(t);await record(c,'app',evidence);await drain(c,1,output([{...candidate,focusIds:[]}]));const [task]=await proposals(c);const {MAX_JSON_BYTES,jsonSize}=await import('../dist/io.js');task.status='accepting';const unit=jsonSize({...task,eventIds:[...task.eventIds,'0'.repeat(64)]})-jsonSize(task);const n=Math.floor((MAX_JSON_BYTES-jsonSize(task)-80)/unit);task.eventIds.push(...Array.from({length:n},(_,i)=>i.toString(16).padStart(64,'0')));const path=join(c.stateDir,'proposals',task.id+'.json');await atomicJson(path,task);const before=JSON.parse(await readFile(path,'utf8'));const {reconcile,accept}=await import('../dist/workflow.js');
 const result=await reconcile(c,task.id,'existing-1',async()=>JSON.stringify([{id:'existing-1',description:`agent-followups:${task.id}`} ]));assert.equal(result.status,'accepted');assert.ok(result.provenanceArchive);assert.deepEqual(JSON.parse(await readFile(join(c.stateDir,'provenance-archives',task.id+'-'+result.provenanceArchive+'.json'),'utf8')),before);assert.equal((await proposals(c))[0].beadId,'existing-1');
 await accept(c,task.id,async()=>{throw new Error('must not create again');});
});

test('transport and reconciliation identity bounds reject before intent or external calls',async t=>{
 const {c}=await fixture(t);await record(c,'app',evidence);await drain(c,1,output([{...candidate,focusIds:[]}]));const [task]=await proposals(c);const path=join(c.stateDir,'proposals',task.id+'.json');task.parentBeads=Array.from({length:1000},(_,i)=>'parent-'+i.toString(16).padStart(64,'0'));await atomicJson(path,task);const {accept,reconcile}=await import('../dist/workflow.js');let calls=0;const fake=async()=>{calls++;throw new Error('must not call');};
 await assert.rejects(accept(c,task.id,fake),/transport budget/);assert.equal((await proposals(c))[0].status,'proposed');await assert.rejects(reconcile(c,task.id,'x'.repeat(513),fake));assert.equal(calls,0);
});
