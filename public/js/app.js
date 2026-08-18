/* =====================================================================
   주간보고 작성 / 조회 화면
   ===================================================================== */
(function () {
  'use strict';
  const { api, toast, esc, fmtBytes, fmtDateTime, statusBadge, openPrint, downloadReport, $, $$ } = window.WR;

  const state = {
    me: null,
    weeks: [],
    orgs: [],
    report: null,      // 현재 로드된 보고서 (없으면 null)
    rows: [],          // [{ itemId, tr, titleEd, planEd, resultEd }]
    toolbar: null,     // 공용 편집 툴바 (SharedToolbar)
    activeEditor: null,// 현재 편집 중인 Editor
    dirty: false,
    listPage: 1,
  };

  // ==================================================================
  // 초기화
  // ==================================================================
  async function init() {
    try {
      const me = await api.get('/api/auth/me');
      state.me = me.user;
    } catch (e) { return; }   // api.js 가 /login 으로 보냄

    $('#topbar').innerHTML = window.WR.renderTopbar(state.me, 'report');
    window.WR.bindTopbar();

    if (sessionStorage.getItem('wr_force_pw')) {
      sessionStorage.removeItem('wr_force_pw');
      setTimeout(() => {
        toast('초기 비밀번호입니다. 비밀번호를 변경해 주세요.', true);
        window.WR.openPasswordModal();
      }, 400);
    }

    const [weeksRes, orgsRes] = await Promise.all([api.get('/api/weeks'), api.get('/api/orgs')]);
    state.weeks = weeksRes.weeks;
    state.orgs = orgsRes.orgs;

    fillWeekSelects();
    fillOrgSelects();
    initToolbar();
    bindTabs();
    bindEditorPanel();
    bindFiles();
    bindSaveButtons();
    bindListTab();

    // URL 파라미터로 특정 보고서 바로 열기 (?report=12)
    const params = new URLSearchParams(location.search);
    if (params.get('report')) {
      await openReportById(Number(params.get('report')));
    } else {
      await loadCurrent();
    }

    window.addEventListener('beforeunload', (e) => {
      if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  function fillWeekSelects() {
    const opts = state.weeks.map((w) =>
      `<option value="${w.id}"${w.is_open ? '' : ' data-closed="1"'}>${esc(w.label)}${w.is_open ? '' : ' [마감]'}</option>`
    ).join('');
    $('#sel-week').innerHTML = opts;
    $('#f-week').innerHTML = '<option value="">전체</option>' + opts;

    // 오늘 기준 주차를 기본 선택
    const today = new Date().toISOString().slice(0, 10);
    const cur = state.weeks.find((w) => w.start_date <= today && today <= w.end_date) || state.weeks[0];
    if (cur) $('#sel-week').value = cur.id;
  }

  function fillOrgSelects() {
    const opts = state.orgs.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
    $('#sel-org').innerHTML = opts;
    $('#f-org').innerHTML = '<option value="">전체</option>' + opts;

    if (state.me.role !== 'ADMIN') {
      $('#sel-org').value = state.me.org_id || '';
      $('#sel-org').disabled = true;
    } else if (state.me.org_id) {
      $('#sel-org').value = state.me.org_id;
    }
  }

  /** 표 위의 공용 툴바를 만든다 (칸마다 툴바를 붙이지 않기 위함) */
  function initToolbar() {
    state.toolbar = new window.WR.SharedToolbar($('#shared-toolbar'), {
      getActive: () => state.activeEditor,
    });
  }

  /** 현재 편집 중인 칸을 툴바에 연결하고, 해당 칸을 시각적으로 표시 */
  function setActiveEditor(ed) {
    if (state.activeEditor === ed) { if (ed) state.toolbar.syncState(); return; }

    if (state.activeEditor) state.activeEditor.area.classList.remove('active');
    state.activeEditor = ed;

    if (ed) {
      ed.area.classList.add('active');
      state.toolbar.setEnabled(true);
      state.toolbar.syncState();
      $('#toolbar-hint').classList.add('hidden');
    } else {
      state.toolbar.setEnabled(false);
      $('#toolbar-hint').classList.remove('hidden');
    }
  }

  function bindTabs() {
    $$('.tabs button').forEach((b) => {
      b.onclick = () => {
        $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
        const isWrite = b.dataset.tab === 'write';
        $('#tab-write').classList.toggle('hidden', !isWrite);
        $('#tab-list').classList.toggle('hidden', isWrite);
        ['#editor-panel', '#files-panel', '#save-panel'].forEach((s) =>
          $(s).classList.toggle('hidden', !isWrite));
        if (!isWrite) searchList(1);
      };
    });
  }

  // ==================================================================
  // 보고서 로드
  // ==================================================================
  async function loadCurrent() {
    const weekId = Number($('#sel-week').value);
    const orgId = Number($('#sel-org').value);
    if (!weekId) return;
    if (!orgId) {
      $('#write-status').innerHTML =
        '<div class="alert error">소속 기관이 지정되지 않았습니다. 관리자에게 기관 배정을 요청하세요.</div>';
      return;
    }

    try {
      const res = await api.get(`/api/reports/lookup?week_id=${weekId}&org_id=${orgId}`);
      applyReport(res.report, weekId, orgId);
    } catch (e) { toast(e.message, true); }
  }

  async function openReportById(id) {
    try {
      const res = await api.get(`/api/reports/${id}`);
      const r = res.report;
      $('#sel-week').value = r.week_id;
      $('#sel-org').value = r.org_id;
      applyReport(r, r.week_id, r.org_id);
    } catch (e) { toast(e.message, true); }
  }

  function applyReport(report, weekId, orgId) {
    state.report = report;
    state.dirty = false;

    const week = state.weeks.find((w) => w.id === weekId);
    const org = state.orgs.find((o) => o.id === orgId);
    const closed = week && !week.is_open;
    const readOnly = report ? !report.can_edit : (closed && state.me.role !== 'ADMIN');

    $('#editor-title').textContent = `${org ? org.name : ''} · ${week ? week.label : ''}`;
    $('#editor-badge').innerHTML =
      (report ? statusBadge(report.status) : statusBadge('NONE')) +
      (closed ? ' <span class="badge closed">마감</span>' : '');

    const msgs = [];
    if (closed) {
      msgs.push(state.me.role === 'ADMIN'
        ? '<div class="alert info">마감된 주차입니다. 관리자 권한으로 수정할 수 있습니다.</div>'
        : '<div class="alert error">마감된 주차입니다. 조회만 가능합니다.</div>');
    }
    if (report) {
      msgs.push(`<div class="alert success">등록된 보고서입니다. (작성자 ${esc(report.author_name || '-')} · 최종수정 ${fmtDateTime(report.updated_at)})</div>`);
    } else if (!closed) {
      msgs.push('<div class="alert info">해당 주차에 등록된 보고서가 없습니다. 아래에서 새로 작성하세요.</div>');
    }
    $('#write-status').innerHTML = msgs.join('');

    renderItems(report ? report.items : [], readOnly);
    $('#note').value = report ? (report.note || '') : '';
    $('#note').disabled = readOnly;
    $('#note').oninput = () => { state.dirty = true; };

    renderAttachments(report ? report.attachments : [], readOnly);

    // 버튼 활성/비활성
    $('#btn-add-row').disabled = readOnly;
    $('#btn-copy-prev').disabled = readOnly;
    $('#btn-save').disabled = readOnly;
    $('#btn-submit').disabled = readOnly;
    $('#btn-delete').disabled = readOnly || !report;
    $('#btn-print').disabled = !report;
    $('#btn-export').disabled = !report;
    $('#btn-submit').textContent = report && report.status === 'SUBMITTED' ? '제출 내용 갱신' : '제출하기';
  }

  // ==================================================================
  // 항목(업무) 편집 그리드
  // ==================================================================
  function renderItems(items, readOnly) {
    setActiveEditor(null);
    $('#items-body').innerHTML = '';
    state.rows = [];
    if (!items || !items.length) {
      if (readOnly) {
        $('#items-body').innerHTML = '<tr><td colspan="5" class="empty">등록된 항목이 없습니다.</td></tr>';
        return;
      }
      addRow(null, readOnly);
      return;
    }
    items.forEach((it) => addRow(it, readOnly));
  }

  function addRow(item, readOnly) {
    const tbody = $('#items-body');
    const empty = tbody.querySelector('.empty');
    if (empty) tbody.innerHTML = '';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="cell-no"></td>
      <td><div class="ed-title"></div></td>
      <td><div class="ed-plan"></div></td>
      <td><div class="ed-result"></div></td>
      <td class="cell-act">
        <button class="btn sm danger btn-del-row" type="button">삭제</button>
        <button class="btn sm btn-up" type="button">▲</button>
        <button class="btn sm btn-down" type="button">▼</button>
      </td>`;
    tbody.appendChild(tr);

    const onChange = () => { state.dirty = true; };
    const onFocus = (ed) => setActiveEditor(ed);

    // 세 칸 모두 같은 편집기를 사용한다 (위쪽 공용 툴바가 그대로 적용됨)
    const titleEd = new window.WR.Editor(tr.querySelector('.ed-title'), {
      html: item ? item.task_title : '', placeholder: '예) 3. 토지 공간정보 및 규제 속성 데이터 통합 구축',
      readOnly, onChange, onFocus,
    });
    const planEd = new window.WR.Editor(tr.querySelector('.ed-plan'), {
      html: item ? item.plan_html : '', placeholder: '이번 주 계획을 입력하세요', readOnly, onChange, onFocus,
    });
    const resultEd = new window.WR.Editor(tr.querySelector('.ed-result'), {
      html: item ? item.result_html : '', placeholder: '실제 수행한 내용을 입력하세요', readOnly, onChange, onFocus,
    });

    const row = { itemId: item ? item.id : null, tr, titleEd, planEd, resultEd };
    state.rows.push(row);

    if (readOnly) {
      tr.querySelector('.cell-act').innerHTML = '<span class="muted small">-</span>';
    } else {
      tr.querySelector('.btn-del-row').onclick = () => {
        if (state.rows.length === 1) { toast('최소 1개의 업무가 필요합니다.', true); return; }
        if (!confirm('이 업무 행을 삭제할까요?\n(저장해야 실제로 반영됩니다)')) return;
        state.rows = state.rows.filter((r) => r !== row);
        tr.remove();
        state.dirty = true;
        renumber();
      };
      tr.querySelector('.btn-up').onclick = () => moveRow(row, -1);
      tr.querySelector('.btn-down').onclick = () => moveRow(row, 1);
    }

    renumber();
    return row;
  }

  function moveRow(row, delta) {
    const i = state.rows.indexOf(row);
    const j = i + delta;
    if (j < 0 || j >= state.rows.length) return;

    // 에디터 DOM 을 옮기면 내용이 유지되므로 HTML 을 주고받는다
    const other = state.rows[j];
    const swap = (a, b) => {
      const t1 = a.titleEd.getHtml(), p1 = a.planEd.getHtml(), r1 = a.resultEd.getHtml(), id1 = a.itemId;
      a.titleEd.setHtml(b.titleEd.getHtml()); a.planEd.setHtml(b.planEd.getHtml());
      a.resultEd.setHtml(b.resultEd.getHtml()); a.itemId = b.itemId;
      b.titleEd.setHtml(t1); b.planEd.setHtml(p1); b.resultEd.setHtml(r1); b.itemId = id1;
    };
    swap(row, other);
    state.dirty = true;
  }

  function renumber() {
    state.rows.forEach((r, i) => { r.tr.querySelector('.cell-no').textContent = i + 1; });
  }

  function collectItems() {
    return state.rows.map((r) => ({
      id: r.itemId,
      task_title: r.titleEd.getHtml(),
      plan_html: r.planEd.getHtml(),
      result_html: r.resultEd.getHtml(),
    })).filter((it) => it.task_title || it.plan_html || it.result_html);
  }

  function bindEditorPanel() {
    $('#btn-load').onclick = () => {
      if (state.dirty && !confirm('저장하지 않은 변경사항이 있습니다. 그래도 불러올까요?')) return;
      loadCurrent();
    };
    $('#sel-week').onchange = () => $('#btn-load').click();
    $('#sel-org').onchange = () => $('#btn-load').click();
    $('#btn-add-row').onclick = () => { addRow(null, false); state.dirty = true; };
    $('#btn-copy-prev').onclick = copyFromPreviousWeek;
  }

  async function copyFromPreviousWeek() {
    const weekId = Number($('#sel-week').value);
    const orgId = Number($('#sel-org').value);
    const idx = state.weeks.findIndex((w) => w.id === weekId);
    const prev = state.weeks[idx + 1];      // weeks 는 최신순 정렬
    if (!prev) { toast('직전 주차 정보가 없습니다.', true); return; }

    try {
      const res = await api.get(`/api/reports/lookup?week_id=${prev.id}&org_id=${orgId}`);
      if (!res.report || !res.report.items.length) {
        toast(`직전 주차(${prev.label})에 등록된 보고서가 없습니다.`, true);
        return;
      }
      if (!confirm(`직전 주차(${prev.label})의 업무명과 계획을 가져옵니다.\n현재 작성 중인 내용은 대체됩니다. 계속할까요?`)) return;

      // 새 행으로 복사 (id 는 비워서 새 항목으로 저장되게)
      const copied = res.report.items.map((it) => ({
        id: null, task_title: it.task_title, plan_html: it.plan_html, result_html: '',
      }));
      renderItems(copied, false);
      state.dirty = true;
      toast(`${copied.length}개 업무를 가져왔습니다. 실적을 입력하세요.`);
    } catch (e) { toast(e.message, true); }
  }

  // ==================================================================
  // 저장 / 삭제
  // ==================================================================
  function bindSaveButtons() {
    $('#btn-save').onclick = () => save('DRAFT');
    $('#btn-submit').onclick = () => {
      const items = collectItems();
      if (!items.length) { toast('내용을 하나 이상 입력하세요.', true); return; }
      const stripTags = (h) => String(h || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim();
      const missing = items.filter((it) => !stripTags(it.task_title));
      if (missing.length && !confirm('업무명이 비어 있는 항목이 있습니다. 그래도 제출할까요?')) return;
      if (!confirm('제출하시겠습니까?\n제출 후에도 마감 전까지는 수정할 수 있습니다.')) return;
      save('SUBMITTED');
    };
    $('#btn-print').onclick = () => {
      if (!state.report) return;
      openPrint(state.report.id);
    };
    $('#btn-export').onclick = () => {
      if (!state.report) return;
      downloadReport(state.report.id);
    };
    $('#btn-delete').onclick = async () => {
      if (!state.report) return;
      if (!confirm('이 주간보고를 삭제합니다.\n등록된 항목과 첨부파일도 함께 삭제되며 되돌릴 수 없습니다. 계속할까요?')) return;
      try {
        await api.del(`/api/reports/${state.report.id}`);
        toast('삭제되었습니다.');
        state.dirty = false;
        await loadCurrent();
      } catch (e) { toast(e.message, true); }
    };
  }

  /** @returns {Promise<object|null>} 저장된 report */
  async function save(status, opts = {}) {
    const weekId = Number($('#sel-week').value);
    const orgId = Number($('#sel-org').value);
    const payload = { week_id: weekId, org_id: orgId, note: $('#note').value, status, items: collectItems() };

    const btns = [$('#btn-save'), $('#btn-submit')];
    btns.forEach((b) => { b.disabled = true; });

    try {
      const res = state.report
        ? await api.put(`/api/reports/${state.report.id}`, payload)
        : await api.post('/api/reports', payload);

      state.dirty = false;
      applyReport(res.report, weekId, orgId);
      if (!opts.silent) toast(status === 'SUBMITTED' ? '제출되었습니다.' : '임시저장되었습니다.');
      return res.report;
    } catch (e) {
      toast(e.message, true);
      return null;
    } finally {
      btns.forEach((b) => { b.disabled = false; });
    }
  }

  // ==================================================================
  // 첨부파일
  // ==================================================================
  function bindFiles() {
    const dz = $('#dropzone');
    const input = $('#file-input');

    dz.onclick = () => input.click();
    input.onchange = () => { if (input.files.length) uploadFiles(input.files); input.value = ''; };

    ['dragenter', 'dragover'].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
    dz.addEventListener('drop', (e) => {
      if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
    });
  }

  async function uploadFiles(fileList) {
    // 아직 저장 전이면 임시저장부터 수행 (첨부는 보고서 id 가 필요)
    if (!state.report) {
      toast('보고서를 먼저 임시저장합니다...');
      const saved = await save('DRAFT', { silent: true });
      if (!saved) return;
    }
    if (!state.report.can_edit) { toast('첨부 권한이 없습니다.', true); return; }

    const fd = new FormData();
    for (const f of fileList) fd.append('files', f);

    $('#dz-hint').textContent = `업로드 중... (${fileList.length}개)`;
    try {
      const res = await api.post(`/api/reports/${state.report.id}/attachments`, fd);
      state.report.attachments = (state.report.attachments || []).concat(res.attachments);
      renderAttachments(state.report.attachments, false);
      toast(`${res.attachments.length}개 파일이 첨부되었습니다.`);
    } catch (e) {
      toast(e.message, true);
    } finally {
      $('#dz-hint').textContent = '';
    }
  }

  function renderAttachments(list, readOnly) {
    const ul = $('#file-list');
    ul.innerHTML = '';
    $('#dropzone').classList.toggle('hidden', !!readOnly);

    if (!list || !list.length) {
      $('#files-note').textContent = readOnly ? '첨부된 자료가 없습니다.' : '';
      return;
    }
    $('#files-note').textContent = `총 ${list.length}건`;

    list.forEach((a) => {
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="fname"><a href="/api/attachments/${a.id}/download">${esc(a.original_name)}</a></span>
        <span class="fmeta">${fmtBytes(a.byte_size)} · ${fmtDateTime(a.created_at)}</span>
        ${readOnly ? '' : '<button class="btn sm danger" type="button">삭제</button>'}`;
      const btn = li.querySelector('button');
      if (btn) {
        btn.onclick = async () => {
          if (!confirm(`"${a.original_name}" 을(를) 삭제할까요?`)) return;
          try {
            await api.del(`/api/attachments/${a.id}`);
            state.report.attachments = state.report.attachments.filter((x) => x.id !== a.id);
            renderAttachments(state.report.attachments, false);
            toast('삭제되었습니다.');
          } catch (e) { toast(e.message, true); }
        };
      }
      ul.appendChild(li);
    });
  }

  // ==================================================================
  // 조회 탭
  // ==================================================================
  function bindListTab() {
    $('#btn-search').onclick = () => searchList(1);
    $('#f-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchList(1); });
    ['#f-week', '#f-org', '#f-status'].forEach((s) => { $(s).onchange = () => searchList(1); });
  }

  async function searchList(page) {
    state.listPage = page || 1;
    const p = new URLSearchParams({ page: state.listPage, size: 20 });
    if ($('#f-week').value)   p.set('week_id', $('#f-week').value);
    if ($('#f-org').value)    p.set('org_id', $('#f-org').value);
    if ($('#f-status').value) p.set('status', $('#f-status').value);
    if ($('#f-q').value.trim()) p.set('q', $('#f-q').value.trim());

    try {
      const res = await api.get('/api/reports?' + p.toString());
      renderList(res);
    } catch (e) { toast(e.message, true); }
  }

  function renderList(res) {
    const tbody = $('#list-body');
    if (!res.reports.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">조회된 보고서가 없습니다.</td></tr>';
      $('#list-pager').innerHTML = '';
      return;
    }

    tbody.innerHTML = res.reports.map((r) => `
      <tr>
        <td>${esc(r.week_label)}${r.is_open ? '' : ' <span class="badge closed">마감</span>'}</td>
        <td>${esc(r.org_name)}</td>
        <td class="center">${statusBadge(r.status)}</td>
        <td class="center">${r.item_count}</td>
        <td class="center">${r.file_count}</td>
        <td>${esc(r.author_name || '-')}</td>
        <td class="small">${fmtDateTime(r.updated_at)}</td>
        <td class="center nowrap">
          <button class="btn sm" data-open="${r.id}">열기</button>
          <button class="btn sm" data-print="${r.id}">인쇄</button>
          <button class="btn sm" data-export="${r.id}"
                  title="한글문서(HWP) 변환은 현재 [Word 다운로드] 하신 후 한글에서 Word문서를 열어서 다른 이름(확장자 .hwp)으로 저장하시기 바랍니다.">Word</button>
        </td>
      </tr>`).join('');

    tbody.querySelectorAll('[data-open]').forEach((b) => {
      b.onclick = async () => {
        $$('.tabs button').find((x) => x.dataset.tab === 'write').click();
        await openReportById(Number(b.dataset.open));
        window.scrollTo({ top: 0, behavior: 'smooth' });
      };
    });
    tbody.querySelectorAll('[data-print]').forEach((b) => {
      b.onclick = () => openPrint(b.dataset.print);
    });
    tbody.querySelectorAll('[data-export]').forEach((b) => {
      b.onclick = () => downloadReport(b.dataset.export);
    });

    const pages = Math.ceil(res.total / res.size);
    $('#list-pager').innerHTML = pages <= 1 ? `<span class="small muted">총 ${res.total}건</span>` : `
      <button class="btn sm" ${res.page <= 1 ? 'disabled' : ''} id="pg-prev">이전</button>
      <span class="small muted">${res.page} / ${pages} (총 ${res.total}건)</span>
      <button class="btn sm" ${res.page >= pages ? 'disabled' : ''} id="pg-next">다음</button>`;
    if ($('#pg-prev')) $('#pg-prev').onclick = () => searchList(res.page - 1);
    if ($('#pg-next')) $('#pg-next').onclick = () => searchList(res.page + 1);
  }

  init();
})();
