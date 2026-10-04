import {all,one} from './db.js';
import {safeJson} from './util.js';

function cramersV(a,b){
  const av=[...new Set(a)],bv=[...new Set(b)],n=Math.min(a.length,b.length);if(!n||av.length<2||bv.length<2)return 0;
  const ai=new Map(av.map((v,i)=>[String(v),i])),bi=new Map(bv.map((v,i)=>[String(v),i]));
  const t=Array.from({length:av.length},()=>Array(bv.length).fill(0));
  for(let i=0;i<n;i++)t[ai.get(String(a[i]))][bi.get(String(b[i]))]++;
  const rs=t.map(r=>r.reduce((x,y)=>x+y,0)),cs=Array.from({length:bv.length},(_,j)=>t.reduce((s,r)=>s+r[j],0));
  let chi=0;for(let i=0;i<av.length;i++)for(let j=0;j<bv.length;j++){const e=rs[i]*cs[j]/n;if(e>0)chi+=(t[i][j]-e)**2/e;}
  const k=Math.min(av.length,bv.length)-1;return k>0?Math.sqrt(chi/(n*k)):0;
}

export function designOrthogonality(rows,factors=['estimator','alpha','recovery_w','sigma','tau','delay_d','adjust_m','authority_k']){
  const pairs=[];for(let i=0;i<factors.length;i++)for(let j=i+1;j<factors.length;j++){
    const a=factors[i],b=factors[j],v=cramersV(rows.map(r=>r[a]),rows.map(r=>r[b]));pairs.push({a,b,cramers_v:v});
  }
  return {n:rows.length,pairs,max_cramers_v:Math.max(0,...pairs.map(x=>x.cramers_v))};
}

export function seedFamilyAudit(rows){
  const by=new Map();
  for(const r of rows||[]){const k=String(r.candidate_id||'');if(!by.has(k))by.set(k,{adaptive:new Set(),confirm:new Set()});const g=by.get(k);const phase=String(r.phase||'');(phase==='confirmation'?g.confirm:g.adaptive).add(String(r.seed));}
  let collisions=0,candidates=0;for(const g of by.values()){if(!g.confirm.size)continue;candidates++;for(const s of g.confirm)if(g.adaptive.has(s))collisions++;}
  return {candidates,collisions,independent:collisions===0};
}

