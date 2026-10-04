import {safeJson,sha256Hex,nowIso} from './util.js';
import {fitReducedForm} from './empirical.js';
import {wilson} from './stats.js';

export const LAB_SNAPSHOT_SCHEMA='DCV-LAB-EVIDENCE-3';
// One indexed project read and one bounded batch, never a query for each person/candidate.
export async function readLabSnapshot(env,campaign,{force=false}={}){
 const p=await env.DB.prepare('SELECT id,name,status,research_cycle,evidence_revision,reviewer_obs_count,candidate_count,updated_at FROM projects WHERE id=?').bind(campaign.project_id).first();
 if(!p)throw new Error('project_not_found');
 const signature=[LAB_SNAPSHOT_SCHEMA,p.id,p.research_cycle,p.evidence_revision,p.reviewer_obs_count,p.candidate_count,p.updated_at].join('|');
 const cachedSnapshot=safeJson(campaign.snapshot_json,null);
 if(!force&&campaign.snapshot_signature===signature&&cachedSnapshot?.schema===LAB_SNAPSHOT_SCHEMA&&Date.now()-Date.parse(campaign.snapshot_at)<86400000)return cachedSnapshot;
 const pid=p.id,cycle=Number(p.research_cycle||1),rev=Number(p.evidence_revision||0);
 const queries=[
  ['config','SELECT research_question,design_json,constraints_json,benchmark_json,validation_json FROM project_config WHERE project_id=?',[pid]],
  ['candidates','SELECT id,base_id,candidate_role,pair_seed_key,sigma,tau,alpha,authority_k,delay_d,recovery_w,adjust_m,estimator,status,evidence_status,max_regret,objective_score FROM design_candidates WHERE project_id=? AND research_cycle=? ORDER BY id LIMIT 501',[pid,cycle]],
  ['episodes','SELECT episode_name,year,country,peak_outflow,concentration,digital_adoption,severity,failed,provenance_type,source_note FROM empirical_episodes WHERE project_id=? ORDER BY year,episode_name LIMIT 1001',[pid]],
  ['human',`SELECT COUNT(*) n,COUNT(DISTINCT NULLIF(o.participant_hash,'anonymous')) participants,SUM(CASE WHEN (o.ai_correct=1 AND o.human_accept=1) OR (o.ai_correct=0 AND o.human_accept=0) THEN 1 ELSE 0 END) appropriate,SUM(CASE WHEN o.ai_correct=1 THEN 1 ELSE 0 END) correct_n,SUM(CASE WHEN o.ai_correct=0 THEN 1 ELSE 0 END) wrong_n FROM reviewer_observations o WHERE o.project_id=? AND json_extract(o.context_json,'$.protocol')='main_v2' AND json_extract(o.context_json,'$.trial_phase')='main' AND COALESCE(CAST(json_extract(o.context_json,'$.attention_check') AS INTEGER),0)=0 AND COALESCE(CAST(json_extract(o.context_json,'$.quality.trial_eligible') AS INTEGER),0)=1 AND NOT EXISTS(SELECT 1 FROM reviewer_quality_flags q WHERE q.project_id=o.project_id AND q.participant_hash=o.participant_hash AND q.protocol_version='main_v2' AND q.research_cycle=? AND q.evidence_revision=? AND q.severity='EXCLUDE') AND (SELECT COUNT(*) FROM reviewer_trials rt WHERE rt.project_id=o.project_id AND rt.participant_hash=o.participant_hash AND rt.protocol_version='main_v2' AND rt.research_cycle=? AND rt.trial_phase='main' AND rt.status='done')>=30 AND (SELECT COUNT(*) FROM reviewer_trials ra WHERE ra.project_id=o.project_id AND ra.participant_hash=o.participant_hash AND ra.protocol_version='main_v2' AND ra.research_cycle=? AND ra.trial_phase='attention' AND ra.status='done')>=3`,[pid,cycle,rev,cycle,cycle]],
  ['protocol','SELECT protocol_json,protocol_hash FROM research_protocols WHERE project_id=? AND research_cycle=? ORDER BY version DESC LIMIT 1',[pid,cycle]],
  ['validation','SELECT validation_type,status,COUNT(*) n FROM validations WHERE project_id=? AND evidence_revision=? GROUP BY validation_type,status',[pid,rev]],
  ['runs','SELECT r.candidate_id,r.phase,r.seed,r.n,r.loss_mean,r.loss_exceed_rate,r.fp_rate,r.fn_rate,r.review_burden,r.recovery_time,json_remove(r.result_json,\'$.raw.scenarios\',\'$.raw.groups\',\'$.scenario_scores\',\'$.validation_groups\') result_json FROM simulation_runs r JOIN design_candidates dc ON dc.id=r.candidate_id WHERE r.project_id=? AND dc.research_cycle=? ORDER BY r.created_at DESC LIMIT 1001',[pid,cycle]],
  ['sources','SELECT name,kind,last_status,last_fetched_at FROM data_sources WHERE project_id=? AND enabled=1 ORDER BY id LIMIT 101',[pid]]
 ];
 const results=await env.DB.batch(queries.map(([,sql,args])=>env.DB.prepare(sql).bind(...args)));
 const data=Object.fromEntries(queries.map(([key],i)=>[key,results[i].results||[]]));
 const limits={candidates:500,episodes:1000,runs:1000,sources:100};
 const truncated=Object.entries(limits).filter(([key,n])=>data[key].length>n).map(([key])=>key);
 for(const [key,n] of Object.entries(limits))data[key]=data[key].slice(0,n);
 const snapshot={schema:LAB_SNAPSHOT_SCHEMA,signature,project:p,captured_at:nowIso(),truncated,...data,
  config: data.config[0]||{},human:data.human[0]||{},protocol:data.protocol[0]||{}};
 snapshot.config={research_question:snapshot.config.research_question,design:safeJson(snapshot.config.design_json),constraints:safeJson(snapshot.config.constraints_json),benchmark:safeJson(snapshot.config.benchmark_json),validation:safeJson(snapshot.config.validation_json)};
 snapshot.protocol={hash:snapshot.protocol.protocol_hash,content:safeJson(snapshot.protocol.protocol_json)};
 snapshot.runs=snapshot.runs.map(r=>({...r,result:safeJson(r.result_json),result_json:undefined}));
 snapshot.diagnostics=diagnoseSnapshot(snapshot);
 snapshot.data_digest=await sha256Hex({project:{id:p.id,cycle,revision:rev},config:snapshot.config,candidates:snapshot.candidates,episodes:snapshot.episodes,human:snapshot.human,protocol:snapshot.protocol,validation:snapshot.validation,runs:snapshot.runs});
 snapshot.digest=await sha256Hex(JSON.stringify(snapshot));
 const serialized=JSON.stringify(snapshot);
 if(new TextEncoder().encode(serialized).length>1_500_000)throw new Error('evidence_snapshot_too_large: narrow the project or export offline');
 return snapshot;
}
export function diagnoseSnapshot(s){
 const cs=s.candidates||[],eps=s.episodes||[],human=s.human||{};
 const counts={};for(const c of cs)counts[c.status]=(counts[c.status]||0)+1;
 const verified=eps.filter(e=>e.provenance_type==='verified');
 let calibration=null,verified_calibration=null,errors=[];
 try{if(eps.length>=6)calibration=fitReducedForm(eps);}catch(e){errors.push('Calibration: '+e.message);}
 try{if(verified.length>=6)verified_calibration=fitReducedForm(verified);}catch(e){errors.push('Verified subset: '+e.message);}
 const n=Number(human.n||0),appropriate=Number(human.appropriate||0);
 const runChecks=(s.runs||[]).filter(r=>r.result?.raw).map(r=>({candidate_id:r.candidate_id,phase:r.phase,seed:r.seed,episodes:r.result.raw.episodes,decisions:r.result.raw.decisions}));
 const blockers=[];
 if(!s.protocol?.hash)blockers.push('Frozen research protocol missing');
 if(!cs.length)blockers.push('No candidate results');
 if(eps.length<81)blockers.push('Historical panel incomplete (target 81)');
 const hv=s.config?.validation||{},minP=Number(hv.min_human_participants||32),minC=Number(hv.min_human_correct_trials||300),minW=Number(hv.min_human_wrong_trials||200);
 if(Number(human.participants||0)<minP)blockers.push(`Fewer than ${minP} quality-controlled main_v2 human participants`);
 if(Number(human.correct_n||0)<minC||Number(human.wrong_n||0)<minW)blockers.push('Quality-controlled human correct/error strata below predeclared minimum');
 if(!s.validation?.some(v=>v.validation_type==='human_recompute'&&v.status==='CONFIRM'))blockers.push('Current-revision human recomputation not confirmed');
 if(s.truncated?.length)blockers.push('Snapshot truncated: '+s.truncated.join(', '));
 if(!runChecks.length)blockers.push('Raw simulation aggregates missing for reproduction');
 return {counts,episodes:eps.length,verified_episodes:verified.length,reconstructed_episodes:eps.length-verified.length,
  calibration,verified_calibration,human:{n,participants:Number(human.participants||0),appropriate_reliance:n?wilson(appropriate,n):null},
  raw_run_checks:runChecks.length,seed_replay_verified:false,
  replication_scope:'Independent reduced-form re-estimation and aggregate checks; complete simulation seed replay requires the supplied engine and full scenario/configuration audit.',
  blockers,errors};
}
export function promptEvidence(s){
 return {digest:s.digest,project:{id:s.project.id,name:s.project.name,cycle:s.project.research_cycle,revision:s.project.evidence_revision},
  protocol:{hash:s.protocol.hash,content:{...s.protocol.content,actual_candidate_plan:{count:s.protocol.content.actual_candidate_plan?.count}}},config:s.config,diagnostics:s.diagnostics,validation:s.validation,sources:s.sources,
  candidates:s.candidates.slice(0,20),scope:'Candidate examples are a bounded subset; counts in diagnostics use the complete bounded snapshot. Metadata-only literature is not full-text verification.'};
}
export async function collectLabLiterature(campaign,config,fetcher=fetch){
 const url=new URL('https://api.crossref.org/works');
 const angle=['','human oversight accountability','robust optimization decision uncertainty','public payment governance','algorithmic delegation boundaries'][Math.floor(campaign.cursor/70)%5];
 url.searchParams.set('query',[config.literature_query,angle].filter(Boolean).join(' '));url.searchParams.set('rows','12');
 url.searchParams.set('filter','type:journal-article,from-pub-date:2023-01-01');
 url.searchParams.set('select','DOI,title,author,container-title,published,URL,abstract');
 const response=await fetcher(url,{headers:{'user-agent':'DCVResearchLab/1.0 (bounded scholarly metadata collection)','accept':'application/json'},signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error('Crossref HTTP '+response.status);
 const json=await response.json();
 return (json.message?.items||[]).slice(0,12).filter(r=>r.DOI&&r.title?.[0]).map(r=>({doi:String(r.DOI).toLowerCase(),title:String(r.title[0]).slice(0,1000),
  authors:(r.author||[]).slice(0,20).map(a=>[a.given,a.family].filter(Boolean).join(' ')),journal:String(r['container-title']?.[0]||'').slice(0,300),
  published_year:Number(r.published?.['date-parts']?.[0]?.[0]||0),url:'https://doi.org/'+r.DOI,abstract:String(r.abstract||'').replace(/<[^>]*>/g,' ').slice(0,2500),retrieved_at:nowIso()}));
}
