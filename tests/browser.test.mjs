import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {createHash} from 'node:crypto';

const base=process.env.WIJDAN_TEST_ORIGIN || 'http://localhost:8788';
const student=process.env.WIJDAN_TEST_KEY || 'a'.repeat(43);
const owner=process.env.WIJDAN_TEST_OWNER || 'b'.repeat(43);
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
const uniq=Date.now().toString(36);
const fileName='Biology '+uniq+'.pdf';
const show=label=>process.stdout.write('Checkpoint '+label+'\n');

async function fixture(){
  const pdf=await PDFDocument.create();
  const font=await pdf.embedFont(StandardFonts.Helvetica);
  for(const text of ['Cell structure and division','Photosynthesis converts light energy']) {
    const page=pdf.addPage([612,792]);
    page.drawText(text,{font,size:28,x:50,y:680});
    page.drawText('Biology study notes and example text',{font,size:16,x:50,y:635});
  }
  return Buffer.from(await pdf.save());
}
async function scannedFixture(page){
  const raster=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=800;canvas.height=600;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,800,600);ctx.fillStyle='#111';ctx.font='46px sans-serif';
    ctx.fillText('Microscope calibration',64,175);ctx.fillText('Check the objective lens',64,245);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const bytes=Buffer.from(raster,'base64');
  const pdf=await PDFDocument.create();
  const shot=pdf.addPage([612,765]);
  shot.drawImage(await pdf.embedPng(bytes),{x:40,y:240,width:530,height:410});
  return {bytes, pdf:Buffer.from(await pdf.save())};
}

async function sign(page,key,path='/'){
  await page.goto(base+path);
  await page.getByLabel('Private access key').fill(key);
  await page.getByRole('button',{name:'Sign In'}).click();
  await page.getByRole('heading',{name:path==='/owner'?'Owner':'Current Study',exact:true}).waitFor({timeout:30_000});
}
async function choose(page, label, value, button='Continue'){
  await page.locator('dialog').getByLabel(label).selectOption(value);
  await page.locator('dialog').getByRole('button',{name:button,exact:true}).click();
}
async function operate(page,name,action){
  await page.getByRole('button',{name:'Options for '+name,exact:true}).click();
  await page.locator('dialog').getByRole('button',{name:action,exact:true}).click();
}

async function chooseLibraryView(page,view){
  const label={grid:'Grid',list:'List',shelves:'Shelves'}[view];
  await page.getByRole('button',{name:label,exact:true}).click();
}
async function addToPage(page,kind,ink,fill){
  await page.getByRole('button',{name:'Add',exact:true}).click();
  await page.locator('dialog').getByRole('button',{name:kind,exact:true}).click();
  if(ink){const rect=await ink.boundingBox();await page.mouse.click(rect.x+95,rect.y+118);}
  if(fill){await page.locator('dialog textarea').fill(fill);await page.locator('dialog').getByRole('button',{name:'Save',exact:true}).click();}
}

