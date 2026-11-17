import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {createLabCampaign,processLabTick} from '../src/lib/lab.js';
import {EARLY_MANUSCRIPT_DRAFTS} from '../src/lib/lab_manuscript_seed.js';
import {makeLabPlan,LAB_ROLES,validateLabOutput} from '../src/lib/lab_policy.js';

test('DAY 3 seeds seven real prose sections without claiming fabricated results',async()=>{
 const DB=makeDb(),pid=await seedProject(DB,{candidates:4,episodes:12});
 const env={DB,AI:{run:async()=>({response:JSON.stringify({summary:'Documented current methodological uncertainties.',findings:[],blockers:[],recommendations:['Verify primary evidence.']})})}};
 await createLabCampaign(env,pid);
 DB.raw.prepare('UPDATE lab_campaigns SET cursor=23,next_run_at=?').run(new Date(0).toISOString()); // data curator, avoids external network
 assert.equal((await processLabTick(env)).status,'task_completed');
 const rows=DB.raw.prepare('SELECT section,markdown,task_seq FROM lab_documents').all();
 assert.equal(rows.length,7);assert.ok(rows.every(r=>r.task_seq===-1&&r.markdown.length>450));
 assert.match(rows.find(r=>r.section==='results').markdown,/does not claim any unverified effect size/);
 DB.raw.prepare("UPDATE lab_documents SET markdown='Human-edited methods section' WHERE section='methods'").run();
 DB.raw.prepare('UPDATE lab_campaigns SET cursor=24,next_run_at=?').run(new Date(0).toISOString());
 assert.equal((await processLabTick(env)).status,'task_completed');
 assert.equal(DB.raw.prepare("SELECT markdown FROM lab_documents WHERE section='methods'").get().markdown,'Human-edited methods section');
});
test('early prose is nonnumerical where results are unavailable and DOI validation keeps unsupported citations out',()=>{
 assert.deepEqual(Object.keys(EARLY_MANUSCRIPT_DRAFTS),['abstract','introduction','related_work','methods','results','discussion','conclusion']);
 for(const text of Object.values(EARLY_MANUSCRIPT_DRAFTS)){assert.doesNotMatch(text,/10\.\d{4,9}\//);}
 const output=validateLabOutput({summary:'Unregistered [SRC:10.1016/j.chbr.2026.101329]',findings:[],blockers:[]},LAB_ROLES[0],[]);
 assert.doesNotMatch(JSON.stringify(output),/10\.1016\/j\.chbr\.2026\.101329/);
 assert.ok(output.blockers.some(s=>s.includes('removed')));
});
