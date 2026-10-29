import crypto from "node:crypto";
import {stripTypeScriptTypes} from "node:module";
import {parse} from "./vendor/acorn.mjs";
export const parseJs = text => parse(text, {ecmaVersion: "latest", sourceType: "module"});
export const sha = text => crypto.createHash("sha256").update(text).digest("hex");
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  // A bare return and an explicit undefined return have identical JavaScript results.
  if (value.type === 'ReturnStatement' && value.argument === null) return canonical({...value,argument:{type:'Identifier',name:'undefined'}});
  if(value.type==='BlockStatement'){
    for(let i=0;i<value.body.length-1;i++){
      const decl=value.body[i],next=value.body[i+1],binding=decl.type==='VariableDeclaration'&&decl.kind==='const'&&decl.declarations.length===1?decl.declarations[0]:undefined;
      if(binding?.id.type==='Identifier'&&next.type==='ReturnStatement'&&next.argument?.type==='ConditionalExpression'&&next.argument.test.type==='Identifier'&&next.argument.test.name===binding.id.name){
        let count=0;const visit=v=>{if(!v||typeof v!=='object')return;if(v.type==='Identifier'&&v.name===binding.id.name)count++;for(const c of Object.values(v))if(Array.isArray(c))c.forEach(visit);else if(c&&typeof c==='object')visit(c);};visit(value);
        if(count===2)return canonical({...value,body:[...value.body.slice(0,i),{...next,argument:{...next.argument,test:binding.init}},...value.body.slice(i+2)]});
      }
      if(binding?.id.type==='Identifier'&&next.type==='VariableDeclaration'&&next.kind==='const'&&next.declarations.length===1){
        const target=next.declarations[0].init;
        const member=target?.type==='BinaryExpression'&&target.left?.type==='ChainExpression'?target.left.expression:undefined;
        if(member?.type==='MemberExpression'&&member.object.type==='Identifier'&&member.object.name===binding.id.name){
          let count=0;const visit=v=>{if(!v||typeof v!=='object')return;if(v.type==='Identifier'&&v.name===binding.id.name)count++;for(const c of Object.values(v))if(Array.isArray(c))c.forEach(visit);else if(c&&typeof c==='object')visit(c);};visit(value);
          if(count===2)return canonical({...value,body:[...value.body.slice(0,i),{...next,declarations:[{...next.declarations[0],init:{...target,left:{...target.left,expression:{...member,object:binding.init}}}}]},...value.body.slice(i+2)]});
        }
      }
      if(binding?.id.type==='Identifier'&&next.type==='IfStatement'&&next.test.type==='MemberExpression'&&!next.test.computed&&next.test.object.type==='Identifier'&&next.test.object.name===binding.id.name){
        let count=0;const visit=v=>{if(!v||typeof v!=='object')return;if(v.type==='Identifier'&&v.name===binding.id.name)count++;for(const c of Object.values(v))if(Array.isArray(c))c.forEach(visit);else if(c&&typeof c==='object')visit(c);};visit(value);
        if(count===2)return canonical({...value,body:[...value.body.slice(0,i),{...next,test:{...next.test,object:binding.init}},...value.body.slice(i+2)]});
      }
      if(binding?.id.type==='Identifier'&&next.type==='IfStatement'&&next.test.type==='BinaryExpression'&&next.test.left.type==='MemberExpression'&&!next.test.left.computed&&next.test.left.object.type==='Identifier'&&next.test.left.object.name===binding.id.name){
        let count=0;const visit=v=>{if(!v||typeof v!=='object')return;if(v.type==='Identifier'&&v.name===binding.id.name)count++;for(const c of Object.values(v))if(Array.isArray(c))c.forEach(visit);else if(c&&typeof c==='object')visit(c);};visit(value);
        if(count===2)return canonical({...value,body:[...value.body.slice(0,i),{...next,test:{...next.test,left:{...next.test.left,object:binding.init}}},...value.body.slice(i+2)]});
      }
      const assignment=next.type==='ExpressionStatement'&&next.expression.type==='AssignmentExpression'&&next.expression.operator==='='?next.expression:undefined;
      if(binding?.id.type==='Identifier'&&assignment?.left.type==='MemberExpression'&&!assignment.left.computed&&assignment.left.object.type==='Identifier'&&assignment.right.type==='TemplateLiteral'&&assignment.right.expressions[0]?.type==='Identifier'&&assignment.right.expressions[0].name===binding.id.name){
        let count=0;const visit=v=>{if(!v||typeof v!=='object')return;if(v.type==='Identifier'&&v.name===binding.id.name)count++;for(const c of Object.values(v))if(Array.isArray(c))c.forEach(visit);else if(c&&typeof c==='object')visit(c);};visit(value);
        if(count===2)return canonical({...value,body:[...value.body.slice(0,i),{...next,expression:{...assignment,right:{...assignment.right,expressions:[binding.init,...assignment.right.expressions.slice(1)]}}},...value.body.slice(i+2)]});
      }
      if(binding?.id.type==='Identifier'&&next.type==='IfStatement'&&next.test.type==='Identifier'&&next.test.name===binding.id.name){
        let count=0;const visit=v=>{if(!v||typeof v!=='object')return;if(v.type==='Identifier'&&v.name===binding.id.name)count++;for(const c of Object.values(v))if(Array.isArray(c))c.forEach(visit);else if(c&&typeof c==='object')visit(c);};visit(value);
        if(count===2)return canonical({...value,body:[...value.body.slice(0,i),{...next,test:binding.init},...value.body.slice(i+2)]});
      }
    }
  }
  if (value.type === 'BlockStatement' && value.body.length===2) {
    const [declaration,ret]=value.body;
    const binding=declaration.type==='VariableDeclaration' && declaration.kind==='const' && declaration.declarations.length===1 ? declaration.declarations[0] : undefined;
    const member=ret.type==='ReturnStatement' && ret.argument?.type==='AwaitExpression' ? ret.argument.argument : undefined;
    if (binding?.id.type==='Identifier' && binding.init?.type==='AwaitExpression' && member?.type==='MemberExpression' && !member.computed && member.object.type==='Identifier' && member.object.name===binding.id.name) {
      return canonical({...value,body:[{...ret,argument:{...ret.argument,argument:{...member,object:binding.init}}}]});
    }
  }
  if (value.type === 'ExpressionStatement' && value.expression?.type === 'UnaryExpression' && value.expression.operator === 'void') return canonical({...value,expression:value.expression.argument});
  if(value.type==='TemplateLiteral'&&value.expressions.some(e=>e.type==='Literal')){
    const quasis=[structuredClone(value.quasis[0])],expressions=[];
    for(let i=0;i<value.expressions.length;i++){const e=value.expressions[i],q=value.quasis[i+1];if(e.type==='Literal'){quasis.at(-1).value.cooked+=String(e.value)+q.value.cooked;quasis.at(-1).tail=q.tail;}else{expressions.push(e);quasis.push(structuredClone(q));}}
    if(expressions.length!==value.expressions.length)return canonical({...value,quasis,expressions});
  }
  if(value.type==='TemplateLiteral'&&value.expressions.every(e=>e.type==='Literal')){let text=value.quasis[0].value.cooked;for(let i=0;i<value.expressions.length;i++)text+=String(value.expressions[i].value)+value.quasis[i+1].value.cooked;return {type:'StaticTemplate',value:text};}
  if (value.type === 'Identifier' && value.name === 'undefined') return {type:'Undefined'};
  if (value.type === 'UnaryExpression' && value.operator === 'void' && value.argument?.value === 0) return {type:'Undefined'};
  const result = {};
  for (const [key,child] of Object.entries(value)) {
    if (['start','end','raw'].includes(key)) continue;
    const brace = (value.type === 'IfStatement' && ['consequent','alternate'].includes(key)) ||
      (['ForStatement','ForOfStatement','ForInStatement','WhileStatement','DoWhileStatement'].includes(value.type) && key === 'body');
    const normalized=canonical(child); result[key] = brace && normalized?.type === 'BlockStatement' && normalized.body.length === 1 ? normalized.body[0] : normalized;
  }
  return result;
}
export const equal = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function difference(a,b,at='') {
  if (JSON.stringify(a)===JSON.stringify(b)) return;
  if (!a || !b || typeof a!=='object' || typeof b!=='object') return {at,a,b};
  for (const key of new Set([...Object.keys(a),...Object.keys(b)])) {
    const found=difference(a[key],b[key],at+'.'+key); if(found)return found;
  }
}

