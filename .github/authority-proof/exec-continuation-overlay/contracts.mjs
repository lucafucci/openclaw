import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {sha} from './ast.mjs';
export async function readContract({here,commit}){
 assert(/^[a-f0-9]{40}$/.test(commit),'invalid contract commit');
 const config=JSON.parse(fs.readFileSync(path.join(here,'contracts.json'),'utf8'));
 for(const [baseline,hashes] of Object.entries(config.approved))assert(config.files.every(f=>(hashes[f]==='absent'||/^[a-f0-9]{64}$/.test(hashes[f]))),`incomplete approved contract ${baseline}`);
 if(config.approved[commit])return {hashes:config.approved[commit],approvedAs:commit,changed:[]};
 const hashes={};let next=0;
 await Promise.all(Array.from({length:4},async()=>{
  while(next<config.files.length){
   const file=config.files[next++];assert(!file.includes('..')&&!path.isAbsolute(file));
   const dest=path.join(here,'contracts',commit,file);let bytes;
   if(fs.existsSync(dest+'.absent')){hashes[file]='absent';continue;}
   if(fs.existsSync(dest))bytes=fs.readFileSync(dest);
   else{
    const response=await fetch(`https://raw.githubusercontent.com/openclaw/openclaw/${commit}/${file}`,{signal:AbortSignal.timeout(30000),redirect:'error'});if(response.status===404){fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest+'.absent','');hashes[file]='absent';continue;}assert(response.ok,`contract source unavailable ${file} HTTP ${response.status}`);bytes=Buffer.from(await response.arrayBuffer());assert(bytes.length<2*1024*1024,`contract source too large ${file}`);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes);
   }
   hashes[file]=sha(bytes);
  }
 }));
 const approvedAs=Object.entries(config.approved).find(([,approved])=>config.files.every(f=>hashes[f]===approved[f]))?.[0];
 const changed=config.files.filter(f=>!Object.values(config.approved).some(a=>a[f]===hashes[f]));
 fs.writeFileSync(path.join(here,'contracts',commit,'manifest.json'),JSON.stringify({commit,hashes,approvedAs,changed},null,2)+'\n');
 return {hashes,approvedAs,changed};
}
if(process.argv[1]===new URL(import.meta.url).pathname){const here=path.dirname(process.argv[1]),commit=process.argv[2];const result=await readContract({here,commit});console.log(JSON.stringify({commit,files:Object.keys(result.hashes).length,approvedAs:result.approvedAs,changed:result.changed}));}
