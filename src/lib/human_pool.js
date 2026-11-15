// v0.10.13 — opt-in pooling of completed main_v2 participants from earlier research cycles.
// Rules (all must hold for a prior-cycle participant to enter the current reviewer pool):
//   1. same human protocol id (main_v2) and identical frozen task-settings hash on every trial;
//   2. completed (main + attention trials) and no EXCLUDE quality flag;
//   3. one session per subject: the same subject_hash is counted once (current cycle wins, then earliest).
// Pooling is refused for independent-replication cycles, which require a fresh human sample.
import { all, one, run, audit } from './db.js';
import { safeJson } from './util.js';
import { bust } from './memo.js';
import { registerEvidence } from './evidence.js';

export const poolKey=(cycle,hash)=>`${Number(cycle)}|${String(hash)}`;

export function selectPoolParticipants(trialRows,sessionRows,{cycle,mainRequired=30,attentionRequired=3}={}){
  const subj=new Map((sessionRows||[]).map(s=>[poolKey(s.research_cycle,s.participant_hash),s.subject_hash||null]));
  const stats={current_completed:0,prior_candidates:0,prior_included:0,prior_excluded_incomplete:0,prior_excluded_flagged:0,prior_excluded_protocol_mismatch:0,prior_excluded_identity_unverified:0,deduped_same_subject:0,cycles_pooled:[]};
  const eligible=[];
  for(const r of trialRows||[]){
    const rc=Number(r.research_cycle),prior=rc<Number(cycle);
    if(prior)stats.prior_candidates++;
    const complete=Number(r.main_n||0)>=mainRequired&&Number(r.attention_n||0)>=attentionRequired;
    if(!complete){if(prior)stats.prior_excluded_incomplete++;continue;}
    if(Number(r.excluded||0)===1){if(prior)stats.prior_excluded_flagged++;continue;}
    if(prior&&Number(r.hash_ok||0)!==1){stats.prior_excluded_protocol_mismatch++;continue;}
    // A stable cross-cycle subject identifier is required to establish independent persons.
    if(prior&&!subj.get(poolKey(rc,r.participant_hash))){stats.prior_excluded_identity_unverified++;continue;}
    eligible.push({participant_hash:String(r.participant_hash),research_cycle:rc,subject:subj.get(poolKey(rc,r.participant_hash))||`p:${r.participant_hash}`});
  }
  // current cycle first, then earliest cycle: that record represents the subject
  eligible.sort((a,b)=>(b.research_cycle===Number(cycle))-(a.research_cycle===Number(cycle))||a.research_cycle-b.research_cycle);
  const seen=new Set(),included=new Set(),cycles=new Set();
  for(const e of eligible){
    if(seen.has(e.subject)){stats.deduped_same_subject++;continue;}
    seen.add(e.subject);included.add(poolKey(e.research_cycle,e.participant_hash));
    if(e.research_cycle===Number(cycle))stats.current_completed++;else{stats.prior_included++;cycles.add(e.research_cycle);}
  }
  stats.cycles_pooled=[...cycles].sort((a,b)=>a-b);
  return {included,stats};
}

export async function selectPoolForCycle(env,projectId,{protocol='main_v2',cycle,hash,mainRequired=30,attentionRequired=3}){
  const trials=await all(env.DB,`SELECT rt.participant_hash,rt.research_cycle,
      SUM(CASE WHEN rt.trial_phase='main' AND rt.status='done' THEN 1 ELSE 0 END) main_n,
      SUM(CASE WHEN rt.trial_phase='attention' AND rt.status='done' THEN 1 ELSE 0 END) attention_n,
      MIN(CASE WHEN rt.protocol_hash=? THEN 1 ELSE 0 END) hash_ok,
      EXISTS(SELECT 1 FROM reviewer_quality_flags q WHERE q.project_id=rt.project_id AND q.participant_hash=rt.participant_hash AND q.protocol_version=rt.protocol_version AND q.research_cycle=rt.research_cycle AND q.severity='EXCLUDE') excluded
    FROM reviewer_trials rt
    WHERE rt.project_id=? AND rt.protocol_version=? AND rt.research_cycle<=? AND NULLIF(rt.participant_hash,'anonymous') IS NOT NULL
    GROUP BY rt.participant_hash,rt.research_cycle`,[hash,projectId,protocol,cycle]);
  const sessions=await all(env.DB,`SELECT participant_hash,research_cycle,subject_hash FROM reviewer_sessions WHERE project_id=? AND protocol_version=? AND research_cycle<=?`,[projectId,protocol,cycle]);
  return selectPoolParticipants(trials,sessions,{cycle,mainRequired,attentionRequired});
}

export async function isReplicationCycle(env,projectId){
  const c=await one(env.DB,`SELECT benchmark_json FROM project_config WHERE project_id=?`,[projectId]);
  return String(safeJson(c?.benchmark_json,{})?.replication_mode||'')==='independent_replication_v1';
}

export async function humanPoolStatus(env,projectId){
  const p=await one(env.DB,`SELECT research_cycle,human_pool_prior_cycles FROM projects WHERE id=?`,[projectId]);if(!p)throw new Error('project_not_found');
  const {humanProtocolHash,HUMAN_PROTOCOL}=await import('./human_trials.js');
  const {latestDefinition}=await import('./define.js');
  const def=await latestDefinition(env,projectId),v=def?.content?.validation||{};
  const cycle=Number(p.research_cycle||1),hash=await humanProtocolHash(env,projectId);
  const sel=await selectPoolForCycle(env,projectId,{protocol:String(v.human_protocol||HUMAN_PROTOCOL),cycle,hash,mainRequired:Number(v.human_main_n||30),attentionRequired:Number(v.human_attention_n||3)});
  const required=Number(v.min_human_participants||32),replication=await isReplicationCycle(env,projectId);
  return {enabled:Number(p.human_pool_prior_cycles||0)===1,research_cycle:cycle,replication_cycle:replication,poolable_total:sel.included.size,required_participants:required,eligibility_status:replication?'BLOCKED_REPLICATION':sel.included.size>=required?'PASS':'HOLD',shortfall:Math.max(0,required-sel.included.size),...sel.stats};
}

export async function setHumanPool(env,projectId,{enabled}={}){
  const p=await one(env.DB,`SELECT human_pool_prior_cycles FROM projects WHERE id=?`,[projectId]);if(!p)throw new Error('project_not_found');
  if(enabled&&await isReplicationCycle(env,projectId)){const e=new Error('pool_not_allowed_in_replication_cycle');throw e;}
  const on=enabled?1:0;
  await run(env.DB,`UPDATE projects SET human_pool_prior_cycles=?,reviewer_hold_marker=NULL WHERE id=?`,[on,projectId]);
  bust(env,projectId);
  await audit(env,projectId,'admin',on?'human_pool.enabled':'human_pool.disabled','project',projectId,{});
  // Same cycle, new revision: stale approvals/reports and refit the reviewer model on the pooled sample.
  const ev=await registerEvidence(env,projectId,{kind:'HUMAN_REVIEW',source:'human_pool_toggle',detail:{enabled:!!on}});
  return {...(await humanPoolStatus(env,projectId)),revalidation:ev};
}