export function nodeKey(node) {
  if (node.type === 'VariableDeclaration') return node.declarations.flatMap(d=>boundNames(d.id)).join(',');
  return node.id?.name ?? `#${node.type}:${sha(JSON.stringify(canonical(node)))}`;
}
export function readSource(text) {
  const js = stripTypeScriptTypes(text,{mode:'strip'});
  const ast = parseJs(js);
  const nodes = ast.body.flatMap(n => n.type === 'ImportDeclaration' || n.type === 'EmptyStatement' ? [] : n.type === 'ExportNamedDeclaration' ? n.declaration ? [n.declaration] : [] : [n]);
  return {text,js,ast,nodes,byKey:new Map(nodes.map(n=>[nodeKey(n),n]))};
}
export function dynamicImports(node) {
  const result=[];
  function visit(value) {
    if (!value || typeof value!=='object') return;
    if (value.type==='ImportExpression' && value.source.type==='Literal') result.push(value.source);
    for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(visit); else if(child && typeof child==='object') visit(child);
  }
  visit(node); return result;
}

function boundNames(n){if(!n)return [];if(n.type==="Identifier")return [n.name];if(n.type==="ObjectPattern")return n.properties.flatMap(p=>boundNames(p.value??p.argument));if(n.type==="ArrayPattern")return n.elements.flatMap(boundNames);if(n.type==="RestElement")return boundNames(n.argument);if(n.type==="AssignmentPattern")return boundNames(n.left);return [];}
