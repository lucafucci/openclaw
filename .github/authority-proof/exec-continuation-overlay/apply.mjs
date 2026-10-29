// Source-derived private patch policy. Refuses unknown compiled declarations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
import {readContract} from './contracts.mjs';
import {adaptSources} from './adapt.mjs';
import {parseJs,sha,canonical,equal,difference,nodeKey,readSource,dynamicImports} from './ast.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const [candidateArg,mode='check']=process.argv.slice(2);
assert(candidateArg && path.isAbsolute(candidateArg),'absolute candidate root required');
assert(['check','apply','verify'].includes(mode),'mode must be check or apply');
const candidate=fs.realpathSync(candidateArg),dist=path.join(candidate,'dist');
assert(candidate.startsWith(fs.realpathSync(path.join(here,'candidates'))+path.sep),'proof candidate must be inside isolated candidates directory');
assert.equal(fs.realpathSync(dist),dist,'symlinked dist forbidden');
const policyHash=sha(['apply.mjs','ast.mjs','adapt.mjs','contracts.mjs','contracts.json','compiled-facades.json','payload.json','local-fixes.patch','vendor/acorn.mjs'].map(f=>f+'\0'+sha(fs.readFileSync(path.join(here,f)))).join('\n'));
const pinnedFacades=JSON.parse(fs.readFileSync(path.join(here,'compiled-facades.json'),'utf8'));
// These unedited dependencies remain part of the proof contract after application.
for(const [source,pinned] of Object.entries(pinnedFacades))for(const [relative,hash] of Object.entries(pinned.hashes)){
 assert(!path.isAbsolute(relative)&&!relative.split('/').includes('..'),'facade path escaped dist');
 const target=path.join(dist,relative);assert.equal(fs.realpathSync(target),target,'facade symlink forbidden');
 assert.equal(sha(fs.readFileSync(target)),hash,`compiled facade changed ${source}:${relative}`);
}
const priorReceipt=path.join(candidate,'local-authority-proof-receipt.json');
if(fs.existsSync(priorReceipt)){
 assert(!fs.lstatSync(priorReceipt).isSymbolicLink(),'receipt symlink forbidden');
 const prior=JSON.parse(fs.readFileSync(priorReceipt,'utf8'));assert.equal(prior.policyHash,policyHash,'candidate prepared by a different policy');
 assert.equal(JSON.parse(fs.readFileSync(path.join(candidate,'package.json'),'utf8')).version,prior.version);assert.equal(JSON.parse(fs.readFileSync(path.join(dist,'build-info.json'),'utf8')).commit,prior.baselineCommit);
 for(const [file,entry] of Object.entries({...prior.bundles,...prior.newModules})){assert(!path.isAbsolute(file)&&!file.split(path.sep).includes('..'));const target=path.join(dist,file);assert.equal(fs.realpathSync(target),target,'receipt target symlink forbidden');assert.equal(sha(fs.readFileSync(target)),entry.after,`applied candidate changed ${file}`);}
 console.log(JSON.stringify({passed:true,mode,version:prior.version,alreadyApplied:true,bundles:Object.keys(prior.bundles).length,newModules:Object.keys(prior.newModules).length}));process.exit(0);
}
assert(mode!=='verify','candidate has no policy receipt');
const config=JSON.parse(fs.readFileSync(path.join(here,'payload.json'),'utf8'));
const buildIdentity=JSON.parse(fs.readFileSync(path.join(dist,'build-info.json'),'utf8'));
const contract=await readContract({here,commit:buildIdentity.commit});
assert(contract.approvedAs,`candidate source contracts require review: ${contract.changed.join(', ')||'mixed approved versions'}`);
const adapted=await adaptSources({here,config,candidate});
const modules=config.modules.map(m=>{
 const before=fs.readFileSync(path.join(here,'payload/before',m.source),'utf8');
 const after=fs.readFileSync(path.join(here,'payload/after',m.source),'utf8');
 assert.equal(sha(before),m.before,`frozen baseline changed ${m.source}`);
 assert.equal(sha(after),m.after,`frozen source changed ${m.source}`);
 const actualBefore=m.new?'':fs.readFileSync(path.join(adapted.base,m.source),'utf8');const actualAfter=fs.readFileSync(path.join(adapted.next,m.source),'utf8');
 if(!m.new)assert.equal(sha(actualBefore),contract.hashes[m.source],`adapted baseline differs from approved contract ${m.source}`);
 return {...m,base:readSource(actualBefore),next:readSource(actualAfter)};
});
function list(d){return fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?list(path.join(d,e.name)):e.name.endsWith('.mjs')||e.name.endsWith('.js')?[path.join(d,e.name)]:[]);}
const bundles=[];
for(const file of list(dist)){
 const text=fs.readFileSync(file,'utf8');
 if(!modules.some(m=>!m.new && text.includes(`//#region ${m.source}\n`)))continue;
 bundles.push({file,relative:path.relative(dist,file),text,edits:[],imports:new Set(),exports:new Set(),changes:[]});
}
const sourceRegion=(b,module)=>{
 const marker=`//#region ${module}\n`,start=b.text.indexOf(marker),offset=start+marker.length;
 assert(start>=0 && b.text.indexOf(marker,offset)===-1,`missing/duplicate region ${module}`);
 const end=b.text.indexOf('//#endregion',offset);assert(end>offset);
 return {offset,end,nodes:parseJs(b.text.slice(offset,end)).body};
};
function classNode(n){return n?.type==='ClassDeclaration'?n:n?.type==='VariableDeclaration'&&n.declarations.length===1&&n.declarations[0].init?.type==='ClassExpression'?n.declarations[0].init:undefined;}
function methodKey(n){return `${n.static?'static ':''}${n.kind}:${n.computed?'[':''}${n.key.name??n.key.value}`;}
const cached=new Map();
function bundleInfo(file){
 assert(file.startsWith(dist+path.sep),'dependency escaped dist');assert.equal(fs.realpathSync(file),file,'dependency symlink forbidden');
 if(cached.has(file))return cached.get(file);
 const text=fs.readFileSync(file,'utf8'),ast=parseJs(text);
 const result={text,ast,exports:ast.body.filter(n=>n.type==='ExportNamedDeclaration').flatMap(n=>n.specifiers??[])};
 cached.set(file,result);return result;
}
const newModules=new Map(modules.filter(m=>m.new).map(m=>[m.source,{...m,bundle:'local-'+path.basename(m.source,'.ts')+'-policy.mjs'}]));
const generated=new Map();
function importSource(module,imp){return imp.startsWith('.')?path.posix.normalize(path.posix.join(path.posix.dirname(module),imp)).replace(/\.js$/,'.ts'):imp;}
function findExport(source,name){
 const fresh=newModules.get(source);if(fresh)return {file:path.join(dist,fresh.bundle),name};
 const matches=[];
 for(const file of list(dist)){
  const text=fs.readFileSync(file,'utf8');if(!text.includes(`//#region ${source}\n`))continue;
  const exp=bundleInfo(file).exports.find(s=>s.local.name===name);
  if(exp)matches.push({file,name:exp.exported.name});
 }
 assert(matches.length,`missing compiled export ${source}:${name}`);
 if(source==='src/process/exec.ts'&&name==='runCommandWithTimeout'){
  const owners=['src/cli/update-cli/update-command-package.ts','src/node-host/auto-update-install.ts'],selected=new Set();
  for(const owner of owners){let ownerFound=false;for(const file of list(dist)){const text=fs.readFileSync(file,'utf8');if(!text.includes(`//#region ${owner}\n`))continue;const imp=bundleInfo(file).ast.body.filter(n=>n.type==='ImportDeclaration').find(n=>n.specifiers.some(s=>s.local.name===name));assert(imp,`updater owner lost executor import ${owner}`);const target=path.resolve(path.dirname(file),imp.source.value);assert(matches.some(m=>m.file===target),`updater executor owner mismatch ${owner}`);selected.add(target);ownerFound=true;}assert(ownerFound,`updater owner absent ${owner}`);}
  assert.equal(selected.size,1,'updater command custody spans multiple executor instances');return matches.find(m=>m.file===[...selected][0]);
 }
 return matches.sort((a,b)=>a.file.length-b.file.length||a.file.localeCompare(b.file))[0];
}
function ensureImport(b,module,imp,spec){
 const source=importSource(module,imp.source.value),name=spec.imported?.name;
 const imports=bundleInfo(b.file).ast.body.filter(n=>n.type==='ImportDeclaration');
 const existing=imports.flatMap(n=>n.specifiers.map(s=>({s,from:n.source.value}))).find(x=>x.s.local.name===spec.local.name);
 if(existing){
  if(source.startsWith('node:')){assert.equal(existing.from,source);return;}
  const dep=bundleInfo(path.resolve(path.dirname(b.file),existing.from));
  const exported=dep.exports.find(s=>s.exported.name===existing.s.imported?.name);
  assert(exported?.local.name===name,`existing import binding mismatch ${spec.local.name}`);
  assert(dep.text.includes(`//#region ${source}\n`),`existing import owner mismatch ${spec.local.name}`);return;
 }
 if(source.startsWith('node:')){
  const binding=spec.type==='ImportDefaultSpecifier'?spec.local.name:spec.type==='ImportNamespaceSpecifier'?`* as ${spec.local.name}`:`{ ${name===spec.local.name?name:`${name} as ${spec.local.name}`} }`;
  b.imports.add(`import ${binding} from ${JSON.stringify(source)};\n`);return;
 }
 assert(spec.type==='ImportSpecifier',`unsupported import ${source}`);
 if(b.text.includes(`//#region ${source}\n`)){
  const region=sourceRegion(b,source),producer=modules.find(m=>m.source===source);
  const inserted=producer&&!producer.base.byKey.has(name)&&producer.next.byKey.has(name);
  assert(region.nodes.some(n=>nodeKey(n).split(',').includes(name))||inserted,`local import binding absent ${name}`);return;
 }
 const target=findExport(source,name);let relative=path.relative(path.dirname(b.file),target.file);if(!relative.startsWith('.'))relative='./'+relative;
 b.imports.add(`import { ${target.name===spec.local.name?target.name:`${target.name} as ${spec.local.name}`} } from ${JSON.stringify(relative)};\n`);
}
function foldConstants(node,module){
 const mod=modules.find(m=>m.source===module),constants=new Map();
 for(const declaration of mod.base.nodes){if(declaration.type!=='VariableDeclaration'||declaration.kind!=='const')continue;for(const d of declaration.declarations){if(d.id.type==='Identifier'&&d.init?.type==='Literal'&&['string','number','boolean'].includes(typeof d.init.value)){const next=mod.next.byKey.get(nodeKey(declaration));if(next&&equal(next,declaration))constants.set(d.id.name,d.init);}}}
  function resolveConstant(source,name,seen=new Set()){
  if(seen.has(source+':'+name))return;seen.add(source+':'+name);
  const dep=config.constantDependencies?.find(d=>d.source===source);if(!dep)return;
  const bytes=fs.readFileSync(path.join(adapted.dependencies,source),'utf8');assert.equal(sha(bytes),adapted.hashes[source]??dep.sha256);assert.equal(sha(bytes),contract.hashes[source],`constant dependency differs from approved contract ${source}`);const info=readSource(bytes);
  const d=info.byKey.get(name)?.declarations?.[0];if(d?.init?.type==='Literal')return d.init;
  const reexport=info.ast.body.find(n=>n.type==='ExportNamedDeclaration'&&n.source&&n.specifiers?.some(s=>s.exported.name===name));if(reexport){const spec=reexport.specifiers.find(s=>s.exported.name===name);return resolveConstant(importSource(source,reexport.source.value),spec.local.name,seen);}
  const exported=info.ast.body.some(n=>n.type==='ExportNamedDeclaration'&&n.specifiers?.some(s=>s.local.name===name));if(!exported)return;
  for(const imp of info.ast.body.filter(n=>n.type==='ImportDeclaration')){const spec=imp.specifiers.find(s=>s.local.name===name);if(spec?.imported)return resolveConstant(importSource(source,imp.source.value),spec.imported.name,seen);}
 }
 for(const imp of mod.base.ast.body.filter(n=>n.type==='ImportDeclaration'))for(const spec of imp.specifiers){const value=resolveConstant(importSource(module,imp.source.value),spec.imported?.name);if(value)constants.set(spec.local.name,value);}
 const edits=[];
 function walk(value,parent,key){
  if(!value||typeof value!=='object')return;
  if(value.type==='Identifier'&&constants.has(value.name)&&!((parent?.type==='Property'||parent?.type==='MemberExpression'||parent?.type==='MethodDefinition')&&key==='key'&&!parent.computed)&&!(parent?.type==='MemberExpression'&&key==='property'&&!parent.computed)){
   assert(!(parent?.type==='VariableDeclarator'&&key==='id'),`constant shadow unsupported ${value.name}`);
   const literal=constants.get(value.name);edits.push({start:value.start,end:value.end,text:JSON.stringify(literal.value)});Object.assign(value,{type:'Literal',value:literal.value});delete value.name;return;
  }
  for(const [k,child] of Object.entries(value)){if(Array.isArray(child))child.forEach(v=>walk(v,value,k));else if(child&&typeof child==='object')walk(child,value,k);}
 }
 walk(node);return edits;
}
function importAliases(node,module,b){
 const mod=modules.find(m=>m.source===module),actual=bundleInfo(b.file).ast.body.filter(n=>n.type==='ImportDeclaration'),aliases=new Map();
 for(const imp of mod.base.ast.body.filter(n=>n.type==='ImportDeclaration')){
  for(const spec of imp.specifiers){
   const source=importSource(module,imp.source.value);
   const choices=imp.source.value.startsWith('.')
    ? actual.filter(n=>n.source.value.startsWith('.')).flatMap(n=>{
       const dep=bundleInfo(path.resolve(path.dirname(b.file),n.source.value));
       if(!dep.text.includes(`//#region ${source}\n`))return [];
       return n.specifiers.filter(s=>s.type==='ImportSpecifier'&&spec.type==='ImportSpecifier'&&dep.exports.some(e=>e.exported.name===s.imported.name&&e.local.name===spec.imported.name));
      })
    : actual.filter(n=>n.source.value===imp.source.value).flatMap(n=>n.specifiers).filter(s=>s.type===spec.type&&(s.type!=='ImportSpecifier'||s.imported.name===spec.imported.name));
   assert(choices.length<=1,`ambiguous compiled import ${source}:${spec.local.name}`);
   if(choices.length===1&&choices[0].local.name!==spec.local.name)aliases.set(spec.local.name,choices[0].local.name);
  }
 }
 const edits=[];
 function walk(value,parent,key){
  if(!value||typeof value!=='object')return;
  if(value.type==='Identifier'&&aliases.has(value.name)&&!((parent?.type==='Property'||parent?.type==='MethodDefinition')&&key==='key'&&!parent.computed)&&!(parent?.type==='MemberExpression'&&key==='property'&&!parent.computed)){
   assert(!(parent?.type==='VariableDeclarator'&&key==='id'),`import alias shadow unsupported ${value.name}`);
   const alias=aliases.get(value.name);edits.push({start:value.start,end:value.end,text:parent?.type==='Property'&&parent.shorthand?`${value.name}: ${alias}`:alias});value.name=alias;if(parent?.type==='Property'&&parent.shorthand)parent.shorthand=false;return;
  }
  for(const [k,child] of Object.entries(value)){if(Array.isArray(child))child.forEach(v=>walk(v,value,k));else if(child&&typeof child==='object')walk(child,value,k);}
 }
 walk(node);return edits;
}
function compile(original,next,built,js,module,b){
 const expected=structuredClone(original);foldConstants(expected,module);importAliases(expected,module,b);const sourceImports=dynamicImports(expected),builtImports=dynamicImports(built),paths=new Map();
 assert.equal(sourceImports.length,builtImports.length,`dynamic import count ${module}`);
 sourceImports.forEach((literal,i)=>{
  const src=importSource(module,literal.value),file=path.resolve(path.dirname(b.file),builtImports[i].value);
  if(!fs.readFileSync(file,'utf8').includes(`//#region ${src}\n`)){
   const pinned=pinnedFacades[src];
   assert(pinned&&path.relative(dist,file)===pinned.file,`dynamic import target mismatch ${src}`);
  }
  paths.set(literal.value,builtImports[i].value);literal.value=builtImports[i].value;
 });
 const normalizedBuilt=structuredClone(built);foldConstants(normalizedBuilt,module);
 if(!equal(expected,normalizedBuilt))fs.writeFileSync(path.join(here,'last-mismatch.json'),JSON.stringify({module,key:nodeKey(original),expected:canonical(expected),built:canonical(normalizedBuilt)},null,2));
 assert(equal(expected,normalizedBuilt),`baseline mismatch ${b.relative}:${nodeKey(original)} ${JSON.stringify(difference(canonical(expected),canonical(normalizedBuilt)))}`);
 let text=js.slice(next.start,next.end);
 const constantEdits=foldConstants(structuredClone(next),module);
 const edits=[...constantEdits,...importAliases(structuredClone(next),module,b)];
 for(const literal of dynamicImports(next)){
  assert(paths.has(literal.value),`new dynamic import unsupported ${literal.value}`);
  edits.push({start:literal.start,end:literal.end,text:JSON.stringify(paths.get(literal.value))});
 }
 for(const e of edits.sort((a,b)=>b.start-a.start))text=text.slice(0,e.start-next.start)+e.text+text.slice(e.end-next.start);
 return text;
}
for(const m of modules.filter(m=>!m.new)){
 const changed=m.next.nodes.filter(n=>!m.base.byKey.has(nodeKey(n))||!equal(m.base.byKey.get(nodeKey(n)),n));
 if(!changed.length)continue;
 const matched=bundles.filter(b=>b.text.includes(`//#region ${m.source}\n`));assert(matched.length,`compiled module absent ${m.source}`);
 for(const old of m.base.nodes)assert(m.next.byKey.has(nodeKey(old)),`removed declaration unsupported ${m.source}:${nodeKey(old)}`);
 const seen=new Set();
 for(const b of matched){
  const editCount=b.edits.length;
  const region=sourceRegion(b,m.source),byKey=new Map(region.nodes.map(n=>[nodeKey(n),n]));
  for(const n of changed){
   const key=nodeKey(n),old=m.base.byKey.get(key),built=byKey.get(key);
   if(!old){
    assert(!built && !bundleInfo(b.file).ast.body.some(x=>nodeKey(x)===key),`new declaration collision ${key}`);
    const next=m.next.nodes.slice(m.next.nodes.indexOf(n)+1).find(x=>byKey.has(nodeKey(x)));
    const start=next?region.offset+byKey.get(nodeKey(next)).start:region.end;
    b.edits.push({start,end:start,text:m.next.js.slice(n.start,n.end)+'\n'});
   }else{
    if(!built)continue; // Bundler may retain only unrelated declarations in another chunk.
    seen.add(key);
    const oc=classNode(old),nc=classNode(n),bc=classNode(built);
    if(oc&&nc&&bc){
     const om=new Map(oc.body.body.map(n=>[methodKey(n),n])),bm=new Map(bc.body.body.map(n=>[methodKey(n),n]));
     assert.equal(oc.body.body.length,nc.body.body.length);
     for(const method of nc.body.body){const mk=methodKey(method),prior=om.get(mk),installed=bm.get(mk);assert(prior&&installed,`missing method ${key}:${mk}`);if(equal(prior,method))continue;b.edits.push({start:region.offset+installed.start,end:region.offset+installed.end,text:compile(prior,method,installed,m.next.js,m.source,b)});}
    }else b.edits.push({start:region.offset+built.start,end:region.offset+built.end,text:compile(old,n,built,m.next.js,m.source,b)});
   }
   b.changes.push(`${m.source}:${key}`);
  }
  if(b.edits.length===editCount)continue;
  const oldImports=new Set(m.base.ast.body.filter(n=>n.type==='ImportDeclaration').flatMap(n=>n.specifiers.map(s=>s.local.name)));
  for(const imp of m.next.ast.body.filter(n=>n.type==='ImportDeclaration'))for(const spec of imp.specifiers.filter(s=>!oldImports.has(s.local.name)))ensureImport(b,m.source,imp,spec);
 }
 for(const n of changed)if(m.base.byKey.has(nodeKey(n)))assert(seen.has(nodeKey(n)),`changed declaration absent from all chunks ${m.source}:${nodeKey(n)}`);
}
for(const [source,m] of newModules){
 let text=m.next.js;
 const b={file:path.join(dist,m.bundle),text,imports:new Set()};
 // New modules preserve node imports; local imports resolve reviewed source owners.
 const edits=[];
 for(const imp of m.next.ast.body.filter(n=>n.type==='ImportDeclaration')){
  if(imp.source.value.startsWith('node:'))continue;
  const lines=[];
  for(const spec of imp.specifiers){
   assert(spec.type==='ImportSpecifier');const target=findExport(importSource(source,imp.source.value),spec.imported.name);
   let relative=path.relative(path.dirname(b.file),target.file);if(!relative.startsWith('.'))relative='./'+relative;
   lines.push(`import { ${target.name===spec.local.name?target.name:`${target.name} as ${spec.local.name}`} } from ${JSON.stringify(relative)};`);
  }
  edits.push({start:imp.start,end:imp.end,text:lines.join('\n')});
 }
 for(const e of edits.sort((a,b)=>b.start-a.start))text=text.slice(0,e.start)+e.text+text.slice(e.end);
 parseJs(text);generated.set(m.bundle,text);
}
const manifest={policyHash,contractBaseline:contract.approvedAs,contractSourceHashes:contract.hashes,baselineCommit:adapted.commit,baselineSourceHashes:adapted.hashes,version:JSON.parse(fs.readFileSync(path.join(candidate,'package.json'),'utf8')).version,sourceHashes:Object.fromEntries(modules.map(m=>[m.source,m.after])),adaptedSourceHashes:Object.fromEntries(modules.map(m=>[m.source,sha(m.next.text)])),bundles:{},newModules:{}};
for(const b of bundles.filter(b=>b.edits.length)){
 let text=b.text;for(const e of b.edits.toReversed().sort((a,b)=>b.start-a.start))text=text.slice(0,e.start)+e.text+text.slice(e.end);
 text=[...b.imports].join('')+text;parseJs(text);generated.set(b.relative,text);
 manifest.bundles[b.relative]={before:sha(b.text),after:sha(text),changes:b.changes};
}
for(const m of newModules.values())manifest.newModules[m.bundle]={after:sha(generated.get(m.bundle))};
// All compatibility checks finish before the first candidate write.
if(mode==='apply'){
 for(const [file,text] of generated){const dest=path.join(dist,file);assert(fs.realpathSync(path.dirname(dest)).startsWith(dist+path.sep)||fs.realpathSync(path.dirname(dest))===dist);if(fs.existsSync(dest)){assert(!fs.lstatSync(dest).isSymbolicLink());assert.equal(sha(fs.readFileSync(dest)),manifest.bundles[file]?.before,`candidate changed during build ${file}`);}fs.writeFileSync(dest+'.local-new',text,{flag:'wx'});fs.renameSync(dest+'.local-new',dest);}
 fs.writeFileSync(path.join(candidate,'local-authority-proof-receipt.json'),JSON.stringify(manifest,null,2)+'\n');
}
fs.writeFileSync(path.join(here,'last-'+manifest.version+'-'+mode+'-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({passed:true,mode,version:manifest.version,bundles:Object.keys(manifest.bundles).length,newModules:Object.keys(manifest.newModules).length}));
