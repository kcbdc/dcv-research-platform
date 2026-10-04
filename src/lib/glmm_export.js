import {all,one} from './db.js';
import {safeJson,sha256Hex,stableStringify} from './util.js';
import {latestDefinition} from './define.js';

function csvCell(v){const s=v==null?'':String(v);return /[",\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s;}
export function rowsToCsv(rows){
  const cols=['participant_id','ai_correct','ai_confidence','confidence_z','human_accept','server_response_ms','client_response_ms','client_server_abs_diff_ms','research_cycle','evidence_revision'];
  return [cols.join(','),...rows.map(r=>cols.map(c=>csvCell(r[c])).join(','))].join('\n');
}

export async function buildReviewerGlmmPackage(env,projectId){
  const p=await one(env.DB,`SELECT research_cycle,evidence_revision FROM projects WHERE id=?`,[projectId]);if(!p)throw new Error('project_not_found');
  const cycle=Number(p.research_cycle||1),rev=Number(p.evidence_revision||0),def=await latestDefinition(env,projectId),v=def?.content?.validation||{},protocol=String(v.human_protocol||'main_v2');
  const raw=await all(env.DB,`SELECT o.participant_hash,o.ai_correct,o.ai_confidence,o.human_accept,o.response_ms,o.context_json,s.subject_hash
    FROM reviewer_observations o LEFT JOIN reviewer_sessions s ON s.project_id=o.project_id AND s.participant_hash=o.participant_hash AND s.protocol_version=? AND s.research_cycle=?
    WHERE o.project_id=? AND json_extract(o.context_json,'$.protocol')=? AND json_extract(o.context_json,'$.trial_phase')='main' AND COALESCE(CAST(json_extract(o.context_json,'$.attention_check') AS INTEGER),0)=0
      AND COALESCE(CAST(json_extract(o.context_json,'$.quality.trial_eligible') AS INTEGER),0)=1
      AND NOT EXISTS(SELECT 1 FROM reviewer_quality_flags q WHERE q.project_id=o.project_id AND q.participant_hash=o.participant_hash AND q.protocol_version=? AND q.research_cycle=? AND q.evidence_revision=? AND q.severity='EXCLUDE')
      AND (SELECT COUNT(*) FROM reviewer_trials rt WHERE rt.project_id=o.project_id AND rt.participant_hash=o.participant_hash AND rt.protocol_version=? AND rt.research_cycle=? AND rt.trial_phase='main' AND rt.status='done')>=?
      AND (SELECT COUNT(*) FROM reviewer_trials ra WHERE ra.project_id=o.project_id AND ra.participant_hash=o.participant_hash AND ra.protocol_version=? AND ra.research_cycle=? AND ra.trial_phase='attention' AND ra.status='done')>=?
    ORDER BY o.created_at`,[protocol,cycle,projectId,protocol,protocol,cycle,rev,protocol,cycle,Number(v.human_main_n||30),protocol,cycle,Number(v.human_attention_n||3)]);
  const rows=[];for(const r of raw){const ctx=safeJson(r.context_json,{}),q=ctx.quality||{},pid=r.subject_hash||await sha256Hex(`${projectId}|${r.participant_hash}`),conf=Number(r.ai_confidence||.75);rows.push({participant_id:pid,ai_correct:Number(r.ai_correct||0),ai_confidence:conf,confidence_z:(conf-.75)/.2,human_accept:Number(r.human_accept||0),server_response_ms:Number(q.server_response_ms??r.response_ms??0),client_response_ms:q.client_response_ms==null?null:Number(q.client_response_ms),client_server_abs_diff_ms:q.client_server_abs_diff_ms==null?null:Number(q.client_server_abs_diff_ms),research_cycle:cycle,evidence_revision:rev});}
  const csv=rowsToCsv(rows),metadata={schema:'DCV-REVIEWER-GLMM-1',protocol,research_cycle:cycle,evidence_revision:rev,n:rows.length,participants:new Set(rows.map(r=>r.participant_id)).size,formula:'human_accept ~ ai_correct * confidence_z + (1 | participant_id)',family:'binomial(logit)',purpose:'confirmatory publication inference; platform operational model remains a penalized approximation'};
  const dataHash=await sha256Hex(stableStringify(rows));
  const r_script=`# DCV confirmatory reviewer GLMM\n# Generated package hash: ${dataHash}\nlibrary(lme4)\nd <- read.csv("reviewer_glmm.csv", stringsAsFactors=FALSE)\nd$participant_id <- factor(d$participant_id)\nfit <- glmer(human_accept ~ ai_correct * confidence_z + (1 | participant_id), data=d, family=binomial(link="logit"), control=glmerControl(optimizer="bobyqa"))\nprint(summary(fit))\nprint(confint(fit, parm="beta_", method="profile"))\n# Primary preregistered contrast is the ai_correct coefficient; report estimate, 95% CI and sensitivity analyses.\n`;
  return {metadata,data_hash:dataHash,csv,r_script};
}