test('study library workflow', {timeout:220_000},async()=>{
  await mkdir('test-output',{recursive:true});
  const browser=await chromium.launch({executablePath:process.env.WIJDAN_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:800,height:1280},deviceScaleFactor:1,acceptDownloads:true});
  const page=await context.newPage();
  const failures=[];
  page.on('pageerror',error=>failures.push(error.message));
  const pdf=await fixture();
  const screenshots=process.env.WIJDAN_SCREENSHOTS!=='0';
  try {
    await sign(page,student);
    assert.equal((await page.request.get(base+'/api/owner/status')).status(),403);
    if(screenshots){await page.waitForTimeout(625);await page.screenshot({path:'test-output/01-home-portrait.png'});}
    show('sign in and owner isolation');

    const second='Cardiology '+uniq+'.pdf';
    await page.locator('#upload').setInputFiles([
      {name:fileName,mimeType:'application/pdf',buffer:pdf},
      {name:second,mimeType:'application/pdf',buffer:pdf},
    ]);
    await page.getByText(second,{exact:true}).waitFor({timeout:35_000});
    await chooseLibraryView(page,'shelves');
    const firstBook=page.getByRole('button',{name:fileName,exact:true});
    const secondBook=page.getByRole('button',{name:second,exact:true});
    await secondBook.waitFor({timeout:35_000});
    await secondBook.click();
    assert.equal(await secondBook.getAttribute('aria-pressed'),'true');
    const visibleCover=page.getByRole('button',{name:'Open '+second,exact:true});
    await visibleCover.locator('img').waitFor();
    await firstBook.click();
    assert.equal(await firstBook.getAttribute('aria-pressed'),'true');
    await page.getByRole('button',{name:'Open '+fileName,exact:true}).waitFor();
    assert.equal(await page.getByRole('checkbox').count(),0);
    if(screenshots){
      await page.setViewportSize({width:390,height:844});
      await page.evaluate(()=>document.documentElement.dataset.theme='dark');
      await page.getByRole('button',{name:'Open '+fileName,exact:true}).locator('img').waitFor();
      await page.screenshot({path:'test-output/08-bookshelves-phone.png'});
      await page.setViewportSize({width:800,height:1280});
      await page.waitForTimeout(200);
      await page.screenshot({path:'test-output/09-bookshelves-tablet.png'});
    }
    show('bookshelf selection, real PDF covers and clean default controls');
    await chooseLibraryView(page,'list');
    await page.locator('article').filter({has:firstBook}).getByText('Ready to Search',{exact:true}).waitFor({timeout:45_000});
    await page.reload();
    await page.getByRole('button',{name:'Library',exact:true}).click();
    await chooseLibraryView(page,'list');
    await page.evaluate(()=>{
      const real=HTMLCanvasElement.prototype.getContext;
      window.failReaderCanvases=1;
      HTMLCanvasElement.prototype.getContext=function(...args){
        if(this.classList.contains('base')&&window.failReaderCanvases>0){
          window.failReaderCanvases--;
          return null;
        }
        return real.apply(this,args);
      };
    });
    await page.getByRole('button',{name:fileName,exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.sheet .ink')?.width>300);
    assert.equal(await page.evaluate(()=>window.failReaderCanvases),0);
    assert.equal(await page.locator('.page-recovery').count(),0);
    assert.equal(await page.locator('.dock').count(),0);
    assert.equal(await page.getByRole('button',{name:'Read',exact:true}).getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('.reader-context').isHidden(),true);
    for(const viewport of [{width:390,height:844},{width:800,height:1280},{width:1280,height:800},{width:1440,height:900}]){
      await page.setViewportSize(viewport);
      const fit=await page.evaluate(()=>({document:document.documentElement.scrollWidth<=innerWidth+1,toolbar:document.querySelector('.editor-toolbar').scrollWidth<=document.querySelector('.editor-toolbar').clientWidth+1}));
      assert.deepEqual(fit,{document:true,toolbar:true});
    }
    assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll('.editor-shell button')].filter(node=>node.offsetParent).map(node=>node.getBoundingClientRect()).every(rect=>rect.width>=44&&rect.height>=42)),true);
    await page.setViewportSize({width:800,height:1280});
    if(screenshots){await page.waitForTimeout(400);await page.screenshot({path:'test-output/05-reader.png'});}
    show('upload, index, reload and successful automatic PDF recovery');

    await page.evaluate(()=>window.failReaderCanvases=2);
    await page.getByRole('button',{name:'Next page',exact:true}).click();
    const originalLink=page.getByRole('link',{name:'Open Original',exact:true});
    await originalLink.waitFor();
    const originalURL=await originalLink.getAttribute('href');
    assert.match(originalURL,/^\/api\/blob\//);
    const originalResponse=await page.request.get(base+originalURL);
    assert.equal(hash(await originalResponse.body()),hash(pdf));
    await page.evaluate(()=>window.failReaderCanvases=0);
    await page.getByRole('button',{name:'Retry',exact:true}).click();
    await page.locator('.page-recovery').waitFor({state:'detached'});
    await page.getByRole('button',{name:'Pen',exact:true}).click();
    const ink=page.locator('.sheet .ink').first();
    await ink.waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelector('.ink')?.width>300);
    const rect=await ink.boundingBox();
    await page.mouse.move(rect.x+100,rect.y+140);
    await page.mouse.down();await page.mouse.move(rect.x+230,rect.y+157,{steps:12});await page.mouse.up();
    await page.waitForFunction(()=>!document.querySelector('[data-action=undo]')?.disabled);
    await addToPage(page,'Typed Note',ink,'Independent handwritten and typed study notes.');
    const fixtures=await scannedFixture(page);
    await page.getByRole('button',{name:'Add',exact:true}).click();
    await page.locator('dialog').getByRole('button',{name:'Image',exact:true}).click();
    const fileChooser=page.waitForEvent('filechooser');
    await page.locator('dialog').getByRole('button',{name:'Choose',exact:true}).click();
    await (await fileChooser).setFiles({name:'worksheet.png',mimeType:'image/png',buffer:fixtures.bytes});
    await page.waitForTimeout(150);{
      const imageRect=await ink.boundingBox();await page.mouse.click(imageRect.x+160,imageRect.y+180);
    }
    await page.getByRole('button',{name:'Add',exact:true}).click();
    await page.locator('dialog').getByRole('button',{name:'Add Page',exact:true}).click();
    await page.locator('dialog').getByLabel('Page type').selectOption('dotted');
    await page.locator('dialog').getByRole('button',{name:'Add',exact:true}).click();
    await page.locator('.sheet.dotted').waitFor();
    await page.getByRole('button',{name:'Back',exact:true}).click();
    await page.getByRole('button',{name:'Current Study',exact:true}).click();
    await page.getByText('Page 3 of 3',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Resume',exact:true}).click();
    await page.getByRole('button',{name:'Page 3 / 3',exact:true}).waitFor();
    await page.getByRole('button',{name:'Reader options'}).click();
    const exported=page.waitForEvent('download');
    await page.locator('dialog').getByRole('button',{name:'Export PDF',exact:true}).click();
    const downloaded=await exported;
    const output=await readFile(await downloaded.path());
    const rendered=await PDFDocument.load(output);
    assert.equal(rendered.getPageCount(),3);
    assert.notEqual(hash(output),hash(pdf));
    await page.getByRole('button',{name:'Reader options'}).click();
    const original=page.waitForEvent('download');
    await page.locator('dialog').getByRole('button',{name:'Download Original',exact:true}).click();
    assert.equal(hash(await readFile(await (await original).path())),hash(pdf));
    await page.getByRole('button',{name:'Back',exact:true}).click();
    show('ink, typed note, inserted image, added page, Resume, merged export and original checksum');

    await page.getByRole('button',{name:'Library',exact:true}).click();
    await chooseLibraryView(page,'list');
    await operate(page,fileName,'Pin');
    await page.getByRole('button',{name:'Add',exact:true}).click();
    await page.locator('dialog').getByRole('button',{name:'New Page'}).click();
    const noteName='Revision '+uniq;
    await page.locator('dialog').getByLabel('Name').fill(noteName);
    await page.locator('dialog').getByRole('button',{name:'Create'}).click();
    await page.locator('.reader-shell').waitFor();
    await addToPage(page,'Typed Note',page.locator('.sheet .ink').first(),'Review later on Thursday');
    await page.getByRole('button',{name:'Back',exact:true}).click();
    await page.getByRole('button',{name:'Notes',exact:true}).click();
    await operate(page,noteName,'Pin');
    await page.getByRole('button',{name:'Current Study',exact:true}).click();
    assert.equal(await page.locator('.pinned-rail article').count()>=2,true);
    await page.getByRole('button',{name:'Manage',exact:true}).click();
    await page.getByRole('button',{name:'Move down'}).first().click();
    await page.getByRole('button',{name:'Save order'}).click();
    await page.waitForTimeout(680);
    await page.locator('#status').waitFor({state:'hidden'});
    if(screenshots){
      await page.screenshot({path:'test-output/02-study-portrait.png'});
      await page.setViewportSize({width:1280,height:800});
      await page.screenshot({path:'test-output/03-study-landscape.png'});
      await page.setViewportSize({width:390,height:844});
      await page.screenshot({path:'test-output/04-study-phone.png'});
    }
    await page.setViewportSize({width:390,height:844});
    const rail=page.locator('.pinned-rail');
    const track=await rail.boundingBox();
    const protocol=await context.newCDPSession(page);
    const send=(type,x,buttons)=>protocol.send('Input.dispatchMouseEvent',{type,x,y:track.y+18,button:type==='mouseMoved'?'none':'left',buttons,pointerType:'pen'});
    await send('mousePressed',track.x+track.width-28,1);
    await send('mouseMoved',track.x+track.width-54,1);
    await send('mouseMoved',track.x+22,1);
    await send('mouseReleased',track.x+22,0);
    await page.waitForFunction(()=>Math.abs(document.querySelector('.pinned-rail').scrollLeft)>4);
    show('standalone note, two pinned types, reorder and pen drag');

    await page.getByRole('button',{name:'Search',exact:true}).click();
    await page.getByRole('searchbox').fill('Photosynthesis converts light energy');
    await page.getByRole('searchbox').press('Enter');
    await page.getByRole('button',{name:'Open Source',exact:true}).first().click({timeout:35_000});
    await page.getByRole('button',{name:'Page 2 / 2',exact:true}).waitFor();
    await page.getByRole('button',{name:'Back',exact:true}).click();
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    if(screenshots)await page.screenshot({path:'test-output/06-settings.png'});
    await page.getByRole('button',{name:'Dark',exact:true}).click();
    await page.getByRole('button',{name:'Apply',exact:true}).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
    await page.getByRole('button',{name:'Light',exact:true}).click();
    await page.getByRole('button',{name:'Apply',exact:true}).click();
    await page.getByRole('button',{name:'Library',exact:true}).click();
    await page.getByRole('button',{name:'Library options',exact:true}).click();
    await page.getByRole('button',{name:'Find in Sources',exact:true}).click();
    await page.locator('dialog').getByLabel('Question').fill('What is photosynthesis?');
    await page.locator('dialog').getByRole('button',{name:'Find sources'}).click();
    await page.getByRole('button',{name:'Open Source',exact:true}).first().waitFor();
    show('document search, Ask Library citations and persistent theme');

    await page.getByRole('button',{name:'Library',exact:true}).click();
    await operate(page,fileName,'Make Available Offline');
    await page.getByText('Available Offline',{exact:true}).waitFor();
    await page.waitForTimeout(900);
    await context.setOffline(true);
    await page.getByRole('button',{name:fileName,exact:true}).click();
    await addToPage(page,'Typed Note',page.locator('.sheet .ink').first(),'Offline revision '+uniq);
    await page.getByRole('button',{name:'Back',exact:true}).click();
    await context.setOffline(false);
    await page.waitForTimeout(1400);
    const synced=await page.evaluate(async text=>{
      let since=0,after='';
      for(let i=0;i<10;i++){
        const packet=await (await fetch('/api/changes?'+new URLSearchParams({since,after}))).json();
        if(packet.records.some(record=>record.kind==='annotation'&&record.data.objects.some(object=>object.text?.includes(text))))return true;
        if(!packet.more)return false;
        [since,after]=packet.cursor;
      }
      return false;
    },'Offline revision '+uniq);
    assert.equal(synced,true);
    await operate(page,fileName,'Delete');
    await page.locator('dialog').getByRole('button',{name:'Delete',exact:true}).click();
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.getByText('Advanced',{exact:true}).click();
    await page.getByRole('button',{name:'Recently Deleted',exact:true}).click();
    await page.locator('dialog').locator('article').filter({hasText:fileName}).getByRole('button',{name:'Restore',exact:true}).click();
    await page.getByRole('button',{name:'Library',exact:true}).click();
    await page.getByRole('button',{name:fileName,exact:true}).waitFor();
    show('offline editing, reconnect and trash/restore');

    const scanName='Scanned '+uniq+'.pdf';
    await page.locator('#upload').setInputFiles({name:scanName,mimeType:'application/pdf',buffer:fixtures.pdf});
    await page.getByText(scanName,{exact:true}).waitFor();
    await page.getByText('OCR Required',{exact:true}).waitFor({timeout:35_000});
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.getByText('Advanced',{exact:true}).click();
    await page.getByRole('button',{name:'Rebuild Index',exact:true}).click();
    await page.locator('dialog').getByRole('button',{name:'Start processing',exact:true}).click();
    await page.getByRole('button',{name:'Library',exact:true}).click();
    if(screenshots){await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(180);await page.screenshot({path:'test-output/07-library.png'});}
    await page.getByRole('button',{name:'Search',exact:true}).click();
    await page.getByRole('searchbox').fill('Microscope calibration');
    await page.getByRole('searchbox').press('Enter');
    for(let attempt=0;attempt<35;attempt++){
      if(await page.getByText('OCR Text',{exact:false}).count())break;
      await page.waitForTimeout(1000);
      await page.getByRole('searchbox').press('Enter');
    }
    await page.getByText('OCR Text',{exact:false}).first().waitFor({timeout:4000});
    show('OCR and searchable scanned PDF');

    const ownerContext=await browser.newContext();
    const admin=await ownerContext.newPage();
    await sign(admin,owner,'/owner');
    assert.equal((await admin.request.get(base+'/api/changes')).status(),403);
    await admin.getByRole('button',{name:'Create backup'}).click();
    await admin.getByRole('link',{name:'Download'}).first().waitFor();
    show('owner backup and role isolation');
    assert.deepEqual(failures,[]);
  }finally{await browser.close();}
});
