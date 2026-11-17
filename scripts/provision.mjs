import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash, randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const target=process.argv[2];
if (!target || new URL(target).protocol!=='https:') throw new Error('Pass the HTTPS deployment origin.');
const origin=new URL(target).origin;
const access='.access';
await mkdir(access,{recursive:true,mode:0o700});

async function account(role) {
  const path=access+'/'+role+'.txt';
  let text;
  try {text=await readFile(path,'utf8');}
  catch(error) {
    if(error.code!=='ENOENT')throw error;
    const key=randomBytes(32).toString('base64url');
    text=(role==='owner'?'Wijdan owner':'Wijdan study library')+'\n\nAccess link\n'+origin+(role==='owner'?'/owner':'/')+'#access='+key+'\n\nPrivate access key\n'+key+'\n';
    await writeFile(path,text,{mode:0o600,flag:'wx'});
  }
  const key=text.trim().split('\n').at(-1);
  if (!/^[\w-]{43}$/.test(key))throw new Error('The local access file is invalid.');
  return {role,key};
}
const accounts=await Promise.all([account('student'),account('owner')]);
const hashes=Object.fromEntries(accounts.map(({role,key})=>[role.toUpperCase()+'_KEY_HASH',createHash('sha256').update(key).digest('hex')]));
if(!process.argv.includes('--verify-only')) {
const result=spawnSync('../node_modules/.bin/wrangler',['secret','bulk','--config','wrangler.production.jsonc'],{
  input:JSON.stringify(hashes),encoding:'utf8',stdio:['pipe','inherit','inherit'],
});
if(result.status!==0)throw new Error('Cloud access key configuration failed.');
}

for(const {role,key} of accounts) {
  const session=await fetch(origin+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({role,key})});
  if(!session.ok)throw new Error(role+' sign-in check failed ('+session.status+').');
  const cookie=session.headers.get('set-cookie').split(';')[0];
  const options={headers:{Cookie:cookie}};
  const own=await fetch(origin+'/api/'+(role==='student'?'changes':'owner/status'),options);
  const other=await fetch(origin+'/api/'+(role==='student'?'owner/status':'changes'),options);
  if(!own.ok||other.status!==403)throw new Error(role+' permissions check failed.');
  const data=await own.json();
  if(role==='student'&&data.records.length)throw new Error('Unexpected data in the new workspace.');
  await fetch(origin+'/api/logout',{method:'POST',headers:{...options.headers,Origin:origin}}).then(response=>{
    if(!response.ok)throw new Error(role+' sign-out check failed.');
  });
  console.log('Verified '+role+' access and role isolation.');
}
const guest=await fetch(origin+'/api/changes');
const html=await fetch(origin+'/');
if(guest.status!==401||!html.ok)throw new Error('Guest access or site readiness check failed.');
console.log('Verified the live entry page and anonymous access boundary.');
