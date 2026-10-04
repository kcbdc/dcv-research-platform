const METRICS=[
  ['loss_mean','loss_max'],
  ['loss_exceed_rate','loss_exceed_max'],
  ['fp_rate','fp_max'],
  ['fn_rate','fn_max'],
  ['review_burden','review_burden_max'],
  ['recovery_time','recovery_time_max']
];

function finite(x){const n=Number(x);return Number.isFinite(n)?n:null;}
export function quantile(values,q){
  const a=values.map(finite).filter(v=>v!=null).sort((x,y)=>x-y);
  if(!a.length)return null;if(a.length===1)return a[0];
  const p=Math.max(0,Math.min(1,Number(q)))*(a.length-1),lo=Math.floor(p),hi=Math.ceil(p),w=p-lo;
  return a[lo]*(1-w)+a[hi]*w;
}
function roundUp(x,step){if(!Number.isFinite(x))return null;const s=Number(step)||.001;return Math.ceil((x-1e-12)/s)*s;}
function summary(values){
  const a=values.map(finite).filter(v=>v!=null);if(!a.length)return {n:0};
  return {n:a.length,min:Math.min(...a),q50:quantile(a,.5),q75:quantile(a,.75),q90:quantile(a,.9),q95:quantile(a,.95),max:Math.max(...a)};
}

/**
 * Derives exploratory upper-bound targets from PRIOR-CYCLE run summaries.
 * These targets are deliberately not confirmatory evidence. They must be frozen
 * into a new research cycle before they can be used for hypothesis testing.
 */
export function calibrateConstraintQuantiles(rows,{quantileLevel=.90,phases=['confirmation','historical','stress'],minRuns=20}={}){
  const allowed=new Set(phases),used=(rows||[]).filter(r=>allowed.has(String(r.phase||'')));
  const stats={},proposal={},steps={loss_max:.005,loss_exceed_max:.005,fp_max:.005,fn_max:.005,review_burden_max:.01,recovery_time_max:.1};
  for(const [metric,key] of METRICS){
    const vals=used.map(r=>r[metric]);stats[metric]=summary(vals);
    const q=quantile(vals,quantileLevel);proposal[key]=q==null?null:roundUp(q,steps[key]);
  }
  const adequate=METRICS.every(([metric])=>Number(stats[metric].n||0)>=minRuns);
  return {
    method:'prior_cycle_run_quantile_v1',quantile:quantileLevel,phases:[...allowed],min_runs:minRuns,run_count:used.length,adequate,
    warning:'Exploratory calibration only. Do not choose thresholds from the same cycle used for confirmatory claims; freeze the proposal into a new research cycle.',
    stats,proposal
  };
}


function latestRowsByCandidate(rows){
  const by=new Map();
  for(const r of rows||[]){
    const id=String(r.candidate_id||r.id||''); if(!id)continue;
    const prev=by.get(id); if(!prev||String(r.created_at||'')>String(prev.created_at||''))by.set(id,r);
  }
  return [...by.values()];
}

/**
 * Threshold-sensitivity analysis over the BROAD candidate set. Unlike quantile
 * calibration this does not choose a single threshold from the observed outcome.
 * It reports how the feasible-region size changes over preregistered threshold grids.
 */
export function constraintSensitivityCurve(rows,{baseConstraints={},fnGrid=[.04,.06,.08,.10,.12],fpGrid=[.02,.035,.055,.08],lossGrid=[.10,.14,.18,.22],reviewGrid=[.20,.30,.40,.55],recoveryGrid=[1.5,2.5,3.5,4.5]}={}){
  const used=latestRowsByCandidate(rows).filter(r=>METRICS.every(([m])=>finite(r[m])!=null));
  const dimensions={fn_max:fnGrid,fp_max:fpGrid,loss_max:lossGrid,review_burden_max:reviewGrid,recovery_time_max:recoveryGrid};
  const passes=(r,c)=>Number(r.loss_mean)<=Number(c.loss_max)&&Number(r.loss_exceed_rate)<=Number(c.loss_exceed_max??.10)&&Number(r.fp_rate)<=Number(c.fp_max)&&Number(r.fn_rate)<=Number(c.fn_max)&&Number(r.review_burden)<=Number(c.review_burden_max)&&Number(r.recovery_time)<=Number(c.recovery_time_max);
  const curves={};
  for(const [key,grid] of Object.entries(dimensions))curves[key]=grid.map(value=>{const c={...baseConstraints,[key]:Number(value)};const n=used.filter(r=>passes(r,c)).length;return{threshold:Number(value),feasible_n:n,total_n:used.length,feasible_share:used.length?n/used.length:null};});
  return {method:'broad_candidate_threshold_sensitivity_v1',candidate_n:used.length,selection_scope:'latest broad-candidate run per design candidate; no single threshold is selected from the outcome distribution',base_constraints:baseConstraints,curves,warning:'Sensitivity evidence describes threshold dependence. Policy acceptability thresholds require an external policy/regulatory/operational basis and must be frozen before confirmatory claims.'};
}

export const __test={METRICS,summary,roundUp,latestRowsByCandidate};
