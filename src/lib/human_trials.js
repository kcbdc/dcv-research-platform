import {one,all,run} from './db.js';
import {uid,nowIso,safeJson,hashString,mulberry32,clamp,randn,sha256Hex,stableStringify} from './util.js';
import {latestDefinition} from './define.js';
import {secureEqual} from './auth.js';
import {replicationParticipantAllowed} from './replication.js';
export const HUMAN_PROTOCOL='main_v2';
export const LEGACY_PROTOCOL='legacy_v1';
const CONF=[.55,.75,.92];

export function humanProtocolSettings(def){
 const v=def?.content?.validation||{};
 return {
  protocol:HUMAN_PROTOCOL,practice_n:Number(v.human_practice_n??10),main_n:Number(v.human_main_n??30),attention_n:Number(v.human_attention_n??3),
  confidences:CONF,ai_error_share:Number(v.human_ai_error_share??.40),fast_ms:Number(v.human_fast_ms??800),slow_ms:Number(v.human_slow_ms??60000),
  max_fast_share:Number(v.human_max_fast_share??.30),attention_fail_max:Number(v.human_attention_fail_max??1),min_discrimination_delta:Number(v.human_min_discrimination_delta??.15),
  cue_noise_sd:Number(v.human_cue_noise_sd??.18),task_version:'noisy_cues_v3',schedule_version:'balanced_6c4w_per_confidence_v3'
 };
}
async function protocolState(env,projectId){const def=await latestDefinition(env,projectId),settings=humanProtocolSettings(def),hash=await sha256Hex(stableStringify(settings));return{def,settings,hash};}
export async function humanProtocolHash(env,projectId){return (await protocolState(env,projectId)).hash;}

