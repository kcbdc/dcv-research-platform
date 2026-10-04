// Background work belongs to scheduled Workers. This view polls only while open.
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let status=null,pollTimer=null,controller=null,activeProject=null,etag='',loading=false,selectedRole='leader';
const stateLabel={active:'자동 연구 진행',paused:'일시 중지',attention:'확인 필요',completed:'패키지 생성 완료',pending:'대기',running:'작업 중',done:'완료',retry:'재시도 대기',failed:'확인 필요'};
const date=s=>s?new Date(s).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'—';
function headers(){const token=window.DCV?.token();return token?{authorization:'Bearer '+token}:{};}
function path(action=''){return `/api/projects/${encodeURIComponent(activeProject)}/lab${action?'/'+action:''}`;}
function ensureLab(){
 if($('#researchLabModal'))return;
 document.body.insertAdjacentHTML('beforeend',`<div class="modal fade" id="researchLabModal" tabindex="-1" aria-labelledby="labTitle"><div class="modal-dialog modal-fullscreen"><div class="modal-content lab-modal"><div class="modal-header"><div><span class="lab-eyebrow">DCV RESEARCH LAB</span><h5 id="labTitle">10인 AI 연구실</h5><small>역할별 AI 에이전트 · 실제 연구 근거로 작성 · 최종 투고는 실제 저자 검토 후 진행</small></div><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="연구실 닫기"></button></div><div class="modal-body"><div id="labNotice" role="status"></div><div class="lab-toolbar"><div id="labCampaign"></div><div class="lab-controls"><button class="btn-ghost" id="labSettingsBtn">연구 설정</button><button class="btn-ghost" id="labPauseBtn">일시 중지</button><button class="btn-future" id="labStartBtn">30일 연구 시작</button></div></div><div class="lab-progress"><div id="labProgressBar"></div></div><div class="lab-workspace"><section class="lab-room" aria-label="연구원 책상" id="labDesks"></section><aside class="lab-detail"><div class="lab-eyebrow">DESK REVIEW</div><h3 id="labDeskTitle">리더 책상에서 최종 결과 확인</h3><div id="labDeskContent">책상을 클릭하면 담당 역할과 실제 최근 작업을 확인할 수 있습니다.</div></aside></div><section class="lab-activity"><h3>활동 기록</h3><div id="labActivity"></div></section><details class="lab-documents"><summary>영문 논문 초안 보기</summary><div id="labDocuments"></div><button class="btn-ghost" id="labLoadDocs">현재 초안 불러오기</button></details><details id="labSettings" class="lab-settings"><summary>목표 저널 및 실제 저자 정보</summary><form id="labConfigForm"><div class="lab-form-grid"><label>목표 저널<input name="target_journal" class="form-control" placeholder="Journal name"></label><label>논문 영어 제목<input name="title" class="form-control" disabled></label><label class="lab-wide">저자 정보 <small>줄마다 이름 | 소속 | 이메일 | 교신저자는 마지막에 corresponding</small><textarea name="authors" class="form-control" rows="3" placeholder="Author name | Affiliation | email@example.com | corresponding"></textarea></label><label class="lab-wide">윤리 심의 및 동의에 대한 실제 확인 내용<textarea name="ethics_statement" class="form-control" rows="3" placeholder="영문으로 실제 확인한 내용을 입력하세요."></textarea></label><label>연구비 확인<input name="funding" class="form-control"></label><label>이해충돌 확인<input name="conflicts" class="form-control"></label><label class="lab-wide">본문을 직접 검토한 핵심 문헌 DOI <small>한 줄에 하나씩</small><textarea name="full_text_verified_dois" class="form-control" rows="3"></textarea></label></div><button class="btn-future" type="submit">연구 설정 저장</button></form><form id="labJournalForm"><h4>최근 3개 JCR 연도 검증 자료</h4><p>각 연도에서 SCIE·SSCI 등재 및 Q1/Q2 또는 AIS 0.75 이상인지 실제 자료로 확인합니다.</p><label>저널 이름<input name="journal" class="form-control" required></label><label>JCR 분야<input name="category" class="form-control" required></label><label>확인한 사람<input name="verified_by" class="form-control" required></label><div id="labJournalYears"></div><button class="btn-future" type="submit">저널 근거 저장</button></form><form id="labReplayForm"><h4>실행한 독립 재현 검증 기록</h4><p>전체 seed를 실제로 재실행한 검증자의 기록을 저장합니다. 리더 책상을 열면 현재 데이터 해시가 표시됩니다.</p><div class="lab-form-grid"><label class="lab-wide">현재 데이터 SHA256<input name="data_digest" class="form-control" readonly required></label><label>재현한 실행 수<input name="replayed_runs" type="number" min="1" step="1" class="form-control" required></label><label>최대 절대 오차<input name="max_absolute_error" type="number" min="0" max="0.00000001" step="any" class="form-control" required></label><label class="lab-wide">실행 로그 SHA256<input name="log_sha256" class="form-control" pattern="[a-fA-F0-9]{64}" required></label><label>HTTPS 검증 보고서<input name="report_url" type="url" class="form-control" required></label><label>실제 검증자<input name="verified_by" class="form-control" required></label></div><label><input name="confirmed" type="checkbox" required> 실제 전체 seed 재현을 완료했습니다.</label><button class="btn-future" type="submit">독립 검증 기록 저장</button></form></details></div></div></div></div>`);
 $('#labStartBtn').onclick=()=>action('',{});
 $('#labPauseBtn').onclick=()=>action(status?.campaign?.status==='active'?'pause':'resume',{});
 $('#labSettingsBtn').onclick=()=>{$('#labSettings').open=true;$('#labSettings').scrollIntoView({block:'start',behavior:'smooth'});};
 $('#labDesks').onclick=e=>{const b=e.target.closest('[data-role]');if(b)showDesk(b.dataset.role,true);};
 $('#labLoadDocs').onclick=loadDocuments;
 $('#labReplayForm').onsubmit=saveReplay;$('#labConfigForm').onsubmit=saveConfig;$('#labJournalForm').onsubmit=saveJournal;
 $('#researchLabModal').addEventListener('hidden.bs.modal',stopPolling);
 $('#researchLabModal').addEventListener('shown.bs.modal',()=>{void refresh();schedulePoll();});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)stopPolling();else if($('#researchLabModal').classList.contains('show')){void refresh();schedulePoll();}});
 window.addEventListener('dcv:project-loaded',ev=>{if(activeProject!==ev.detail.id){stopPolling();status=null;etag='';activeProject=ev.detail.id;if($('#researchLabModal').classList.contains('show')){void refresh();schedulePoll();}}});
}
function notice(text,error=false){const el=$('#labNotice');el.textContent=text;el.classList.toggle('lab-error',error);}
function stopPolling(){clearTimeout(pollTimer);pollTimer=null;controller?.abort();}
function schedulePoll(){clearTimeout(pollTimer);if(document.hidden||!$('#researchLabModal')?.classList.contains('show'))return;pollTimer=setTimeout(async()=>{await refresh();schedulePoll();},120000);}
async function refresh(){
 if(loading||!activeProject)return;loading=true;controller=new AbortController();
 try{const r=await fetch(path(),{headers:{...headers(),...(etag?{'if-none-match':etag}:{})},signal:controller.signal,cache:'no-store'});if(r.status===304)return;
  const data=await r.json();if(!r.ok)throw new Error(data.error==='lab_migration_required'?'연구실 준비가 아직 끝나지 않았습니다. 서버 업데이트 후 이용할 수 있습니다.':data.error||r.statusText);
  etag=r.headers.get('etag')||'';status=data;render();notice('연구실을 닫아도 서버에서 일정에 따라 자동 작업이 계속됩니다.');
 }catch(e){if(e.name!=='AbortError')notice(e.message,true);}finally{loading=false;}
}
function render(){
 const c=status.campaign;
 $('#labStartBtn').hidden=!!c;$('#labPauseBtn').hidden=!c||c.status==='completed';$('#labSettingsBtn').hidden=!c;
 $('#labPauseBtn').textContent=c?.status==='active'?'일시 중지':'다시 시작';
 $('#labCampaign').innerHTML=c?`<b>${esc(c.title)}</b><p>${esc(stateLabel[c.status]||c.status)} · 마감 ${esc(date(c.deadline_at))} (한국 시간)<br>완료 ${c.completed_tasks} / ${c.total_tasks} · 다음 작업 ${esc(date(c.next_run_at))}${c.last_error?`<br><span class="lab-error">${esc(c.last_error)}</span>`:''}</p>`:'<b>공공 지급결제 위임 가능 영역 연구</b><p>서버 자동 실행이 준비되면 10개 역할이 30회 연구 사이클을 수행합니다.</p>';
 $('#labProgressBar').style.width=(c?(c.cursor/c.total_tasks)*100:0)+'%';
 const roles=[...status.roles].sort((a,b)=>(a.id==='leader'?-1:b.id==='leader'?1:0));
 $('#labDesks').innerHTML=roles.map((r,i)=>{const t=r.activity,state=t?.status||'pending';return `<button class="lab-desk ${r.group} ${state==='running'?'working':''}" data-role="${r.id}" aria-label="${esc(r.name)} 책상"><span class="lab-seat"><span class="lab-person" style="--coat:${['#436eaa','#a76954','#51957a','#7775a9'][i%4]}"><i class="lab-hair"></i><i class="lab-face"></i><i class="lab-body"></i></span><span class="lab-monitor"><span>${state==='running'?'ANALYZING':state==='done'?'REVIEWED':'DCV LAB'}</span></span><span class="lab-table"></span></span><span class="lab-desk-name">${esc(r.name)}</span><small>${esc(r.title)}</small><span class="lab-badge ${state}">${esc(stateLabel[state]||state)}${t?' · Day '+t.day:''}</span>${r.id==='leader'?'<span class="lab-leader-note">최종 결과물 확인 ↗</span>':''}</button>`;}).join('');
 $('#labActivity').innerHTML=(status.activity||[]).map(t=>`<article><span>DAY ${t.day}</span><div><b>${esc(status.roles.find(r=>r.id===t.role_id)?.name||t.role_id)}</b><p>${esc(t.summary||t.error||'')}</p></div><small>${esc(date(t.completed_at))}</small></article>`).join('')||'<p>아직 실행된 작업이 없습니다. 활동 상태는 실제 서버 작업 기록에서 표시됩니다.</p>';
 if(c)fillSettings();
 if(selectedRole)void showDesk(selectedRole,false);
}
async function showDesk(id,loadReview=false){
 selectedRole=id;
 document.querySelectorAll('.lab-desk').forEach(e=>e.classList.toggle('selected',e.dataset.role===id));
 const role=status.roles.find(r=>r.id===id);$('#labDeskTitle').textContent=role.name+' · '+role.title;
 $('#labDeskContent').innerHTML=`<p>${esc(role.mission)}</p><div class="lab-desk-log">${esc(role.activity?.summary||role.activity?.error||'아직 실행된 작업이 없습니다.')}</div>`;
 if(id!=='leader')return;
 const pkg=status.package;
 $('#labDeskContent').insertAdjacentHTML('beforeend',pkg?`<div class="lab-delivery"><b>${esc(pkg.status==='INTERNAL_REVIEW_COMPLETE'?'내부 검토 완료':'보완이 필요한 초안 패키지')}</b><p>${(pkg.size_bytes/1024).toFixed(0)} KB · ${esc(date(pkg.created_at))}</p><button class="btn-future" id="labDownload">6종 결과물 ZIP 받기</button><button class="btn-ghost" id="labRebuild">설정 반영 후 ZIP 재생성</button><small>실제 저자 검토 후 투고 · 저널 게재승인 여부는 별도</small></div>`:'<div class="lab-delivery"><b>6종 결과물</b><p>10월 30일 마감 시 서버에 저장됩니다.<br>완료 전에는 아래 초안과 검토 항목을 확인할 수 있습니다.</p></div>');
 if(pkg){$('#labDownload').onclick=download;$('#labRebuild').onclick=()=>action('rebuild',{});}
 if(loadReview&&status.campaign){try{const r=await fetch(path('review'),{headers:headers(),cache:'no-store'});const data=await r.json();if(r.ok&&selectedRole==='leader'){$('#labReplayForm').elements.data_digest.value=data.data_digest||'';}if(r.ok&&selectedRole==='leader')$('#labDeskContent').insertAdjacentHTML('beforeend',`<h4>최종 검토 항목</h4><ul class="lab-blockers">${data.blockers.map(b=>'<li>'+esc(b)+'</li>').join('')}</ul>`);}catch(e){notice(e.message,true);}}
}
function fillSettings(){
 const form=$('#labConfigForm'),cfg=status.config;
 if(form.contains(document.activeElement))return;
 for(const key of ['target_journal','ethics_statement','funding','conflicts'])form.elements[key].value=cfg[key]||'';
 form.elements.title.value=status.campaign.title;
 form.elements.authors.value=(cfg.authors||[]).map(a=>[a.name,a.affiliation,a.email,a.corresponding?'corresponding':''].join(' | ')).join('\n');
 form.elements.full_text_verified_dois.value=(cfg.full_text_verified_dois||[]).join('\n');
 if(!$('#labJournalYears').children.length)$('#labJournalYears').innerHTML=cfg.metric_years.map(y=>`<fieldset data-year="${y}"><legend>${y} JCR 기준연도</legend><div class="lab-form-grid"><label>등재 구분<select name="edition_${y}" class="form-select"><option>SSCI</option><option>SCIE</option></select></label><label>Quartile<select name="quartile_${y}" class="form-select"><option value="">미확인</option><option>Q1</option><option>Q2</option><option>Q3</option><option>Q4</option></select></label><label>AIS<input name="ais_${y}" type="number" step="0.001" min="0" class="form-control"></label><label>Clarivate / Web of Science 자료 링크<input name="source_${y}" type="url" class="form-control" required></label></div></fieldset>`).join('');
}
async function action(name,data,method='POST'){
 try{const r=await fetch(path(name),{method,headers:{...headers(),'content-type':'application/json'},body:JSON.stringify(data)}),j=await r.json();if(!r.ok)throw new Error(j.error||r.statusText);etag='';await refresh();notice('저장되었습니다.');}catch(e){notice(e.message,true);}
}
async function saveConfig(e){e.preventDefault();const f=e.target.elements;const authors=f.authors.value.split('\n').filter(x=>x.trim()).map(line=>{const [name='',affiliation='',email='',corresponding='']=line.split('|').map(x=>x.trim());return {name,affiliation,email,corresponding:corresponding.toLowerCase()==='corresponding'};});await action('config',{target_journal:f.target_journal.value,authors,ethics_statement:f.ethics_statement.value,funding:f.funding.value,conflicts:f.conflicts.value,full_text_verified_dois:f.full_text_verified_dois.value.split('\n').map(x=>x.trim()).filter(Boolean)},'PUT');}
async function saveJournal(e){e.preventDefault();const f=e.target.elements,rows=status.config.metric_years.map(y=>({journal:f.journal.value,category:f.category.value,verified_by:f.verified_by.value,metric_year:y,edition:f['edition_'+y].value,quartile:f['quartile_'+y].value||null,ais:f['ais_'+y].value?Number(f['ais_'+y].value):null,source_url:f['source_'+y].value}));await action('journals',{rows});}
async function loadDocuments(){try{const r=await fetch(path('documents'),{headers:headers()}),j=await r.json();if(!r.ok)throw new Error(j.error);$('#labDocuments').innerHTML=j.documents.map(d=>`<details><summary>${esc(d.section)}</summary><pre>${esc(d.markdown)}</pre></details>`).join('')||'<p>아직 작성된 영문 초안이 없습니다.</p>';}catch(e){notice(e.message,true);}}
async function download(){try{const r=await fetch(path('download'),{headers:headers()});if(!r.ok)throw new Error((await r.json()).error);const url=URL.createObjectURL(await r.blob()),a=document.createElement('a');a.href=url;a.download='DCV_Submission_2026-10-30.zip';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}catch(e){notice(e.message,true);}}
$('#researchLabBtn')?.addEventListener('click',()=>{activeProject=window.DCV?.current();if(!activeProject){alert('먼저 연구 프로젝트를 선택하세요.');return;}ensureLab();window.DCV.modal('researchLabModal').show();});

async function saveReplay(e){e.preventDefault();const f=e.target.elements;await action('replication',{data_digest:f.data_digest.value,report_url:f.report_url.value,verified_by:f.verified_by.value,checks:{full_seed_replay:f.confirmed.checked,replayed_runs:Number(f.replayed_runs.value),max_absolute_error:Number(f.max_absolute_error.value),log_sha256:f.log_sha256.value}});}
