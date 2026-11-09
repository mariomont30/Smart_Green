// Smart_Green: inicializacao local. Arquivos, perfis e temporarios ficam nesta pasta no D.
const path=require('node:path'),fs=require('node:fs'),fsp=require('node:fs/promises'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),runtime=__dirname;
process.env.TEMP=path.join(runtime,'temp');process.env.TMP=process.env.TEMP;
process.env.npm_config_cache=path.join(runtime,'npm-cache');
for(const p of [process.env.TEMP,path.join(root,'validacao'),path.join(runtime,'downloads')])fs.mkdirSync(p,{recursive:true});
const {chromium}=require(path.join(runtime,'tools/node_modules/playwright-core'));
const headless=process.argv.includes('--headless');
let red,context,dashboard,closing=false;
const log=(s)=>console.log(new Date().toLocaleTimeString('pt-BR')+' '+s);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function close(){
  if(closing)return;closing=true;
  await Promise.allSettled([context?.close(),dashboard?.close()]);
  if(red&&!red.killed)red.kill();
}
process.on('SIGINT',()=>close().finally(()=>process.exit(0)));
process.on('SIGTERM',()=>close().finally(()=>process.exit(0)));
async function waitReady(url){
  for(let i=0;i<60;i++){try{const r=await fetch(url,{signal:AbortSignal.timeout(1000)});if(r.ok)return;}catch{}await sleep(500);}
  throw Error('O painel nao iniciou. Consulte validacao/node-red-inicio.log.');
}
async function launch(profile){
  const candidates=[path.join(process.env.PROGRAMFILES||'C:/Program Files','Google/Chrome/Application/chrome.exe'),path.join(process.env['PROGRAMFILES(X86)']||'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe')];
  const executablePath=candidates.find(p=>fs.existsSync(p));
  if(!executablePath)throw Error('Chrome ou Edge nao encontrado.');
  return chromium.launchPersistentContext(path.join(runtime,profile+'-v2'),{
    executablePath,headless,viewport:{width:1600,height:1000},acceptDownloads:true,downloadsPath:path.join(runtime,'downloads'),
    args:['--disk-cache-dir='+path.join(runtime,profile+'-cache'),'--no-first-run','--disable-breakpad','--disable-crash-reporter','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--disable-features=CalculateNativeWinOcclusion']
  });
}
async function fitCircuit(page){
  const size=page.viewportSize();
  for(let i=0;i<12;i++){
    const boxes=await page.locator('#esp,#soil,#lcd,#servo,#dht,#btn,#net').evaluateAll(es=>es.map(e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom};}));
    if(boxes.length&&boxes.every(b=>b.x>size.width/2+12&&b.right<size.width-15&&b.y>110&&b.bottom<size.height-100))return;
    await page.mouse.move(size.width*0.77,size.height*0.45);
    await page.mouse.wheel(0,500);await sleep(100);
  }
}
(async()=>{
  log('Preparando Node-RED no disco D...');
  let exists=false;
  try{
    const response=await fetch('http://127.0.0.1:1880/flows',{signal:AbortSignal.timeout(1200)});
    if(response.ok){const flows=await response.json();if(!Array.isArray(flows)||!flows.some(n=>n.id==='tab_sg'))throw Error('A porta 1880 esta em uso por outro projeto. Encerre-o antes de iniciar.');const wanted=JSON.parse(fs.readFileSync(path.join(root,'node-red/flows.json'),'utf8')); if(flows.find(n=>n.id==='telemetry')?.func!==wanted.find(n=>n.id==='telemetry')?.func||!flows.some(n=>n.id==='mqtt_ack')||wanted.some(w=>w.format&&flows.find(n=>n.id===w.id)?.format!==w.format)){const deployed=await fetch('http://127.0.0.1:1880/flows',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(wanted)});if(!deployed.ok)throw Error('Falha ao atualizar o fluxo Smart_Green: HTTP '+deployed.status);}exists=true;}
  }catch(e){if(e.message.includes('outro projeto')||e.message.includes('Falha ao atualizar'))throw e;}
  if(!exists){
    const out=fs.openSync(path.join(root,'validacao/node-red-inicio.log'),'a');
    red=cp.spawn(process.execPath,[path.join(root,'node-red/node_modules/node-red/red.js'),'--userDir',path.join(root,'node-red'),'--settings',path.join(root,'node-red/settings.js'),path.join(root,'node-red/flows.json')],{cwd:path.join(root,'node-red'),env:process.env,windowsHide:true,stdio:['ignore',out,out]});
    red.on('error',e=>log('Falha Node-RED: '+e.message));
  }
  await waitReady('http://127.0.0.1:1880/ui/');
  log('Painel iniciado. Abrindo duas janelas independentes para manter a simulacao ativa.');
  context=await launch('wokwi-usuario');
  dashboard=await launch('painel-usuario');
  const panel=dashboard.pages()[0]||await dashboard.newPage();
  await panel.goto('http://127.0.0.1:1880/ui/',{waitUntil:'domcontentloaded'});
  const page=context.pages()[0]||await context.newPage();
  page.on('download',async download=>{const name=path.basename(download.suggestedFilename());await download.saveAs(path.join(runtime,'downloads',name));});

  const netlog=(kind,data)=>fsp.appendFile(path.join(root,'validacao/rede-inicializacao.jsonl'),JSON.stringify({time:new Date().toISOString(),kind,data})+'\n').catch(()=>{});
  page.on('console',m=>{if(m.type()==='error')netlog('console',m.text().replace(/(wss?:\/\/[^?\s]+)\?[^\s]+/g,'$1?[redacted]').slice(0,500));});
  page.on('websocket',ws=>{const u=new URL(ws.url());const name=u.origin+u.pathname;netlog('websocket',name);ws.on('socketerror',e=>netlog('socketerror',{name,error:String(e)}));ws.on('close',()=>netlog('socketclosed',name));});
  const focusSession=await context.newCDPSession(page);
  await focusSession.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  log('Carregando o firmware e o circuito no Wokwi...');
  await page.goto('https://wokwi.com/projects/new/esp32',{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForFunction(()=>window.monaco?.editor?.getModels().some(m=>m.uri.toString()==='vfs:sketch.ino'),null,{timeout:60000});
  const sketch=await fsp.readFile(path.join(root,'wokwi/sketch.ino'),'utf8');
  const diagram=await fsp.readFile(path.join(root,'wokwi/diagram.json'),'utf8');
  await page.evaluate(code=>window.monaco.editor.getModels().find(m=>m.uri.toString()==='vfs:sketch.ino').setValue(code),sketch);
  await page.getByRole('button',{name:'diagram.json',exact:true}).click();
  await page.waitForFunction(()=>window.monaco.editor.getModels().some(m=>m.uri.toString()==='vfs:diagram.json'));
  await page.evaluate(json=>window.monaco.editor.getModels().find(m=>m.uri.toString()==='vfs:diagram.json').setValue(json),diagram);
  await fitCircuit(page);
  await page.getByRole('button',{name:'Library Manager',exact:true}).click();
  const librariesText=await fsp.readFile(path.join(root,'wokwi/libraries.txt'),'utf8');
  if(!await page.getByRole('button',{name:'libraries.txt',exact:true}).count()){
    await page.getByRole('button',{name:'Add a new library',exact:true}).click();
    await page.locator('input[type=text]').fill('PubSubClient');
    await page.getByRole('menuitem',{name:'PubSubClient',exact:true}).click({timeout:45000});
  }
  await page.getByRole('button',{name:'libraries.txt',exact:true}).click();
  await page.waitForFunction(()=>window.monaco.editor.getModels().some(m=>m.uri.toString()==='vfs:libraries.txt'));
  await page.evaluate(text=>window.monaco.editor.getModels().find(m=>m.uri.toString()==='vfs:libraries.txt').setValue(text),librariesText);
  await fsp.writeFile(path.join(root,'validacao/bibliotecas-carregadas.txt'),await page.evaluate(()=>window.monaco.editor.getModels().find(m=>m.uri.toString()==='vfs:libraries.txt').getValue()));
  log('Cinco bibliotecas configuradas pelo arquivo libraries.txt.');
  await page.getByRole('button',{name:'sketch.ino',exact:true}).click();
  log('Compilando o projeto no Wokwi. Aguarde a fila gratuita.');
  await page.getByRole('button',{name:'Start the simulation',exact:true}).click();
  const diagnostic=setInterval(async()=>{try{await fsp.writeFile(path.join(root,'validacao/inicializacao-estado.txt'),(await page.locator('body').innerText()).slice(-18000));await page.screenshot({path:path.join(root,'validacao/inicializacao-em-andamento.png'),fullPage:true});await fsp.writeFile(path.join(root,'validacao/visibilidade.json'),JSON.stringify(await page.evaluate(()=>({state:document.visibilityState,focus:document.hasFocus()}))));}catch{}},15000);
  await page.bringToFront();
  log('Aguardando a primeira telemetria online do ESP32...');
  let online=false;
  for(let attempt=1;attempt<=3;attempt++){
    try {
      await page.waitForFunction(()=>/\[ACK\] seq=\d+/.test(document.body.innerText)||[...document.querySelectorAll('button[aria-label]')].some(b=>(b.getAttribute('aria-label')||'').startsWith('WiFi Error:')),null,{timeout:120000});
    } catch {}
    online=await page.evaluate(()=>/\[ACK\] seq=\d+/.test(document.body.innerText));
    if(online)break;
    if(attempt<3){
      const restart=page.getByRole('button',{name:'Restart the simulation',exact:true});
      log('Conexao ainda indisponivel. Nova tentativa '+(attempt+1)+' de 3.');
      if(await restart.count()){await restart.click();await sleep(1000);}
    }
  }
  if(!online){
    const labels=await page.locator('button[aria-label]').evaluateAll(es=>es.map(b=>b.getAttribute('aria-label')));
    const wifiError=labels.find(s=>s&&s.startsWith('WiFi Error:'));
    log(wifiError||'O ESP32 ainda esta offline. Confira a chave NET e a conexao no Wokwi.');
    log('As janelas permanecerao abertas. Use Restart the simulation no Wokwi para tentar novamente.');
  }
  await sleep(1200);
  await page.screenshot({path:path.join(root,'validacao/inicializacao-wokwi.png'),fullPage:true});
  await panel.screenshot({path:path.join(root,'validacao/inicializacao-painel.png'),fullPage:true});
  await fsp.writeFile(path.join(root,'validacao/INICIALIZACAO.json'),JSON.stringify({ok:online,status:online?'online':'aguardando_conexao',checked_at:new Date().toISOString(),project_root:root,temp:process.env.TEMP,npm_cache:process.env.npm_config_cache,mode:headless?'headless':'visible'},null,2));
  clearInterval(diagnostic);
  if(online)log('VALIDADO: ESP32 online e painel aberto. Projeto pronto para usar.');
  else log('PROJETO CARREGADO: painel aberto; conexao do simulador ainda pendente.');
  log('O painel esta na outra janela: http://localhost:1880/ui');
  log('Mantenha esta janela de terminal aberta. Ctrl+C encerra o projeto.');
  log('Para criar um link publico, use SAVE no Wokwi e entre na sua conta.');
  const intervals=setInterval(()=>{},60000);
  context.on('close',()=>{log('Wokwi fechado. Encerrando o projeto.');clearInterval(intervals);close().finally(()=>process.exit(0));});
  if(headless){await sleep(2000);log('HEADLESS_SETUP_OK');}
})().catch(async e=>{console.error('ERRO: '+e.stack);try{const p=context?.pages()[0];if(p){await fsp.writeFile(path.join(root,'validacao/inicializacao-erro.txt'),(await p.locator('body').innerText()).slice(-24000));await p.screenshot({path:path.join(root,'validacao/inicializacao-erro.png'),fullPage:true});}}catch{}await close();process.exitCode=1;});


