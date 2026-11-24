import {all,one,run,enqueueOnce} from './db.js';
import {hashString,sha256Hex,safeJson,nowIso} from './util.js';
import {freezeConfirm,runConfirm,calibrateLoss} from './research_confirm.js';
import {gridEffects,kstarEffects} from './research_effects.js';
import {latestDefinition} from './define.js';
import {latestProtocol} from './rigor.js';
import {loadEmpiricalCalibration} from './empirical.js';
import {__test} from './compute.js';
const axes=['sigma','tau','alpha','authority_k','delay_d','recovery_w','adjust_m','estimator'];
const key=c=>JSON.stringify(axes.map(k=>c[k]));
const finite=Number.isFinite;
export function regionVerdicts(result,effects,p2Definition=null){
 const rows=result.region.map(r=>({...r.candidate,verdict:r.actual}));
 const g=gridEffects(rows); const verdict=(lo,hi,r)=>!finite(lo)||!finite(hi)||!r?'INCONCLUSIVE':(r.direction===1?lo:-hi)>r.minimum?'SUPPORTED':(r.direction===1?hi:-lo)<r.minimum?'REFUTED':'INCONCLUSIVE';
 const kg=kstarEffects(result.region);const p2=Object.entries(p2Definition==='kstar_grid_v1'?kg:g.P2).map(([axis,q])=>[axis,verdict(q.lower,q.upper,effects.P2_axes?.[axis])]);
 const registered=effects.P2_axes?Object.fromEntries(p2):null;
 const primary=registered&&(p2Definition==='kstar_grid_v1'?['alpha','delay_d']:['alpha','delay_d','authority_k']).map(k=>registered[k]);
 const p2Status=primary?(primary.every(v=>v==='SUPPORTED')?'SUPPORTED':primary.some(v=>v==='REFUTED')?'REFUTED':'INCONCLUSIVE'):'INCONCLUSIVE';
 const n=result.region.length, x=result.subset.expansion,u=result.subset.unknown;
 return {P1:verdict(g.P1.lower,g.P1.upper,effects.P1),P2:['finite_grid_signed_interactions_v1','kstar_grid_v1'].includes(p2Definition)?p2Status:'INCONCLUSIVE',P2_definition:p2Definition,P2_registered_signed_contrasts:p2Status,P2_axes:registered,P3:result.hypotheses.P3,P4:x>0?'REFUTED':n>0&&u===0?'SUPPORTED':'INCONCLUSIVE',bounds:g,kstar_bounds:kg,scope:'fixed registered grid; simultaneous computational intervals; P2 uses explicitly registered definition; Kstar uses two slope contrasts; P4 subset (equality allowed); no external validity claim'};
}
export async function freezeFinal(env,id,input){
 const p=await one(env.DB,'SELECT research_cycle,evidence_revision FROM projects WHERE id=?',[id]);if(!p)throw Error('project_not_found');
 const cycle=Number(p.research_cycle),revision=Number(p.evidence_revision);
 const protocol=await latestProtocol(env,id),def=await latestDefinition(env,id);if(!protocol?.protocol?.execution_config||!def)throw Error('frozen_execution_protocol_required');
 const configDef={...def,content:{...def.content,...protocol.protocol.execution_config}};
 const rm=await one(env.DB,'SELECT model_json FROM reviewer_models WHERE project_id=? AND research_cycle=? AND evidence_revision=? ORDER BY version DESC LIMIT 1',[id,cycle,revision]);if(!rm)throw Error('current_reviewer_model_required');
 const grid=await all(env.DB,'SELECT sigma,tau,alpha,authority_k,delay_d,recovery_w,adjust_m,estimator FROM design_candidates WHERE project_id=? AND research_cycle=? ORDER BY boundary_score DESC,id',[id,cycle]);
 const unique=[...new Map(grid.map(c=>[key(c),c])).values()];
 const cal=await loadEmpiricalCalibration(env,id),config=__test.configFrom(configDef,env,cal);
 if(input.cost_rows){if(input.cost_unit!=='normalized_model_loss')throw Error('normalized_model_loss_unit_required');config.empirical={...config.empirical,loss:{...config.empirical.loss,...calibrateLoss(input.cost_rows)}};}
 const scenarios=(await __test.loadScenarios(env,id,'confirmation',cal)).scenarios;
 const runs=await all(env.DB,'SELECT DISTINCT seed,n FROM simulation_runs WHERE project_id=? ORDER BY seed,n',[id]);for(const r of runs)if(!Number.isSafeInteger(r.seed)||!Number.isSafeInteger(r.n)||r.n<1||r.n>100000)throw Error('invalid_source_run');
 const prior=await all(env.DB,'SELECT spec_json FROM research_confirm_jobs WHERE project_id=?',[id]);const seeds=new Set(runs.map(r=>r.seed));for(const r of prior){const s=safeJson(r.spec_json,{});for(let i=0;i<(s.adaptive_looks?.at(-1)||s.blocks);i++)seeds.add(hashString(`${s.namespace}|confirm-v1|${i}`));}
 if(!seeds.size)throw Error('source_runs_required');
 if(!Number.isSafeInteger(input.blocks)||input.blocks<2||unique.length*(input.adaptive_looks?.at(-1)||input.blocks)*config.horizon>30000000)throw Error('compute_budget_exceeded');
 const namespace=crypto.randomUUID();const spec={grid:unique,scenarios,sourceSeeds:[...seeds],sourceRuns:runs,blocks:input.blocks,namespace,reviewer:safeJson(rm.model_json,{}),config,constraints:configDef.content.constraints,effects:input.effects,bounds:input.bounds,interactionAxis:'alpha',adaptive_looks:input.adaptive_looks||null,selective_boundary:true,p2_definition:input.p2_definition||null,cost_provenance:input.cost_rows||null,protocol_hash:protocol.protocol_hash,cycle,revision};
 if(new TextEncoder().encode(JSON.stringify(spec)).length>1800000)throw Error("frozen_snapshot_too_large");const frozen=await freezeConfirm(spec);const latest=await one(env.DB,'SELECT research_cycle,evidence_revision FROM projects WHERE id=?',[id]);if(Number(latest.research_cycle)!==cycle||Number(latest.evidence_revision)!==revision)throw Error('evidence_changed_retry');
 await run(env.DB,`INSERT INTO research_confirm_jobs(project_id,cycle,revision,hash,spec_json,created_at) VALUES(?,?,?,?,?,?)`,[id,cycle,revision,frozen.hash,JSON.stringify(spec),nowIso()]);return {hash:frozen.hash,cycle,revision,grid:unique.length,blocks:spec.blocks};
}
export async function queueFinal(env,id){const r=await currentFinal(env,id);if(!r||r.result)throw Error('no_pending_frozen_protocol');return {job:await enqueueOnce(env,id,'research_confirm_final',{hash:r.hash},90),hash:r.hash};}
export async function currentFinal(env,id){const r=await one(env.DB,`SELECT j.hash,j.cycle,j.revision,j.created_at,j.result_json,j.code_revision FROM research_confirm_jobs j JOIN projects p ON p.id=j.project_id AND p.research_cycle=j.cycle AND p.evidence_revision=j.revision WHERE j.project_id=?`,[id]);return r?{hash:r.hash,cycle:r.cycle,revision:r.revision,created_at:r.created_at,code_revision:r.code_revision,result:safeJson(r.result_json,null)}:null;}
export async function executeFinal(env,id,hash){if(env.EXTERNAL_RUNTIME!=='github-actions'||!env.RUNNER_CODE_REVISION)throw Error('confirm_requires_github_actions');const row=await one(env.DB,'SELECT * FROM research_confirm_jobs WHERE project_id=? AND hash=?',[id,hash]);const current=await currentFinal(env,id);if(!row||current?.hash!==hash)return {skipped:'stale'};if(current.result)return {skipped:'already_done'};const spec=JSON.parse(row.spec_json);const result=await runConfirm({spec,hash});result.region_propositions=regionVerdicts(result,spec.effects,spec.p2_definition);result.boundary_candidates=result.region.filter(r=>r.actual==='HOLD'||r.ideal==='HOLD').map(r=>r.candidate);const latest=await currentFinal(env,id);if(latest?.hash!==hash)return {skipped:'stale'};if(new TextEncoder().encode(JSON.stringify(result)).length>1800000)throw Error("result_too_large");await run(env.DB,'UPDATE research_confirm_jobs SET result_json=?,code_revision=? WHERE project_id=? AND hash=? AND result_json IS NULL',[JSON.stringify(result),env.RUNNER_CODE_REVISION||null,id,hash]);return {hash,region:result.region.length};}
