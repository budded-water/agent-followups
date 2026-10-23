import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Task } from '../dist/contracts.js';
import { atomicJson, hash, withLock, command } from '../dist/io.js';
import { proposalReview, setProposalReview, similarProposals, reviewTask } from '../dist/review.js';
import { accept, exportMarkdown, record, drain, proposals } from '../dist/workflow.js';
import { currentReview } from './helpers.mjs';
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'followup-review-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const c={version:1,stateDir:join(root,'state'),beadsDir:join(root,'planning'),projects:[{id:'app',root},{id:'other',root:join(root,'other')}],codexBinary:'no-model',beadsBinary:'fake',timeoutSeconds:1,capturePrompts:false};await mkdir(c.stateDir,{mode:0o700});
 async function add(title, project='app', source='reproduction.json') {
  const id=hash([project,title]);const task=Task.parse({id,candidate:{title,project,kind:'investigation',certainty:'hypothesis',evidence:[{source,summary:'Observed validation policy reuse behavior'}],rationale:'Validation policy changes must revoke reused source evidence',acceptance:'Check changed policy',nextStep:'Inspect source validation policy and reuse'},eventIds:[hash(title)],parentBeads:[],status:'proposed',createdAt:new Date().toISOString()});await atomicJson(join(c.stateDir,'proposals',id+'.json'),task);return task;
 }
 return {c,add};
}
test('legacy proposals are readable but import requires operator review before any external call',async t=>{
 const {c,add}=await fixture(t);const task=await add('Policy evidence reuse');let calls=0;const fake=async(b,a,o)=>{calls++;if(a[0]==='list')return '[]';assert.ok(o.input.includes('Import review: '));return '{"id":"plan-1"}';};
 assert.equal((await proposalReview(c,task.id)).state,'unreviewed');await assert.rejects(accept(c,task.id,fake),/review is required/);assert.equal(calls,0);
 const reviewed=await setProposalReview(c,task.id,currentReview);const done=await accept(c,task.id,fake);assert.equal(done.importReview,reviewed.revision);assert.equal(calls,2);await accept(c,task.id,async()=>{throw new Error('must not repeat');});
 await assert.rejects(setProposalReview(c,task.id,currentReview),/only to proposed/);
});
test('new observations invalidate review while preserving immutable review history and decisions',async t=>{
 const {c,add}=await fixture(t);const task=await add('Policy review');const first=await setProposalReview(c,task.id,currentReview);const path=join(c.stateDir,'review-history',task.id,first.revision+'.json');const bytes=await readFile(path,'utf8');
 const changed=await reviewTask(c,task.id);changed.eventIds.push(hash('new contradictory observation'));await atomicJson(join(c.stateDir,'proposals',task.id+'.json'),changed);
 assert.equal((await proposalReview(c,task.id)).state,'stale');await assert.rejects(accept(c,task.id,async()=>{throw new Error('no external call');}),/review is required/);
 const second=await setProposalReview(c,task.id,{...currentReview,reason:'Checked new observation'});assert.notEqual(first.revision,second.revision);assert.equal(await readFile(path,'utf8'),bytes);assert.equal((await proposalReview(c,task.id)).state,'valid');assert.equal((await proposalReview(c,task.id,first.revision)).state,'stale');
});
test('resolved and needs-investigation verdicts block imports without rejecting proposal state',async t=>{
 const {c,add}=await fixture(t);const task=await add('Old issue');
 for(const verdict of ['resolved','needs_investigation']) {await setProposalReview(c,task.id,{...currentReview,verdict});await assert.rejects(accept(c,task.id,async()=>{throw new Error('external call');}),/review is required/);assert.equal((await reviewTask(c,task.id)).status,'proposed');}
 assert.ok((await exportMarkdown(c)).includes('valid / needs_investigation'));
});
test('manual duplicate association preserves both proposals and forbids cross-project targets, cycles and chains',async t=>{
 const {c,add}=await fixture(t);const a=await add('Invalidate source validation after policy changes');const b=await add('Investigate validation evidence reuse after policy changes');const other=await add('Other project','other');
 for(const id of [a.id,other.id,hash('missing')])await assert.rejects(setProposalReview(c,a.id,{...currentReview,verdict:'duplicate',duplicateOf:id}));
 await setProposalReview(c,a.id,{...currentReview,verdict:'duplicate',duplicateOf:b.id});assert.equal((await proposalReview(c,a.id)).review.duplicateOf,b.id);await assert.rejects(accept(c,a.id),/review is required/);
 await assert.rejects(setProposalReview(c,b.id,{...currentReview,verdict:'duplicate',duplicateOf:a.id}));const stale=await reviewTask(c,a.id);stale.eventIds.push(hash('later evidence'));await atomicJson(join(c.stateDir,'proposals',a.id+'.json'),stale);assert.equal((await proposalReview(c,a.id)).state,'stale');const third=await add('Third policy proposal');await assert.rejects(setProposalReview(c,b.id,{...currentReview,verdict:'duplicate',duplicateOf:third.id}),/incoming duplicate/);assert.equal((await reviewTask(c,a.id)).eventIds.length,2);assert.equal((await reviewTask(c,b.id)).status,'proposed');
});
test('similarity suggests paraphrased local candidates with reasons, excludes other projects and never mutates',async t=>{
 const {c,add}=await fixture(t);const a=await add('Invalidate source checks when validation policy changes','app','one.json');const b=await add('Investigate validation evidence reuse after release policy changes','app','two.json');await add(b.candidate.title,'other');a.candidate.rationale='A compliance issue';a.candidate.nextStep='Inspect identity';b.candidate.rationale='Evidence from an older release';b.candidate.nextStep='Reproduce behavior';await atomicJson(join(c.stateDir,'proposals',a.id+'.json'),a);await atomicJson(join(c.stateDir,'proposals',b.id+'.json'),b);const before=await readFile(join(c.stateDir,'proposals',a.id+'.json'),'utf8');
 const result=await similarProposals(c,a.id);assert.equal(result.method,'lexical-and-evidence-source');assert.equal(result.automaticMerge,false);assert.deepEqual(result.suggestions.map(s=>s.id),[b.id]);assert.ok(result.suggestions[0].sharedTerms.includes('policy'));assert.equal(await readFile(join(c.stateDir,'proposals',a.id+'.json'),'utf8'),before);
});
test('malformed or tampered review history and invalid source attribution fail closed',async t=>{
 const {c,add}=await fixture(t);const task=await add('Guard evidence');
 await assert.rejects(setProposalReview(c,task.id,{...currentReview,checkedAgainst:[]}));await assert.rejects(setProposalReview(c,task.id,{...currentReview,duplicateOf:hash('x')}));
 const first=await setProposalReview(c,task.id,currentReview);await atomicJson(join(c.stateDir,'review-history',task.id,first.revision+'.json'),{...first.review,reason:'tampered'});await assert.rejects(proposalReview(c,task.id),/hash mismatch/);await assert.rejects(accept(c,task.id));
 await withLock(c,async()=>{await assert.rejects(setProposalReview(c,task.id,currentReview),/owns the state lock/);});
});
test('review CLI round trip and scope revocation do not invoke model or import tasks',async t=>{
 const {c,add}=await fixture(t);const task=await add('CLI review');const config=join(c.stateDir,'config.json');const input=join(c.stateDir,'review-input.json');await atomicJson(config,c);await atomicJson(input,currentReview);
 // Config loading requires distinct real project roots outside private state.
 const repo=await mkdtemp(join(tmpdir(),'review-cli-repo-'));t.after(()=>rm(repo,{recursive:true,force:true}));await atomicJson(config,{...c,projects:[{id:'app',root:repo}]});
 const args=['dist/cli.js','review','set','--id',task.id,'--input',input,'--config',config];const output=await command(process.execPath,args,{cwd:join(import.meta.dirname,'..'),timeoutMs:5000});assert.equal(JSON.parse(output).review.verdict,'current');
 c.projects=[];await assert.rejects(setProposalReview(c,task.id,currentReview),/no longer configured/);await assert.rejects(similarProposals(c,task.id),/no longer configured/);
});

test('real duplicate discovery invalidates a current review before a subsequent import',async t=>{
 const {c}=await fixture(t);const candidate={title:'Check source validation policy reuse',project:'app',kind:'investigation',certainty:'hypothesis',evidence:[{source:'fixture report',summary:'Policy changed without rechecking'}],rationale:'Check policy identity',acceptance:'Reproduce policy change',nextStep:'Inspect source'};
 const extractor=async(b,a)=>{await atomicJson(a[a.indexOf('-o')+1],{outcome:'candidates_found',candidates:[candidate]});return '';};
 await record(c,'app',[{source:'first observation',summary:'First occurrence'}]);await drain(c,1,extractor);const [task]=await proposals(c);await setProposalReview(c,task.id,currentReview);assert.equal((await proposalReview(c,task.id)).state,'valid');
 await record(c,'app',[{source:'second observation',summary:'New occurrence requiring fresh inspection'}]);await drain(c,1,extractor);assert.equal((await proposals(c)).length,1);assert.equal((await proposals(c))[0].eventIds.length,2);assert.equal((await proposalReview(c,task.id)).state,'stale');let calls=0;await assert.rejects(accept(c,task.id,async()=>{calls++;return '[]';}),/review is required/);assert.equal(calls,0);
});
