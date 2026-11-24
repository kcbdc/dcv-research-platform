import fs from 'node:fs';import {pairedAudit} from '../src/lib/research_replication_audit.js';
const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('usage: node scripts/research-paired-audit.mjs frozen-spec.json output.json');const result=await pairedAudit(JSON.parse(fs.readFileSync(input,'utf8')));fs.writeFileSync(output,JSON.stringify(result,null,2),{flag:'wx'});
