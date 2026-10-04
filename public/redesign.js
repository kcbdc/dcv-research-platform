const $=s=>document.querySelector(s);
$('#redesignBtn')?.addEventListener('click',()=>{
 if(!window.DCV?.current())return;
 if(!$('#redesignModal'))document.body.insertAdjacentHTML('beforeend',`<div class="modal fade" id="redesignModal" tabindex="-1"><div class="modal-dialog"><div class="modal-content"><div class="modal-header"><h5>τ·d 208개 후보 재설계</h5><button class="btn-close" data-bs-dismiss="modal" aria-label="닫기"></button></div><form id="redesignForm"><div class="modal-body"><p>기존 후보·결과를 보존하고 새 연구 주기를 시작합니다. 첨부한 208행 CSV를 선택하세요. 실행 중인 작업이 있으면 완료 후 적용할 수 있습니다.</p><input id="redesignFile" type="file" accept=".csv" class="form-control" required><p class="mt-3">손실·FN·FP의 비열등성 허용폭은 결과를 보기 전에 정해야 합니다. 아래 값은 입력 예시이며 현실성은 실제 저자가 정당화해야 합니다.</p><label><input id="useNoninferiority" type="checkbox"> 전량 검토 K0 대비 비열등성 제약 사용</label><div class="mt-2"><label>손실 상대 허용폭 δ<input id="niLoss" type="number" min="0" max="1" step="0.01" value="0.10" class="form-control"></label><label>FN 절대 허용폭<input id="niFn" type="number" min="0" max="1" step="0.001" value="0.01" class="form-control"></label><label>FP 절대 허용폭<input id="niFp" type="number" min="0" max="1" step="0.001" value="0.01" class="form-control"></label></div><p class="mt-3">K0/K1은 정의상 전량 검토 점검 후보입니다. 핵심 비교는 K2/K3 192행입니다. 참가자 30명 및 정답·오답 각 60건 기준은 유지합니다.</p><div id="redesignStatus" role="status"></div></div><div class="modal-footer"><button id="redesignSubmit" class="btn-future" type="submit">CSV 검증 후 새 연구 주기 시작</button></div></form></div></div></div>`);
 $('#redesignForm').onsubmit=async e=>{e.preventDefault();const button=$('#redesignSubmit');button.disabled=true;try{const file=$('#redesignFile').files[0];if(!file||file.size>150000)throw new Error('150KB 이하의 208행 CSV를 선택하세요.');const input={csv:await file.text()};if($('#useNoninferiority').checked)input.noninferiority={loss_relative_margin:Number($('#niLoss').value),fn_absolute_margin:Number($('#niFn').value),fp_absolute_margin:Number($('#niFp').value)};const r=await window.DCV.api(`/api/projects/${window.DCV.current()}/redesign`,{method:'POST',body:JSON.stringify(input)});$('#redesignStatus').textContent=`208개 후보를 예약했습니다. 새 연구 Cycle ${r.research_cycle} · Evidence r${r.evidence_revision}.`;window.DCV.toast('재설계가 저장되었습니다. 새 연구 주기로 실행합니다.');}catch(error){$('#redesignStatus').textContent=error.message;}finally{button.disabled=false;}};
 window.DCV.modal('redesignModal').show();
});


$('#balancedRedesignBtn')?.addEventListener('click',async()=>{
  const projectId=window.DCV?.current();
  if(!projectId)return;
  const ok=confirm('현재 후보·실행 기록은 보존하고 새 연구 Cycle에서 4개 추정기 × α 4수준 × W 3수준의 균형요인 설계(v2)를 시작합니다. 기존 인간실험 894건은 legacy_v1로 보존되며 주 분석에서는 제외됩니다. 계속할까요?');
  if(!ok)return;
  const button=$('#balancedRedesignBtn');button.disabled=true;
  try{
    const r=await window.DCV.api(`/api/projects/${projectId}/rebalance-v2`,{method:'POST',body:'{}'});
    window.DCV.toast(`균형설계 v2 적용: 연구 Cycle ${r.research_cycle} · Evidence r${r.evidence_revision}`);
    setTimeout(()=>location.reload(),700);
  }catch(error){
    window.DCV.toast(error.message||'균형설계 적용에 실패했습니다.');
  }finally{button.disabled=false;}
});
