import {buildDocx} from '../../public/docx.js';
import {labZip,labBarPng} from './lab_archive.js';
import {REPLICATION_CODE} from './lab_code_bundle.js';
import {MANUSCRIPT_SECTIONS,journalAssessment} from './lab_policy.js';
import {nowIso,sha256Hex,safeJson} from './util.js';

const label={abstract:'Abstract',introduction:'Introduction',related_work:'Related literature',methods:'Methods',results:'Results',discussion:'Discussion',conclusion:'Conclusion'};
const table=(heads,rows)=>`| ${heads.join(' | ')} |\n| ${heads.map(()=>'---').join(' | ')} |\n${rows.map(r=>'| '+r.map(v=>String(v??'Not available').replace(/\|/g,'/').replace(/\n/g,' ')).join(' | ')+' |').join('\n')}`;
const csv=rows=>{if(!rows.length)return '';const keys=Object.keys(rows[0]);const cell=v=>'"'+String(typeof v==='object'?JSON.stringify(v):v??'').replaceAll('"','""')+'"';return '\uFEFF'+[keys.map(cell).join(','),...rows.map(r=>keys.map(k=>cell(r[k])).join(','))].join('\n');};
export function labReadiness(campaign,snapshot,documents,sources,journals,taskReviews=[],replication=null){
 const config=safeJson(campaign.config_json),docs=new Map(documents.map(d=>[d.section,d]));
 const blockers=[...(snapshot.diagnostics?.blockers||[])];
 const journal=journalAssessment(journals,config.metric_years,config.target_journal);
 if(!journal.eligible)blockers.push('Official three-year journal eligibility evidence missing or below threshold');
 if(!config.target_journal)blockers.push('Target journal not selected');
 if(!config.authors?.length||config.authors.some(a=>!a.name||!a.affiliation)||!config.authors.some(a=>a.corresponding&&a.email))blockers.push('Real authors, affiliations and corresponding author incomplete');
 if(!config.ethics_statement)blockers.push('Human-research ethics/consent statement not supplied');
 if(!config.funding||!config.conflicts)blockers.push('Author-confirmed funding and conflict declarations incomplete');
 if(sources.length<15)blockers.push('Fewer than 15 DOI-verified references');
 if(new Set((config.full_text_verified_dois||[]).map(d=>d.toLowerCase()).filter(d=>sources.some(s=>s.doi.toLowerCase()===d))).size<10)blockers.push('Full-text support verification missing for key literature');
 for(const section of MANUSCRIPT_SECTIONS){const d=docs.get(section);if(!d?.markdown?.trim())blockers.push('Manuscript section missing: '+section);else if(d.evidence_signature!==snapshot.data_digest)blockers.push('Manuscript section uses superseded evidence: '+section);}
 for(const section of ['cover_letter','title_page','highlights','appendices'])if(!docs.get(section)?.markdown?.trim())blockers.push('Submission document missing: '+section);
 const words=MANUSCRIPT_SECTIONS.map(k=>docs.get(k)?.markdown||'').join(' ').split(/\s+/).filter(Boolean).length;
 if(words<3500)blockers.push('Main manuscript below 3500-word internal review floor');
 const replayChecks=safeJson(replication?.checks_json),replayVerified=replication?.data_digest===snapshot.data_digest&&replayChecks.full_seed_replay===true;
 if(!replayVerified)blockers.push('Complete simulation seed replay has not been independently verified');
 for(const review of taskReviews){const output=safeJson(review.output_json);if(output.blockers?.length)blockers.push(...output.blockers.map(b=>`${review.role_id}: ${b}`));}
 if(Number(campaign.failed_tasks||0)>0)blockers.push('Campaign contains exhausted task failures');
 return {status:blockers.length?'DRAFT_REQUIRES_REVIEW':'INTERNAL_REVIEW_COMPLETE',blockers:[...new Set(blockers)],word_count:words,journal,replication:replayVerified?replication:null,
  acceptance:'Not submitted; journal acceptance is an external editorial decision',human_signoff_required:true};
}
const REPRO_SCRIPT=`import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fitReducedForm} from './src/lib/empirical.js';
import {wilson} from './src/lib/stats.js';
const snapshot=JSON.parse(fs.readFileSync(new URL('./data/evidence_snapshot.json',import.meta.url),'utf8'));
const expected=snapshot.digest;delete snapshot.digest;
assert.equal(createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),expected,'Snapshot hash mismatch');
const counts={};for(const c of snapshot.candidates)counts[c.status]=(counts[c.status]||0)+1;
assert.deepEqual(counts,snapshot.diagnostics.counts,'Candidate totals mismatch');
if(snapshot.episodes.length>=6){const fit=fitReducedForm(snapshot.episodes);assert.deepEqual(fit,snapshot.diagnostics.calibration,'Calibration mismatch');}
const h=snapshot.human;if(Number(h.n)>0)assert.deepEqual(wilson(Number(h.appropriate||0),Number(h.n)),snapshot.diagnostics.human.appropriate_reliance,'Human interval mismatch');
console.log(JSON.stringify({ok:true,scope:'hash, candidate totals, OLS and human Wilson interval',full_seed_replay:false},null,2));
`;
export async function buildLabPackage(campaign,snapshot,documents,sources,journals,reviews=[],replication=null){
 const config=safeJson(campaign.config_json),docs=new Map(documents.map(d=>[d.section,d.markdown]));
 const readiness=labReadiness(campaign,snapshot,documents,sources,journals,reviews,replication);
 const title=campaign.title,notice=`Package status: ${readiness.status}. Generated ${nowIso()}.\n\nThis is an AI-assisted research draft. Real authors must verify every claim, citation, ethics declaration and journal requirement before submission. Journal acceptance has not been obtained.\n\n`;
 const references=sources.map(s=>`${(safeJson(s.authors_json,[])||s.authors||[]).join(', ')} (${s.published_year||'n.d.'}). ${s.title}. ${s.journal||''}. https://doi.org/${s.doi}`).join('\n\n');
 const replaceCitations=md=>String(md).replace(/\[SRC:([^\]]+)\]/g,(_,doi)=>`(https://doi.org/${doi})`);
 let manuscript=`# ${title}\n\n`+MANUSCRIPT_SECTIONS.map(k=>`## ${label[k]}\n\n${replaceCitations(docs.get(k)||'This section has not yet passed the research workflow.')}\n`).join('\n');
 const entries=Object.entries(snapshot.diagnostics.counts),image=await labBarPng(entries.map(([,v])=>v));
 manuscript+=`\n## Auditable results summary\n\n${table(['Candidate classification','Count'],entries)}\n\n![Candidate classifications](figures/candidate_classifications.png)\n\nFigure 1. Candidate counts in the frozen project snapshot. Bars follow the table order above. These are model-conditional classifications, not observed treatment effects.\n\n## References\n\n${references}`;
 const images={candidate_classifications:{data:image,w:640,h:240}};
 const authors=config.authors.map(a=>`${a.name}, ${a.affiliation}${a.corresponding?' (Corresponding author: '+a.email+')':''}`).join('\n\n');
 const cover=docs.get('cover_letter')||`# Cover letter\n\nDear Editor,\n\nPlease review the accompanying draft entitled ${title}. The target journal and submission declarations require author verification.\n\n${authors||'Author details not supplied.'}`;
 // Author identity and declarations come exclusively from human-supplied settings.
 const titlePage=`# ${title}\n\n${authors||'Author details not supplied.'}\n\n## Funding\n\n${config.funding||'Not supplied.'}\n\n## Conflicts of interest\n\n${config.conflicts||'Not supplied.'}\n\n## Research ethics\n\n${config.ethics_statement||'Not supplied.'}\n\n## AI assistance\n\nRole-specific AI agents assisted literature organization, analysis interpretation and drafting. Human authors remain responsible for the work.`;
 const highlights=docs.get('highlights')||'# Highlights\n\nHighlights are pending evidence-based editorial review.';
 const appendix=(docs.get('appendices')||'# Online supplementary appendices')+`\n\n## Evidence and verification boundaries\n\n${table(['Item','Value'],[['Project',snapshot.project.id],['Research cycle',snapshot.project.research_cycle],['Evidence revision',snapshot.project.evidence_revision],['Snapshot SHA256',snapshot.digest],['Historical episodes',snapshot.episodes.length],['Verified episodes',snapshot.diagnostics.verified_episodes],['Real human participants',snapshot.diagnostics.human.participants],['Full seed replay',readiness.replication?'Externally verified by '+readiness.replication.verified_by:'Not independently verified']])}\n\n## Reproducibility diagnostics\n\n${JSON.stringify(snapshot.diagnostics,null,2)}\n\n## Journal verification\n\n${table(['Journal','Metric year','Edition','Category','Quartile','AIS','Verifier'],journals.map(r=>[r.journal,r.metric_year,r.edition,r.category,r.quartile,r.ais,r.verified_by]))}`;
 const supplementFiles=[{name:'package.json',data:JSON.stringify({private:true,type:'module',scripts:{reproduce:'node reproduce.mjs'},engines:{node:'>=22'}},null,2)},
  {name:'reproduce.mjs',data:REPRO_SCRIPT},{name:'data/evidence_snapshot.json',data:JSON.stringify(snapshot)},
  {name:'data/candidates.csv',data:csv(snapshot.candidates)},{name:'data/crisis_episodes.csv',data:csv(snapshot.episodes)},
  {name:'data/simulation_run_summaries.json',data:JSON.stringify(snapshot.runs)},
  {name:'data/literature.json',data:JSON.stringify(sources)},{name:'data/journal_evidence.json',data:JSON.stringify(journals)},{name:'data/independent_replay_review.json',data:JSON.stringify(replication)},
  {name:'figures/candidate_classifications.png',data:image},...REPLICATION_CODE,
  {name:'README.md',data:'# Reproduction\n\nRun `npm run reproduce` using Node 22 or newer. No network or D1 connection is needed for snapshot hash, reduced-form OLS, candidate totals and human Wilson interval checks.\n\nThe supplied simulation engine and schema document the original model. Full seed replay is not certified by these aggregate checks. Reconstructed historical rows and model-conditional assumptions must be disclosed. Human records are exported only as aggregate counts; participant identifiers are excluded.\n'}];
 const supplement=await labZip(supplementFiles);
 const doc=(md)=>buildDocx(md,{images,title,author:config.authors.map(a=>a.name).join('; ')||'DCV Research Lab AI draft'});
 const files=[{name:'1_Manuscript.docx',data:doc(manuscript)},{name:'2_Cover_Letter.docx',data:doc(cover)},
  {name:'3_Supplementary_Data_and_code.zip',data:supplement},{name:'4_Title_Page.docx',data:doc(titlePage)},
  {name:'5_Highlights.docx',data:doc(highlights)},{name:'6_Online_Supplementary_Appendices.docx',data:doc(appendix)},
  {name:'README_SUBMISSION_STATUS.txt',data:notice+'Blocking issues:\n'+readiness.blockers.map(b=>'- '+b).join('\n')}];
 const manifest={schema:'DCV-SUBMISSION-PACKAGE-1',project_id:snapshot.project.id,snapshot_digest:snapshot.digest,created_at:nowIso(),readiness,files:[]};
 for(const file of files)manifest.files.push({name:file.name,bytes:typeof file.data==='string'?new TextEncoder().encode(file.data).length:file.data.length,sha256:await sha256Bytes(file.data)});
 files.push({name:'manifest.json',data:JSON.stringify(manifest,null,2)});
 const bytes=await labZip(files);
 if(bytes.length>8_000_000)throw new Error('Package exceeds bounded 8MB storage budget');
 return {bytes,manifest,sha256:await sha256Bytes(bytes)};
}
export async function sha256Bytes(data){const bytes=typeof data==='string'?new TextEncoder().encode(data):data;const digest=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');}
