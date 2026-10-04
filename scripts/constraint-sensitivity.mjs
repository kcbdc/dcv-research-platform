import fs from 'node:fs';import {constraintSensitivityCurve} from '../src/lib/constraint_calibration.js';
const file=process.argv[2];if(!file)throw new Error('Usage: node scripts/constraint-sensitivity.mjs runs.csv [constraints.json]');
const lines=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/),h=lines.shift().split(',');const rows=lines.filter(Boolean).map(line=>{const v=line.split(',');return Object.fromEntries(h.map((k,i)=>[k,v[i]]));});
const base=process.argv[3]?JSON.parse(fs.readFileSync(process.argv[3],'utf8')):{loss_max:.18,loss_exceed_max:.10,fp_max:.055,fn_max:.08,review_burden_max:.30,recovery_time_max:2.5};
console.log(JSON.stringify(constraintSensitivityCurve(rows,{baseConstraints:base}),null,2));
