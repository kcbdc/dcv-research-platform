#!/usr/bin/env node
import fs from 'node:fs';
import {calibrateConstraintQuantiles} from '../src/lib/constraint_calibration.js';

function csvParse(text){
  const rows=[];let row=[],cell='',q=false;for(let i=0;i<text.length;i++){
    const c=text[i],n=text[i+1];
    if(c==='"'){if(q&&n==='"'){cell+='"';i++;}else q=!q;}
    else if(c===','&&!q){row.push(cell);cell='';}
    else if((c==='\n'||c==='\r')&&!q){if(c==='\r'&&n==='\n')i++;row.push(cell);cell='';if(row.some(x=>x!==''))rows.push(row);row=[];}
    else cell+=c;
  }
  if(cell||row.length){row.push(cell);rows.push(row);}if(!rows.length)return[];
  const head=rows.shift().map(x=>x.trim());return rows.map(r=>Object.fromEntries(head.map((h,i)=>[h,r[i]??''])));
}
const args=process.argv.slice(2),input=args.find(x=>!x.startsWith('--'));
if(!input){console.error('Usage: npm run constraints:quantiles -- simulation_runs.csv [--q=0.90] [--out=constraint-calibration.json]');process.exit(2);}
const q=Number((args.find(x=>x.startsWith('--q='))||'--q=0.90').split('=')[1]);
const out=(args.find(x=>x.startsWith('--out='))||'').split('=')[1];
const rows=csvParse(fs.readFileSync(input,'utf8'));
const result=calibrateConstraintQuantiles(rows,{quantileLevel:q});
const body=JSON.stringify(result,null,2)+'\n';if(out)fs.writeFileSync(out,body);else process.stdout.write(body);
if(!result.adequate)process.exitCode=3;
