import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {sha} from './ast.mjs';
export async function adaptSources({here,config,candidate}){
 const build=JSON.parse(fs.readFileSync(path.join(candidate,'dist/build-info.json'),'utf8'));
 assert(/^[a-f0-9]{40}$/.test(build.commit),'candidate build commit missing');
 const packageVersion=JSON.parse(fs.readFileSync(path.join(candidate,'package.json'),'utf8')).version;
 assert.equal(build.version,packageVersion,'candidate version/build identity mismatch');
 if(build.commit===config.baselineCommit)return {commit:build.commit,base:path.join(here,'payload/before'),next:path.join(here,'payload/after'),dependencies:path.join(here,'dependencies'),hashes:{}};
 const cache=path.join(here,'upstream',build.commit),receipt=path.join(cache,'source-receipt.json');
 const files=[...new Set([...config.modules.filter(m=>!m.new).map(m=>m.source),...(config.constantDependencies??[]).map(m=>m.source)])];
 let hashes;
 if(fs.existsSync(receipt)){
  hashes=JSON.parse(fs.readFileSync(receipt,'utf8'));
  for(const file of files)assert.equal(sha(fs.readFileSync(path.join(cache,'before',file))),hashes[file],`cached upstream source modified ${file}`);
 }else{
  hashes={};
  for(const file of files){
   assert((file.startsWith('src/')||file.startsWith('packages/')||file.startsWith('scripts/'))&&!file.includes('..'));
   const response=await fetch(`https://raw.githubusercontent.com/openclaw/openclaw/${build.commit}/${file}`,{signal:AbortSignal.timeout(30000),redirect:'error'});
   assert(response.ok,`upstream source unavailable ${file}: HTTP ${response.status}`);
   const text=await response.text();assert(Buffer.byteLength(text)<1024*1024,`upstream source too large ${file}`);
   const dest=path.join(cache,'before',file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,text);hashes[file]=sha(text);
  }
  fs.writeFileSync(receipt,JSON.stringify(hashes,null,2)+'\n');
 }
 const work=fs.mkdtempSync(path.join(here,'adapt-work-'));
 try{
  for(const file of files){const dest=path.join(work,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(cache,'before',file),dest);}
  execFileSync('git',['apply','--check',path.join(here,'local-fixes.patch')],{cwd:work,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  execFileSync('git',['apply',path.join(here,'local-fixes.patch')],{cwd:work,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  for(const module of config.modules){const dest=path.join(cache,'after',module.source);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(work,module.source),dest);}
 }catch(error){throw new Error(`Local patch conflict with candidate ${build.version} ${build.commit}: ${error.stderr?.toString().slice(0,4096)??error.message}`);}finally{fs.rmSync(work,{recursive:true,force:true});}
 return {commit:build.commit,base:path.join(cache,'before'),next:path.join(cache,'after'),dependencies:path.join(cache,'before'),hashes};
}
