import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import {chromium} from 'playwright';
const root=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.infinite-canvas-root.json'),'utf8'));
const config=JSON.parse(fs.readFileSync(path.join(root.dataDir||path.join(os.homedir(),'.infinite-canvas'),'backend.json'),'utf8'));
const testURL = process.env.WORKBENCH_TEST_URL;
if (!testURL) throw new Error('Set WORKBENCH_TEST_URL to a production workbench URL.');
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1600,height:1000}}), errors=[],writes=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/tasks',route=>route.request().method()==='POST' ? route.abort('blockedbyclient') : route.continue());
 page.on('request',r=>{if(r.method()==='POST' && /\/(production\/ops|tasks)$/.test(new URL(r.url()).pathname))writes.push(new URL(r.url()).pathname)});
 await page.addInitScript(({url,token})=>{localStorage.setItem('backend-url',url);localStorage.setItem('backend-token',token)},config);
 await page.goto(testURL);
 const open=page.getByRole('button',{name:'打开画布',exact:true}).first(); try {await open.waitFor()} catch(error) {console.error({url:page.url(),errors,text:(await page.locator('body').innerText()).slice(0,1200)});throw error;}
 const editorField = page.locator('[data-production-target^="shot:"] textarea').first();
 const originalAction=await editorField.inputValue();
 await editorField.fill(originalAction+'\n临时草稿保留验证');
 const sourceURL=page.url(); const field=page.getByRole('textbox').first(); await field.fill('画布收起状态测试');
 await open.click();
 const overlay=page.locator('[data-workbench-canvas]'); await overlay.waitFor();
 await page.locator('[data-workbench-canvas] main').waitFor({timeout:60000});
 assert.equal(page.url(),sourceURL,'canvas must not navigate away');
 const findButton=overlay.getByRole('button',{name:'找画面',exact:true});
 if(await findButton.count()){await findButton.click();await page.locator('.ant-modal-wrap').waitFor();await page.keyboard.press('Escape');await page.locator('.ant-modal-wrap').waitFor({state:'hidden'});assert.equal(await overlay.isVisible(),true,'Escape closes nested dialog before canvas');}
 assert.equal(await page.locator('[data-workbench-underlay]').evaluate(el=>el.inert),true);
 const world = overlay.locator('.origin-top-left').first();
 const transform = await world.evaluate(el=>el.style.transform);
 const canvasElement = await overlay.locator('main').evaluateHandle(el=>el);

 await page.getByRole('button',{name:'收起画布',exact:true}).click();
 assert.equal(await overlay.isVisible(),false);
 assert.equal(await field.inputValue(),'画布收起状态测试');
 assert.equal(await editorField.inputValue(),originalAction+'\n临时草稿保留验证');
 assert.equal(await page.evaluate(()=>{const event=new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true,cancelable:true});window.dispatchEvent(event);return event.defaultPrevented}),false,'hidden canvas must not consume Space');
 const mainCount=await page.locator('[data-workbench-canvas] main').count(); assert.equal(mainCount,1,'canvas retained');
 const button=page.getByRole('button',{name:'展开画布',exact:true}).first(); await button.click();
 assert.equal(await page.locator('[data-workbench-canvas] main').count(),1);
 assert.equal(await world.evaluate(el=>el.style.transform),transform,'viewport retained');
 assert.equal(await overlay.locator('main').evaluate((el,original)=>el===original,canvasElement),true,'same canvas DOM instance');
 await page.keyboard.press('Escape'); assert.equal(await overlay.isVisible(),false);
 await field.fill('');await editorField.fill(originalAction);
 await page.getByRole('button',{name:'角色与素材',exact:true}).first().click();
 await page.locator('[data-subject-picture-bindings]').first().waitFor();
 const reference = page.getByRole('link',{name:'定位到图片画布'}).first();
 if(await reference.count()){await reference.click();await overlay.waitFor({state:'visible'});assert.equal(new URL(page.url()).pathname,new URL(sourceURL).pathname);await page.getByRole('button',{name:'收起画布',exact:true}).click();}
 await page.getByRole('button',{name:'连续性',exact:true}).first().click();
 await page.locator('[data-continuity-readable]').waitFor();
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'展开画布',exact:true}).first().click();
 const bounds=await overlay.boundingBox();assert.equal(Math.round(bounds.width),390);
 await page.getByRole('button',{name:'收起画布',exact:true}).click();
 await page.goto(testURL);await page.getByRole('button',{name:'打开画布',exact:true}).first().waitFor();
 await page.setViewportSize({width:1600,height:1000});
 await page.getByRole('button',{name:'生成与交付',exact:true}).first().click();
 await page.locator('[data-production-target-groups]').waitFor();
 const light=await browser.newPage({viewport:{width:1440,height:900}});
 light.on('pageerror',error=>errors.push(error.message));
 light.on('request',r=>{if(r.method()==='POST' && /\/(production\/ops|tasks)$/.test(new URL(r.url()).pathname))writes.push(new URL(r.url()).pathname)});
 await light.route('**/tasks',route=>route.request().method()==='POST' ? route.abort('blockedbyclient') : route.continue());
 await light.addInitScript(({url,token})=>{localStorage.setItem('backend-url',url);localStorage.setItem('backend-token',token);localStorage.setItem('infinite-canvas:theme_store',JSON.stringify({state:{theme:'light'},version:0}));},config);
 await light.goto(testURL);await light.getByRole('button',{name:'打开画布',exact:true}).first().click();
 await light.locator('[data-workbench-canvas] main').waitFor();
 await light.getByRole('button',{name:'收起画布',exact:true}).click();
 await light.close();
 assert.equal(writes.length,0,'no production edits or paid tasks');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,routePreserved:true,draftPreserved:true,canvasRetained:true,escaped:true,productionWrites:writes.length,errors}));
} finally {await browser.close()}
