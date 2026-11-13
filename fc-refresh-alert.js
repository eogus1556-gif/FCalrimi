(function(){
  'use strict';

  const SUPABASE_URL='https://gqkkuuvsraimgpctyohy.supabase.co';
  const SUPABASE_KEY='sb_publishable_-iFLiXQ_y4VVKtbeWliMRA_8-XDNErM';
  const PAGE=(document.currentScript&&document.currentScript.dataset.page)||'';
  const STORE=(()=>{try{return window.localStorage}catch(_){return null}})();
  const ACK_KEY='fc_refresh_alarm_ack_v1',ACK_TTL=6*60*60*1000;
  let players=new Map(), client=null, profile=null, checking=false;
  let previous=new Map(), alerted=new Set(), alarmLoop=null, alarmStop=null, queued=[],currentAlarmIds=[];

  function injectUi(){
    if(document.getElementById('fcSharedAlarmOverlay'))return;
    const style=document.createElement('style');
    style.textContent=`
      .fc-shared-alarm{position:fixed;inset:0;z-index:10020;display:none;align-items:center;justify-content:center;padding:18px;background:rgba(2,6,10,.78)}
      body.fc-shared-alarm-open .adSlot.adReady,body.fc-shared-alarm-open .squadSideAd.adReady,body.fc-shared-alarm-open .subAd.adReady,body.fc-shared-alarm-open .sideAd.adReady,body.fc-shared-alarm-open .bottomAd.adReady{position:fixed;z-index:10030;filter:none!important;opacity:1!important}
      .fc-shared-alarm.show{display:flex}.fc-shared-alarm-card{width:min(380px,100%);padding:27px 25px 22px;border:1px solid #baff32;border-radius:20px;background:#111923;color:#eef4fb;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.52);font-family:Pretendard,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
      .fc-shared-alarm-card h2{margin:0 0 13px;color:#baff32;font-size:24px}.fc-shared-alarm-msg{margin:0 0 14px;font-size:15px;font-weight:750;line-height:1.55}.fc-shared-alarm-more{display:none;margin:-3px 0 14px;color:#8ea0b3;font-size:12px;line-height:1.55}.fc-shared-alarm-note{display:none;margin:0 0 15px;color:#b8c6d5;font-size:12px}.fc-shared-alarm-sound{margin:0 0 16px;color:#8ea0b3;font-size:12px}.fc-shared-alarm-sound select{margin-left:6px;padding:6px 8px;border:1px solid #2e3b4d;border-radius:7px;background:#182330;color:#eef4fb}.fc-shared-alarm-actions{display:grid;gap:8px}.fc-shared-alarm-actions button{width:100%;min-height:48px;border-radius:10px;font-weight:900}.fc-shared-alarm-ok{border:0;background:#baff32;color:#091018}.fc-shared-alarm-fav{border:1px solid #baff32;background:transparent;color:#baff32}
    `;
    document.head.appendChild(style);
    const node=document.createElement('div');
    node.id='fcSharedAlarmOverlay'; node.className='fc-shared-alarm';
    node.innerHTML=`<div class="fc-shared-alarm-card" role="dialog" aria-modal="true" aria-labelledby="fcSharedAlarmTitle"><h2 id="fcSharedAlarmTitle">🔔 갱신 알림</h2><p id="fcSharedAlarmMsg" class="fc-shared-alarm-msg"></p><div id="fcSharedAlarmMore" class="fc-shared-alarm-more"></div><p id="fcSharedAlarmNote" class="fc-shared-alarm-note">현재 작업중인 스쿼드는 유지됩니다.</p><div class="fc-shared-alarm-sound">알림음 최대 시간 <select id="fcSharedAlarmSound"><option value="10">10초</option><option value="30">30초</option><option value="60">1분</option><option value="120">2분</option><option value="300">5분</option></select></div><div class="fc-shared-alarm-actions"><button type="button" class="fc-shared-alarm-ok" id="fcSharedAlarmOk">확인</button><button type="button" class="fc-shared-alarm-fav" id="fcSharedAlarmFav">즐겨찾기로 이동</button></div></div>`;
    document.body.appendChild(node);
    const saved=getSoundMax();
    const select=document.getElementById('fcSharedAlarmSound');
    if([...select.options].some(o=>+o.value===saved))select.value=String(saved);
    select.addEventListener('change',()=>{if(STORE)STORE.setItem('fc_sound_maxsec',select.value);resetSoundStop()});
    document.getElementById('fcSharedAlarmOk').addEventListener('click',dismiss);
    document.getElementById('fcSharedAlarmFav').addEventListener('click',goFavorites);
    document.getElementById('fcSharedAlarmNote').style.display=PAGE==='squadmaker'?'block':'none';
  }

  function loadScript(src){return new Promise((resolve,reject)=>{const old=[...document.scripts].find(s=>s.src===src);if(old){if(window.supabase)return resolve();old.addEventListener('load',resolve,{once:true});old.addEventListener('error',reject,{once:true});return}const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=reject;document.head.appendChild(s)})}
  async function getClient(){
    if(client)return client;
    try{
      if(!window.supabase)await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js');
      client=window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
      const result=await client.auth.getSession(); profile=result&&result.data&&result.data.session&&result.data.session.user||null;
      client.auth.onAuthStateChange((_event,session)=>{profile=session&&session.user||null});
      return client;
    }catch(_){return null}
  }
  async function loadPlayers(){
    try{
      const r=await fetch('/api/players?v=20261105-alert',{cache:'no-cache'}); if(!r.ok)return;
      const raw=await r.json(); players=new Map((raw||[]).map(x=>[Number(x[0]),{id:Number(x[0]),name:x[1]||'',season:x[2]||'',hj:x[4]==null?'':(x[3]||''),min:x[4]==null?-1:Number(x[4])}]));
    }catch(_){}
  }
  function guestObject(key){try{const all=JSON.parse((STORE&&STORE.getItem(key))||'{}');return all.guest||{}}catch(_){return{}}}
  async function targets(){
    const sb=await getClient();
    if(sb&&profile){
      try{
        const [f,c]=await Promise.all([sb.from('favorites').select('spid').eq('user_id',profile.id).is('removed_at',null),sb.from('custom_times').select('spid,hj,min').eq('user_id',profile.id)]);
        if(!f.error){const fav={};(f.data||[]).forEach(x=>fav[x.spid]=true);const custom={};if(!c.error)(c.data||[]).forEach(x=>custom[x.spid]={hj:x.hj,min:Number(x.min)});return{fav,custom}}
      }catch(_){}
    }
    return{fav:guestObject('fc_favs'),custom:guestObject('fc_custom_times')};
  }
  function leads(){
    const raw=(STORE&&STORE.getItem('fc_alarm_lead'))||'5';
    const values=String(raw).split('+').map(x=>parseInt(x,10)).filter(x=>Number.isFinite(x)&&x>=0&&x<=30);
    return values.length?[...new Set(values)].sort((a,b)=>b-a):[5];
  }
  function quiet(){
    const m=/^(\d{1,4})-(\d{1,4})$/.exec((STORE&&STORE.getItem('fc_quiet'))||'');if(!m)return false;
    const s=+m[1],e=+m[2],d=new Date(),n=d.getHours()*60+d.getMinutes();return s<e?(n>=s&&n<e):(n>=s||n<e);
  }
  function nextIn(hj,min){
    if(!['홀','짝'].includes(hj)||min<0)return-1;const now=new Date();
    for(let add=0;add<=25;add++){const h=(now.getHours()+add)%24;if((hj==='홀')!==(h%2===1))continue;const diff=add*60+(min-now.getMinutes());if(diff>=0)return diff}return-1;
  }
  function label(hj,min){return hj==='홀'?`홀수시 ${String(min).padStart(2,'0')}분`:hj==='짝'?`짝수시 ${String(min).padStart(2,'0')}분`:''}
  function cycleKey(p,hj,min,lead){const d=new Date(),next=nextIn(hj,min),stamp=new Date(d.getTime()+next*60000);return`${p.id}:${stamp.getFullYear()}-${stamp.getMonth()+1}-${stamp.getDate()}-${stamp.getHours()}:${min}:${lead}`}
  function readAck(){
    if(!STORE)return{};try{const now=Date.now(),raw=JSON.parse(STORE.getItem(ACK_KEY)||'{}'),clean={};Object.entries(raw||{}).forEach(([k,t])=>{if(now-Number(t)<ACK_TTL)clean[k]=Number(t)});return clean}catch(_){return{}}
  }
  function isAcked(key){return !!readAck()[key]}
  function acknowledge(ids){
    if(!STORE||!ids||!ids.length)return;const raw=readAck(),now=Date.now();ids.forEach(id=>{if(id)raw[id]=now});try{STORE.setItem(ACK_KEY,JSON.stringify(raw))}catch(_){}
  }
  async function check(){
    if(checking||!players.size||quiet())return;checking=true;
    try{
      const {fav,custom}=await targets(), pending=[];
      for(const raw of Object.keys(fav||{})){const id=Number(raw),p=players.get(id);if(!p)continue;const eff=p.hj?{hj:p.hj,min:p.min}:custom[id];if(!eff||!eff.hj)continue;const n=nextIn(eff.hj,Number(eff.min));if(n<0)continue;const prev=previous.has(id)?previous.get(id):null;
        for(const lead of leads()){const key=cycleKey(p,eff.hj,Number(eff.min),lead);if(alerted.has(key)||isAcked(key)){alerted.add(key);continue}const crossed=prev==null?n===lead:(prev>lead&&n<=lead);if(crossed){alerted.add(key);pending.push({name:p.name,season:p.season,refresh:label(eff.hj,eff.min),n,key})}}
        previous.set(id,n);
      }
      const groups={};pending.forEach(x=>(groups[x.n]||(groups[x.n]=[])).push(x));
      Object.entries(groups).forEach(([n,a])=>show(a.length===1?`${a[0].name} (${a[0].season}) · ${a[0].refresh} 갱신 ${n}분 전`:`${a.map(x=>x.name).join(', ')} 갱신 ${n}분 전`,a.map(x=>x.key)));
      if(alerted.size>800)alerted=new Set([...alerted].slice(-400));
    }finally{checking=false}
  }
  function soundOn(){return!(STORE&&STORE.getItem('fc_sound')==='off')}
  function getSoundMax(){const n=parseInt((STORE&&STORE.getItem('fc_sound_maxsec'))||'60',10);return n>=5&&n<=600?n:60}
  let audio=null;
  function sound(){if(!soundOn())return;try{audio=audio||new(window.AudioContext||window.webkitAudioContext)();if(audio.state==='suspended')audio.resume();const now=audio.currentTime;[880,1175].forEach((f,i)=>{const o=audio.createOscillator(),g=audio.createGain(),t=now+i*.18;o.frequency.value=f;g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(.22,t+.02);g.gain.exponentialRampToValueAtTime(.0001,t+.16);o.connect(g);g.connect(audio.destination);o.start(t);o.stop(t+.18)})}catch(_){}}
  function resetSoundStop(){if(alarmStop)clearTimeout(alarmStop);alarmStop=setTimeout(()=>{if(alarmLoop)clearInterval(alarmLoop);alarmLoop=null},getSoundMax()*1000)}
  function show(msg,ids=[]){
    const overlay=document.getElementById('fcSharedAlarmOverlay');if(!overlay)return;
    if(ids.length&&ids.every(isAcked))return;
    if(overlay.classList.contains('show')){if(msg&&!queued.some(x=>x.msg===msg)){queued.push({msg,ids});const more=document.getElementById('fcSharedAlarmMore');more.style.display='block';more.innerHTML=queued.map(x=>'· '+escapeHtml(x.msg)).join('<br>')}return}
    queued=[];currentAlarmIds=[...ids];document.getElementById('fcSharedAlarmMore').style.display='none';document.getElementById('fcSharedAlarmMore').innerHTML='';document.getElementById('fcSharedAlarmMsg').textContent=msg||'';document.body.classList.add('fc-shared-alarm-open');overlay.classList.add('show');sound();if(alarmLoop)clearInterval(alarmLoop);alarmLoop=setInterval(sound,1500);resetSoundStop();
  }
  function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function dismiss(mark=true){if(mark)acknowledge([...currentAlarmIds,...queued.flatMap(x=>x.ids||[])]);document.getElementById('fcSharedAlarmOverlay')?.classList.remove('show');document.body.classList.remove('fc-shared-alarm-open');if(alarmLoop)clearInterval(alarmLoop);if(alarmStop)clearTimeout(alarmStop);alarmLoop=alarmStop=null;queued=[];currentAlarmIds=[]}
  function goFavorites(){try{if(PAGE==='squadmaker'&&typeof window.save==='function')window.save()}catch(_){}dismiss();location.href='/index.html?view=favorites'}
  async function init(){injectUi();await Promise.all([loadPlayers(),getClient()]);check();setInterval(check,20000);window.addEventListener('storage',e=>{if(['fc_favs','fc_custom_times','fc_alarm_lead','fc_quiet'].includes(e.key))check();if(e.key===ACK_KEY&&currentAlarmIds.length&&currentAlarmIds.every(isAcked))dismiss(false)})}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