function shuffled(a,rng){a=[...a];for(let i=a.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function mainSchedule(participant){
 const rng=mulberry32(hashString(`human-v3|${participant}`)&0x7fffffff),rows=[];
 for(const confidence of CONF){for(let i=0;i<6;i++)rows.push({confidence,ai_correct:1});for(let i=0;i<4;i++)rows.push({confidence,ai_correct:0});}
 return shuffled(rows,rng);
}
function makeTask(participant,phase,ordinal,settings={cue_noise_sd:.18}){
 const rng=mulberry32(hashString(`${participant}|${phase}|${ordinal}|DCV-human-v3`)&0x7fffffff);
 if(phase==='attention'){
  const confidence=CONF[(ordinal-1)%CONF.length];
  return {confidence,ai_correct:1,recommendation:1,attention_check:1,expected_accept:0,task:{scope:'decision_v3_noisy_cues',risk_band:['낮음','중간','높음'][(ordinal+1)%3],anomaly_indicator:ordinal%2?'상승':'보통',transaction_pattern:'최근 변동성 혼재',evidence_note:'표시된 단서는 잡음이 포함된 불완전 정보입니다.',decision_prompt:'품질 확인 지시: 이번 문항에서는 단서 및 AI 권고와 관계없이 “인간 개입”을 선택하세요.'}};
 }
 const isPractice=phase==='practice',spec=isPractice?{confidence:CONF[(ordinal-1)%3],ai_correct:(ordinal%5<3)?1:0}:mainSchedule(participant)[ordinal-1];
 const latent=clamp(.15+.70*rng(),0,1), truth=latent>.55, noisy=clamp(latent+randn(rng)*Number(settings.cue_noise_sd??.18),0,1);
 const correct=!!spec.ai_correct,recommendation=correct?truth:!truth;
 const band=noisy<.38?'낮음':noisy<.62?'중간':'높음';
 const anomaly=noisy+.10*randn(rng)>.62?'상승':'보통';
 const task={scope:isPractice?'practice_v3_noisy_cues':'main_v3_noisy_cues',risk_band:band,anomaly_indicator:anomaly,transaction_pattern:rng()>.5?'최근 변동성 확대':'최근 변동성 안정',evidence_note:'표시된 단서는 잡음이 포함된 불완전 정보입니다. 숨겨진 실제 위험상태나 정답 규칙은 제공되지 않습니다.',decision_prompt:'불완전한 단서와 AI 권고를 함께 보고 권고를 수용할지 인간이 개입할지 판단하세요.'};
 return {confidence:spec.confidence,ai_correct:correct?1:0,recommendation:recommendation?1:0,task,attention_check:0,expected_accept:null};
}

async function resumePendingTrial(env,projectId,participant,cycle,protocolHash,settings){
 const rows=await all(env.DB,`SELECT id,confidence,recommendation,task_json,trial_phase,ordinal,attention_check,expected_accept,created_at FROM reviewer_trials WHERE project_id=? AND research_cycle=? AND participant_hash=? AND protocol_version=? AND status='pending' ORDER BY created_at DESC,id DESC`,[projectId,cycle,participant,HUMAN_PROTOCOL]);
 if(!rows.length)return null;
 const keep=rows[0];
 if(rows.length>1){
  const extras=rows.slice(1).map(x=>x.id);
  for(const id of extras)await run(env.DB,`UPDATE reviewer_trials SET status='superseded' WHERE id=? AND status='pending'`,[id]);
 }
 const raw=safeJson(keep.task_json,{}),task={...raw};delete task.protocol_hash;
 return {trial_id:keep.id,protocol:HUMAN_PROTOCOL,protocol_hash:protocolHash,phase:keep.trial_phase,confidence:Number(keep.confidence),recommendation:!!keep.recommendation,task,attention_check:!!keep.attention_check,trial_number:Number(keep.ordinal),practice_cap:settings.practice_n,cap:settings.main_n,attention_cap:settings.attention_n,feedback_after_response:keep.trial_phase==='practice',resumed_pending:true,pending_created_at:keep.created_at};
}

async function counts(env,projectId,participant,cycle){
 const xs=await all(env.DB,`SELECT trial_phase,status,COUNT(*) n FROM reviewer_trials WHERE project_id=? AND research_cycle=? AND participant_hash=? AND protocol_version=? GROUP BY trial_phase,status`,[projectId,cycle,participant,HUMAN_PROTOCOL]);
 const get=(p,s)=>Number(xs.find(x=>x.trial_phase===p&&x.status===s)?.n||0), total=p=>get(p,'done')+get(p,'pending');
 return {practice_done:get('practice','done'),practice_total:total('practice'),main_done:get('main','done'),main_total:total('main'),attention_done:get('attention','done'),attention_total:total('attention')};
}
async function issueSessionToken(env,projectId,participant,cycle){const token=`hs_${crypto.randomUUID()}_${crypto.randomUUID()}`,hash=await sha256Hex(token);await run(env.DB,`UPDATE reviewer_sessions SET session_token_hash=?,updated_at=? WHERE project_id=? AND participant_hash=? AND protocol_version=? AND research_cycle=?`,[hash,nowIso(),projectId,participant,HUMAN_PROTOCOL,cycle]);return token;}
export async function verifyHumanSession(env,projectId,participant,token){if(!token)return false;const p=await one(env.DB,'SELECT research_cycle FROM projects WHERE id=?',[projectId]);if(!p)return false;const row=await one(env.DB,`SELECT session_token_hash,quiz_passed FROM reviewer_sessions WHERE project_id=? AND participant_hash=? AND protocol_version=? AND research_cycle=?`,[projectId,participant,HUMAN_PROTOCOL,Number(p.research_cycle||1)]);if(!row?.quiz_passed||!row.session_token_hash)return false;return secureEqual(String(row.session_token_hash),await sha256Hex(String(token)));}


export async function loginHumanInvite(env,inviteToken,requestFingerprint='',projectId=null){
 if(!inviteToken)throw new Error('human_invite_required');
 const tokenHash=await sha256Hex(String(inviteToken));
 const row=await one(env.DB,`SELECT i.*,p.name project_name,p.research_cycle current_cycle,p.evidence_revision current_revision FROM reviewer_invites i JOIN projects p ON p.id=i.project_id WHERE i.token_hash=? ${projectId?'AND i.project_id=?':''} LIMIT 1`,projectId?[tokenHash,projectId]:[tokenHash]);
 if(!row)throw new Error('invalid_human_invite');
 const cycle=Number(row.current_cycle||1);if(Number(row.research_cycle||0)!==cycle)throw new Error('human_invite_stale_cycle');
 const fpHash=requestFingerprint?await sha256Hex(`${row.project_id}|${requestFingerprint}`):null;
 if(row.status==='used'&&row.request_fingerprint_hash&&fpHash&&String(row.request_fingerprint_hash)!==String(fpHash))throw new Error('human_invite_device_mismatch');
 const derived=await sha256Hex(`human-login|${row.project_id}|${cycle}|${row.subject_hash||row.id}|${row.id}`);
 const participant=String(row.participant_hash||`hp_${derived.slice(0,32)}`);
 if(row.status==='unused')await run(env.DB,`UPDATE reviewer_invites SET status='used',participant_hash=?,request_fingerprint_hash=?,used_at=? WHERE id=? AND status='unused'`,[participant,fpHash,nowIso(),row.id]);
 const check=await one(env.DB,`SELECT status,participant_hash,request_fingerprint_hash FROM reviewer_invites WHERE id=?`,[row.id]);
 if(check?.status!=='used'||String(check?.participant_hash||'')!==participant)throw new Error('human_invite_binding_failed');
 if(check.request_fingerprint_hash&&fpHash&&String(check.request_fingerprint_hash)!==String(fpHash))throw new Error('human_invite_device_mismatch');
 const sess=await one(env.DB,`SELECT quiz_passed FROM reviewer_sessions WHERE project_id=? AND participant_hash=? AND protocol_version=? AND research_cycle=?`,[row.project_id,participant,HUMAN_PROTOCOL,cycle]);
 const session_token=Number(sess?.quiz_passed||0)===1?await issueSessionToken(env,row.project_id,participant,cycle):null;
 return {status:session_token?'READY':'QUIZ_REQUIRED',project_id:row.project_id,project_name:row.project_name||'DCV Research',research_cycle:cycle,evidence_revision:Number(row.current_revision||0),protocol:HUMAN_PROTOCOL,participant_hash:participant,participant_label:`P-${derived.slice(0,8).toUpperCase()}`,invite_label:row.label||null,quiz_required:!session_token,session_token};
}

export async function issueHumanInvite(env,projectId,{label=null,subject_key=null}={}){
 const p=await one(env.DB,'SELECT research_cycle FROM projects WHERE id=?',[projectId]);if(!p)throw new Error('project_not_found');
 const token=`hi_${crypto.randomUUID()}_${crypto.randomUUID()}`,hash=await sha256Hex(token),id=uid('hinv'),subjectHash=await sha256Hex(String(subject_key||id));
 await run(env.DB,`INSERT INTO reviewer_invites(id,project_id,research_cycle,token_hash,label,subject_hash,status,created_at) VALUES(?,?,?,?,?,?,'unused',?)`,[id,projectId,Number(p.research_cycle||1),hash,label?String(label).slice(0,120):null,subjectHash,nowIso()]);
 return {id,invite_token:token,research_cycle:Number(p.research_cycle||1),status:'unused',subject_key_bound:!!subject_key};
}
async function bindHumanInvite(env,projectId,participant,inviteToken,cycle,requestFingerprint=''){
 if(!inviteToken)throw new Error('human_invite_required');const h=await sha256Hex(String(inviteToken));
 const row=await one(env.DB,`SELECT * FROM reviewer_invites WHERE project_id=? AND research_cycle=? AND token_hash=?`,[projectId,cycle,h]);if(!row)throw new Error('invalid_human_invite');
 const fpHash=requestFingerprint?await sha256Hex(`${projectId}|${requestFingerprint}`):null;
 if(row.status==='used'&&String(row.participant_hash||'')!==String(participant))throw new Error('human_invite_already_used');
 if(row.status==='used'&&row.request_fingerprint_hash&&fpHash&&String(row.request_fingerprint_hash)!==fpHash)throw new Error('human_invite_device_mismatch');
 if(row.status==='unused')await run(env.DB,`UPDATE reviewer_invites SET status='used',participant_hash=?,request_fingerprint_hash=?,used_at=? WHERE id=? AND status='unused'`,[participant,fpHash,nowIso(),row.id]);
 const check=await one(env.DB,`SELECT participant_hash,status FROM reviewer_invites WHERE id=?`,[row.id]);if(String(check?.participant_hash||'')!==String(participant)||check?.status!=='used')throw new Error('human_invite_binding_failed');return {invite_id:row.id,subject_hash:row.subject_hash||null};
}
function postPracticePlan(participant,settings){
 const main=mainSchedule(participant).map((x,i)=>({phase:'main',mainOrdinal:i+1,spec:x})),rng=mulberry32(hashString(`attention-slots|${participant}`)&0x7fffffff);
 const slots=[4+Math.floor(rng()*6),14+Math.floor(rng()*7),24+Math.floor(rng()*7)].sort((a,b)=>a-b),out=[];let mi=0,ai=0;
 for(let pos=1;pos<=settings.main_n+settings.attention_n;pos++){if(ai<slots.length&&pos===slots[ai]){out.push({phase:'attention',attentionOrdinal:ai+1});ai++;}else{out.push(main[mi++]);}}
 return out;
}

export async function submitHumanQuiz(env,projectId,participant,answers,inviteToken=null,requestFingerprint=''){
 if(typeof participant!=='string'||participant.length<8||participant.length>200)throw new Error('Participant pseudonym is required');
 const p=await one(env.DB,'SELECT research_cycle,evidence_revision FROM projects WHERE id=?',[projectId]);if(!p)throw new Error('project_not_found');
 const invite=await bindHumanInvite(env,projectId,participant,inviteToken,Number(p.research_cycle||1),requestFingerprint);
 const eligibility=await replicationParticipantAllowed(env,projectId,participant,Number(p.research_cycle||1),invite.subject_hash);if(!eligibility.allowed)throw new Error(eligibility.reason||'replication_requires_fresh_participant');
 const prev=await one(env.DB,`SELECT * FROM reviewer_sessions WHERE project_id=? AND participant_hash=? AND protocol_version=? AND research_cycle=?`,[projectId,participant,HUMAN_PROTOCOL,Number(p.research_cycle||1)]);
 if(Number(prev?.quiz_attempts||0)>=2&&!prev?.quiz_passed)throw new Error('understanding_quiz_failed_twice');
 const a=Array.isArray(answers)?answers.map(Boolean):[],key=[true,false,true,false,true],score=key.reduce((n,x,i)=>n+(a[i]===x?1:0),0),passed=prev?.quiz_passed?true:score===key.length,attempts=prev?.quiz_passed?Number(prev.quiz_attempts||1):Number(prev?.quiz_attempts||0)+1,ts=nowIso();
 await run(env.DB,`INSERT INTO reviewer_sessions(id,project_id,participant_hash,protocol_version,research_cycle,evidence_revision,quiz_attempts,quiz_passed,started_at,updated_at,subject_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,participant_hash,protocol_version,research_cycle) DO UPDATE SET evidence_revision=excluded.evidence_revision,quiz_attempts=excluded.quiz_attempts,quiz_passed=excluded.quiz_passed,updated_at=excluded.updated_at,subject_hash=COALESCE(reviewer_sessions.subject_hash,excluded.subject_hash)`,[prev?.id||uid('hsess'),projectId,participant,HUMAN_PROTOCOL,Number(p.research_cycle||1),Number(p.evidence_revision||0),attempts,passed?1:0,prev?.started_at||ts,ts,invite.subject_hash]);
 const session_token=passed?await issueSessionToken(env,projectId,participant,Number(p.research_cycle||1)):null;
 return {status:passed?'PASS':'RETRY',score,attempts,max_attempts:2,protocol:HUMAN_PROTOCOL,session_token,reeducation:passed?null:'연구 문항에는 잡음이 있는 단서가 제시됩니다. AI 권고는 참고정보이며 항상 맞지 않습니다. 주의확인 문항의 지시는 그대로 따라야 합니다.'};
}

export async function createHumanTrial(env,projectId,participant,sessionToken=null){
 if(typeof participant!=='string'||participant.length<8||participant.length>200)throw new Error('Participant pseudonym is required');
 const p=await one(env.DB,'SELECT research_cycle,evidence_revision FROM projects WHERE id=?',[projectId]);if(!p)throw new Error('project_not_found');
 const eligibility=await replicationParticipantAllowed(env,projectId,participant,Number(p.research_cycle||1));if(!eligibility.allowed)throw new Error(eligibility.reason||'replication_requires_fresh_participant');
 const sess=await one(env.DB,`SELECT quiz_passed,quiz_attempts FROM reviewer_sessions WHERE project_id=? AND participant_hash=? AND protocol_version=? AND research_cycle=?`,[projectId,participant,HUMAN_PROTOCOL,Number(p.research_cycle||1)]);if(!sess?.quiz_passed)throw new Error(Number(sess?.quiz_attempts||0)>=2?'understanding_quiz_failed_twice':'understanding_quiz_required');
 if(sessionToken!==null&&!(await verifyHumanSession(env,projectId,participant,sessionToken)))throw new Error('invalid_human_session');
 const cycle=Number(p.research_cycle||1),{settings,hash}=await protocolState(env,projectId);
 const pending=await resumePendingTrial(env,projectId,participant,cycle,hash,settings);if(pending)return pending;
 const c=await counts(env,projectId,participant,cycle);
 let phase,ordinal;
 if(c.practice_done<settings.practice_n){phase='practice';ordinal=c.practice_done+1;}
 else {
  const done=c.main_done+c.attention_done,total=c.main_total+c.attention_total;if(done>=settings.main_n+settings.attention_n)throw new Error('participant_trial_cap_reached');if(total>done)throw new Error('complete_pending_trial');
  const slot=postPracticePlan(participant,settings)[done];phase=slot.phase;ordinal=phase==='main'?slot.mainOrdinal:slot.attentionOrdinal;
 }
 const t=makeTask(participant,phase,ordinal,settings),id=uid('trial'),now=nowIso(),taskJson={...t.task,protocol_hash:hash};
 const result=await env.DB.prepare(`INSERT INTO reviewer_trials(id,project_id,participant_hash,confidence,ai_correct,recommendation,task_json,research_cycle,evidence_revision,created_at,protocol_version,trial_phase,ordinal,attention_check,expected_accept,protocol_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,projectId,participant,t.confidence,t.ai_correct,t.recommendation,JSON.stringify(taskJson),p.research_cycle,p.evidence_revision,now,HUMAN_PROTOCOL,phase,ordinal,t.attention_check,t.expected_accept,hash).run();
 if(!result.meta?.changes)throw new Error('trial_create_failed');
 return {trial_id:id,protocol:HUMAN_PROTOCOL,protocol_hash:hash,phase,confidence:t.confidence,recommendation:!!t.recommendation,task:t.task,attention_check:!!t.attention_check,trial_number:ordinal,practice_cap:settings.practice_n,cap:settings.main_n,attention_cap:settings.attention_n,feedback_after_response:phase==='practice'};
}
async function upsertFlag(env,projectId,participant,t,code,severity,detail={}){await run(env.DB,`INSERT INTO reviewer_quality_flags(id,project_id,participant_hash,protocol_version,research_cycle,evidence_revision,flag_code,severity,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,participant_hash,protocol_version,research_cycle,evidence_revision,flag_code) DO UPDATE SET severity=excluded.severity,detail_json=excluded.detail_json,created_at=excluded.created_at`,[uid('hqf'),projectId,participant,HUMAN_PROTOCOL,t.research_cycle,t.evidence_revision,code,severity,JSON.stringify(detail),nowIso()]);}
export async function recordHumanTrial(env,projectId,b,sessionToken=null){
 const t=await one(env.DB,'SELECT t.*,p.research_cycle current_cycle FROM reviewer_trials t JOIN projects p ON p.id=t.project_id WHERE t.id=? AND t.project_id=? AND t.participant_hash=?',[b.trial_id,projectId,b.participant_hash]);
 if(!t||t.status!=='pending'||Number(t.research_cycle)!==Number(t.current_cycle))throw new Error('Invalid, consumed or superseded trial');
 if(sessionToken!==null&&!(await verifyHumanSession(env,projectId,b.participant_hash,sessionToken)))throw new Error('invalid_human_session');
 if(typeof b.human_accept!=='boolean')throw new Error('Invalid response');
 const {settings,hash}=await protocolState(env,projectId);if(t.protocol_hash&&String(t.protocol_hash)!==hash)throw new Error('human_protocol_drift');
 const completedAt=nowIso(),serverMs=Math.max(0,Date.parse(completedAt)-Date.parse(t.created_at)),clientMs=Number.isFinite(Number(b.response_ms))?Math.max(0,Number(b.response_ms)):null;
 const id=uid('review'),correct=!!t.ai_correct,recovered=!correct&&!b.human_accept,focusBlur=Math.max(0,Number(b.focus_blur_count||0));
 const tooFast=serverMs<settings.fast_ms,tooSlow=serverMs>settings.slow_ms,attentionFail=!!t.attention_check&&Number(t.expected_accept)!==(b.human_accept?1:0),analysisEligible=t.trial_phase==='main'&&!tooFast&&!tooSlow;
 const context={protocol:HUMAN_PROTOCOL,protocol_version:HUMAN_PROTOCOL,protocol_hash:hash,task:safeJson(t.task_json),cycle:t.research_cycle,trial_phase:t.trial_phase,ordinal:t.ordinal,attention_check:!!t.attention_check,focus_blur_count:focusBlur,timing:{server_response_ms:serverMs,client_response_ms:clientMs,client_server_abs_diff_ms:clientMs==null?null:Math.abs(clientMs-serverMs)},quality:{too_fast:tooFast,too_slow:tooSlow,attention_fail:attentionFail,trial_eligible:analysisEligible}};
 const rs=await env.DB.batch([
  env.DB.prepare(`INSERT INTO reviewer_observations(id,project_id,participant_hash,ai_confidence,ai_correct,human_accept,response_ms,recovered,recovery_ms,context_json,created_at,trial_id) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM reviewer_trials WHERE id=? AND status='pending')`).bind(id,projectId,b.participant_hash,t.confidence,t.ai_correct,b.human_accept?1:0,serverMs,recovered?1:0,recovered?serverMs:null,JSON.stringify(context),completedAt,t.id,t.id),
  env.DB.prepare("UPDATE reviewer_trials SET status='done',completed_at=? WHERE id=? AND EXISTS(SELECT 1 FROM reviewer_observations WHERE id=?)").bind(completedAt,t.id,id),
  env.DB.prepare('UPDATE projects SET reviewer_obs_count=reviewer_obs_count+1,reviewer_last_observed_at=?,reviewer_hold_marker=NULL WHERE id=? AND EXISTS(SELECT 1 FROM reviewer_observations WHERE id=?)').bind(completedAt,projectId,id)
 ]);
 if(!rs[0].meta?.changes)throw new Error('Trial already consumed');
 if(tooFast)await upsertFlag(env,projectId,b.participant_hash,t,'FAST_RESPONSE_TRIAL','WARN',{threshold_ms:settings.fast_ms});
 if(tooSlow)await upsertFlag(env,projectId,b.participant_hash,t,'SLOW_RESPONSE_TRIAL','WARN',{threshold_ms:settings.slow_ms});
 if(attentionFail)await upsertFlag(env,projectId,b.participant_hash,t,'ATTENTION_FAILURE','WARN',{ordinal:t.ordinal});
 const qc=await one(env.DB,`WITH scoped AS (
   SELECT o.human_accept,o.response_ms,o.created_at,rt.trial_phase,rt.attention_check,rt.expected_accept
   FROM reviewer_observations o JOIN reviewer_trials rt ON rt.id=o.trial_id
   WHERE o.project_id=? AND o.participant_hash=? AND rt.protocol_version=? AND rt.research_cycle=?
 ), last10 AS (
   SELECT human_accept FROM scoped WHERE trial_phase='main' ORDER BY created_at DESC LIMIT 10
 ) SELECT
   SUM(CASE WHEN trial_phase='main' THEN 1 ELSE 0 END) main_n,
   SUM(CASE WHEN trial_phase='main' AND response_ms<? THEN 1 ELSE 0 END) fast_main,
   SUM(CASE WHEN attention_check=1 AND expected_accept IS NOT NULL AND expected_accept<>human_accept THEN 1 ELSE 0 END) attention_fail,
   (SELECT COUNT(*) FROM last10) last10_n,
   (SELECT COUNT(DISTINCT human_accept) FROM last10) last10_distinct
 FROM scoped`,[projectId,b.participant_hash,HUMAN_PROTOCOL,Number(t.research_cycle),settings.fast_ms]);
 // v0.10.7: fast-share denominator and numerator are both MAIN trials from the same cycle.
 // The old query counted fast practice/attention trials in the numerator, which could falsely exclude a participant.
 if(Number(qc?.main_n||0)>=10&&Number(qc?.fast_main||0)/Math.max(1,Number(qc?.main_n||0))>settings.max_fast_share)await upsertFlag(env,projectId,b.participant_hash,t,'FAST_RESPONSE_PARTICIPANT','EXCLUDE',{fast:qc.fast_main,n:qc.main_n,threshold:settings.max_fast_share});
 if(Number(qc?.attention_fail||0)>settings.attention_fail_max)await upsertFlag(env,projectId,b.participant_hash,t,'ATTENTION_FAILURE_PARTICIPANT','EXCLUDE',{failed:qc.attention_fail,max_allowed:settings.attention_fail_max});
 if(Number(qc?.last10_n||0)===10&&Number(qc?.last10_distinct||0)===1)await upsertFlag(env,projectId,b.participant_hash,t,'STRAIGHTLINE_10','EXCLUDE',{length:10});
 return {id,correct,recovered,protocol:HUMAN_PROTOCOL,phase:t.trial_phase,response_ms_server:serverMs,response_ms_client:clientMs,feedback:t.trial_phase==='practice'?{ai_correct:correct}:null,quality:context.quality};
}
export const __test={mainSchedule,makeTask};
export const makeHumanTask = makeTask;
