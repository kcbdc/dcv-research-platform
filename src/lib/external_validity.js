import {all,one,run,audit} from './db.js';
import {nowIso,uid,safeJson} from './util.js';

const SHA256=/^[a-f0-9]{64}$/i;
const LEVELS=['INTERNAL_COMPUTATIONAL','CONTEXTUAL_PUBLIC_PAYMENT','OUTCOME_VALIDATED_PUBLIC_PAYMENT','INDEPENDENT_EXTERNAL_REPLICATION'];

export function evaluateExternalValidity(input={}){
  const caseBRows=Number(input.case_b_rows||0);
  const datasets=Array.isArray(input.datasets)?input.datasets:[];
  const evaluations=Array.isArray(input.evaluations)?input.evaluations:[];
  const verified=datasets.filter(d=>String(d.status||'').toUpperCase()==='VERIFIED');
  const publicData=verified.filter(d=>Number(d.actual_public_payment||0)===1);
  const labelled=publicData.filter(d=>Number(d.outcome_ground_truth||0)===1);
  const evalByDataset=new Map();
  for(const e of evaluations){
    if(String(e.status||'').toUpperCase()!=='PASS'||Number(e.n||0)<30)continue;
    if(!SHA256.test(String(e.analysis_code_hash||''))||!SHA256.test(String(e.result_hash||'')))continue;
    const a=evalByDataset.get(e.dataset_id)||[];a.push(e);evalByDataset.set(e.dataset_id,a);
  }
  const outcomeValidated=labelled.filter(d=>(evalByDataset.get(d.id)||[]).some(e=>String(e.dataset_hash||d.data_hash||'')===String(d.data_hash||'')));
  const independent=outcomeValidated.filter(d=>Number(d.independent_source||0)===1&&(evalByDataset.get(d.id)||[]).some(e=>Number(e.independent_implementation||0)===1&&String(e.implementation_scope||'').toLowerCase()!=='dcv_platform'));
  let level=LEVELS[0];
  if(caseBRows>0||publicData.length)level=LEVELS[1];
  if(outcomeValidated.length)level=LEVELS[2];
  if(independent.length)level=LEVELS[3];
  const rank=LEVELS.indexOf(level);
  const supports=[
    'conditional delegation-region identification within the declared simulation model',
    ...(rank>=1?['contextual alignment with observed public fiscal/subsidy-payment environment']:[]),
    ...(rank>=2?['out-of-sample outcome consistency on registered public-payment records with explicit ground truth']:[]),
    ...(rank>=3?['external replication across an independent data source and non-DCV implementation']:[])
  ];
  const doesNotSupport=[
    'causal effect of delegation',
    'universally optimal public-payment threshold',
    'directly identified social welfare cost of FP/FN',
    ...(rank<2?['claim that algorithmic delegation outcomes are externally validated on real public-payment decisions']:[]),
    ...(rank<3?['claim of independent external replication']:[])
  ];
  return {
    schema:'DCV-EXTERNAL-VALIDITY-1',level,rank,
    public_payment_context_available:caseBRows>0||publicData.length>0,
    outcome_validated:outcomeValidated.length>0,
    independent_external_replication:independent.length>0,
    counts:{case_b_official_rows:caseBRows,verified_datasets:verified.length,actual_public_payment_datasets:publicData.length,outcome_labelled_datasets:labelled.length,outcome_validated_datasets:outcomeValidated.length,independent_replication_datasets:independent.length},
    supports,does_not_support:doesNotSupport,
    claim_guard:rank===0?'INTERNAL_ONLY':rank===1?'CONTEXT_ONLY':rank===2?'OUTCOME_VALIDATED':'INDEPENDENT_EXTERNAL_REPLICATION',
    note:rank<2?'Case B aggregate/context data do not by themselves provide payment-stop/fraud ground truth.':rank<3?'External outcome validation exists, but it is not an independent implementation replication.':'Independent source + non-DCV implementation replication is registered.'
  };
}

export async function assessExternalValidity(env,projectId){
  const caseB=await one(env.DB,`SELECT COUNT(*) n FROM official_observations WHERE project_id=? AND case_layer='B'`,[projectId]);
  let datasets=[],evaluations=[];
  try{
    datasets=await all(env.DB,`SELECT * FROM external_validity_datasets WHERE project_id=? ORDER BY created_at`,[projectId]);
    evaluations=await all(env.DB,`SELECT e.*,d.data_hash dataset_hash FROM external_validity_evaluations e JOIN external_validity_datasets d ON d.id=e.dataset_id WHERE e.project_id=? ORDER BY e.created_at`,[projectId]);
  }catch{}
  return {...evaluateExternalValidity({case_b_rows:Number(caseB?.n||0),datasets,evaluations}),datasets,evaluations};
}

