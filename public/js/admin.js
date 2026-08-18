/* =====================================================================
   관리자 화면
   ===================================================================== */
(function () {
  'use strict';
  const { api, toast, esc, fmtDateTime, statusBadge, openPrint, downloadReport, $, $$ } = window.WR;

  const state = { me: null, orgs: [], tab: 'status' };
  const body = () => $('#tab-body');

  async function init() {
    try {
      const me = await api.get('/api/auth/me');
      state.me = me.user;
    } catch (e) { return; }

    if (state.me.role !== 'ADMIN') { location.href = '/report'; return; }

    $('#topbar').innerHTML = window.WR.renderTopbar(state.me, 'admin');
    window.WR.bindTopbar();

    $$('#admin-tabs button').forEach((b) => {
      b.onclick = () => {
        $$('#admin-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        state.tab = b.dataset.tab;
        render();
      };
    });
    render();
    refreshPendingBadge();
  }

  /** 가입 승인 탭에 대기건수 배지를 표시 */
  async function refreshPendingBadge() {
    try {
      const res = await api.get('/api/admin/approvals');
      const n = res.pending.signups + res.pending.resets;
      const el = $('#cnt-approvals');
      el.textContent = n;
      el.classList.toggle('hidden', n === 0);
    } catch (e) { /* 배지는 실패해도 무시 */ }
  }

  function render() {
    body().innerHTML = '<div class="empty">불러오는 중...</div>';
    const fn = {
      status: renderStatus,
      matrix: renderMatrix,
      orgs: renderOrgs,
      approvals: renderApprovals,
      users: renderUsers,
      weeks: renderWeeks,
      audit: renderAudit,
    }[state.tab];
    Promise.resolve().then(fn).catch((e) => {
      body().innerHTML = `<div class="alert error">불러오지 못했습니다: ${esc(e.message)}</div>`;
    });
  }

  // ==================================================================
  // 1. 등록 현황 (특정 주차)
  // ==================================================================
  async function renderStatus(weekId) {
    const [weeksRes, statusRes] = await Promise.all([
      api.get('/api/weeks?limit=60'),
      api.get('/api/admin/status' + (weekId ? `?week_id=${weekId}` : '')),
    ]);
    const { week, rows, summary } = statusRes;

    if (!week) { body().innerHTML = '<div class="empty">등록된 주차가 없습니다.</div>'; return; }

    const pct = summary.total ? Math.round((summary.submitted / summary.total) * 100) : 0;

    body().innerHTML = `
      <div class="row">
        <label class="field" style="flex:2 1 320px">
          <span>보고 주차</span>
          <select id="st-week">
            ${weeksRes.weeks.map((w) =>
              `<option value="${w.id}" ${w.id === week.id ? 'selected' : ''}>${esc(w.label)}${w.is_open ? '' : ' [마감]'}</option>`).join('')}
          </select>
        </label>
        <div class="field narrow">
          <span style="display:block;height:0;overflow:hidden">&nbsp;</span>
          <button class="btn" id="st-refresh">새로고침</button>
        </div>
      </div>

      <div class="stat-row mt8">
        <div class="stat"><div class="k">대상 작성자</div><div class="v">${summary.total}</div></div>
        <div class="stat ok"><div class="k">제출완료</div><div class="v">${summary.submitted}</div></div>
        <div class="stat warn"><div class="k">임시저장</div><div class="v">${summary.draft}</div></div>
        <div class="stat bad"><div class="k">미등록</div><div class="v">${summary.none}</div></div>
        <div class="stat"><div class="k">제출률</div><div class="v">${pct}%</div></div>
      </div>

      <div class="table-scroll mt16">
        <table class="grid">
          <thead>
            <tr>
              <th style="width:220px">기관</th>
              <th class="center" style="width:100px">상태</th>
              <th class="center" style="width:70px">업무</th>
              <th class="center" style="width:70px">첨부</th>
              <th style="width:110px">작성자</th>
              <th style="width:150px">최종수정</th>
              <th style="width:150px">제출시각</th>
              <th class="center" style="width:270px">관리</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td><b>${esc(r.org_name)}</b></td>
                <td class="center">${statusBadge(r.status)}</td>
                <td class="center">${r.item_count}</td>
                <td class="center">${r.file_count}</td>
                <td>${r.report_id ? esc(r.author_name || r.user_name || '-') : '-'}</td>
                <td class="small">${r.report_id ? fmtDateTime(r.updated_at) : '-'}</td>
                <td class="small">${r.submitted_at ? fmtDateTime(r.submitted_at) : '-'}</td>
                <td class="center nowrap">
                  ${r.report_id ? `
                    <button class="btn sm" data-open="${r.report_id}">열기</button>
                    <button class="btn sm" data-print="${r.report_id}">인쇄</button>
                    <button class="btn sm" data-export="${r.report_id}"
                      title="한글문서(HWP) 변환은 현재 [Word 다운로드] 하신 후 한글에서 Word문서를 열어서 다른 이름(확장자 .hwp)으로 저장하시기 바랍니다.">Word</button>
                    <button class="btn sm" data-moveorg="${r.report_id}"
                      title="잘못된 기관으로 등록된 보고서를 올바른 기관으로 옮깁니다 (업무·첨부는 그대로 유지)">소속변경</button>` : '<span class="muted small">-</span>'}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    $('#st-week').onchange = () => renderStatus(Number($('#st-week').value));
    $('#st-refresh').onclick = () => renderStatus(Number($('#st-week').value));
    bindOpenPrint();
  }

  function bindOpenPrint() {
    body().querySelectorAll('[data-open]').forEach((b) => {
      b.onclick = () => { location.href = `/report?report=${b.dataset.open}`; };
    });
    body().querySelectorAll('[data-print]').forEach((b) => {
      b.onclick = () => openPrint(b.dataset.print);
    });
    body().querySelectorAll('[data-export]').forEach((b) => {
      b.onclick = () => downloadReport(b.dataset.export);
    });
    body().querySelectorAll('[data-moveorg]').forEach((b) => {
      b.onclick = () => moveReportOrg(Number(b.dataset.moveorg));
    });
  }

  /** 보고서를 다른 기관으로 옮긴다 (소속을 잘못 지정해 등록한 경우) */
  async function moveReportOrg(reportId) {
    let orgs;
    try { orgs = await api.get('/api/orgs'); } catch (e) { return toast(e.message, true); }

    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal" style="max-width:400px">
        <header>보고서 소속 변경</header>
        <div class="body">
          <div class="alert error hidden" id="mo-err"></div>
          <p class="small muted">잘못된 기관으로 등록된 보고서를 바로잡는 기능입니다.<br>
            업무·첨부는 그대로 유지되고 <b>기관만</b> 바뀝니다.</p>
          <label class="field"><span>옮길 기관</span>
            <select id="mo-org">
              ${orgs.orgs.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}
            </select>
          </label>
        </div>
        <footer>
          <button class="btn" id="mo-cancel">취소</button>
          <button class="btn primary" id="mo-ok">옮기기</button>
        </footer>
      </div>`;
    document.body.appendChild(back);

    const close = () => back.remove();
    back.querySelector('#mo-cancel').onclick = close;
    back.addEventListener('click', (e) => { if (e.target === back) close(); });

    back.querySelector('#mo-ok').onclick = async () => {
      try {
        const res = await api.put(`/api/admin/reports/${reportId}/org`,
          { org_id: Number(back.querySelector('#mo-org').value) });
        close();
        toast(`"${res.org_name}" 으로 옮겼습니다.`);
        render();
      } catch (e) {
        const el = back.querySelector('#mo-err');
        el.textContent = e.message; el.classList.remove('hidden');
      }
    };
  }

  // ==================================================================
  // 2. 주차별 현황판 (매트릭스)
  // ==================================================================
  async function renderMatrix(n) {
    const weeks = n || 8;
    const res = await api.get(`/api/admin/overview?weeks=${weeks}`);

    if (!res.weeks.length) { body().innerHTML = '<div class="empty">데이터가 없습니다.</div>'; return; }

    const cellHtml = (c) => {
      if (!c || !Number(c.total_users)) return '<td class="cell-n">·</td>';

      const total = Number(c.total_users) || 0;
      const submitted = Number(c.submitted) || 0;
      const draft = Number(c.draft) || 0;
      const none = Number(c.none_cnt) || 0;

      if (submitted === total) {
        return `<td class="cell-s" title="제출완료 ${submitted}명 / 대상 ${total}명"><b>완료</b><br><span class="small">${submitted}/${total}명</span></td>`;
      }
      if (draft > 0 || submitted > 0) {
        return `<td class="cell-d" title="완료 ${submitted}명 · 임시저장 ${draft}명 · 미등록 ${none}명"><b>진행중</b><br><span class="small">완료 ${submitted} · 임시 ${draft} · 미등록 ${none}</span></td>`;
      }
      return `<td class="cell-n" title="미등록 ${none}명 / 대상 ${total}명">미등록<br><span class="small">${none}/${total}명</span></td>`;
    };

    body().innerHTML = `
      <div class="row">
        <label class="field narrow" style="flex:0 0 180px">
          <span>표시 주차 수</span>
          <select id="mx-n">
            ${[4, 8, 12, 16, 26].map((k) => `<option value="${k}" ${k === weeks ? 'selected' : ''}>최근 ${k}주</option>`).join('')}
          </select>
        </label>
      </div>
      <p class="small muted">기관별 작성 대상 인원의 제출 상태입니다.
        &nbsp;<span class="badge submitted">완료</span> 전원 제출완료
        &nbsp;<span class="badge draft">진행중</span> 일부 제출 또는 임시저장
        &nbsp;<span class="badge none">미등록</span> 등록 없음</p>
      <div class="table-scroll mt8">
        <table class="matrix">
          <thead>
            <tr>
              <th class="org">기관</th>
              ${res.weeks.map((w) => `<th>${esc(w.label.replace(/^\d+년\s*/, '')).replace(/주차\s*/, '주<br>')}</th>`).join('')}
              <th>제출률</th>
            </tr>
          </thead>
          <tbody>
            ${res.orgs.map((o) => {
              const cells = res.weeks.map((w) => res.cells[`${w.id}:${o.id}`]);
              const target = cells.reduce((sum, c) => sum + (Number(c?.total_users) || 0), 0);
              const done = cells.reduce((sum, c) => sum + (Number(c?.submitted) || 0), 0);
              const rate = target ? Math.round((done / target) * 100) : 0;
              return `<tr>
                <th class="org">${esc(o.name)}</th>
                ${cells.map(cellHtml).join('')}
                <td><b>${rate}%</b></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;

    $('#mx-n').onchange = () => renderMatrix(Number($('#mx-n').value));
  }

  // ==================================================================
  // 3. 기관 관리
  // ==================================================================
  async function renderOrgs() {
    const res = await api.get('/api/admin/orgs');
    state.orgs = res.orgs;

    body().innerHTML = `
      <div class="row">
        <label class="field" style="flex:2 1 260px"><span>기관명</span><input type="text" id="o-name" placeholder="예) ㈜비아이매트릭스"></label>
        <label class="field narrow" style="flex:0 0 120px"><span>정렬순서</span><input type="number" id="o-sort" value="0"></label>
        <div class="field narrow">
          <span style="display:block;height:0;overflow:hidden">&nbsp;</span>
          <button class="btn primary" id="o-add">기관 추가</button>
        </div>
      </div>

      <div class="table-scroll mt8">
        <table class="grid">
          <thead><tr>
            <th style="width:60px" class="center">순서</th><th>기관명</th>
            <th class="center" style="width:90px">사용자</th><th class="center" style="width:90px">보고서</th>
            <th class="center" style="width:90px">사용여부</th><th class="center" style="width:200px">관리</th>
          </tr></thead>
          <tbody>
            ${res.orgs.map((o) => `
              <tr data-id="${o.id}">
                <td class="center">${o.sort_order}</td>
                <td><b>${esc(o.name)}</b></td>
                <td class="center">${o.user_count}</td>
                <td class="center">${o.report_count}</td>
                <td class="center">${o.is_active ? '<span class="badge submitted">사용</span>' : '<span class="badge none">중지</span>'}</td>
                <td class="center nowrap">
                  <button class="btn sm" data-edit="${o.id}">수정</button>
                  <button class="btn sm" data-toggle="${o.id}">${o.is_active ? '사용중지' : '사용'}</button>
                  <button class="btn sm danger" data-del="${o.id}">삭제</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    $('#o-add').onclick = async () => {
      const name = $('#o-name').value.trim();
      if (!name) return toast('기관명을 입력하세요.', true);
      try {
        await api.post('/api/admin/orgs', { name, sort_order: Number($('#o-sort').value) || 0 });
        toast('추가되었습니다.'); renderOrgs();
      } catch (e) { toast(e.message, true); }
    };

    body().querySelectorAll('[data-edit]').forEach((b) => {
      b.onclick = async () => {
        const o = res.orgs.find((x) => x.id === Number(b.dataset.edit));
        const name = prompt('기관명', o.name);
        if (name === null) return;
        const sort = prompt('정렬순서', o.sort_order);
        if (sort === null) return;
        try {
          await api.put(`/api/admin/orgs/${o.id}`, { name: name.trim(), sort_order: Number(sort) || 0 });
          toast('수정되었습니다.'); renderOrgs();
        } catch (e) { toast(e.message, true); }
      };
    });

    body().querySelectorAll('[data-toggle]').forEach((b) => {
      b.onclick = async () => {
        const o = res.orgs.find((x) => x.id === Number(b.dataset.toggle));
        try {
          await api.put(`/api/admin/orgs/${o.id}`, { is_active: !o.is_active });
          renderOrgs();
        } catch (e) { toast(e.message, true); }
      };
    });

    body().querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('이 기관을 삭제할까요?')) return;
        try {
          await api.del(`/api/admin/orgs/${b.dataset.del}`);
          toast('삭제되었습니다.'); renderOrgs();
        } catch (e) { toast(e.message, true); }
      };
    });
  }

  // ==================================================================
  // 3-2. 가입 승인 / 비밀번호 재설정 요청
  // ==================================================================
  async function renderApprovals() {
    const [res, orgsRes] = await Promise.all([
      api.get('/api/admin/approvals'),
      api.get('/api/orgs'),
    ]);
    const pendingSignups = res.signups.filter((s) => s.approval_status === 'PENDING');
    const rejected = res.signups.filter((s) => s.approval_status === 'REJECTED');

    body().innerHTML = `
      <div class="stat-row">
        <div class="stat bad"><div class="k">가입 승인 대기</div><div class="v">${pendingSignups.length}</div></div>
        <div class="stat warn"><div class="k">비밀번호 재설정 요청</div><div class="v">${res.resets.length}</div></div>
        <div class="stat"><div class="k">반려된 신청</div><div class="v">${rejected.length}</div></div>
      </div>

      <h3 class="sec-title">가입 승인 대기</h3>
      <p class="small muted">현재 <b>자동 승인</b>이 켜져 있으면 신규 가입자는 대기 없이 바로 사용합니다.
        승인제로 바꾸려면 서버 <code>.env</code> 의 <code>SIGNUP_AUTO_APPROVE=false</code> 로 설정 후 재기동하세요.</p>
      <div class="table-scroll">
        <table class="grid">
          <thead><tr>
            <th style="width:130px">아이디</th><th style="width:100px">이름</th>
            <th style="width:190px">이메일</th><th style="width:130px">연락처</th>
            <th style="width:170px">신청 기관</th><th>담당 업무</th>
            <th style="width:140px">신청일시</th><th class="center" style="width:170px">처리</th>
          </tr></thead>
          <tbody>
            ${pendingSignups.length ? pendingSignups.map((u) => `
              <tr>
                <td><b>${esc(u.username)}</b></td>
                <td>${esc(u.name)}</td>
                <td class="small">${esc(u.email || '-')}</td>
                <td class="small">${esc(u.phone || '-')}</td>
                <td>
                  <select data-org-for="${u.id}" style="font-size:12.5px;padding:4px 6px">
                    ${orgsRes.orgs.map((o) => `<option value="${o.id}" ${o.id === u.org_id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
                  </select>
                </td>
                <td class="small">${esc(u.signup_note || '-')}</td>
                <td class="small">${fmtDateTime(u.created_at)}</td>
                <td class="center nowrap">
                  <button class="btn sm primary" data-approve="${u.id}">승인</button>
                  <button class="btn sm danger" data-reject="${u.id}">반려</button>
                </td>
              </tr>`).join('') : '<tr><td colspan="8" class="empty">대기 중인 가입 신청이 없습니다.</td></tr>'}
          </tbody>
        </table>
      </div>

      <h3 class="sec-title">비밀번호 재설정 요청</h3>
      <p class="small muted">메일 서버가 없어 자동 발송이 불가합니다. 임시 비밀번호를 발급한 뒤 신청자에게 직접 전달하세요.
        (신청자는 첫 로그인 시 비밀번호 변경 안내를 받습니다)</p>
      <div class="table-scroll">
        <table class="grid">
          <thead><tr>
            <th style="width:130px">아이디</th><th style="width:100px">이름</th>
            <th style="width:190px">이메일</th><th style="width:170px">기관</th>
            <th style="width:140px">요청일시</th><th style="width:130px">요청 IP</th>
            <th class="center" style="width:210px">처리</th>
          </tr></thead>
          <tbody>
            ${res.resets.length ? res.resets.map((r) => `
              <tr>
                <td><b>${esc(r.username)}</b></td>
                <td>${esc(r.name)}</td>
                <td class="small">${esc(r.email || '-')}</td>
                <td>${esc(r.org_name || '-')}</td>
                <td class="small">${fmtDateTime(r.created_at)}</td>
                <td class="small muted">${esc(r.requested_ip || '-')}</td>
                <td class="center nowrap">
                  <button class="btn sm primary" data-issue="${r.id}">임시 비밀번호 발급</button>
                  <button class="btn sm danger" data-rreject="${r.id}">반려</button>
                </td>
              </tr>`).join('') : '<tr><td colspan="7" class="empty">대기 중인 요청이 없습니다.</td></tr>'}
          </tbody>
        </table>
      </div>

      ${rejected.length ? `
        <h3 class="sec-title">반려된 신청</h3>
        <div class="table-scroll">
          <table class="grid">
            <thead><tr><th style="width:130px">아이디</th><th style="width:100px">이름</th>
              <th style="width:190px">이메일</th><th style="width:140px">신청일시</th>
              <th class="center" style="width:170px">처리</th></tr></thead>
            <tbody>
              ${rejected.map((u) => `
                <tr>
                  <td>${esc(u.username)}</td><td>${esc(u.name)}</td>
                  <td class="small">${esc(u.email || '-')}</td>
                  <td class="small">${fmtDateTime(u.created_at)}</td>
                  <td class="center"><button class="btn sm" data-approve="${u.id}">승인으로 변경</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}`;

    // ---- 가입 승인 / 반려 ----
    body().querySelectorAll('[data-approve]').forEach((b) => {
      b.onclick = async () => {
        const id = Number(b.dataset.approve);
        const sel = body().querySelector(`[data-org-for="${id}"]`);
        try {
          await api.post(`/api/admin/users/${id}/approval`, {
            approve: true,
            org_id: sel ? Number(sel.value) : null,
          });
          toast('승인되었습니다. 이제 로그인할 수 있습니다.');
          renderApprovals(); refreshPendingBadge();
        } catch (e) { toast(e.message, true); }
      };
    });

    body().querySelectorAll('[data-reject]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('이 가입 신청을 반려할까요?\n신청자는 로그인할 수 없게 됩니다.')) return;
        try {
          await api.post(`/api/admin/users/${b.dataset.reject}/approval`, { approve: false });
          toast('반려되었습니다.');
          renderApprovals(); refreshPendingBadge();
        } catch (e) { toast(e.message, true); }
      };
    });

    // ---- 비밀번호 재설정 처리 ----
    body().querySelectorAll('[data-issue]').forEach((b) => {
      b.onclick = async () => {
        const pw = prompt('발급할 임시 비밀번호를 입력하세요 (8자 이상).\n발급 후 신청자에게 직접 전달하세요.', randomPw());
        if (!pw) return;
        try {
          const r = await api.post(`/api/admin/reset-requests/${b.dataset.issue}`, { password: pw });
          alert(`"${r.username}" 계정의 임시 비밀번호가 설정되었습니다.\n\n    ${pw}\n\n신청자에게 전달하세요. 첫 로그인 시 변경 안내가 표시됩니다.`);
          renderApprovals(); refreshPendingBadge();
        } catch (e) { toast(e.message, true); }
      };
    });

    body().querySelectorAll('[data-rreject]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('이 재설정 요청을 반려할까요?')) return;
        try {
          await api.post(`/api/admin/reset-requests/${b.dataset.rreject}`, { reject: true });
          toast('반려되었습니다.');
          renderApprovals(); refreshPendingBadge();
        } catch (e) { toast(e.message, true); }
      };
    });
  }

  /** 임시 비밀번호 후보 생성 (관리자가 그대로 쓰거나 고쳐 쓸 수 있게) */
  function randomPw() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const buf = new Uint32Array(12);
    crypto.getRandomValues(buf);
    return Array.from(buf, (n) => chars[n % chars.length]).join('');
  }

  // ==================================================================
  // 4. 사용자 관리
  // ==================================================================
  async function renderUsers() {
    const [usersRes, orgsRes] = await Promise.all([api.get('/api/admin/users'), api.get('/api/orgs')]);
    const orgOpts = orgsRes.orgs.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('');

    body().innerHTML = `
      <div class="row">
        <label class="field" style="flex:1 1 140px"><span>아이디</span><input type="text" id="u-username" placeholder="영문/숫자"></label>
        <label class="field" style="flex:1 1 120px"><span>이름</span><input type="text" id="u-name"></label>
        <label class="field" style="flex:1 1 160px"><span>초기 비밀번호</span><input type="text" id="u-pw" placeholder="8자 이상"></label>
        <label class="field" style="flex:1 1 160px"><span>소속 기관</span><select id="u-org">${orgOpts}</select></label>
        <label class="field narrow" style="flex:0 0 120px"><span>권한</span>
          <select id="u-role"><option value="USER">작성자</option><option value="ADMIN">관리자</option></select>
        </label>
        <div class="field narrow">
          <span style="display:block;height:0;overflow:hidden">&nbsp;</span>
          <button class="btn primary" id="u-add">사용자 추가</button>
        </div>
      </div>
      <p class="small muted">추가된 계정은 최초 로그인 시 비밀번호 변경 안내가 표시됩니다.</p>

      <div class="table-scroll mt8">
        <table class="grid">
          <thead><tr>
            <th style="width:130px">아이디</th><th style="width:110px">이름</th>
            <th style="width:180px">소속 기관</th><th class="center" style="width:80px">권한</th>
            <th class="center" style="width:80px">상태</th><th style="width:150px">최근 로그인</th>
            <th class="center" style="width:230px">관리</th>
          </tr></thead>
          <tbody>
            ${usersRes.users.map((u) => `
              <tr>
                <td><b>${esc(u.username)}</b></td>
                <td>${esc(u.name)}</td>
                <td>${esc(u.org_name || '-')}</td>
                <td class="center">${u.role === 'ADMIN' ? '<span class="badge draft">관리자</span>' : '<span class="badge none">작성자</span>'}</td>
                <td class="center">${
                  u.approval_status === 'PENDING'  ? '<span class="badge draft">승인대기</span>' :
                  u.approval_status === 'REJECTED' ? '<span class="badge closed">반려</span>'   :
                  u.is_active ? '<span class="badge submitted">활성</span>' : '<span class="badge closed">중지</span>'
                }</td>
                <td class="small">${fmtDateTime(u.last_login_at)}</td>
                <td class="center nowrap">
                  <button class="btn sm" data-uedit="${u.id}">수정</button>
                  <button class="btn sm" data-upw="${u.id}">비밀번호</button>
                  <button class="btn sm" data-utoggle="${u.id}">${u.is_active ? '중지' : '활성'}</button>
                  <button class="btn sm danger" data-udel="${u.id}">삭제</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    $('#u-add').onclick = async () => {
      try {
        await api.post('/api/admin/users', {
          username: $('#u-username').value.trim(),
          name: $('#u-name').value.trim(),
          password: $('#u-pw').value,
          org_id: $('#u-role').value === 'ADMIN' ? ($('#u-org').value || null) : $('#u-org').value,
          role: $('#u-role').value,
        });
        toast('사용자가 추가되었습니다.');
        renderUsers();
      } catch (e) { toast(e.message, true); }
    };

    const find = (id) => usersRes.users.find((x) => x.id === Number(id));

    body().querySelectorAll('[data-uedit]').forEach((b) => {
      b.onclick = () => openUserEdit(find(b.dataset.uedit), orgsRes.orgs);
    });

    body().querySelectorAll('[data-upw]').forEach((b) => {
      b.onclick = async () => {
        const u = find(b.dataset.upw);
        const pw = prompt(`"${u.username}" 계정의 새 비밀번호를 입력하세요 (8자 이상)`);
        if (!pw) return;
        try {
          await api.post(`/api/admin/users/${u.id}/password`, { password: pw });
          toast('비밀번호가 초기화되었습니다.');
        } catch (e) { toast(e.message, true); }
      };
    });

    body().querySelectorAll('[data-utoggle]').forEach((b) => {
      b.onclick = async () => {
        const u = find(b.dataset.utoggle);
        try {
          await api.put(`/api/admin/users/${u.id}`, { is_active: !u.is_active });
          renderUsers();
        } catch (e) { toast(e.message, true); }
      };
    });

    body().querySelectorAll('[data-udel]').forEach((b) => {
      b.onclick = async () => {
        const u = find(b.dataset.udel);
        if (!confirm(`"${u.username}" 계정을 삭제할까요?`)) return;
        try {
          await api.del(`/api/admin/users/${u.id}`);
          toast('삭제되었습니다.'); renderUsers();
        } catch (e) { toast(e.message, true); }
      };
    });
  }

  function openUserEdit(u, orgs) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal">
        <header>사용자 수정 · ${esc(u.username)}</header>
        <div class="body">
          <label class="field"><span>이름</span><input type="text" id="e-name" value="${esc(u.name)}"></label>
          <label class="field"><span>이메일</span><input type="email" id="e-email" value="${esc(u.email || '')}"></label>
          <label class="field"><span>소속 기관</span>
            <select id="e-org">
              <option value="">(없음)</option>
              ${orgs.map((o) => `<option value="${o.id}" ${o.id === u.org_id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
            </select>
          </label>
          <label class="field"><span>권한</span>
            <select id="e-role">
              <option value="USER"  ${u.role === 'USER' ? 'selected' : ''}>작성자</option>
              <option value="ADMIN" ${u.role === 'ADMIN' ? 'selected' : ''}>관리자</option>
            </select>
          </label>
        </div>
        <footer>
          <button class="btn" id="e-cancel">취소</button>
          <button class="btn primary" id="e-ok">저장</button>
        </footer>
      </div>`;
    document.body.appendChild(back);

    const close = () => back.remove();
    $('#e-cancel', back).onclick = close;
    back.addEventListener('click', (e) => { if (e.target === back) close(); });

    $('#e-ok', back).onclick = async () => {
      try {
        await api.put(`/api/admin/users/${u.id}`, {
          name: $('#e-name', back).value.trim(),
          email: $('#e-email', back).value.trim() || null,
          org_id: $('#e-org', back).value ? Number($('#e-org', back).value) : null,
          role: $('#e-role', back).value,
        });
        close(); toast('저장되었습니다.'); renderUsers();
      } catch (e) { toast(e.message, true); }
    };
  }

  // ==================================================================
  // 5. 주차 / 마감 관리
  // ==================================================================
  async function renderWeeks() {
    const res = await api.get('/api/admin/weeks');
    body().innerHTML = `
      <p class="small muted">주차를 <b>마감</b>하면 해당 주차의 보고서는 일반 사용자가 등록·수정할 수 없습니다. (관리자는 계속 수정 가능)</p>
      <div class="table-scroll mt8">
        <table class="grid">
          <thead><tr>
            <th style="width:280px">주차</th><th style="width:120px">시작</th><th style="width:120px">종료</th>
            <th class="center" style="width:100px">등록건수</th><th class="center" style="width:100px">상태</th>
            <th class="center" style="width:120px">관리</th>
          </tr></thead>
          <tbody>
            ${res.weeks.map((w) => `
              <tr>
                <td><b>${esc(w.label)}</b></td>
                <td class="small">${w.start_date}</td>
                <td class="small">${w.end_date}</td>
                <td class="center">${w.report_count}</td>
                <td class="center">${w.is_open ? '<span class="badge submitted">진행중</span>' : '<span class="badge closed">마감</span>'}</td>
                <td class="center"><button class="btn sm" data-w="${w.id}" data-open="${w.is_open}">${w.is_open ? '마감하기' : '마감해제'}</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    body().querySelectorAll('[data-w]').forEach((b) => {
      b.onclick = async () => {
        try {
          await api.put(`/api/admin/weeks/${b.dataset.w}`, { is_open: b.dataset.open !== 'true' });
          renderWeeks();
        } catch (e) { toast(e.message, true); }
      };
    });
  }

  // ==================================================================
  // 6. 활동 로그
  // ==================================================================
  async function renderAudit() {
    const res = await api.get('/api/admin/audit?limit=200');
    body().innerHTML = `
      <div class="table-scroll">
        <table class="grid">
          <thead><tr>
            <th style="width:150px">일시</th><th style="width:120px">사용자</th>
            <th style="width:160px">동작</th><th>내용</th><th style="width:130px">IP</th>
          </tr></thead>
          <tbody>
            ${res.logs.length ? res.logs.map((l) => `
              <tr>
                <td class="small">${fmtDateTime(l.created_at)}</td>
                <td>${esc(l.username || '-')}</td>
                <td class="small">${esc(l.action)}</td>
                <td class="small">${esc(l.detail || '')}${l.target_id ? ` <span class="muted">#${l.target_id}</span>` : ''}</td>
                <td class="small muted">${esc(l.ip || '-')}</td>
              </tr>`).join('') : '<tr><td colspan="5" class="empty">기록이 없습니다.</td></tr>'}
          </tbody>
        </table>
      </div>`;
  }

  init();
})();
