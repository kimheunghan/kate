/* =====================================================================
   공통 유틸 + API 클라이언트
   ===================================================================== */
(function (global) {
  'use strict';

  const HEADERS = { 'X-Requested-With': 'WeeklyReport' };

  async function request(method, url, body, opts = {}) {
    const init = { method, headers: { ...HEADERS }, credentials: 'same-origin' };

    if (body instanceof FormData) {
      init.body = body;                        // Content-Type 은 브라우저가 boundary 와 함께 설정
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    // 서버 재기동·네트워크 순단이면 fetch 자체가 TypeError 로 실패한다.
    // 브라우저 원문("Failed to fetch") 대신 상황을 알려주고,
    // 조회(GET)는 한 번 자동 재시도한다. 작성 중인 내용은 화면에 그대로 남는다.
    let res;
    try {
      res = await fetch(url, init);
    } catch (netErr) {
      if (method === 'GET' && !opts.noRetry) {
        await new Promise((r) => setTimeout(r, 1200));
        try {
          res = await fetch(url, init);
        } catch (e2) {
          throw new Error('서버에 연결할 수 없습니다. 네트워크 상태를 확인한 뒤 다시 시도하세요.');
        }
      } else {
        const err = new Error(
          '서버에 연결하지 못해 저장되지 않았습니다.\n'
          + '작성하신 내용은 화면에 그대로 있으니, 잠시 후 다시 [저장]을 눌러주세요.'
        );
        err.network = true;
        throw err;
      }
    }

    if (res.status === 401 && !opts.allowAnonymous) {
      location.href = '/login';
      throw new Error('로그인이 필요합니다.');
    }

    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : await res.text();

    if (!res.ok) {
      const msg = (data && data.error) || (typeof data === 'string' && data) || `요청 실패 (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      err.body = (data && typeof data === 'object') ? data : null;  // 상세 정보(중복 목록 등)
      throw err;
    }
    return data;
  }

  const api = {
    get:  (url, opts)       => request('GET', url, undefined, opts),
    post: (url, body, opts) => request('POST', url, body, opts),
    put:  (url, body, opts) => request('PUT', url, body, opts),
    del:  (url, opts)       => request('DELETE', url, undefined, opts),
  };

  // ------------------------------------------------------------------
  // UI 유틸
  // ------------------------------------------------------------------
  let toastTimer = null;
  function toast(msg, isError) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 4200 : 2400);
  }

  /** 텍스트를 HTML 로 넣을 때 항상 이걸 통과시킬 것 */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function fmtDateTime(s) {
    if (!s) return '-';
    const d = new Date(s);
    if (isNaN(d)) return '-';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function statusBadge(status) {
    if (status === 'SUBMITTED') return '<span class="badge submitted">제출완료</span>';
    return '<span class="badge none">미등록</span>';
  }

  /** 인쇄 창 열기. CSP 로 인쇄 문서의 인라인 스크립트가 막히므로 여는 쪽에서 print() 를 호출한다. */
  function openPrint(reportId) {
    const w = window.open(`/api/reports/${reportId}/print`, '_blank', 'width=1000,height=800');
    if (!w) { toast('팝업이 차단되었습니다. 브라우저의 팝업 차단을 해제하세요.', true); return; }
    w.addEventListener('load', () => { try { w.focus(); w.print(); } catch (e) { /* 사용자가 직접 인쇄 */ } });
  }

  /**
   * 파일 내려받기.
   * 주소로 바로 이동시키면(location.href) HTTP 사이트에서는 Chrome 이
   * '안전하지 않은 다운로드'로 차단한다. 내용을 받아 브라우저가 직접
   * 파일로 만들어 저장하면(blob:) 그 검사를 받지 않는다.
   */
  async function downloadFile(url, fallbackName) {
    let res;
    try {
      // cache:'no-store' 를 빼면 크롬이 예전에 받은 문서를 그대로 다시 준다.
      res = await fetch(url, { headers: { ...HEADERS }, credentials: 'same-origin', cache: 'no-store' });
    } catch (e) {
      toast('서버에 연결할 수 없습니다.', true);
      return;
    }
    if (res.status === 401) { location.href = '/login'; return; }
    if (!res.ok) {
      let msg = `내려받지 못했습니다 (${res.status})`;
      try {
        const j = await res.json();
        if (j && j.error) msg = j.error;
      } catch (e) { /* 본문이 JSON 이 아니면 기본 메시지 */ }
      toast(msg, true);
      return;
    }

    // 서버가 지정한 파일명을 그대로 사용 (한글 파일명은 filename* 에 들어 있다)
    const cd = res.headers.get('content-disposition') || '';
    let name = fallbackName || 'download';
    const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    const plain = /filename="([^"]+)"/i.exec(cd);
    if (utf8) { try { name = decodeURIComponent(utf8[1]); } catch (e) { /* 그대로 */ } }
    else if (plain) name = plain[1];

    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30000);
  }

  /** 보고서를 Word 문서로 내려받는다 */
  function downloadReport(reportId) {
    downloadFile(`/api/reports/${reportId}/export`, '주간보고.doc');
  }

  /** 보고서를 아래한글 문서(HWPX)로 내려받는다 */
  function downloadReportHwpx(reportId) {
    downloadFile(`/api/reports/${reportId}/export-hwpx`, '주간보고.hwpx');
  }

  /**
   * 주간보고를 한글 문서로 내려받는다 (보이는 범위만).
   *   주차를 고르면  → 그 주차 한 파일(.hwpx)
   *   고르지 않으면  → 주차마다 한 파일씩 묶은 ZIP
   */
  function downloadWeekHwpx(weekId, orgId) {
    const q = new URLSearchParams();
    if (weekId) q.set('week_id', String(weekId));
    if (orgId)  q.set('org_id', String(orgId));
    downloadFile(`/api/reports/export-hwpx-week?${q}`,
      weekId ? '주간보고.hwpx' : '주간보고_전체.zip');
  }

  /**
   * 권한 명칭 (화면 전체에서 이 표기를 쓴다)
   *   ADMIN     총괄관리자 — 전체 기관
   *   ORG_ADMIN 기관관리자 — 자기 기관만
   *   USER      작성자     — 자기가 속한 기관
   */
  const ROLE_LABEL = {
    ADMIN: '총괄관리자', SUPERVISOR: '감독관리자', ORG_ADMIN: '기관관리자', USER: '작성자',
  };
  function roleLabel(role) { return ROLE_LABEL[role] || '작성자'; }

  /**
   * 쪽 이동을 그린다. 한 쪽이면 아무것도 그리지 않는다.
   * @param {HTMLElement} host  그릴 자리
   * @param {{page:number, pages:number, onGo:(n:number)=>void}} opt
   */
  function renderPager(host, { page, pages, onGo }) {
    if (!host) return;
    if (!pages || pages <= 1) { host.innerHTML = ''; return; }

    // 현재 쪽 둘레만 보여 준다 (앞뒤 두 개씩)
    const from = Math.max(1, Math.min(page - 2, pages - 4));
    const to = Math.min(pages, Math.max(page + 2, 5));
    const nums = [];
    for (let i = from; i <= to; i++) nums.push(i);

    host.innerHTML =
      `<button class="btn sm" data-go="1" ${page <= 1 ? 'disabled' : ''}>«</button>` +
      `<button class="btn sm" data-go="${page - 1}" ${page <= 1 ? 'disabled' : ''}>이전</button>` +
      (from > 1 ? '<span class="pg-gap">…</span>' : '') +
      nums.map((n) => `<button class="btn sm pg-num${n === page ? ' on' : ''}" data-go="${n}">${n}</button>`).join('') +
      (to < pages ? '<span class="pg-gap">…</span>' : '') +
      `<button class="btn sm" data-go="${page + 1}" ${page >= pages ? 'disabled' : ''}>다음</button>` +
      `<button class="btn sm" data-go="${pages}" ${page >= pages ? 'disabled' : ''}>»</button>`;

    host.querySelectorAll('[data-go]').forEach((b) => {
      b.onclick = () => { const n = Number(b.dataset.go); if (n !== page) onGo(n); };
    });
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  /**
   * 내 정보(권한·소속)를 이 창이 열려 있는 동안만 기억한다.
   *   화면을 옮길 때마다 서버 답을 기다리느라 상단바와 탭이 비어 보였다.
   *   기억해 둔 값으로 먼저 그리고, 받아 온 값으로 다시 맞춘다.
   *   화면 표시에만 쓴다. 실제 권한은 언제나 서버가 확인한다.
   */
  const ME_KEY = 'wr.me';
  const store = () => (typeof window !== 'undefined' ? window.sessionStorage : null);
  function rememberMe(user) {
    try { store().setItem(ME_KEY, JSON.stringify(user)); } catch (e) { /* 무시 */ }
  }
  function cachedMe() {
    try { return JSON.parse(store().getItem(ME_KEY) || 'null'); } catch (e) { return null; }
  }
  function forgetMe() {
    try { store().removeItem(ME_KEY); } catch (e) { /* 무시 */ }
  }

  /**
   * 아이디 칸에 공백이 들어오지 않게 한다.
   *   표에서 아이디를 드래그해 복사하면 칸 앞의 줄바꿈·들여쓰기가 함께 붙는다.
   *   붙여넣는 순간 지워 준다.
   */
  function stripBlanks(el) {
    if (!el) return;
    const clean = () => {
      const v = el.value.replace(/\s+/g, '');
      if (v !== el.value) el.value = v;
    };
    el.addEventListener('input', clean);
    el.addEventListener('paste', () => setTimeout(clean, 0));
    el.addEventListener('blur', clean);
  }

  /** 공통 상단바 렌더 */
  function renderTopbar(user, active) {
    const nav = [{ href: '/report', key: 'report', label: '주간보고' }];
    // 관리자 화면 : 총괄관리자(전부) · 감독관리자와 중복권한자(주차별 현황판)
    //               · 기관관리자(사용자 관리)
    const seesAdmin = ['ADMIN', 'SUPERVISOR', 'ORG_ADMIN'].includes(user.role)
      || user.can_view_all === true;
    if (seesAdmin) nav.push({ href: '/admin', key: 'admin', label: '관리화면' });

    return `
      <h1 id="btn-brand" title="사업단 현판 보기">주간실적 보고 시스템</h1>
      <nav>${nav.map((n) =>
        `<a href="${n.href}" class="${n.key === active ? 'active' : ''}">${esc(n.label)}</a>`).join('')}</nav>
      <div class="spacer"></div>
      <button class="who" id="btn-profile" type="button" title="내 정보 수정">
        ${esc(user.org_name || '소속없음')} ·
        <b>${esc(user.name)}</b> <span class="role-tag">${roleLabel(user.role)}</span>
        <span class="who-edit">수정</span>
      </button>
      <button class="btn sm" id="btn-pw">비밀번호</button>
      <button class="btn sm" id="btn-logout">로그아웃</button>`;
  }

  /** 사업단 현판. 벽 없이 판만 그린다 (사진이 아니라 글자라 늘려도 또렷하다) */
  function openBrandPlate() {
    const back = document.createElement('div');
    back.className = 'plate-back';
    back.innerHTML = `
      <div class="plate" role="img" aria-label="AI 인허가 사업단 현판">
        <div class="plate-in">
          <div class="plate-title">AI 인허가 사업단</div>
          <div class="plate-sub">국토교통부 · 과학기술정보통신부</div>
        </div>
      </div>`;
    const close = () => back.remove();
    back.addEventListener('click', close);
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
    document.body.appendChild(back);
  }

  function bindTopbar() {
    const brand = $('#btn-brand');
    if (brand) brand.onclick = openBrandPlate;

    const logout = $('#btn-logout');
    if (logout) {
      logout.onclick = async () => {
        await api.post('/api/auth/logout', {}).catch(() => {});
        forgetMe();
        location.href = '/login';
      };
    }
    const pw = $('#btn-pw');
    if (pw) pw.onclick = openPasswordModal;

    const prof = $('#btn-profile');
    if (prof) prof.onclick = openProfileModal;
  }

  /** 내 정보 수정 (이름·이메일·연락처·소속) */
  async function openProfileModal() {
    let me, orgs;
    try {
      [me, orgs] = await Promise.all([api.get('/api/auth/me'), api.get('/api/orgs')]);
    } catch (e) { toast(e.message, true); return; }
    const u = me.user;

    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal" style="max-width:420px">
        <header>내 정보</header>
        <div class="body">
          <div class="alert error hidden" id="pf-err"></div>
          <label class="field"><span>아이디</span>
            <input type="text" id="pf-username" name="username" autocomplete="username"
                   value="${esc(u.username)}" disabled></label>
          <label class="field"><span>이름</span>
            <input type="text" id="pf-name" value="${esc(u.name)}"></label>
          <label class="field"><span>이메일</span>
            <input type="email" id="pf-email" value="${esc(u.email || '')}"
                   placeholder="아이디·비밀번호 찾기에 사용됩니다"></label>
          <label class="field"><span>연락처</span>
            <input type="text" id="pf-phone" value="${esc(u.phone || '')}" placeholder="010-0000-0000"></label>
          <label class="field" style="margin-bottom:6px"><span>기관</span>
            <select id="pf-org">
              ${u.role === 'ADMIN' ? '<option value="">(전체 / 소속 없음)</option>' : ''}
              ${orgs.orgs.map((o) =>
                `<option value="${o.id}" ${o.id === u.org_id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
            </select>
          </label>
          <p class="hint-note" style="margin:0 0 12px">
            <span class="mark">※</span>
            주간보고는 <b>기관 단위</b>로 관리됩니다. 소속을 바꾸면 작성 화면이 바뀐 기관의 보고서를 보여줍니다.
            <b>기존 보고서는 삭제되지 않으며</b> [등록 내역 조회] 에서 계속 확인할 수 있습니다.
          </p>
          <p class="small muted">아이디와 권한은 변경할 수 없습니다. 비밀번호는 상단 [비밀번호] 버튼에서 바꾸세요.</p>
        </div>
        <footer>
          <button class="btn" id="pf-cancel">취소</button>
          <button class="btn primary" id="pf-ok">저장</button>
        </footer>
      </div>`;
    document.body.appendChild(back);

    const close = () => back.remove();
    $('#pf-cancel', back).onclick = close;
    back.addEventListener('click', (e) => { if (e.target === back) close(); });

    $('#pf-ok', back).onclick = async () => {
      const err = $('#pf-err', back);
      const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); };
      err.classList.add('hidden');

      const payload = {
        name: $('#pf-name', back).value.trim(),
        email: $('#pf-email', back).value.trim(),
        phone: $('#pf-phone', back).value.trim(),
        org_id: $('#pf-org', back).value ? Number($('#pf-org', back).value) : null,
      };
      if (!payload.name) return fail('이름을 입력하세요.');

      // 소속 변경은 작성 대상 기관이 바뀌므로 확인받고,
      // 이전 소속에서 쓴 보고서가 있으면 함께 옮길지 묻는다
      if (Number(payload.org_id) !== Number(u.org_id)) {
        const from = u.org_name || '소속 없음';
        const to = $('#pf-org', back).selectedOptions[0]?.textContent.trim() || '소속 없음';

        let prev = { total: 0, movable: 0, conflicts: [] };
        if (payload.org_id) {
          try { prev = await api.get(`/api/auth/move-preview?to_org_id=${payload.org_id}`); }
          catch (e) { /* 미리보기 실패해도 진행 */ }
        }

        if (prev.total > 0) {
          const msg =
            `"${from}" 에서 작성하신 보고서가 ${prev.total}건 있습니다.\n\n` +
            `[확인] 누르면 이 보고서들을 "${to}" 로 함께 옮깁니다.\n` +
            `[취소] 누르면 보고서는 "${from}" 에 그대로 두고 소속만 바꿉니다.\n` +
            (prev.conflicts.length
              ? `\n※ 아래 주차는 "${to}" 에 이미 보고서가 있어 옮길 수 없습니다.\n   ${prev.conflicts.join('\n   ')}\n`
              : '') +
            `\n업무·첨부는 어느 쪽이든 삭제되지 않습니다.`;
          payload.move_reports = confirm(msg);
        } else {
          const ok = confirm(
            `소속을 "${from}" → "${to}" 로 변경합니다.\n\n` +
            `앞으로 작성·수정 대상이 "${to}" 의 보고서로 바뀝니다.\n계속할까요?`
          );
          if (!ok) return;
        }
      }

      try {
        const res = await api.put('/api/auth/profile', payload);
        close();
        if (res.moved) {
          toast(`저장되었습니다. 보고서 ${res.moved}건을 함께 옮겼습니다.`
            + (res.skipped ? ` (${res.skipped}건은 이전 소속에 남음)` : ''));
        } else {
          toast('저장되었습니다.');
        }
        // 소속이 바뀌면 편집 권한이 달라지므로 화면을 다시 불러온다
        if (Number(res.user.org_id) !== Number(u.org_id)) location.reload();
        else {
          const active = document.querySelector('.topbar nav a.active');
          $('#topbar').innerHTML = renderTopbar(res.user, active ? active.getAttribute('href').slice(1) : '');
          bindTopbar();
        }
      } catch (e) { fail(e.message); }
    };
    $('#pf-name', back).focus();
  }

  function openPasswordModal() {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal" style="max-width:400px">
        <header>비밀번호 변경</header>
        <div class="body">
          <div class="alert error hidden" id="pw-err"></div>
          <label class="field"><span>현재 비밀번호</span>
            <input type="password" id="pw-cur" autocomplete="off" data-lpignore="true"></label>
          <label class="field"><span>새 비밀번호 (8자 이상)</span>
            <input type="password" id="pw-new" autocomplete="off" data-lpignore="true"></label>
          <label class="field"><span>새 비밀번호 확인</span>
            <input type="password" id="pw-new2" autocomplete="off" data-lpignore="true"></label>
          <label class="check"><input type="checkbox" id="pw-show"> 입력한 비밀번호 표시</label>
          <p class="small muted" id="pw-preview"></p>
        </div>
        <footer>
          <button class="btn" id="pw-cancel">취소</button>
          <button class="btn primary" id="pw-ok">변경</button>
        </footer>
      </div>`;
    document.body.appendChild(back);

    const close = () => back.remove();
    $('#pw-cancel', back).onclick = close;
    back.addEventListener('click', (e) => { if (e.target === back) close(); });

    // 브라우저 비밀번호 관리자가 다른 값을 채워 넣어도 눈으로 확인할 수 있게 한다
    const pwFields = ['#pw-cur', '#pw-new', '#pw-new2'].map((s2) => $(s2, back));
    const preview = $('#pw-preview', back);
    const showBox = $('#pw-show', back);
    const syncPreview = () => {
      if (!showBox.checked) { preview.textContent = ''; return; }
      const v = $('#pw-new', back).value;
      preview.textContent = v ? `새 비밀번호: ${v}  (${v.length}자)` : '';
    };
    showBox.onchange = () => {
      pwFields.forEach((f) => { f.type = showBox.checked ? 'text' : 'password'; });
      syncPreview();
    };
    pwFields.forEach((f) => f.addEventListener('input', syncPreview));

    $('#pw-ok', back).onclick = async () => {
      const err = $('#pw-err', back);
      const cur = $('#pw-cur', back).value;
      const nw = $('#pw-new', back).value;
      const nw2 = $('#pw-new2', back).value;

      const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); };
      if (nw.length < 8) return fail('새 비밀번호는 8자 이상이어야 합니다.');
      if (nw !== nw2) return fail('새 비밀번호가 서로 일치하지 않습니다.');

      try {
        await api.post('/api/auth/password', { current_password: cur, new_password: nw });
        close();
        toast('비밀번호가 변경되었습니다.');
      } catch (e) { fail(e.message); }
    };
    $('#pw-cur', back).focus();
  }

  global.WR = { api, toast, esc, roleLabel, renderPager, stripBlanks, rememberMe, cachedMe, forgetMe, fmtBytes, fmtDateTime, statusBadge, openPrint, downloadReport, downloadReportHwpx, downloadWeekHwpx, downloadFile, $, $$, renderTopbar, bindTopbar, openPasswordModal, openProfileModal };
})(window);
