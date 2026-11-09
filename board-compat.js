/* Optional ESP32 UART adapter. micro:bit requests/characteristics pass through unchanged. */
(()=>{'use strict';
 const script=document.currentScript, root=new URL('.',script.src), repo=script.dataset.repo;
 const serviceUUID='6e400001-b5a3-f393-e0a9-e50e24dcca9e';
 let board='microbit',device=null,pending=false,epoch=0,timer;
 const sessions=new WeakMap();
 function selectUI(){const s=document.getElementById('bx-board-select');if(s){s.value=board;s.disabled=pending;}}
 async function requestDevice(options){
  if(pending)throw Error('기기 선택을 진행 중입니다.');
  if(!navigator.bluetooth)throw Error('블루투스를 지원하는 브라우저를 사용해주세요.');
  pending=true;selectUI();const selected=board,token=epoch;
  try{
   const d=await navigator.bluetooth.requestDevice(selected==='microbit'?options:{filters:[{namePrefix:'ESP'},{namePrefix:'MPY'}],optionalServices:[serviceUUID]});
   if(token!==epoch)throw Error('연결할 보드가 변경되었습니다.');
   if(device&&device!==d&&device.gatt.connected)device.gatt.disconnect();
   device=d;sessions.set(d,{board:selected,epoch:token});
   d.addEventListener('gattserverdisconnected',()=>{if(device===d){epoch++;device=null;}});
   return d;
  }finally{pending=false;selectUI();}
 }
 async function getCharacteristic(service,uuid){
  const session=sessions.get(service.device);
  if(!session||session.epoch!==epoch){service.device?.gatt?.disconnect();throw Error('연결을 다시 시작해주세요.');}
  const esp=session.board==='esp32';
  let mapped=String(uuid).toLowerCase();
  if(esp){if(mapped==='6e400003-b5a3-f393-e0a9-e50e24dcca9e')mapped='6e400002-b5a3-f393-e0a9-e50e24dcca9e';else if(mapped==='6e400002-b5a3-f393-e0a9-e50e24dcca9e')mapped='6e400003-b5a3-f393-e0a9-e50e24dcca9e';}
  const c=await service.getCharacteristic(esp?mapped:uuid);
  if(session.epoch!==epoch){service.device.gatt.disconnect();throw Error('연결할 보드가 변경되었습니다.');}
  if(!esp)return c;
  let queue=Promise.resolve();
  function write(data){
   const bytes=data instanceof ArrayBuffer?new Uint8Array(data.slice(0)):new Uint8Array(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength));
   const job=queue.then(async()=>{
    for(let i=0;i<bytes.length;i+=20){
     if(session.epoch!==epoch||!service.device.gatt.connected)throw Error('기기 연결이 해제되었습니다.');
     const chunk=bytes.slice(i,i+20);
     if(c.properties.write&&c.writeValueWithResponse)await c.writeValueWithResponse(chunk);
     else if(c.properties.writeWithoutResponse&&c.writeValueWithoutResponse)await c.writeValueWithoutResponse(chunk);
     else await c.writeValue(chunk);
    }
   });queue=job.catch(()=>{});return job;
  }
  return new Proxy(c,{get(target,key){if(['writeValue','writeValueWithResponse','writeValueWithoutResponse'].includes(key))return write;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
 }
 window.BoardLink={requestDevice,getCharacteristic,get board(){return board;}};
 function mount(){
  const host=document.querySelector('.sidebar,.dashboard-sidebar,.controls')||document.querySelector('main');if(!host)return;
  const bar=document.createElement('div');bar.className='bx-board-toolbar';bar.innerHTML='<div class="bx-board-picker"><span class="bx-board-logos" aria-hidden="true"><img data-bx-logo="microbit" class="active" alt=""><img data-bx-logo="esp32" alt=""></span><select id="bx-board-select" aria-label="연결할 보드"><option value="microbit">micro:bit</option><option value="esp32">ESP32</option></select></div><span class="bx-sr" role="status" id="bx-board-feedback"></span>';
  bar.querySelector('[data-bx-logo=microbit]').src=new URL('assets/boards/microbit.svg',root);bar.querySelector('[data-bx-logo=esp32]').src=new URL('assets/boards/espressif.svg',root);
  host.prepend(bar);const select=bar.querySelector('select');
  select.addEventListener('change',()=>{
   const next=select.value;if(pending||next===board){selectUI();return;}
   if(device?.gatt.connected&&!confirm('기기 동작을 멈췄나요? 보드를 바꾸면 현재 블루투스 연결이 해제됩니다.')){selectUI();return;}
   epoch++;if(device?.gatt.connected)device.gatt.disconnect();device=null;board=next;selectUI();
   document.documentElement.dataset.bxBoard=board;
   bar.querySelectorAll('[data-bx-logo]').forEach(img=>img.classList.toggle('active',img.dataset.bxLogo===board));
   clearTimeout(timer);bar.classList.remove('bx-board-changed');void bar.offsetWidth;bar.classList.add('bx-board-changed');timer=setTimeout(()=>bar.classList.remove('bx-board-changed'),650);
   document.getElementById('bx-board-feedback').textContent=(board==='microbit'?'micro:bit':'ESP32')+' 선택됨';
   updateSupport();window.dispatchEvent(new CustomEvent('boardchange',{detail:{board}}));
  });
  document.addEventListener('click',event=>{
   const button=event.target.closest('button,[data-tour]');
   if(board==='esp32'&&button&&(button.hasAttribute('data-tour')||/사용법 둘러보기/.test(button.textContent))){event.preventDefault();event.stopImmediatePropagation();openGuide(button);}
  },true);
 }
 let originals=[],hidden=[];
 function updateSupport(){
  originals.forEach(([node,text])=>{node.nodeValue=text;});originals=[];hidden.forEach(([el,value])=>el.hidden=value);hidden=[];
  document.querySelectorAll('[data-bx-generated]').forEach(n=>n.remove());
  if(board==='microbit')return;
  const streamer=repo==='microbit_data_streamer';
  const help=document.querySelector('#support-card,#support,#support-modal,#game-support');
  // Change text only in instructional paragraphs, never names, saved classes or live data.
  document.querySelectorAll('p,li,summary').forEach(el=>{
   if(el.closest('footer,dialog,.device-examples,.device-prepare,.device-example-card'))return;
   for(const node of el.childNodes){if(node.nodeType===3&&/마이크로비트|micro:bit/.test(node.nodeValue)){originals.push([node,node.nodeValue]);node.nodeValue=node.nodeValue.replaceAll('마이크로비트','ESP32').replaceAll('micro:bit','ESP32');}}
  });
  let examples=document.querySelector('#help-examples,#support-examples');
  if(!examples&&help)examples=[...help.querySelectorAll('details')].find(d=>/예제/.test(d.querySelector('summary')?.textContent||''));
  const content=document.createElement('div');content.dataset.bxGenerated='';content.className='bx-esp-examples';
  content.innerHTML='<p>사용할 기기에 맞는 예제를 선택해주세요.</p><div class="bx-esp-prepare"><strong>ESP32 준비</strong><p>BLE를 지원하는 ESP32에 MicroPython과 예제 파일을 저장하고 실행하세요. 연결 목록에서 ESP 또는 MPY로 시작하는 이름을 선택합니다.</p></div><article><h4>ESP32 기본</h4><p>'+(streamer?'테스트 값을 웹앱으로 보내 그래프 수신을 확인합니다. 실제 센서 측정값은 아닙니다.':'웹앱에서 보내는 데이터를 Thonny 콘솔에서 확인합니다. 모터나 LED를 움직이는 예제는 아닙니다.')+'</p><a href="https://github.com/boundary-x/'+repo+'/tree/main/examples/esp32" target="_blank" rel="noopener noreferrer">'+(streamer?'데이터 송신 테스트':'데이터 수신 테스트')+' 예제 ↗</a><p>main.py와 ble_library.py를 보드에 저장하세요. '+(streamer?'외부 센서를 쓰려면 예제의 테스트 값을 센서 측정값으로 바꾸세요.':'길게 나뉘어 들어오는 데이터도 줄바꿈까지 모아 처리합니다.')+'</p></article>';
  if(examples){[...examples.children].filter(n=>n.tagName!=='SUMMARY').forEach(el=>{hidden.push([el,el.hidden]);el.hidden=true;});examples.append(content);}else if(help)help.append(content);else document.querySelector('.sidebar,.controls,main')?.append(content);
  if(help){
   [...help.querySelectorAll('details')].filter(d=>/보정|캘리브레이션/.test(d.querySelector('summary')?.textContent||'')).forEach(el=>{hidden.push([el,el.hidden]);el.hidden=true;});
   const note=document.createElement('div');note.dataset.bxGenerated='';note.className='bx-esp-note';note.innerHTML='<strong>업데이트 노트 · 2026.11.09</strong><p>ESP32 보드 선택, BLE UART 연결 및 테스트 예제를 추가했습니다. micro:bit 화면과 데이터 형식은 유지합니다.</p>';help.append(note);
  }
 }
 function openGuide(opener){
  const d=document.createElement('dialog');d.className='bx-esp-guide';d.setAttribute('aria-label','ESP32 사용 안내');
  d.innerHTML='<h2>ESP32로 연결하기</h2><ol><li>사용 가이드의 ESP32 테스트 예제 파일을 보드에 저장하고 실행하세요.</li><li>기기 연결을 눌러 ESP 또는 MPY로 시작하는 장치를 선택하세요.</li><li>'+(repo==='microbit_data_streamer'?'웹앱 그래프에 테스트 데이터가 들어오는지 확인하세요.':'웹앱의 기존 기능을 실행하고 Thonny 콘솔에서 데이터를 확인하세요.')+'</li></ol><p>아이폰·아이패드는 Bluefy를 사용하세요. 로봇 제어는 별도의 ESP32 제어 코드가 필요합니다.</p><button type="button">닫기</button>';
  document.body.append(d);d.querySelector('button').onclick=()=>d.close();d.addEventListener('close',()=>{d.remove();opener.focus();});d.showModal();
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
})();