export async function registerExternalValidityDataset(env,projectId,input={}){
  const dataHash=String(input.data_hash||'').trim();
  if(!SHA256.test(dataHash))throw new Error('external_dataset_sha256_required');
  const actual=input.actual_public_payment?1:0,outcome=input.outcome_ground_truth?1:0,independent=input.independent_source?1:0;
  const rows=Math.max(0,Math.floor(Number(input.row_count||0)));
  const provenance=input.provenance&&typeof input.provenance==='object'?input.provenance:{};
  if(actual&&!String(input.domain||'').trim())throw new Error('external_dataset_domain_required');
  if(outcome&&!String(provenance.outcome_definition||'').trim())throw new Error('outcome_definition_required');
  if(!String(provenance.source_url||provenance.source_document||provenance.source_note||'').trim())throw new Error('dataset_provenance_required');
  const status=String(input.status||'REGISTERED').toUpperCase()==='VERIFIED'?'VERIFIED':'REGISTERED',id=uid('extdata'),ts=nowIso();
  await run(env.DB,`INSERT INTO external_validity_datasets(id,project_id,name,domain,jurisdiction,source_type,actual_public_payment,outcome_ground_truth,independent_source,row_count,data_hash,provenance_json,status,created_at,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[id,projectId,String(input.name||'External validation dataset').slice(0,240),String(input.domain||'').slice(0,120),String(input.jurisdiction||'').slice(0,80),String(input.source_type||'external_records').slice(0,80),actual,outcome,independent,rows,dataHash,JSON.stringify(provenance),status,ts,status==='VERIFIED'?ts:null]);
  await audit(env,projectId,'user','external_validity.dataset_registered','external_validity_dataset',id,{status,actual_public_payment:!!actual,outcome_ground_truth:!!outcome,independent_source:!!independent,row_count:rows,data_hash:dataHash});
  return {id,status,data_hash:dataHash,row_count:rows};
}

export async function recordExternalValidityEvaluation(env,projectId,input={}){
  const datasetId=String(input.dataset_id||'');
  const d=await one(env.DB,`SELECT * FROM external_validity_datasets WHERE id=? AND project_id=?`,[datasetId,projectId]);if(!d)throw new Error('external_dataset_not_found');
  if(String(d.status||'').toUpperCase()!=='VERIFIED')throw new Error('external_dataset_must_be_verified');
  const codeHash=String(input.analysis_code_hash||''),resultHash=String(input.result_hash||'');
  if(!SHA256.test(codeHash)||!SHA256.test(resultHash))throw new Error('external_evaluation_hashes_required');
  const n=Math.max(0,Math.floor(Number(input.n||0)));if(n<1)throw new Error('external_evaluation_n_required');
  const status=['PASS','FAIL','HOLD'].includes(String(input.status||'').toUpperCase())?String(input.status).toUpperCase():'HOLD';
  const p=await one(env.DB,`SELECT research_cycle FROM projects WHERE id=?`,[projectId]);
  const implementationScope=String(input.implementation_scope||'dcv_platform').slice(0,120),independent=input.independent_implementation?1:0;
  if(independent&&implementationScope.toLowerCase()==='dcv_platform')throw new Error('independent_implementation_scope_required');
  const id=uid('exteval'),ts=nowIso();
  await run(env.DB,`INSERT INTO external_validity_evaluations(id,project_id,dataset_id,research_cycle,candidate_id,status,n,result_json,analysis_code_hash,result_hash,implementation_scope,independent_implementation,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,[id,projectId,datasetId,Number(p?.research_cycle||1),input.candidate_id||null,status,n,JSON.stringify(input.result||{}),codeHash,resultHash,implementationScope,independent,ts]);
  await audit(env,projectId,'user','external_validity.evaluation_recorded','external_validity_evaluation',id,{dataset_id:datasetId,status,n,analysis_code_hash:codeHash,result_hash:resultHash,implementation_scope:implementationScope,independent_implementation:!!independent});
  return {id,status,n};
}
