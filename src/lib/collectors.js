import { all, run, audit } from './db.js';
import { nowIso, uid, safeJson,sha256Hex } from './util.js';
import { importEmpiricalEpisodes } from './empirical.js';
import { collectFdicSource } from './fdic.js';
import { collectOfficialSource } from './official_sources.js';

function getPath(obj, path){ if(!path) return obj; return String(path).split('.').reduce((a,k)=>a?.[k], obj); }
function parseCsv(text){
  const lines=text.trim().split(/\r?\n/); if(lines.length<2) return [];
  const heads=lines[0].split(',').map(x=>x.trim().replace(/^"|"$/g,''));
  return lines.slice(1).filter(Boolean).map(line=>{ const vals=line.split(',').map(x=>x.trim().replace(/^"|"$/g,'')); return Object.fromEntries(heads.map((h,i)=>[h,vals[i]])); });
}

function normalizeRows(source, body, contentType){
  const mapping=safeJson(source.mapping_json,{});
  let data;
  if(source.kind==='csv' || contentType.includes('text/csv')) data=parseCsv(body);
  else if(source.kind==='text') data=[{value:body}];
  else data=JSON.parse(body);
  const arr=getPath(data,mapping.rows_path);
  return Array.isArray(arr)?arr:[arr ?? data];
}

export async function collectProject(env, projectId,{dueOnly=false}={}){
  const dueSql=dueOnly?"AND COALESCE(next_fetch_at,'1970-01-01T00:00:00.000Z')<=?":'';
  const sources=await all(env.DB, `SELECT * FROM data_sources WHERE project_id=? AND enabled=1 ${dueSql} ORDER BY COALESCE(next_fetch_at,'1970-01-01T00:00:00.000Z'),id LIMIT ${env.EXTERNAL_RUNTIME==='github-actions'?1:2}`, dueOnly?[projectId,nowIso()]:[projectId]);
  let inserted=0, empiricalRows=0, errors=[];
  for(const s of sources){
    try{
      if(s.kind==='official_connector'){
        const or=await collectOfficialSource(env,projectId,s); inserted+=Number(or.inserted||0); continue;
      }
      if(s.kind==='fdic_sod' || s.kind==='fdic_financials'){
        const fr=await collectFdicSource(env,projectId,s);
        inserted+=Number(fr.inserted||0);
        if(fr.errors?.length) errors.push(...fr.errors.map(x=>({source:s.name,...x})));
        {const ts=nowIso();await run(env.DB,`UPDATE data_sources SET last_fetched_at=?,last_status=?,next_fetch_at=CASE WHEN ? THEN ? ELSE strftime('%Y-%m-%dT%H:%M:%fZ',datetime(?,'+' || cadence_minutes || ' minutes')) END WHERE id=?`,[fr.partial?null:ts,fr.partial?'partial:resume_next_tick':fr.errors?.length?`partial:${fr.errors.length}`:'ok',fr.partial?1:0,ts,ts,s.id]);}
        continue;
      }
      const headers=safeJson(s.headers_json,{});
      const resp=await fetch(s.url,{method:s.method||'GET',headers,signal:AbortSignal.timeout(20000)});
      if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body=await resp.text();
      const rows=normalizeRows(s,body,resp.headers.get('content-type')||'');
      const map=safeJson(s.mapping_json,{});
      if(s.kind==='episodes' || map.target==='empirical_episodes'){
        const epRows=rows.slice(0,1000).map(row=>({
          episode_name:getPath(row,map.episode_name_path||'episode_name')??getPath(row,'name'), year:getPath(row,map.year_path||'year'), country:getPath(row,map.country_path||'country'),
          peak_outflow:getPath(row,map.peak_outflow_path||'peak_outflow'), concentration:getPath(row,map.concentration_path||'concentration'), digital_adoption:getPath(row,map.digital_adoption_path||'digital_adoption'),
          severity:getPath(row,map.severity_path||'severity'), failed:getPath(row,map.failed_path||'failed'), provenance_type:getPath(row,map.provenance_path||'provenance_type')||map.provenance_type||'external_import',
          reliability_grade:getPath(row,map.reliability_path||'reliability_grade'), source_note:`external:${s.name}`, metadata:{source_id:s.id,http_status:resp.status}
        })).filter(x=>x.episode_name);
        const ir=await importEmpiricalEpisodes(env,projectId,epRows); empiricalRows+=ir.inserted;
      } else {
        const observations=[];
        for(const row of rows.slice(0,500)){
          const key=String(getPath(row,map.key_path)||map.key||s.name||'signal');
          const raw=getPath(row,map.value_path||'value');
          const num=Number(raw); const isNum=Number.isFinite(num);
          const observed=String(getPath(row,map.time_path)||nowIso());
          const contentHash=await sha256Hex({source_id:s.id,key,observed:map.time_path?getPath(row,map.time_path):null,row});
          const payload=JSON.stringify(row);if(payload.length>32000)throw new Error('observation_payload_exceeds_32KB');
          observations.push({id:uid('obs'),observed_at:observed,ingested_at:nowIso(),key,value_num:isNum?num:null,value_text:isNum?null:String(raw??''),payload_json:payload,quality_json:JSON.stringify({http_status:resp.status}),content_hash:contentHash});
        }
        if(observations.length){
          // json_each inserts many rows with ONE SQL statement, with no per-row reads.
          for(let i=0;i<observations.length;i+=25){const result=await run(env.DB,`INSERT OR IGNORE INTO raw_observations(id,project_id,source_id,observed_at,ingested_at,key,value_num,value_text,payload_json,quality_json,content_hash)
            SELECT json_extract(value,'$.id'),?,?,json_extract(value,'$.observed_at'),json_extract(value,'$.ingested_at'),json_extract(value,'$.key'),json_extract(value,'$.value_num'),json_extract(value,'$.value_text'),json_extract(value,'$.payload_json'),json_extract(value,'$.quality_json'),json_extract(value,'$.content_hash') FROM json_each(?)`,[projectId,s.id,JSON.stringify(observations.slice(i,i+25))]);inserted+=Number(result.meta?.changes||0);}
        }
      }
      {const ts=nowIso();await run(env.DB,`UPDATE data_sources SET last_fetched_at=?,last_status='ok',next_fetch_at=strftime('%Y-%m-%dT%H:%M:%fZ',datetime(?,'+' || cadence_minutes || ' minutes')) WHERE id=?`,[ts,ts,s.id]);}
    }catch(e){
      errors.push({source:s.name,error:String(e)});
      {const ts=nowIso();await run(env.DB,`UPDATE data_sources SET last_fetched_at=?,last_status=?,next_fetch_at=strftime('%Y-%m-%dT%H:%M:%fZ',datetime(?,'+' || cadence_minutes || ' minutes')) WHERE id=?`,[ts,`error:${String(e).slice(0,120)}`,ts,s.id]);}
    }
  }
  await audit(env,projectId,'agent','collect.complete','project',projectId,{inserted,empiricalRows,errors});
  return {inserted,empiricalRows,errors,sources:sources.length};
}
