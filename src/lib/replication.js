import {one,all,run,audit,enqueueOnce} from './db.js';
import {safeJson,nowIso,uid,sha256Hex,stableStringify} from './util.js';
import {registerEvidence} from './evidence.js';
import {assessDoctoralRigor} from './doctoral_rigor.js';
import {latestProtocol} from './rigor.js';
import {bust} from './memo.js';
import {loadEmpiricalCalibration} from './empirical.js';

export const REPLICATION_MODE='independent_replication_v1';

function lockedVector(c){return {estimator:c.estimator,sigma:Number(c.sigma),tau:Number(c.tau),alpha:Number(c.alpha),K:Number(c.authority_k),d:Number(c.delay_d),W:Number(c.recovery_w),m:Number(c.adjust_m)};}
function candidateRow(c){return {...lockedVector(c),base_id:`replication_${c.design_key||c.id}`,role:'replication_locked'};}

export async function activeReplication(env,projectId,cycle=null){
  const p=cycle==null?await one(env.DB,'SELECT research_cycle FROM projects WHERE id=?',[projectId]):null;
  const c=Number(cycle ?? p?.research_cycle ?? 1);
  return one(env.DB,`SELECT * FROM independent_replications WHERE project_id=? AND replication_cycle=? ORDER BY started_at DESC LIMIT 1`,[projectId,c]);
}

