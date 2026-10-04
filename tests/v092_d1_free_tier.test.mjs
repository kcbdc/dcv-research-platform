import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb} from './helpers/d1shim.mjs';
import {seedProject} from './helpers/seed.mjs';
import {scheduleAll} from '../src/lib/orchestrator.js';

test('project_cycle_stats stays in sync without rescanning candidate/run tables',async()=>{
 const DB=makeDb(),id=await seedProject(DB,{candidates:3,reviewer:0,episodes:0});
 const p=DB.raw.prepare('SELECT research_cycle FROM projects WHERE id=?').get(id),cycle=Number(p.research_cycle||1);
 let s=DB.raw.prepare('SELECT * FROM project_cycle_stats WHERE project_id=? AND research_cycle=?').get(id,cycle);
 assert.equal(Number(s.candidate_total),3);
 const feasibleBefore=Number(s.candidate_feasible||0), unresolvedBefore=Number(s.candidate_unresolved||0), boundaryBefore=Number(s.boundary_sum||0);
 const c=DB.raw.prepare('SELECT id,boundary_score FROM design_candidates WHERE project_id=? LIMIT 1').get(id);const oldBoundary=Number(c.boundary_score||0);
 DB.raw.prepare("UPDATE design_candidates SET status='confirmed_feasible',evidence_status='UNRESOLVED',boundary_score=.4,updated_at=datetime('now') WHERE id=?").run(c.id);
 s=DB.raw.prepare('SELECT * FROM project_cycle_stats WHERE project_id=? AND research_cycle=?').get(id,cycle);
 assert.ok(Number(s.candidate_feasible)>=feasibleBefore);assert.equal(Number(s.candidate_unresolved),unresolvedBefore+1);assert.ok(Math.abs(Number(s.boundary_sum)-(boundaryBefore-oldBoundary+.4))<1e-9);
 const before=Number(s.simulation_total||0);
 DB.raw.prepare("INSERT INTO simulation_runs(id,project_id,candidate_id,phase,seed,n,result_json,created_at,evidence_revision) VALUES('v092run',?,?, 'confirmation',1,1,'{}',datetime('now'),0)").run(id,c.id);
 s=DB.raw.prepare('SELECT * FROM project_cycle_stats WHERE project_id=? AND research_cycle=?').get(id,cycle);
 assert.equal(Number(s.simulation_total),before+1);assert.ok(Number(s.simulation_confirmation)>=1);
});

test('automatic draft report waits while heavy compute is in flight',async()=>{
 const DB=makeDb(),id=await seedProject(DB,{candidates:1,reviewer:0,episodes:0});
 DB.raw.prepare("INSERT INTO jobs(id,project_id,type,status,priority,payload_json,phase,run_after,created_at,updated_at) VALUES('heavy-v092',?,'compute_candidate','queued',40,'{}','exploration',datetime('now'),datetime('now'),datetime('now'))").run(id);
 await scheduleAll({DB},{process:false});
 assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM jobs WHERE project_id=? AND type='generate_report' AND status='queued'").get(id).n,0);
});
