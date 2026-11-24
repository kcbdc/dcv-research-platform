// Versioned loss policies. Baseline preserves legacy arithmetic and recovery exposure.
export function lossPolicy(spec={}){
 const mode=spec.mode??'baseline'; if(!['baseline','weighted_v1'].includes(mode))throw Error('unknown_loss_policy');
 const weights={}; for(const k of ['fp','fn','exposure','delay','review','recovery']){const v=spec.weights?.[k]??1;if(typeof v!=='number'||!Number.isFinite(v)||v<0)throw Error('invalid_loss_weight:'+k);weights[k]=v;}
 if(mode==='baseline'&&Object.values(weights).some(v=>v!==1))throw Error('baseline_weights_must_equal_one');
 return {mode,weights};
}
export function stepLoss({finalStop,shouldStop,cFP,cFN,riskExcess,queueMode,decisionDelay,T,multiplier,needsReview,reviewCost},w){
 const decisionLoss=(finalStop&&!shouldStop?cFP*w.fp:0)+(!finalStop&&shouldStop?cFN*w.fn:0);
 const exposure=!finalStop?cFN*riskExcess*(1+(queueMode?0:decisionDelay/Math.max(1,T))):0;
 const delayLoss=queueMode?0:(decisionDelay/Math.max(1,T))*(finalStop?cFP:cFN);
 return {exposure,loss:(decisionLoss+exposure*w.exposure+delayLoss*w.delay)*multiplier+(needsReview?reviewCost*w.review:0)};
}