export async function startIndependentReplication(env,projectId,input={}){
  const p=await one(env.DB,`SELECT * FROM projects WHERE id=?`,[projectId]);if(!p)throw new Error('project_not_found');
  const sourceCycle=Number(p.research_cycle||1),sourceRev=Number(p.evidence_revision||0);
  const running=await one(env.DB,"SELECT 1 x FROM jobs WHERE project_id=? AND status='running' LIMIT 1",[projectId]);if(running)throw new Error('wait_for_running_job_before_replication');
  const existing=await one(env.DB,`SELECT * FROM independent_replications WHERE project_id=? AND status IN ('PREREGISTERED','RUNNING') ORDER BY started_at DESC LIMIT 1`,[projectId]);if(existing)throw new Error('independent_replication_already_active');
  const signed=await one(env.DB,`SELECT * FROM approvals WHERE project_id=? AND research_cycle=? AND evidence_revision=? AND stale_at IS NULL AND decision='SCIENTIFICALLY_APPROVED' ORDER BY created_at DESC LIMIT 1`,[projectId,sourceCycle,sourceRev]);
  if(!signed)throw new Error('scientific_signoff_required_before_independent_replication');
  const rigor=await assessDoctoralRigor(env,projectId);if(!rigor.hard_pass)throw new Error('doctoral_rigor_required_before_independent_replication');
  const sourceCandidateId=signed.candidate_id;if(!sourceCandidateId)throw new Error('signed_candidate_missing');
  const cand=await one(env.DB,`SELECT * FROM design_candidates WHERE id=? AND project_id=? AND research_cycle=?`,[sourceCandidateId,projectId,sourceCycle]);if(!cand)throw new Error('signed_candidate_not_in_source_cycle');
  const cfg=await one(env.DB,`SELECT * FROM project_config WHERE project_id=?`,[projectId]);if(!cfg)throw new Error('project_config_missing');
  const sourceProtocol=await latestProtocol(env,projectId);if(!sourceProtocol?.protocol_hash)throw new Error('source_protocol_not_frozen');
  const lockedConstraints=safeJson(cfg.constraints_json,{}),lockedBenchmark=safeJson(cfg.benchmark_json,{}),lockedValidation=safeJson(cfg.validation_json,{});
  const lockedCalibration=await loadEmpiricalCalibration(env,projectId),lockedEpisodes=await all(env.DB,`SELECT * FROM empirical_episodes WHERE project_id=? ORDER BY year,episode_name`,[projectId]),lockedScenarios=await all(env.DB,`SELECT * FROM scenarios WHERE project_id=? ORDER BY scenario_type,name`,[projectId]);
  const empiricalSnapshot={calibration:lockedCalibration,episodes:lockedEpisodes},scenarioSnapshot={rows:lockedScenarios};
  const replicationSnapshotHash=await sha256Hex(stableStringify({empirical:empiricalSnapshot,scenarios:scenarioSnapshot}));
  const seedSalt=String(input.seed_salt||await sha256Hex(`${projectId}|${sourceCycle}|replication-seed-v1`)).slice(0,32);
  const scenarioSalt=String(input.scenario_salt||await sha256Hex(`${projectId}|${sourceCycle}|replication-scenario-v1`)).slice(0,32);
  const confirmationN=Math.max(300,Math.min(5000,Number(input.confirmation_n||600)));
  const design={...safeJson(cfg.design_json,{}),design_mode:REPLICATION_MODE,max_candidates:1,candidate_rows:[candidateRow(cand)],grid_source:'locked_source_candidate'};
  const benchmark={...lockedBenchmark,replication_mode:REPLICATION_MODE,replication_source_cycle:sourceCycle,replication_source_candidate_id:sourceCandidateId,replication_seed_salt:seedSalt,replication_scenario_salt:scenarioSalt,replication_scenario_mode:'deterministic_holdout_perturbation_v1',replication_snapshot_hash:replicationSnapshotHash};
  const validation={...lockedValidation,confirmation_n:confirmationN,max_confirmation:0,human_protocol:'main_v2',replication_fresh_participants:true};
  const nextCycle=sourceCycle+1,id=uid('replication'),ts=nowIso();
  const lockHash=await sha256Hex(stableStringify({source_cycle:sourceCycle,candidate:lockedVector(cand),constraints:lockedConstraints,benchmark:lockedBenchmark,validation:lockedValidation,confirmation_n:confirmationN,seed_salt:seedSalt,scenario_salt:scenarioSalt,replication_snapshot_hash:replicationSnapshotHash}));
  await run(env.DB,`INSERT INTO independent_replications(id,project_id,source_cycle,replication_cycle,source_candidate_id,source_design_key,source_protocol_hash,locked_design_json,locked_constraints_json,locked_benchmark_json,locked_validation_json,locked_empirical_json,locked_scenarios_json,seed_salt,scenario_salt,status,started_at,result_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[id,projectId,sourceCycle,nextCycle,sourceCandidateId,cand.design_key||null,sourceProtocol.protocol_hash,JSON.stringify(lockedVector(cand)),JSON.stringify(lockedConstraints),JSON.stringify(lockedBenchmark),JSON.stringify(lockedValidation),JSON.stringify(empiricalSnapshot),JSON.stringify(scenarioSnapshot),seedSalt,scenarioSalt,'PREREGISTERED',ts,JSON.stringify({lock_hash:lockHash,replication_snapshot_hash:replicationSnapshotHash,source_evidence_revision:sourceRev,confirmation_n:confirmationN,fresh_human_sample_required:true})]);
  let ev;try{ev=await registerEvidence(env,projectId,{kind:'DESIGN_CHANGE',impact_from:'define',force_new_cycle:true,source:REPLICATION_MODE,config_update:{design,constraints:lockedConstraints,benchmark,validation},detail:{replication_id:id,source_cycle:sourceCycle,source_candidate_id:sourceCandidateId,source_design_key:cand.design_key||null,source_protocol_hash:sourceProtocol.protocol_hash,lock_hash:lockHash,replication_snapshot_hash:replicationSnapshotHash,confirmation_n:confirmationN,fresh_human_sample_required:true,scenario_mode:benchmark.replication_scenario_mode}});}catch(e){await run(env.DB,`UPDATE independent_replications SET status='ABORTED',completed_at=?,result_json=? WHERE id=?`,[nowIso(),JSON.stringify({lock_hash:lockHash,error:String(e?.message||e).slice(0,200)}),id]);throw e;}
  if(Number(ev.research_cycle)!==nextCycle){await run(env.DB,`UPDATE independent_replications SET status='ABORTED',completed_at=? WHERE id=?`,[nowIso(),id]);throw new Error('replication_cycle_allocation_mismatch');}
  await run(env.DB,`UPDATE independent_replications SET status='RUNNING' WHERE id=?`,[id]);
  bust(env,projectId);await audit(env,projectId,'user','replication.started','independent_replication',id,{source_cycle:sourceCycle,replication_cycle:nextCycle,source_candidate_id:sourceCandidateId,lock_hash:lockHash,replication_snapshot_hash:replicationSnapshotHash,confirmation_n:confirmationN});
  return {id,status:'RUNNING',source_cycle:sourceCycle,replication_cycle:nextCycle,source_candidate_id:sourceCandidateId,source_design_key:cand.design_key||null,lock_hash:lockHash,replication_snapshot_hash:replicationSnapshotHash,confirmation_n:confirmationN,fresh_human_sample_required:true};
}

export async function replicationParticipantAllowed(env,projectId,participant,cycle,subjectHash=null){
  const r=await activeReplication(env,projectId,cycle);if(!r)return {allowed:true,replication:false};
  let prior=null;if(subjectHash){try{prior=await one(env.DB,`SELECT 1 x FROM reviewer_sessions WHERE project_id=? AND research_cycle=? AND subject_hash=? LIMIT 1`,[projectId,Number(r.source_cycle),subjectHash]);}catch{}}
  if(!prior)prior=await one(env.DB,`SELECT 1 x FROM reviewer_trials WHERE project_id=? AND participant_hash=? AND research_cycle=? LIMIT 1`,[projectId,participant,Number(r.source_cycle)]);
  return {allowed:!prior,replication:true,source_cycle:Number(r.source_cycle),identity_scope:subjectHash?'server_invite_subject_hash':'participant_pseudonym_fallback',reason:prior?'replication_requires_fresh_participant':null};
}

export async function replicationStatus(env,projectId){
  const p=await one(env.DB,'SELECT research_cycle,evidence_revision FROM projects WHERE id=?',[projectId]);if(!p)throw new Error('project_not_found');
  const r=await one(env.DB,`SELECT * FROM independent_replications WHERE project_id=? ORDER BY replication_cycle DESC LIMIT 1`,[projectId]);if(!r)return {status:'NOT_STARTED'};
  const cand=await one(env.DB,`SELECT * FROM design_candidates WHERE project_id=? AND research_cycle=? ORDER BY created_at LIMIT 1`,[projectId,r.replication_cycle]);
  const phases=await all(env.DB,`SELECT phase,COUNT(*) runs,SUM(n) episodes,AVG(loss_mean) loss_mean,AVG(fp_rate) fp_rate,AVG(fn_rate) fn_rate,AVG(review_burden) review_burden,AVG(recovery_time) recovery_time FROM simulation_runs sr JOIN design_candidates dc ON dc.id=sr.candidate_id WHERE sr.project_id=? AND dc.research_cycle=? GROUP BY phase`,[projectId,r.replication_cycle]);
  const source_phases=await all(env.DB,`SELECT phase,COUNT(*) runs,SUM(n) episodes,AVG(loss_mean) loss_mean,AVG(fp_rate) fp_rate,AVG(fn_rate) fn_rate,AVG(review_burden) review_burden,AVG(recovery_time) recovery_time FROM simulation_runs WHERE project_id=? AND candidate_id=? GROUP BY phase`,[projectId,r.source_candidate_id]);
  const sm=new Map(source_phases.map(x=>[x.phase,x])),comparison=phases.map(x=>{const q=sm.get(x.phase);return {phase:x.phase,source:q||null,replication:x,delta:q?{loss_mean:Number(x.loss_mean||0)-Number(q.loss_mean||0),fp_rate:Number(x.fp_rate||0)-Number(q.fp_rate||0),fn_rate:Number(x.fn_rate||0)-Number(q.fn_rate||0),review_burden:Number(x.review_burden||0)-Number(q.review_burden||0),recovery_time:Number(x.recovery_time||0)-Number(q.recovery_time||0)}:null};});
  const human=await one(env.DB,`SELECT COUNT(DISTINCT rt.participant_hash) participants,COUNT(*) trials FROM reviewer_trials rt WHERE rt.project_id=? AND rt.research_cycle=? AND rt.trial_phase='main' AND rt.status='done'`,[projectId,r.replication_cycle]);
  const approval=await one(env.DB,`SELECT decision,evidence_level,created_at FROM approvals WHERE project_id=? AND research_cycle=? AND stale_at IS NULL ORDER BY created_at DESC LIMIT 1`,[projectId,r.replication_cycle]);
  return {...r,locked_design:safeJson(r.locked_design_json,{}),result:safeJson(r.result_json,{}),candidate:cand?{id:cand.id,design_key:cand.design_key,status:cand.status,evidence_status:cand.evidence_status}:null,phases,source_phases,comparison,human:{participants:Number(human?.participants||0),trials:Number(human?.trials||0)},approval:approval||null,current_cycle:Number(p.research_cycle||1),current_revision:Number(p.evidence_revision||0)};
}

export async function syncReplicationStatus(env,projectId){
  const p=await one(env.DB,'SELECT research_cycle FROM projects WHERE id=?',[projectId]);if(!p)return null;const cycle=Number(p.research_cycle||1),r=await activeReplication(env,projectId,cycle);if(!r)return null;
  const cand=await one(env.DB,`SELECT id,status,evidence_status FROM design_candidates WHERE project_id=? AND research_cycle=? ORDER BY created_at LIMIT 1`,[projectId,cycle]);
  const approval=await one(env.DB,`SELECT decision FROM approvals WHERE project_id=? AND research_cycle=? AND stale_at IS NULL ORDER BY created_at DESC LIMIT 1`,[projectId,cycle]);
  const robust=await one(env.DB,`SELECT status FROM validations v JOIN design_candidates c ON c.id=v.candidate_id WHERE v.project_id=? AND c.research_cycle=? AND v.validation_type='robust' ORDER BY v.created_at DESC LIMIT 1`,[projectId,cycle]);
  const human=await one(env.DB,`SELECT status FROM validations v JOIN design_candidates c ON c.id=v.candidate_id WHERE v.project_id=? AND c.research_cycle=? AND v.validation_type='human_recompute' ORDER BY v.created_at DESC LIMIT 1`,[projectId,cycle]);
  let status=String(r.status||'RUNNING');if(approval?.decision==='SCIENTIFICALLY_APPROVED')status='SCIENTIFICALLY_REPLICATED';else if(approval?.decision==='COMPUTATIONALLY_CONFIRMED')status='COMPUTATIONALLY_REPLICATED';else if(cand?.status==='confirmation_failed'||cand?.evidence_status==='INFEASIBLE')status='FAILED_CONFIRMATION';else if(robust?.status==='REJECT')status='FAILED_ROBUST';else if(human?.status==='REJECT')status='FAILED_HUMAN';else if(cand?.status==='boundary_hold')status='HOLD_BOUNDARY';else status='RUNNING';
  if(status!==r.status)await run(env.DB,`UPDATE independent_replications SET status=?,completed_at=CASE WHEN ? IN ('FAILED_CONFIRMATION','FAILED_ROBUST','FAILED_HUMAN','HOLD_BOUNDARY','COMPUTATIONALLY_REPLICATED','SCIENTIFICALLY_REPLICATED') THEN COALESCE(completed_at,?) ELSE completed_at END WHERE id=?`,[status,status,nowIso(),r.id]);return {id:r.id,status};
}

export async function markReplicationFromApproval(env,projectId,cycle,approval){
  const r=await activeReplication(env,projectId,cycle);if(!r)return null;
  const result={...safeJson(r.result_json,{}),approval_decision:approval.decision,evidence_level:approval.evidenceLevel||approval.evidence_level||null,completed_cycle:Number(cycle),completed_at:nowIso()};
  await run(env.DB,`UPDATE independent_replications SET status='COMPUTATIONALLY_REPLICATED',completed_at=?,result_json=? WHERE id=?`,[result.completed_at,JSON.stringify(result),r.id]);
  await audit(env,projectId,'agent','replication.computationally_confirmed','independent_replication',r.id,result);return result;
}
