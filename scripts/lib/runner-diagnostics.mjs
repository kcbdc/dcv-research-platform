export class RunnerError extends Error {
 constructor(code,message,details={}){super(message);this.name='RunnerError';this.code=code;this.safeMessage=message;this.details=details;}
}
export function diagnoseD1(status,json){
 const errors=[...(json?.errors||[]),...(Array.isArray(json?.result)?json.result.flatMap(r=>r.errors||[{message:r.error||''}]):[])];
 const codes=errors.map(e=>e.code).filter(c=>Number.isInteger(c));
 const missing=errors.map(e=>/no such (table|column):\s*([a-zA-Z_][a-zA-Z0-9_.]*)/.exec(String(e.message||''))).find(Boolean);
 let code='D1_REQUEST_FAILED',message='D1 request failed. Check the Cloudflare error codes and persisted job errors.';
 if(status===401||status===403){code='D1_AUTHORIZATION_FAILED';message='Check CF_D1_API_TOKEN permissions and its Cloudflare account scope.';}
 else if(status===404){code='D1_DATABASE_NOT_FOUND';message='Check CF_ACCOUNT_ID and CF_D1_DATABASE_ID point to the same account/database.';}
 else if(status===429){code='D1_RATE_LIMITED';message='Cloudflare rate limit reached; rerun after backoff.';}
 else if(errors.some(e=>/UNIQUE constraint failed:\s*research_protocols\.project_id,\s*research_protocols\.version/i.test(String(e.message||'')))){code='PROTOCOL_VERSION_CONFLICT';message='Protocol version collided across research cycles. Apply the protocol version allocation fix.';}
 else if(missing){code='D1_SCHEMA_MISSING';message=`Missing database ${missing[1]}: ${missing[2]}. Apply remote migrations to the platform DB.`;}
 return new RunnerError(code,message,{http_status:status,cloudflare_codes:codes});
}
export function safeDiagnostic(error){
 if(error instanceof RunnerError)return {code:error.code,message:error.safeMessage,...error.details,stage:error.stage||'unknown'};
 const message=String(error?.message||'');
 const known={protocol_runtime_upgrade_required:['PROTOCOL_RUNTIME_UPGRADE','Frozen protocol belongs to an older runtime contract; a fresh research cycle will be created automatically.'],protocol_drift_after_simulation_start:['PROTOCOL_DRIFT','Frozen protocol changed after simulation started; inspect the research cycle and evidence change.'],protocol_integrity_failure:['PROTOCOL_INTEGRITY_FAILURE','Current inputs no longer match the frozen protocol.'],definition_missing:['DEFINITION_MISSING','The project needs a definition before candidates can be seeded.'],runner_api_budget_exhausted:['API_BUDGET_EXHAUSTED','Runner API budget exhausted; remaining work will resume later.'],external_runner_lease_lost:['RUNNER_LEASE_LOST','Runner lease expired or is owned by another run.']};
 const [code,text]=known[message]||['RUNNER_UNEXPECTED_ERROR','Unexpected runner error. Raw messages, SQL parameters, and response bodies are withheld.'];
 return {code,message:text,stage:error?.stage||'unknown',error_type:['SyntaxError','TypeError','AbortError','TimeoutError'].includes(error?.name)?error.name:'Error'};
}
export async function preflightD1(DB){
 const connection=await DB.prepare('SELECT 1 AS connected').first();
 if(connection?.connected!==1)throw new RunnerError('D1_PREFLIGHT_FAILED','D1 connection probe returned an unexpected response.');
 const required=['projects','jobs','simulation_runs','research_protocols','external_runner_leases'];
 const r=await DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('projects','jobs','simulation_runs','research_protocols','external_runner_leases')`).all();
 const found=new Set((r.results||[]).map(x=>x.name)),missing=required.filter(x=>!found.has(x));
 if(missing.length)throw new RunnerError(missing.includes('external_runner_leases')?'MIGRATION_0021_MISSING':'D1_SCHEMA_MISSING','Run npm run db:migrate:remote against the platform DB before Actions.',{missing_tables:missing});
}
export function runnerCredentials(input,expectedId){
 const clean=name=>String(input[name]||'').trim();
 const accountId=clean('CF_ACCOUNT_ID'),databaseId=clean('CF_D1_DATABASE_ID'),token=clean('CF_D1_API_TOKEN'),aiToken=clean('CF_AI_API_TOKEN');
 for(const [name,value] of [['CF_ACCOUNT_ID',accountId],['CF_D1_DATABASE_ID',databaseId],['CF_D1_API_TOKEN',token]])if(!value)throw new RunnerError('RUNNER_SECRET_MISSING',`Required repository Secret is missing: ${name}.`);
 if(!/^[a-f0-9]{32}$/i.test(accountId))throw new RunnerError('ACCOUNT_ID_INVALID','CF_ACCOUNT_ID must contain the 32-character Cloudflare account ID, without URL or quotation marks.');
 if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(databaseId))throw new RunnerError('DATABASE_ID_INVALID','CF_D1_DATABASE_ID must contain a D1 UUID, without URL or quotation marks.');
 if(databaseId!==expectedId)throw new RunnerError('DATABASE_BINDING_MISMATCH','CF_D1_DATABASE_ID does not match wrangler.jsonc. Preserve the platform DB binding.');
 return {accountId,databaseId,token,aiToken};
}
