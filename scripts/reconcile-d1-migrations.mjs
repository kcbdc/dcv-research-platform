import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createD1Rest} from './lib/d1-rest.mjs';
import {runnerCredentials} from './lib/runner-diagnostics.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const MIGRATIONS_DIR=path.join(ROOT,'migrations');

export function migrationArtifacts(sql){
  const columns=[]; const tables=[]; const indexes=[]; const triggers=[];
  for(const m of sql.matchAll(/ALTER\s+TABLE\s+([A-Za-z_][\w]*)\s+ADD\s+COLUMN\s+([A-Za-z_][\w]*)/gi)) columns.push({table:m[1],column:m[2]});
  for(const m of sql.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z_][\w]*)/gi)) tables.push(m[1]);
  for(const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z_][\w]*)/gi)) indexes.push(m[1]);
  for(const m of sql.matchAll(/CREATE\s+TRIGGER(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z_][\w]*)/gi)) triggers.push(m[1]);
  return {columns,tables,indexes,triggers};
}

function q(s){return `'${String(s).replaceAll("'","''")}'`;}

export async function reconcileD1Migrations(DB,{dir=MIGRATIONS_DIR,log=console.log}={}){
  await DB.prepare(`CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`).run();
  const appliedRows=await DB.prepare(`SELECT name FROM d1_migrations`).all();
  const applied=new Set((appliedRows.results||[]).map(r=>r.name));
  const masterRows=await DB.prepare(`SELECT type,name,tbl_name FROM sqlite_master WHERE type IN ('table','index','trigger')`).all();
  const master={table:new Set(),index:new Set(),trigger:new Set()};
  for(const r of masterRows.results||[]) if(master[r.type]) master[r.type].add(r.name);
  const columnCache=new Map();
  const columnsFor=async table=>{
    if(columnCache.has(table)) return columnCache.get(table);
    const res=await DB.prepare(`SELECT name FROM pragma_table_info(${q(table)})`).all();
    const s=new Set((res.results||[]).map(r=>r.name));columnCache.set(table,s);return s;
  };
  const files=fs.readdirSync(dir).filter(n=>/^\d+.*\.sql$/i.test(n)).sort();
  const reconciled=[];const pending=[];const partial=[];
  for(const name of files){
    if(applied.has(name)) continue;
    const sql=fs.readFileSync(path.join(dir,name),'utf8');
    const a=migrationArtifacts(sql);
    const artifactCount=a.columns.length+a.tables.length+a.indexes.length+a.triggers.length;
    if(!artifactCount){pending.push(name);continue;}
    let present=0;const missing=[];
    for(const t of a.tables){if(master.table.has(t))present++;else missing.push(`table:${t}`);}
    for(const i of a.indexes){if(master.index.has(i))present++;else missing.push(`index:${i}`);}
    for(const t of a.triggers){if(master.trigger.has(t))present++;else missing.push(`trigger:${t}`);}
    for(const c of a.columns){const cols=await columnsFor(c.table);if(cols.has(c.column))present++;else missing.push(`column:${c.table}.${c.column}`);}
    if(present===artifactCount){
      await DB.prepare(`INSERT OR IGNORE INTO d1_migrations(name) VALUES(?)`).bind(name).run();
      reconciled.push(name);log(`Reconciled already-present D1 migration: ${name}`);
    }else if(present>0 && a.columns.length){
      partial.push({name,present,total:artifactCount,missing});
    }else pending.push(name);
  }
  if(partial.length){
    const e=new Error('D1_PARTIAL_MIGRATION_STATE');
    e.details=partial;e.message='Some legacy migrations are only partially reflected in the live schema. Refusing to re-run non-idempotent ALTER TABLE statements.';throw e;
  }
  return {reconciled,pending};
}

async function main(){
  const cfg=JSON.parse(fs.readFileSync(path.join(ROOT,'wrangler.jsonc'),'utf8'));
  const credentials=runnerCredentials(process.env,cfg.d1_databases[0].database_id);
  const DB=createD1Rest(credentials);
  const result=await reconcileD1Migrations(DB);
  console.log(JSON.stringify({status:'ok',...result,d1_api_calls:DB.calls,d1_rows_read:Number(DB.rowsRead||0)}));
}

if(process.argv[1]===fileURLToPath(import.meta.url)) main().catch(error=>{
  console.error('D1 migration reconciliation failed: '+JSON.stringify({code:error.message==='D1_PARTIAL_MIGRATION_STATE'?'D1_PARTIAL_MIGRATION_STATE':'D1_MIGRATION_RECONCILE_FAILED',message:error.message,details:error.details||null}));
  process.exitCode=1;
});
