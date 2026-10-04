import {diagnoseD1,RunnerError} from './runner-diagnostics.mjs';
// Trusted Actions runtime only. No SQL proxy is exposed by the public Worker.
export function restStatement(sql, params=[]) {
  let out='',values=[],i=0,quote=null,line=false,block=false;
  for(let k=0;k<sql.length;k++){
    const c=sql[k],next=sql[k+1];
    if(line){out+=c;if(c==='\n')line=false;continue;}
    if(block){out+=c;if(c==='*'&&next==='/'){out+=next;k++;block=false;}continue;}
    if(quote){out+=c;if(c===quote){if(next===quote){out+=next;k++;}else quote=null;}continue;}
    if(c==='-'&&next==='-'){line=true;out+=c;continue;}
    if(c==='/'&&next==='*'){block=true;out+=c;continue;}
    if(c==="'"||c==='"'||c==='`'){quote=c;out+=c;continue;}
    if(c!=='?'){out+=c;continue;}
    if(i>=params.length)throw new Error('D1 parameter count mismatch');
    const value=params[i++];
    if(value instanceof ArrayBuffer||ArrayBuffer.isView(value)){
      const bytes=value instanceof ArrayBuffer?new Uint8Array(value):new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
      out+=`X'${Buffer.from(bytes).toString('hex')}'`;
    }else{if(value===undefined||typeof value==='object'&&value!==null)throw new Error('Unsupported D1 parameter');out+='?';values.push(value);}
  }
  if(i!==params.length)throw new Error('D1 parameter count mismatch');
  return {sql:out,params:values};
}
export function createD1Rest({accountId,databaseId,token,fetchImpl=fetch,intervalMs=650,maxCalls=250,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
  if(!/^[a-f0-9]{32}$/i.test(accountId||'')||!/^[a-f0-9-]{36}$/i.test(databaseId||'')||!token)throw new Error('Missing or invalid Cloudflare D1 runner credentials');
  let calls=0,last=0,workCalls=0,controlCalls=0,controlDepth=0,rowsRead=0;
  const query=async statements=>{
    for(let attempt=0;attempt<3;attempt++){
      if(controlDepth?controlCalls>=20:workCalls>=maxCalls)throw new Error(controlDepth?'runner_cleanup_budget_exhausted':'runner_api_budget_exhausted');
      await sleep(Math.max(0,last+intervalMs-Date.now()));last=Date.now();calls++;if(controlDepth)controlCalls++;else workCalls++;
      let response;try{response=await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({batch:statements}),signal:AbortSignal.timeout(60000)});}catch{throw new RunnerError('D1_NETWORK_FAILED','D1 connection failed or timed out. Check Cloudflare availability; writes are not blindly retried.');}
      if(response.status===429&&attempt<2){await sleep(Math.min(5000,Number(response.headers.get('retry-after')||2)*1000));continue;}
      let json;try{json=await response.json();}catch{throw new RunnerError('D1_RESPONSE_NOT_JSON','Cloudflare returned a non-JSON response.',{http_status:response.status});}
      if(!response.ok||!json.success||!Array.isArray(json.result)||json.result.some(r=>r.success===false))throw diagnoseD1(response.status,json);
      rowsRead+=json.result.reduce((n,r)=>n+Number(r?.meta?.rows_read||0),0);
      return json.result;
    }
  };
  const prepare=(sql,params=[])=>({
    _statement:()=>restStatement(sql,params),bind:(...p)=>prepare(sql,p),
    all:async()=> (await query([restStatement(sql,params)]))[0],
    first:async column=>{const row=(await query([restStatement(sql,params)]))[0].results?.[0]??null;return column?row?.[column]??null:row;},
    run:async()=> (await query([restStatement(sql,params)]))[0]
  });
  return {prepare,batch:async statements=>statements.length?query(statements.map(s=>s._statement())):[],get calls(){return calls;},get remaining(){return Math.max(0,maxCalls-workCalls);},get workCalls(){return workCalls;},get rowsRead(){return rowsRead;},async withControl(fn){controlDepth++;try{return await fn();}finally{controlDepth--;}}};
}
