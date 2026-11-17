import {cp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';

const require = createRequire(import.meta.url);
const packageFile = (name, file) => resolve(require.resolve(name + '/package.json'), '..', file);
const out = 'dist';
await rm(out,{recursive:true,force:true});
await cp('public', out, {recursive:true,filter:path=>!path.endsWith('creative-os-project.json')});
await mkdir(out + '/vendor', {recursive:true});
for (const [name, file, output] of [
  ['pdfjs-dist', 'legacy/build/pdf.mjs', 'pdf.mjs'],
  ['pdfjs-dist', 'legacy/build/pdf.worker.mjs', 'pdf.worker.mjs'],
  ['fflate','esm/browser.js','fflate.mjs'],
  ['pdf-lib', 'dist/pdf-lib.min.js', 'pdf-lib.js'],
  ['tesseract.js', 'dist/tesseract.min.js', 'tesseract.js'],
  ['tesseract.js', 'dist/worker.min.js', 'tesseract-worker.js'],
]) {
  await cp(packageFile(name, file), out + '/vendor/' + output);
}
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  const source = packageFile('pdfjs-dist', directory);
  try { await cp(source, out + '/vendor/' + directory, {recursive:true}); }
  catch (error) { if (error.code !== 'ENOENT' || directory !== 'wasm') throw error; }
}
const core = packageFile('tesseract.js-core', '.');
await mkdir(out + '/vendor/ocr', {recursive:true});
for (const file of await readdir(core)) {
  if (/^tesseract-core[.a-z-]*\.(?:js|wasm)$/.test(file)) await cp(resolve(core, file), out + '/vendor/ocr/' + file);
}
for (const language of ['eng','ara']) {
  const base = packageFile('@tesseract.js-data/' + language, '.');
  const models = (await readdir(base)).filter(name => name.startsWith('4.0.0'));
  const model = models.find(name => name.includes('best_int')) || models[0];
  await cp(resolve(base, model, language + '.traineddata.gz'), out + '/vendor/ocr/' + language + '.traineddata.gz');
}
const shellFiles=['index.html','study.css','app.js','store.js','documents.js','editor.js','ui.js','sw.js'];
const files=await Promise.all(shellFiles.map(async name=>[name,await readFile('public/'+name,'utf8')]));
const hash=createHash('sha256');
for(const [name,content] of files)hash.update(name).update(content);
hash.update(await readFile('package-lock.json'));
const revision=process.env.BUILD_ID || hash.digest('hex').slice(0,14);
if(!/^[a-zA-Z0-9_-]+$/.test(revision))throw new Error('BUILD_ID contains invalid characters.');
const clientAsset=/(["'])(\/(?:study\.css|app\.js)|\.\/(?:store|documents|editor|ui)\.js|\/vendor\/pdf(?:\.worker)?\.mjs)\1/g;
await Promise.all(files.map(([name,content])=>{
  if(name==='sw.js')return writeFile(out+'/'+name,content.replaceAll('BUILD_ID',revision));
  if(name==='study.css')return;
  return writeFile(out+'/'+name,content.replace(clientAsset,(_match,quote,path)=>quote+path+'?v='+revision+quote));
}));
