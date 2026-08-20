/* =====================================================================
   관리자 화면
   ===================================================================== */
(function () {
  'use strict';
  const { api, toast, esc, fmtDateTime, statusBadge, $, $$ } = window.WR;

  const state = { me: null, orgs: [], tab: 'status' };

  /** 담당 역할 표기 */
  const PAGE_SIZE = 10;                  // 목록 한 쪽에 보여 줄 건수
  const page = { status: 1, users: 1, audit: 1 };   // 화면별 현재 쪽

  /** 배열에서 현재 쪽에 해당하는 부분만 잘라 낸다 */
  function slicePage(rows, which) {
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (page[which] > pages) page[which] = pages;
    const from = (page[which] - 1) * PAGE_SIZE;
    return { part: rows.slice(from, from + PAGE_SIZE), pages };
  }

  const DUTY_LABEL = { LEAD: '총괄책임자', MANAGER: '실무책임자', RESEARCHER: '참여연구원' };
  // 담당 역할은 반드시 선택해야 한다. 빈 항목은 고르라는 안내일 뿐 저장되지 않는다.
  const dutyOptions = (sel) => ['', 'LEAD', 'MANAGER', 'RESEARCHER']
    .map((v) => `<option value="${v}" ${sel === v || (!sel && !v) ? 'selected' : ''}>${
      v ? DUTY_LABEL[v] : '선택하세요'}</option>`).join('');
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
  }

  function render() {
    body().innerHTML = '<div class="empty">불러오는 중...</div>';
    const fn = {
      status: renderStatus,
      matrix: renderMatrix,
      users: renderUsers,
      audit: renderAudit,
    }[state.tab];
    Promise.resolve().then(fn).catch((e) => {
      body().innerHTML = `<div class="alert error">불러오지 못했습니다: ${esc(e.message)}</div>`;
    });
  }

  // ==================================================================
  // 1. 등록 현황 (특정 주차)
  // ==================================================================
  async function renderStatus(weekId, filters) {
    const f = filters || {};
    const q = new URLSearchParams();
    if (weekId) q.set('week_id', weekId);
    if (f.org) q.set('org_id', f.org);
    if (f.status) q.set('status', f.status);
    if (f.q) q.set('q', f.q);

    const [weeksRes, orgsRes, statusRes] = await Promise.all([
      api.get('/api/weeks?limit=60'),
      api.get('/api/orgs'),
      api.get('/api/admin/status' + (q.toString() ? `?${q}` : '')),
    ]);
    const { week, rows, summary, byOrg, scopedOrgId } = statusRes;
    if (!week) { body().innerHTML = '<div class="empty">등록된 주차가 없습니다.</div>'; return; }

    const orgLocked = !!scopedOrgId && state.me.role === 'ORG_ADMIN';

    const { part: stRows, pages: stPages } = slicePage(rows, 'status');

    body().innerHTML = `
      <p class="small muted">선택한 주차에 <b>가입한 작성자 전원</b>이 나옵니다. 아직 안 낸 사람도 <b>미등록</b> 으로 표시됩니다.</p>
      <div class="search-bar">
        <label class="sb-field sb-week" style="flex:1 1 300px">
          <span>보고 주차</span>
          <select id="st-week">
            ${weeksRes.weeks.map((w) =>
              `<option value="${w.id}" ${w.id === week.id ? 'selected' : ''}>${esc(w.label)}</option>`).join('')}
          </select>
        </label>
        <button class="btn primary sb-btn" id="st-refresh">조회</button>

        <label class="sb-field" style="flex:0 0 140px">
          <span>상태</span>
          <select id="st-status">
            <option value="">전체</option>
            <option value="NONE"      ${f.status === 'NONE' ? 'selected' : ''}>미등록만</option>
            <option value="SUBMITTED" ${f.status === 'SUBMITTED' ? 'selected' : ''}>제출완료만</option>
          </select>
        </label>
        <label class="sb-field" style="flex:0 0 160px">
          <span>이름 검색</span>
          <input type="text" id="st-q" value="${esc(f.q || '')}" placeholder="예: 홍길동">
        </label>

        <!-- 기관은 작성 화면과 동일하게 오른쪽 끝에 배치 -->
        <label class="sb-field sb-right" style="flex:0 0 auto">
          <span>기관</span>
          <select id="st-org" ${orgLocked ? 'disabled' : ''}>
            <option value="">전체</option>
            ${orgsRes.orgs.map((o) =>
              `<option value="${o.id}" ${String(f.org) === String(o.id) || scopedOrgId === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
          </select>
        </label>
      </div>

      <div class="stat-row mt8">
        <div class="stat"><div class="k">대상 인원</div><div class="v">${summary.total}</div></div>
        <div class="stat ok"><div class="k">제출완료</div><div class="v">${summary.submitted}</div></div>
        <div class="stat bad"><div class="k">미등록</div><div class="v">${summary.none}</div></div>
        <div class="stat"><div class="k">제출률</div><div class="v">${summary.rate}%</div></div>
      </div>

      ${byOrg.length ? `
      <h3 class="sec-title">기관별 소계</h3>
      <div class="table-scroll">
        <table class="grid fixed">
          <thead><tr><th>기관</th><th class="center" style="width:14%">대상</th>
            <th class="center" style="width:14%">제출</th>
            <th class="center" style="width:14%">미등록</th><th class="center" style="width:14%">제출률</th></tr></thead>
          <tbody>
            ${byOrg.map((o) => `
              <tr>
                <td><b>${esc(o.org_name || '(소속없음)')}</b></td>
                <td class="center">${o.total_users}</td>
                <td class="center">${o.submitted}</td>
                <td class="center">${o.none_cnt}</td>
                <td class="center"><b>${o.total_users ? Math.round((o.submitted / o.total_users) * 100) : 0}%</b></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : ''}

      <h3 class="sec-title">작성자 제출 현황 (${rows.length}명)</h3>
      <div class="table-scroll">
        <table class="grid fixed">
          <thead>
            <tr>
              <th style="width:18%">기관</th>
              <th style="width:11%">이름</th>
              <th style="width:13%">아이디</th>
              <th class="center" style="width:10%">상태</th>
              <th class="center" style="width:6%">항목</th>
              <th class="center" style="width:6%">첨부</th>
              <th style="width:15%">제출시각</th>
              <th style="width:15%">최종수정</th>
            </tr>
          </thead>
          <tbody>
            ${stRows.length ? stRows.map((r) => `
              <tr>
                <td>${esc(r.org_name || '-')}</td>
                <td><b>${esc(r.user_name)}</b></td>
                <td class="small muted">${esc(r.username)}</td>
                <td class="center">${statusBadge(r.status)}</td>
                <td class="center">${r.item_count}</td>
                <td class="center">${r.file_count}</td>
                <td class="small">${r.submitted_at ? fmtDateTime(r.submitted_at) : '-'}</td>
                <td class="small">${r.report_id ? fmtDateTime(r.updated_at) : '-'}</td>
              </tr>`).join('') : '<tr><td colspan="8" class="empty">조건에 맞는 작성자가 없습니다.</td></tr>'}
          </tbody>
        </table>
      </div>
      <div class="pager" id="st-pager"></div>`;

    window.WR.renderPager($('#st-pager'), {
      page: page.status, pages: stPages,
      onGo: (n) => { page.status = n; renderStatus(weekId, f); },
    });

    const readFilters = () => ({
      org: $('#st-org').value, status: $('#st-status').value, q: $('#st-q').value.trim(),
    });
    $('#st-week').onchange = () => { page.status = 1; renderStatus(Number($('#st-week').value), readFilters()); };
    $('#st-refresh').onclick = () => { page.status = 1; renderStatus(Number($('#st-week').value), readFilters()); };
    ['#st-org', '#st-status'].forEach((sel) => {
      $(sel).onchange = () => { page.status = 1; renderStatus(Number($('#st-week').value), readFilters()); };
    });
    $('#st-q').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { page.status = 1; renderStatus(Number($('#st-week').value), readFilters()); }
    });
  }

  // ==================================================================
  // 2. 주차별 현황판 (매트릭스)
  // ==================================================================
  async function renderMatrix(n) {
    const weeks = n || 8;
    const res = await api.get(`/api/admin/overview?weeks=${weeks}`);
    if (!res.weeks.length) { body().innerHTML = '<div class="empty">데이터가 없습니다.</div>'; return; }

    const shortLabel = (label) => esc(label).replace(/\s*\(/, '<br>(');
    const cell = (c) => {
      if (!c || !c.total_users) return '<td class="cell-n">·</td>';
      const rate = Math.round((c.submitted / c.total_users) * 100);
      const cls = rate >= 100 ? 'cell-s' : (rate > 0 ? 'cell-d' : 'cell-n');
      return `<td class="${cls}" title="제출 ${c.submitted} / 미등록 ${c.none_cnt}">
                <b>${c.submitted}</b><span class="muted">/${c.total_users}</span>
                <div class="rate">${rate}%</div></td>`;
    };

    body().innerHTML = `
      <p class="small muted">최근 몇 주간 <b>기관별로 몇 명이 제출했는지</b> 흐름을 봅니다.
        칸의 숫자는 <b>제출 인원 / 대상 인원</b> 이며, 대상 인원은 그 기관에 가입한 작성자 수입니다.</p>
      <div class="search-bar">
        <label class="sb-field" style="flex:0 0 180px">
          <span>표시 주차 수</span>
          <select id="mx-n">
            ${[4, 8, 12, 16, 26].map((k) => `<option value="${k}" ${k === weeks ? 'selected' : ''}>최근 ${k}주</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="table-scroll mt8">
        <table class="matrix">
          <thead>
            <tr>
              <th class="org">기관</th>
              ${res.weeks.map((w) => `<th>${shortLabel(w.label)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${res.orgs.map((o) => `
              <tr>
                <th class="org">${esc(o.name)}</th>
                ${res.weeks.map((w) => cell(res.cells[`${w.id}:${o.id}`])).join('')}
              </tr>`).join('')}
            <tr class="total-row">
              <th class="org">전체</th>
              ${res.weeks.map((w) => {
                const t = res.totals[w.id] || { submitted: 0, total_users: 0 };
                const rate = t.total_users ? Math.round((t.submitted / t.total_users) * 100) : 0;
                return `<td><b>${t.submitted}</b><span class="muted">/${t.total_users}</span>
                          <div class="rate">${rate}%</div></td>`;
              }).join('')}
            </tr>
          </tbody>
        </table>
      </div>`;

    $('#mx-n').onchange = () => renderMatrix(Number($('#mx-n').value));
  }

  // 4. 사용자 관리
  // ==================================================================
  async function renderUsers(filters) {
    const f = filters || {};
    const q = new URLSearchParams();
    if (f.q) q.set('q', f.q);
    if (f.org) q.set('org_id', f.org);

    const [usersRes, orgsRes] = await Promise.all([
      api.get('/api/admin/users' + (q.toString() ? `?${q}` : '')),
      api.get('/api/orgs'),
    ]);
    const orgOpts = orgsRes.orgs.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('');

    const { part: uRows, pages: uPages } = slicePage(usersRes.users, 'users');

    body().innerHTML = `
      <h3 class="sec-title">사용자 추가</h3>
      <div class="search-bar">
        <label class="sb-field" style="flex:1 1 140px">
          <span>아이디</span><input type="text" id="u-username" placeholder="영문/숫자 4자 이상">
        </label>
        <label class="sb-field" style="flex:1 1 120px">
          <span>이름</span><input type="text" id="u-name">
        </label>
        <label class="sb-field" style="flex:1 1 160px">
          <span>초기 비밀번호</span><input type="text" id="u-pw" placeholder="8자 이상">
        </label>
        <label class="sb-field" style="flex:1 1 160px">
          <span>기관</span><select id="u-org">${orgOpts}</select>
        </label>
        <label class="sb-field" style="flex:0 0 140px">
          <span>담당 역할</span>
          <select id="u-duty">${dutyOptions('')}</select>
        </label>
        <label class="sb-field" style="flex:0 0 130px">
          <span>권한</span>
          <select id="u-role">
            <option value="USER">작성자</option>
            <option value="ORG_ADMIN">기관관리자</option>
            <option value="ADMIN">총괄관리자</option>
          </select>
        </label>
        <button class="btn primary sb-btn" id="u-add">사용자 추가</button>
      </div>

      <h3 class="sec-title">사용자 목록 (${usersRes.users.length}명)</h3>
      <div class="search-bar">
        <label class="sb-field" style="flex:1 1 240px">
          <span>검색 (이름·아이디·이메일)</span>
          <input type="text" id="u-q" value="${esc(f.q || '')}" placeholder="예: 홍길동">
        </label>
        <label class="sb-field" style="flex:0 0 200px">
          <span>기관</span>
          <select id="u-forg">
            <option value="">전체</option>
            ${orgsRes.orgs.map((o) =>
              `<option value="${o.id}" ${String(f.org) === String(o.id) ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
          </select>
        </label>
        <button class="btn primary sb-btn" id="u-search">조회</button>
      </div>

      <div class="table-scroll mt8">
        <table class="grid fixed">
          <thead><tr>
            <th style="width:19%">기관</th><th style="width:11%">이름</th>
            <th style="width:13%">아이디</th>
            <th class="center" style="width:11%">담당 역할</th>
            <th class="center" style="width:9%">권한</th>
            <th class="center" style="width:8%">상태</th><th style="width:15%">최근 로그인</th>
            <th class="center" style="width:14%">사용자 권한 및 삭제</th>
          </tr></thead>
          <tbody>
            ${uRows.map((u) => `
              <tr>
                <td>${esc(u.org_name || '-')}</td>
                <td><b>${esc(u.name)}</b></td>
                <td class="small muted">${esc(u.username)}</td>
                <td class="center small">${u.duty ? DUTY_LABEL[u.duty] : '-'}</td>
                <td class="center">${
                  u.role === 'ADMIN'     ? '<span class="badge role-admin">총괄관리자</span>' :
                  u.role === 'ORG_ADMIN' ? '<span class="badge role-org">기관관리자</span>' :
                                           '<span class="badge role-user">작성자</span>'
                }</td>
                <td class="center">${
                  u.approval_status === 'PENDING'  ? '<span class="badge draft">승인대기</span>' :
                  u.approval_status === 'REJECTED' ? '<span class="badge closed">반려</span>'   :
                  u.is_active ? '<span class="badge submitted">활성</span>' : '<span class="badge closed">중지</span>'
                }</td>
                <td class="small">${fmtDateTime(u.last_login_at)}</td>
                <td class="center nowrap">
                  <button class="btn sm" data-uedit="${u.id}">권한</button>
                  <button class="btn sm danger" data-udel="${u.id}">삭제</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="pager" id="u-pager"></div>`;

    window.WR.renderPager($('#u-pager'), {
      page: page.users, pages: uPages,
      onGo: (n) => { page.users = n; renderUsers(f); },
    });

    const readUserFilters = () => ({ q: $('#u-q').value.trim(), org: $('#u-forg').value });
    $('#u-search').onclick = () => { page.users = 1; renderUsers(readUserFilters()); };
    $('#u-forg').onchange = () => { page.users = 1; renderUsers(readUserFilters()); };
    $('#u-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { page.users = 1; renderUsers(readUserFilters()); } });

    $('#u-add').onclick = async () => {
      const payload = {
        username: $('#u-username').value.trim(),
        name: $('#u-name').value.trim(),
        password: $('#u-pw').value,
        org_id: $('#u-role').value === 'ADMIN' ? ($('#u-org').value || null) : $('#u-org').value,
        role: $('#u-role').value,
        duty: $('#u-duty').value || null,
      };

      // 어느 칸이 문제인지 바로 알 수 있게 항목별로 확인하고 그 칸에 커서를 둔다
      const problem =
        !payload.username ? ['#u-username', '아이디를 입력하세요.'] :
        !/^[A-Za-z0-9._-]{4,50}$/.test(payload.username)
          ? ['#u-username', '아이디는 영문/숫자/._- 조합 4자 이상이어야 합니다.'] :
        !payload.name ? ['#u-name', '이름을 입력하세요.'] :
        !payload.password ? ['#u-pw', '초기 비밀번호를 입력하세요.'] :
        payload.password.length < 8 ? ['#u-pw', '초기 비밀번호는 8자 이상이어야 합니다.'] :
        (payload.role !== 'ADMIN' && !payload.org_id) ? ['#u-org', '기관을 선택하세요.'] :
        !payload.duty ? ['#u-duty', '담당 역할을 선택하세요.'] : null;

      if (problem) {
        toast(problem[1], true);
        $(problem[0]).focus();
        return;
      }

      try {
        await addUserWithDuplicateCheck(payload);
        toast(`"${payload.name}" 사용자가 추가되었습니다.`);
        renderUsers();
      } catch (e) { toast(e.message, true); }
    };

    const find = (id) => usersRes.users.find((x) => x.id === Number(id));

    body().querySelectorAll('[data-uedit]').forEach((b) => {
      b.onclick = () => openUserEdit(find(b.dataset.uedit), orgsRes.orgs);
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

  /**
   * 사용자 추가. 같은 기관에 이름이 같은 사람이 있으면 서버가 409 로 알려준다.
   * 이때 구분용 접미사(-A, -B)를 붙일지 관리자에게 확인받는다.
   */
  async function addUserWithDuplicateCheck(payload) {
    try {
      await api.post('/api/admin/users', payload);
      return;
    } catch (e) {
      if (!e.body || !e.body.duplicate_name) throw e;

      const { duplicates, suggestion } = e.body;
      const who = duplicates
        .map((d) => `    · ${d.name} (${d.username}${d.email ? ', ' + d.email : ''})`)
        .join('\n');

      const ok = confirm(
        `같은 기관에 "${payload.name}" 님이 이미 ${duplicates.length}명 있습니다.\n\n${who}\n\n` +
        `[확인] 구분되도록 이름을 바꿔 등록합니다.\n` +
        (suggestion.renameExistingTo
          ? `    기존: ${payload.name} → ${suggestion.renameExistingTo}\n`
          : '') +
        `    신규: ${payload.name} → ${suggestion.newName}\n\n` +
        `[취소] 등록을 멈춥니다. 이름을 직접 고쳐 다시 시도하세요.`
      );
      if (!ok) throw new Error('등록을 취소했습니다.');

      // 기존 사용자에게도 접미사를 붙여 둘 다 구분되게 한다
      if (suggestion.renameExistingId && suggestion.renameExistingTo) {
        await api.put(`/api/admin/users/${suggestion.renameExistingId}`,
          { name: suggestion.renameExistingTo });
      }
      await api.post('/api/admin/users',
        { ...payload, name: suggestion.newName, allow_duplicate_name: true });
    }
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
          <label class="field"><span>기관</span>
            <select id="e-org">
              <option value="">(없음)</option>
              ${orgs.map((o) => `<option value="${o.id}" ${o.id === u.org_id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
            </select>
          </label>
          <label class="field"><span>담당 역할</span>
            <select id="e-duty">${dutyOptions(u.duty || '')}</select>
          </label>
          <label class="field"><span>비밀번호 재설정</span>
            <input type="text" id="e-pw" autocomplete="off" data-lpignore="true"
                   placeholder="변경할 때만 입력 (8자 이상)">
          </label>
          <p class="small muted" style="margin:-6px 0 12px">
            <span class="mark">※</span> 비워 두면 기존 비밀번호가 유지됩니다.</p>
          <div class="field-hl">
            <label class="field"><span>권한</span>
              <select id="e-role">
                <option value="USER"      ${u.role === 'USER' ? 'selected' : ''}>작성자</option>
                <option value="ORG_ADMIN" ${u.role === 'ORG_ADMIN' ? 'selected' : ''}>기관관리자</option>
                <option value="ADMIN"     ${u.role === 'ADMIN' ? 'selected' : ''}>총괄관리자</option>
              </select>
            </label>
          </div>
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
      const payload = {
        name: $('#e-name', back).value.trim(),
        email: $('#e-email', back).value.trim() || null,
        org_id: $('#e-org', back).value ? Number($('#e-org', back).value) : null,
        role: $('#e-role', back).value,
        duty: $('#e-duty', back).value || null,
      };

      // 소속을 바꾸면, 이 사람이 이전 기관에서 쓴 보고서를 함께 옮길지 확인한다.
      // (보고서는 작성 당시 소속을 그대로 갖고 있어 자동으로 따라가지 않는다)
      if (payload.org_id && Number(payload.org_id) !== Number(u.org_id)) {
        const from = u.org_name || '소속 없음';
        const to = $('#e-org', back).selectedOptions[0]?.textContent.trim() || '';
        const cnt = u.report_count || 0;
        if (cnt > 0) {
          payload.move_reports = confirm(
            `"${u.name}" 님의 기관을 "${from}" → "${to}" 로 바꿉니다.\n\n` +
            `"${from}" 에서 작성한 보고서가 ${cnt}건 있습니다.\n\n` +
            `[확인] 이 보고서들도 "${to}" 실적으로 함께 옮깁니다.\n` +
            `[취소] 보고서는 "${from}" 실적으로 그대로 두고 기관만 바꿉니다.\n\n` +
            `업무·첨부는 어느 쪽이든 삭제되지 않습니다.`
          );
        }
      }

      if (!payload.duty) {
        toast('담당 역할을 선택하세요.', true);
        $('#e-duty', back).focus();
        return;
      }

      const newPw = $('#e-pw', back).value.trim();
      if (newPw && newPw.length < 8) {
        toast('비밀번호는 8자 이상이어야 합니다.', true);
        $('#e-pw', back).focus();
        return;
      }

      try {
        const res = await api.put(`/api/admin/users/${u.id}`, payload);

        // 비밀번호는 별도 엔드포인트에서 처리한다 (해싱·변경 안내 플래그 포함)
        if (newPw) {
          await api.post(`/api/admin/users/${u.id}/password`, { password: newPw });
        }

        close();
        const parts = ['저장되었습니다.'];
        if (res.moved_reports) parts.push(`보고서 ${res.moved_reports}건을 함께 옮겼습니다.`);
        if (newPw) parts.push('비밀번호가 변경되었습니다.');
        toast(parts.join(' '));

        if (newPw) {
          alert(`"${u.name}" 님의 비밀번호를 바꿨습니다.\n\n    ${newPw}\n\n` +
                `본인에게 전달하세요. 첫 로그인 시 변경 안내가 표시됩니다.`);
        }
        renderUsers();
      } catch (e) { toast(e.message, true); }
    };
  }

  // ==================================================================
  // 5. 활동 로그
  // ==================================================================
  // 동작 코드를 우리말로 풀어 쓴다
  const ACTION_TEXT = {
    LOGIN: '로그인', LOGOUT: '로그아웃', LOGIN_FAIL: '로그인 실패',
    SIGNUP: '회원가입', FIND_ID: '아이디 찾기',
    PASSWORD_CHANGE: '비밀번호 변경', PROFILE_UPDATE: '내 정보 수정',
    RESET_REQUEST: '비밀번호 재설정 요청', RESET_DIRECT: '비밀번호 재설정 진행',
    RESET_COMPLETE: '비밀번호 재설정 완료', RESET_DONE: '비밀번호 재설정 완료',
    RESET_REJECT: '비밀번호 재설정 반려',
    RESET_MAIL_SENT: '재설정 메일 발송', RESET_MAIL_FAIL: '재설정 메일 실패',
    REPORT_SAVE: '보고서 저장', REPORT_UPDATE: '보고서 수정',
    REPORT_DELETE: '보고서 삭제', REPORT_STATUS: '보고서 상태 변경',
    REPORT_EXPORT: 'Word 다운로드', REPORT_EXPORT_HWPX: '한글 다운로드',
    REPORT_EXPORT_HWPX_WEEK: '주차 한글 다운로드',
    REPORT_EXPORT_HWPX_ALL: '전체 주차 ZIP 다운로드',
    REPORT_MOVE_ORG: '보고서 기관 이관', REPORT_ORG_CHANGE: '보고서 기관 변경',
    EXCEL_IMPORT: '엑셀 일괄등록', EXCEL_PREVIEW: '엑셀 미리보기',
    FILE_UPLOAD: '증적자료 첨부', FILE_DELETE: '증적자료 삭제',
    USER_CREATE: '사용자 추가', USER_UPDATE: '사용자 수정',
    USER_DELETE: '사용자 삭제', USER_PASSWORD_RESET: '비밀번호 초기화',
    ORG_CREATE: '기관 추가', ORG_UPDATE: '기관 수정', ORG_DELETE: '기관 삭제',
    WEEK_TOGGLE: '주차 마감 전환',
  };

  // 활동 로그의 기간 고르기.
  //  월·주·일 단위를 한 번에 고를 수 있게 미리 담아 둔다.
  //  '직접 지정' 을 고르면 시각까지 직접 적을 수 있다.
  const RANGE_LABEL = {
    today: '오늘', yesterday: '어제',
    d7: '최근 7일', d30: '최근 30일',
    week: '이번 주', lastweek: '지난 주',
    month: '이번 달', lastmonth: '지난 달',
    custom: '직접 지정',
  };

  /** 두 자리로 맞춘다 */
  const p2 = (n) => String(n).padStart(2, '0');
  /** 날짜를 입력칸에 넣을 모양(YYYY-MM-DDTHH:MM)으로 */
  const stamp = (d, h, m) =>
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(h)}:${p2(m)}`;

  /** 고른 단위에 맞는 시작·끝 시각을 만든다 */
  function rangeOf(kind) {
    const now = new Date();
    const day = (n) => { const d = new Date(now); d.setDate(d.getDate() + n); return d; };
    const s = (d) => stamp(d, 0, 0);
    const e = (d) => stamp(d, 23, 59);

    switch (kind) {
      case 'today':     return { from: s(now), to: e(now) };
      case 'yesterday': return { from: s(day(-1)), to: e(day(-1)) };
      case 'd7':        return { from: s(day(-6)), to: e(now) };
      case 'd30':       return { from: s(day(-29)), to: e(now) };
      case 'week': {    // 월요일 시작
        const back = (now.getDay() + 6) % 7;
        return { from: s(day(-back)), to: e(now) };
      }
      case 'lastweek': {
        const back = (now.getDay() + 6) % 7 + 7;
        const start = day(-back);
        const end = new Date(start); end.setDate(end.getDate() + 6);
        return { from: s(start), to: e(end) };
      }
      case 'month':     return { from: s(new Date(now.getFullYear(), now.getMonth(), 1)), to: e(now) };
      case 'lastmonth': {
        const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const end = new Date(now.getFullYear(), now.getMonth(), 0);
        return { from: s(start), to: e(end) };
      }
      default:          return { from: '', to: '' };
    }
  }

  // 활동 로그 검색 조건 (화면을 다시 그려도 유지된다)
  const auditFilter = { range: '', from: '', to: '', action: '', q: '' };

  async function renderAudit() {
    const q = new URLSearchParams({ page: page.audit, size: PAGE_SIZE });
    ['from', 'to', 'action', 'q'].forEach((k) => { if (auditFilter[k]) q.set(k, auditFilter[k]); });

    const res = await api.get(`/api/admin/audit?${q}`);
    const aRows = res.logs;
    const aPages = Math.max(1, Math.ceil(res.total / res.size));

    body().innerHTML = `
      <div class="search-bar">
        <label class="sb-field" style="flex:0 0 130px">
          <span>기간</span>
          <select id="al-range">
            <option value="">전체</option>
            ${Object.entries(RANGE_LABEL).map(([k, v]) =>
              `<option value="${k}" ${auditFilter.range === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </label>
        <label class="sb-field" style="flex:0 0 205px">
          <span>시작</span>
          <input type="datetime-local" id="al-from" value="${esc(auditFilter.from)}">
        </label>
        <label class="sb-field" style="flex:0 0 205px">
          <span>종료</span>
          <input type="datetime-local" id="al-to" value="${esc(auditFilter.to)}">
        </label>
        <label class="sb-field" style="flex:0 0 190px">
          <span>행위</span>
          <select id="al-action">
            <option value="">전체</option>
            ${res.actions.map((code) =>
              `<option value="${esc(code)}" ${auditFilter.action === code ? 'selected' : ''}>${
                esc(ACTION_TEXT[code] || code)}</option>`).join('')}
          </select>
        </label>
        <label class="sb-field" style="flex:1 1 200px">
          <span>검색어</span>
          <input type="text" id="al-q" value="${esc(auditFilter.q)}"
                 placeholder="사용자ID·이름·내용·IP">
        </label>
        <button class="btn primary sb-btn" id="al-search">조회</button>
        <button class="btn sb-btn" id="al-reset">초기화</button>
      </div>

      <h3 class="sec-title">활동 로그 (총 ${res.total}건)</h3>

      <div class="table-scroll">
        <table class="grid fixed">
          <thead><tr>
            <th style="width:11%">일시</th>
            <th style="width:10%">사용자ID</th>
            <th style="width:9%">사용자</th>
            <th style="width:12%">동작</th>
            <th style="width:12%">행위</th>
            <th>내용</th><th style="width:11%">IP</th>
          </tr></thead>
          <tbody>
            ${aRows.length ? aRows.map((l) => `
              <tr>
                <td class="small">${fmtDateTime(l.created_at)}</td>
                <td>${esc(l.username || '(비로그인)')}</td>
                <td>${esc(l.user_name || '(비로그인)')}</td>
                <td class="small">${esc(l.action)}</td>
                <td class="small">${esc(ACTION_TEXT[l.action] || '-')}</td>
                <td class="small">${esc(l.detail || '')}</td>
                <td class="small muted">${esc(l.ip || '-')}</td>
              </tr>`).join('') : '<tr><td colspan="7" class="empty">기록이 없습니다.</td></tr>'}
          </tbody>
        </table>
      </div>
      <div class="pager" id="a-pager"></div>`;

    window.WR.renderPager($('#a-pager'), {
      page: res.page, pages: aPages,
      onGo: (n) => { page.audit = n; renderAudit(); },
    });

    const runSearch = () => {
      auditFilter.from = $('#al-from').value;
      auditFilter.to = $('#al-to').value;
      auditFilter.action = $('#al-action').value;
      auditFilter.q = $('#al-q').value.trim();
      page.audit = 1;
      renderAudit();
    };
    $('#al-search').onclick = runSearch;
    $('#al-action').onchange = runSearch;

    // 기간을 고르면 시작·종료가 자동으로 채워지고 바로 조회한다
    $('#al-range').onchange = () => {
      const kind = $('#al-range').value;
      auditFilter.range = kind;
      if (kind && kind !== 'custom') {
        const r = rangeOf(kind);
        auditFilter.from = r.from;
        auditFilter.to = r.to;
      } else if (!kind) {
        auditFilter.from = '';
        auditFilter.to = '';
      }
      auditFilter.action = $('#al-action').value;
      auditFilter.q = $('#al-q').value.trim();
      page.audit = 1;
      renderAudit();
    };
    // 시각을 직접 고치면 '직접 지정' 으로 바뀐다
    ['#al-from', '#al-to'].forEach((s) => {
      $(s).onchange = () => { auditFilter.range = 'custom'; runSearch(); };
    });
    $('#al-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
    $('#al-reset').onclick = () => {
      Object.keys(auditFilter).forEach((k) => { auditFilter[k] = ''; });
      page.audit = 1;
      renderAudit();
    };
  }

  init();
})();