export function evaluateDoctoralRigor(input){
  const checks=[];const add=(id,level,pass,detail)=>checks.push({id,level,pass:!!pass,detail});
  const replicationMode=String(input.replication_mode||'')==='independent_replication_v1';
  const hg=input.human_realized||{}, ciLo=Number(hg.discrimination_ci_lo);
  add('protocol_frozen_before_first_run','HARD',!!input.protocol && String(input.protocol.status||'').toUpperCase()==='FROZEN' && (!input.first_run_at || String(input.protocol.frozen_at||'')<=String(input.first_run_at)),{status:input.protocol?.status||null,frozen_at:input.protocol?.frozen_at||null,first_run_at:input.first_run_at||null});
  add('orthogonal_full_factor_design','HARD',replicationMode||Number(input.orthogonality?.max_cramers_v??1)<=0.05,{max_cramers_v:input.orthogonality?.max_cramers_v??null,target:0.05,factors:input.orthogonality?.factors||null,not_applicable:replicationMode?'locked_single_candidate_holdout':null});
  add('independent_confirmation_seed_family','HARD',!!input.seed_audit?.independent,{collisions:input.seed_audit?.collisions??null});
  add('holdout_resampling_lock','HARD',!replicationMode||!!input.replication_lock_ok,{mode:replicationMode?'preregistered_internal_holdout_resampling':null,source_cycle:input.replication_source_cycle??null,current_cycle:input.cycle});
  add('holdout_seed_family_disjoint','HARD',!replicationMode||Number(input.replication_seed_collisions||0)===0,{collisions:Number(input.replication_seed_collisions||0)});
  add('holdout_scenarios_preregistered','HARD',!replicationMode||String(input.replication_scenario_mode||'')==='deterministic_holdout_perturbation_v1',{scenario_mode:input.replication_scenario_mode||null});
  add('holdout_fresh_human_identifier','HARD',!replicationMode||Number(input.replication_human_overlap||0)===0,{overlapping_participant_ids:Number(input.replication_human_overlap||0),scope:'server-issued invite identity; not a claim of external replication'});
  add('approval_delay_queue_realized','HARD',Number(input.confirmation_realized?.runs||0)>0&&Number(input.confirmation_realized?.non_queue_runs||0)===0,{runs:Number(input.confirmation_realized?.runs||0),non_queue_runs:Number(input.confirmation_realized?.non_queue_runs||0)});
  add('human_sample_realized','HARD',Number(hg.participants||0)>=Number(hg.required_participants||0)&&Number(hg.correct_trials||0)>=Number(hg.required_correct||0)&&Number(hg.wrong_trials||0)>=Number(hg.required_wrong||0),hg);
  add('human_discrimination_realized','HARD',Number.isFinite(ciLo)&&ciLo>=Number(hg.required_delta||.15),{estimate:hg.discrimination_estimate??null,ci95_lo:Number.isFinite(ciLo)?ciLo:null,required_delta:Number(hg.required_delta||.15),model_version:hg.model_version??null});
  add('confirmatory_episodes_realized','HARD',Number(input.confirmation_realized?.min_candidate_episodes||0)>=Number(input.confirmation_n||0),{required_per_candidate:Number(input.confirmation_n||0),min_candidate_episodes:Number(input.confirmation_realized?.min_candidate_episodes||0),candidates:Number(input.confirmation_realized?.candidates||0)});
  add('runtime_protocol_attestation','HARD',!!input.protocol?.protocol_hash&&Number(input.confirmation_realized?.runs||0)>0&&Number(input.confirmation_realized?.protocol_hash_mismatches||0)===0,{runs:Number(input.confirmation_realized?.runs||0),mismatches:Number(input.confirmation_realized?.protocol_hash_mismatches||0),expected_protocol_hash:input.protocol?.protocol_hash||null,note:'Every confirmatory run must carry the exact frozen protocol hash used at execution time.'});
  add('no_post_start_definition_changes','HARD',Number(input.post_start_definition_versions||0)===0,{post_start_definition_versions:Number(input.post_start_definition_versions||0)});
  add('policy_threshold_basis_declared','ADVISORY',/policy|regulatory|sla|expert|operational/i.test(String(input.constraint_basis||'')),{constraint_basis:input.constraint_basis||null,note:'Prior-cycle quantiles alone are exploratory and do not establish policy acceptability.'});
  add('threshold_sensitivity_available','ADVISORY',!!input.threshold_sensitivity_available,{available:!!input.threshold_sensitivity_available});
  add('robust_phase_coverage','ADVISORY',Number(input.robust_complete||0)>0&&Number(input.robust_missing||0)===0,{complete:input.robust_complete||0,missing:input.robust_missing||0});
  add('no_current_candidate_orphans','ADVISORY',Number(input.orphan_current||0)===0,{orphan_current:Number(input.orphan_current||0)});
  add('forking_path_ledger_populated','ADVISORY',Number(input.definition_versions||0)>0&&Number(input.protocol_versions||0)>0,{definition_versions:Number(input.definition_versions||0),protocol_versions:Number(input.protocol_versions||0),post_start_definition_versions:Number(input.post_start_definition_versions||0)});
  const hard=checks.filter(x=>x.level==='HARD'),advisory=checks.filter(x=>x.level==='ADVISORY');
  return {schema:'DCV-DOCTORAL-RIGOR-2',hard_pass:hard.every(x=>x.pass),hard_passed:hard.filter(x=>x.pass).length,hard_total:hard.length,advisory_passed:advisory.filter(x=>x.pass).length,advisory_total:advisory.length,checks};
}
export async function assessDoctoralRigor(env,projectId){
  const p=await one(env.DB,`SELECT research_cycle,evidence_revision FROM projects WHERE id=?`,[projectId]);if(!p)throw new Error('project_not_found');
  const cycle=Number(p.research_cycle||1);
  const cfg=await one(env.DB,`SELECT design_json,constraints_json,benchmark_json,validation_json FROM project_config WHERE project_id=?`,[projectId])||{};
  const design=safeJson(cfg.design_json,{}),constraints=safeJson(cfg.constraints_json,{}),benchmark=safeJson(cfg.benchmark_json,{}),validation=safeJson(cfg.validation_json,{});
  const protocol=await one(env.DB,`SELECT version,protocol_hash,frozen_at,status FROM research_protocols WHERE project_id=? AND research_cycle=? ORDER BY version DESC LIMIT 1`,[projectId,cycle]);
  const first=await one(env.DB,`SELECT MIN(r.created_at) first_run_at FROM simulation_runs r JOIN design_candidates c ON c.id=r.candidate_id WHERE r.project_id=? AND c.research_cycle=?`,[projectId,cycle]);
  const cands=await all(env.DB,`SELECT id,estimator,alpha,recovery_w,sigma,tau,delay_d,adjust_m,authority_k FROM design_candidates WHERE project_id=? AND research_cycle=?`,[projectId,cycle]);
  const seeds=await all(env.DB,`SELECT r.candidate_id,r.phase,r.seed FROM simulation_runs r JOIN design_candidates c ON c.id=r.candidate_id WHERE r.project_id=? AND c.research_cycle=? AND r.phase IN ('exploration','refinement','confirmation')`,[projectId,cycle]);
  const robust=await one(env.DB,`SELECT SUM(CASE WHEN x.n=3 THEN 1 ELSE 0 END) complete,SUM(CASE WHEN x.n<3 THEN 1 ELSE 0 END) missing FROM (SELECT c.id,COUNT(DISTINCT r.phase) n FROM design_candidates c LEFT JOIN simulation_runs r ON r.candidate_id=c.id AND r.phase IN ('confirmation','historical','stress') WHERE c.project_id=? AND c.research_cycle=? GROUP BY c.id) x`,[projectId,cycle]);
  const orphan=await one(env.DB,`SELECT COUNT(*) n FROM validations v LEFT JOIN design_candidates c ON c.id=v.candidate_id WHERE v.project_id=? AND v.candidate_id IS NOT NULL AND (c.id IS NULL OR c.research_cycle<>?)`,[projectId,cycle]);
  const defs=await one(env.DB,`SELECT COUNT(*) n,SUM(CASE WHEN ? IS NOT NULL AND created_at>? THEN 1 ELSE 0 END) post FROM definitions WHERE project_id=?`,[first?.first_run_at||null,first?.first_run_at||'',projectId]);
  const prots=await one(env.DB,`SELECT COUNT(*) n FROM research_protocols WHERE project_id=?`,[projectId]);
  const conf=await all(env.DB,`SELECT r.candidate_id,r.n,r.result_json FROM simulation_runs r JOIN design_candidates c ON c.id=r.candidate_id WHERE r.project_id=? AND c.research_cycle=? AND r.phase='confirmation'`,[projectId,cycle]);
  const byCand=new Map();let nonQueue=0,protocolHashMismatches=0;for(const r of conf){byCand.set(r.candidate_id,(byCand.get(r.candidate_id)||0)+Number(r.n||0));const j=safeJson(r.result_json,{});if(String(j.delay_mode||'')!=='queue_v1')nonQueue++;if(!protocol?.protocol_hash||String(j.protocol_hash||'')!==String(protocol.protocol_hash))protocolHashMismatches++;}
  const confirmation_realized={runs:conf.length,non_queue_runs:nonQueue,protocol_hash_mismatches:protocolHashMismatches,candidates:byCand.size,min_candidate_episodes:byCand.size?Math.min(...byCand.values()):0};
  const rm=await one(env.DB,`SELECT version,model_json FROM reviewer_models WHERE project_id=? AND research_cycle=? AND evidence_revision=? ORDER BY version DESC LIMIT 1`,[projectId,cycle,Number(p?.evidence_revision||0)]);const rmodel=safeJson(rm?.model_json,{}),sg=rmodel.sample_gate||{};
  const human_realized={model_version:rm?.version??null,participants:Number(sg.participants?.observed||rmodel.participants||0),required_participants:Number(sg.participants?.required||validation.min_human_participants||32),correct_trials:Number(sg.correct_trials?.observed||rmodel.correct_n||0),required_correct:Number(sg.correct_trials?.required||validation.min_human_correct_trials||300),wrong_trials:Number(sg.wrong_trials?.observed||rmodel.wrong_n||0),required_wrong:Number(sg.wrong_trials?.required||validation.min_human_wrong_trials||200),discrimination_estimate:sg.discrimination?.estimate??rmodel.discrimination_delta??null,discrimination_ci_lo:sg.discrimination?.ci95?.lo??rmodel.cluster_bootstrap?.ci95?.discrimination_delta?.lo??null,required_delta:Number(sg.discrimination?.minimum_effect||validation.human_min_discrimination_delta||.15)};
  let threshold_sensitivity_available=false;try{const a=await one(env.DB,`SELECT 1 x FROM audit_log WHERE project_id=? AND action='constraints.sensitivity.generated' LIMIT 1`,[projectId]);threshold_sensitivity_available=!!a?.x;}catch{}
  let replication=null,replicationSeedCollisions=0,replicationHumanOverlap=0;try{replication=await one(env.DB,`SELECT * FROM independent_replications WHERE project_id=? AND replication_cycle=? LIMIT 1`,[projectId,cycle]);}catch{}
  if(replication){const srcSeeds=await all(env.DB,`SELECT DISTINCT CAST(r.seed AS TEXT) seed FROM simulation_runs r JOIN design_candidates c ON c.id=r.candidate_id WHERE r.project_id=? AND c.research_cycle=?`,[projectId,Number(replication.source_cycle)]),curSeeds=new Set(seeds.map(x=>String(x.seed))),srcSet=new Set(srcSeeds.map(x=>String(x.seed)));replicationSeedCollisions=[...curSeeds].filter(x=>srcSet.has(x)).length;const overlap=await one(env.DB,`SELECT COUNT(*) n FROM (SELECT DISTINCT participant_hash FROM reviewer_trials WHERE project_id=? AND research_cycle=? INTERSECT SELECT DISTINCT participant_hash FROM reviewer_trials WHERE project_id=? AND research_cycle=?)`,[projectId,Number(replication.source_cycle),projectId,cycle]);replicationHumanOverlap=Number(overlap?.n||0);}
  return evaluateDoctoralRigor({cycle,protocol,first_run_at:first?.first_run_at||null,orthogonality:{...designOrthogonality(cands),factors:['estimator','alpha','recovery_w','sigma','tau','delay_d','adjust_m','authority_k']},seed_audit:seedFamilyAudit(seeds),confirmation_n:validation.confirmation_n,confirmation_realized,human_realized,constraint_basis:constraints.constraint_basis,threshold_sensitivity_available,robust_complete:Number(robust?.complete||0),robust_missing:Number(robust?.missing||0),orphan_current:Number(orphan?.n||0),definition_versions:Number(defs?.n||0),post_start_definition_versions:Number(defs?.post||0),protocol_versions:Number(prots?.n||0),replication_mode:benchmark.replication_mode,replication_scenario_mode:benchmark.replication_scenario_mode,replication_source_cycle:replication?.source_cycle??benchmark.replication_source_cycle,replication_lock_ok:!!replication&&Number(replication.source_cycle)<cycle&&!!replication.source_candidate_id&&!!replication.source_protocol_hash,replication_seed_collisions:replicationSeedCollisions,replication_human_overlap:replicationHumanOverlap});
}

