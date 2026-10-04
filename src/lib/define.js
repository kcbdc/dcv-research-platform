import { one, run, audit } from './db.js';
import { cached, bust } from './memo.js';
import { aiJson } from './ai.js';
import { nowIso, uid, safeJson } from './util.js';
import { ensureEmpiricalProfile, empiricalReadiness } from './empirical.js';

const DEFAULT_DESIGN={
  sigma:[0.03,0.05,0.10], tau:[0,1,2], alpha:[0.15,0.35,0.55,0.75], K:[0,1,2,3], d:[0,1,2,4], W:[0.05,0.12,0.22], m:[0.08,0.15,0.25], estimators:['ema','kalman','changepoint','adaptive'], max_candidates:192, design_mode:'orthogonal_balanced_v3'
};
const DEFAULT_CONSTRAINTS={loss_max:0.18, loss_exceed_max:0.10, fp_max:0.055, fn_max:0.08, review_burden_max:0.30, recovery_time_max:2.5, confidence:0.95, constraint_basis:'queue_v1_exploratory_boundary_targets_v1'};
const DEFAULT_VALIDATION={multiplicity_method:'bonferroni',familywise_confidence:0.95,max_refinement:3,max_confirmation:2,exploration_n:180,refinement_n:240,confirmation_n:300,robust_n:300,cluster_bootstrap_n:300,human_protocol:'main_v2',min_human_participants:32,min_human_correct_trials:300,min_human_wrong_trials:200,human_fast_ms:800,human_slow_ms:60000,human_max_fast_share:0.30,human_attention_fail_max:1,human_min_discrimination_delta:0.15,human_practice_n:10,human_main_n:30,human_attention_n:3,human_ai_error_share:0.40,human_cue_noise_sd:0.18};

export async function defineProject(env, projectId){
  const p=await one(env.DB,`SELECT p.*,c.research_question,c.design_json,c.constraints_json,c.benchmark_json,c.validation_json FROM projects p LEFT JOIN project_config c ON c.project_id=p.id WHERE p.id=?`,[projectId]);
  if(!p) throw new Error('project_not_found');
  const design={...DEFAULT_DESIGN,...safeJson(p.design_json,{})};
  const constraints={...DEFAULT_CONSTRAINTS,...safeJson(p.constraints_json,{})};
  const validation={...DEFAULT_VALIDATION,...safeJson(p.validation_json,{})};
  const rq=p.research_question||'잡음과 승인 지연 하에서 알고리즘 위임 가능 영역은 어떻게 변화하는가?';
  await ensureEmpiricalProfile(env,projectId);
  const empirical=await empiricalReadiness(env,projectId);
  const gate={
    D0_empirical_anchor_defined:!!empirical?.profile,
    D1_computable_question:!!rq,
    D2_variables_separated:Array.isArray(design.sigma)&&Array.isArray(design.K),
    D3_constraints_defined:Object.keys(constraints).length>=5,
    D4_thresholds_numeric:['loss_max','fp_max','fn_max','review_burden_max','recovery_time_max'].every(k=>Number.isFinite(Number(constraints[k]))),
    D5_authority_defined:Array.isArray(design.K)&&design.K.length>1,
    D6_recovery_defined:Array.isArray(design.W)&&Array.isArray(design.m)
  };
  const pass=Object.values(gate).filter(Boolean).length;
  const status=pass===Object.keys(gate).length?'CONFIRM':pass>=5?'REVISE':'HOLD';
  const content={research_question:rq,design,constraints,benchmark:{confidence_method:'residual_common_v1',...safeJson(p.benchmark_json,{})},validation,empirical_calibration:{status:empirical.status,target_rows:empirical.target_rows,complete_rows:empirical.complete_rows,profile_version:empirical.profile?.version,profile_name:empirical.profile?.name}};
  const ai=await aiJson(env,
    'You are a neutral research design auditor. Check operational definitions, falsifiability, measurement validity, and hidden assumptions.',
    JSON.stringify({content,gate}),
    {summary:'AI review unavailable; deterministic gate used.',risks:[],suggestions:[]}
  );
  const last=await one(env.DB,`SELECT COALESCE(MAX(version),0) v FROM definitions WHERE project_id=?`,[projectId]);
  const id=uid('def');
  await run(env.DB,`INSERT INTO definitions(id,project_id,version,status,content_json,gate_json,ai_note,created_at) VALUES(?,?,?,?,?,?,?,?)`,
    [id,projectId,(last?.v||0)+1,status,JSON.stringify(content),JSON.stringify(gate),JSON.stringify(ai),nowIso()]);
  await run(env.DB,`UPDATE projects SET current_stage=?,status=?,updated_at=? WHERE id=?`,[status==='CONFIRM'?'measure':'define',status.toLowerCase(),nowIso(),projectId]);
  bust(env,projectId);
  await audit(env,projectId,'agent','define.complete','definition',id,{status,gate});
  return {id,status,gate,content,ai};
}

export async function latestDefinition(env, projectId){
  // compute_candidate 1건마다(그리고 무결성 검사에서 또 한 번) 조회되던 정의를 isolate 메모로. 저장 시 bust.
  return cached(env,projectId,'def:latest',async()=>{
    const d=await one(env.DB,`SELECT * FROM definitions WHERE project_id=? ORDER BY version DESC LIMIT 1`,[projectId]);
    if(!d) return null;
    return {...d,content:safeJson(d.content_json,{}),gate:safeJson(d.gate_json,{})};
  });
}
