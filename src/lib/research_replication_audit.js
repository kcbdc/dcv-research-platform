import {pairedInterval} from './research_effects.js';
import {__test} from './compute.js';
import {hashString,mulberry32,sha256Hex,stableStringify} from './util.js';
// Offline only. Does not mutate candidate status or the production protocol.
export async function pairedAudit(spec){
 const {candidate,constraints,config,scenarios,reviewer,seedNamespace,blocks,sourceSeeds}=spec;
 if(!candidate||!constraints||!config||!Array.isArray(scenarios)||!scenarios.length||!reviewer||typeof seedNamespace!=='string'||seedNamespace.length<16||!Number.isSafeInteger(blocks)||blocks<2||blocks>5000||!Array.isArray(sourceSeeds)||!sourceSeeds.length||sourceSeeds.some(x=>!Number.isSafeInteger(x)))throw Error('invalid_audit_spec');
 const sourceSet=new Set(sourceSeeds);const seeds=Array.from({length:blocks},(_,i)=>hashString(`${seedNamespace}|audit-v1|${i}`));if(new Set(seeds).size!==blocks||seeds.some(x=>sourceSet.has(x)))throw Error('seed_overlap');
 const hash=await sha256Hex(stableStringify(spec));const out=[];
 const ideal={correct_override_rate:1,unnecessary_override_rate:0,participant_accept_sd:0,mean_delay:0};
 for(let i=0;i<blocks;i++){const seed=seeds[i],sc=scenarios[i%scenarios.length];const sim=(c,r)=>__test.simulateEpisode(c,constraints,mulberry32(seed),sc,r,{...config,audit_perfect_label:false,audit_participant_effect:true},mulberry32(seed^0x5a5a));const actual=sim(candidate,reviewer),reference=sim(candidate,ideal);out.push({seed,scenario:sc.key,actual:{loss:actual.episodeLoss,fn:actual.fn/actual.decisions,fp:actual.fp/actual.decisions,review:actual.reviewN/actual.decisions,adjustments:actual.adjustmentN,exposure:actual.exposureMean},ideal:{loss:reference.episodeLoss,fn:reference.fn/reference.decisions,fp:reference.fp/reference.decisions,review:reference.reviewN/reference.decisions,adjustments:reference.adjustmentN,exposure:reference.exposureMean}});}
 return {spec_hash:hash,scope:'offline paired computational audit; ideal reviewer approximation; no empirical replication or candidate verdict',effects:Object.fromEntries(["fn","fp","review"].map(k=>[k,pairedInterval(out.map(b=>b.actual[k]-b.ideal[k]),{min:-1,max:1,family:3})])),blocks:out};
}