export async function assessDoctoralRigorSnapshot(env,projectId,{project,content,cands,runRows,protocol}={}){
  const cycle=Number(project?.research_cycle||1);
  const constraints=content?.constraints||{},benchmark=content?.benchmark||{},validation=content?.validation||{};
  const firstRun=(runRows||[]).map(r=>r.created_at).filter(Boolean).sort()[0]||null;
  const dbRows=(cands||[]).map(c=>({estimator:c.estimator,alpha:c.alpha,recovery_w:c.W??c.recovery_w,sigma:c.sigma,tau:c.tau,delay_d:c.d??c.delay_d,adjust_m:c.m??c.adjust_m,authority_k:c.K??c.authority_k}));
  const seedRows=(runRows||[]).filter(r=>['exploration','refinement','confirmation'].includes(String(r.phase||''))).map(r=>({candidate_id:r.candidate_id,phase:r.phase,seed:r.seed}));
  const phaseBy=new Map();for(const r of runRows||[]){if(!['confirmation','historical','stress'].includes(String(r.phase||'')))continue;const s=phaseBy.get(r.candidate_id)||new Set();s.add(r.phase);phaseBy.set(r.candidate_id,s);}
  let robustComplete=0,robustMissing=0;for(const c of cands||[]){const n=phaseBy.get(c.id)?.size||0;if(n===3)robustComplete++;else robustMissing++;}
  const orphan=await one(env.DB,`SELECT COUNT(*) n FROM validations v LEFT JOIN design_candidates c ON c.id=v.candidate_id WHERE v.project_id=? AND v.candidate_id IS NOT NULL AND (c.id IS NULL OR c.research_cycle<>?)`,[projectId,cycle]);
  const defs=await one(env.DB,`SELECT COUNT(*) n,SUM(CASE WHEN ? IS NOT NULL AND created_at>? THEN 1 ELSE 0 END) post FROM definitions WHERE project_id=?`,[firstRun,firstRun||'',projectId]);
  const prots=await one(env.DB,`SELECT COUNT(*) n FROM research_protocols WHERE project_id=?`,[projectId]);
  const conf=(runRows||[]).filter(r=>String(r.phase||'')==='confirmation');
  const byCand=new Map();let nonQueue=0,protocolHashMismatches=0;for(const r of conf){byCand.set(r.candidate_id,(byCand.get(r.candidate_id)||0)+Number(r.n||0));const j=safeJson(r.result_json,{});if(String(j.delay_mode||'')!=='queue_v1')nonQueue++;if(!protocol?.protocol_hash||String(j.protocol_hash||'')!==String(protocol.protocol_hash))protocolHashMismatches++;}
  const confirmation_realized={runs:conf.length,non_queue_runs:nonQueue,protocol_hash_mismatches:protocolHashMismatches,candidates:byCand.size,min_candidate_episodes:byCand.size?Math.min(...byCand.values()):0};
  const rm=await one(env.DB,`SELECT version,model_json FROM reviewer_models WHERE project_id=? AND research_cycle=? AND evidence_revision=? ORDER BY version DESC LIMIT 1`,[projectId,cycle,Number(project?.evidence_revision||0)]);const rmodel=safeJson(rm?.model_json,{}),sg=rmodel.sample_gate||{};
  const human_realized={model_version:rm?.version??null,participants:Number(sg.participants?.observed||rmodel.participants||0),required_participants:Number(sg.participants?.required||validation.min_human_participants||32),correct_trials:Number(sg.correct_trials?.observed||rmodel.correct_n||0),required_correct:Number(sg.correct_trials?.required||validation.min_human_correct_trials||300),wrong_trials:Number(sg.wrong_trials?.observed||rmodel.wrong_n||0),required_wrong:Number(sg.wrong_trials?.required||validation.min_human_wrong_trials||200),discrimination_estimate:sg.discrimination?.estimate??rmodel.discrimination_delta??null,discrimination_ci_lo:sg.discrimination?.ci95?.lo??rmodel.cluster_bootstrap?.ci95?.discrimination_delta?.lo??null,required_delta:Number(sg.discrimination?.minimum_effect||validation.human_min_discrimination_delta||.15)};
  let threshold_sensitivity_available=false;try{const a=await one(env.DB,`SELECT 1 x FROM audit_log WHERE project_id=? AND action='constraints.sensitivity.generated' LIMIT 1`,[projectId]);threshold_sensitivity_available=!!a?.x;}catch{}
  let replication=null,replicationSeedCollisions=0,replicationHumanOverlap=0;try{replication=await one(env.DB,`SELECT * FROM independent_replications WHERE project_id=? AND replication_cycle=? LIMIT 1`,[projectId,cycle]);}catch{}
  if(replication){const srcSeeds=await all(env.DB,`SELECT DISTINCT CAST(r.seed AS TEXT) seed FROM simulation_runs r JOIN design_candidates c ON c.id=r.candidate_id WHERE r.project_id=? AND c.research_cycle=?`,[projectId,Number(replication.source_cycle)]),curSeeds=new Set(seedRows.map(x=>String(x.seed))),srcSet=new Set(srcSeeds.map(x=>String(x.seed)));replicationSeedCollisions=[...curSeeds].filter(x=>srcSet.has(x)).length;const overlap=await one(env.DB,`SELECT COUNT(*) n FROM (SELECT DISTINCT participant_hash FROM reviewer_trials WHERE project_id=? AND research_cycle=? INTERSECT SELECT DISTINCT participant_hash FROM reviewer_trials WHERE project_id=? AND research_cycle=?)`,[projectId,Number(replication.source_cycle),projectId,cycle]);replicationHumanOverlap=Number(overlap?.n||0);}
  return evaluateDoctoralRigor({cycle,protocol,first_run_at:firstRun,orthogonality:{...designOrthogonality(dbRows),factors:['estimator','alpha','recovery_w','sigma','tau','delay_d','adjust_m','authority_k']},seed_audit:seedFamilyAudit(seedRows),confirmation_n:validation.confirmation_n,confirmation_realized,human_realized,constraint_basis:constraints.constraint_basis,threshold_sensitivity_available,robust_complete:robustComplete,robust_missing:robustMissing,orphan_current:Number(orphan?.n||0),definition_versions:Number(defs?.n||0),post_start_definition_versions:Number(defs?.post||0),protocol_versions:Number(prots?.n||0),replication_mode:benchmark.replication_mode,replication_scenario_mode:benchmark.replication_scenario_mode,replication_source_cycle:replication?.source_cycle??benchmark.replication_source_cycle,replication_lock_ok:!!replication&&Number(replication.source_cycle)<cycle&&!!replication.source_candidate_id&&!!replication.source_protocol_hash,replication_seed_collisions:replicationSeedCollisions,replication_human_overlap:replicationHumanOverlap});
}

export const __test={cramersV};
