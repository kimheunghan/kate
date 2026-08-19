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
    rows: [],          // [{ itemId, tr, planEd, resultEd, nextEd }]
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
    applyListScopeUi();
    initToolbar();
    bindTabs();
    bindEditorPanel();
    bindExcelImport();
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
    } else {
      state.toolbar.setEnabled(false);
    }
  }

  /**
   * 조회 탭은 권한에 따라 보이는 범위가 다르다.
   *   작성자      : 본인 보고서만 → 기관·작성자 열이 의미 없으므로 숨긴다
   *   기관 관리자 : 자기 기관 전체
   *   전체 관리자 : 전부
   */
  function applyListScopeUi() {
    const role = state.me.role;
    const onlyMine = role !== 'ADMIN' && role !== 'ORG_ADMIN';

    const orgFilter = $('#f-org');
    if (orgFilter && orgFilter.closest('label')) {
      orgFilter.closest('label').classList.toggle('hidden', role !== 'ADMIN');
    }
    const note = $('#list-scope-note');
    if (note) {
      note.textContent = onlyMine
        ? '본인이 작성한 보고서만 표시됩니다.'
        : (role === 'ORG_ADMIN'
            ? `${state.me.org_name || '소속 기관'} 소속 전체 보고서가 표시됩니다.`
            : '전체 기관의 보고서가 표시됩니다.');
    }
    // 작성자 열은 항상 표시한다 (본인 확인용). 기관 열만 작성자에게 숨긴다.
    document.querySelectorAll('.col-org').forEach((el) => {
      el.classList.toggle('hidden', onlyMine);
    });
    document.querySelectorAll('.col-author').forEach((el) => {
      el.classList.remove('hidden');
    });
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
    $('#btn-del-row').disabled = readOnly;
    $('#btn-save').disabled = readOnly;
    $('#btn-print').disabled = !report;
    $('#btn-export').disabled = !report;
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
        $('#items-body').innerHTML = '<tr><td colspan="4" class="empty">등록된 항목이 없습니다.</td></tr>';
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
      <td><div class="ed-plan"></div></td>
      <td><div class="ed-result"></div></td>
      <td><div class="ed-next"></div></td>`;
    tbody.appendChild(tr);

    const onChange = () => { state.dirty = true; };
    const onFocus = (ed) => setActiveEditor(ed);

    // 세 칸 모두 같은 편집기를 사용한다 (위쪽 공용 툴바가 그대로 적용됨)
    const planEd = new window.WR.Editor(tr.querySelector('.ed-plan'), {
      html: item ? item.plan_html : '',
      placeholder: '이번 주 계획을 입력하세요', readOnly, onChange, onFocus,
    });
    const resultEd = new window.WR.Editor(tr.querySelector('.ed-result'), {
      html: item ? item.result_html : '',
      placeholder: '실제 수행한 내용을 입력하세요', readOnly, onChange, onFocus,
    });
    const nextEd = new window.WR.Editor(tr.querySelector('.ed-next'), {
      html: item ? (item.next_plan_html || '') : '',
      placeholder: '다음 주 계획을 입력하세요', readOnly, onChange, onFocus,
    });

    const row = { itemId: item ? item.id : null, tr, planEd, resultEd, nextEd };
    state.rows.push(row);

    renumber();
    return row;
  }

  function renumber() {
    state.rows.forEach((r, i) => { r.tr.querySelector('.cell-no').textContent = i + 1; });
  }

  function collectItems() {
    return state.rows.map((r) => ({
      id: r.itemId,
      plan_html: r.planEd.getHtml(),
      result_html: r.resultEd.getHtml(),
      next_plan_html: r.nextEd.getHtml(),
    })).filter((it) => it.plan_html || it.result_html || it.next_plan_html);
  }

  function bindEditorPanel() {
    $('#btn-load').onclick = () => {
      if (state.dirty && !confirm('저장하지 않은 변경사항이 있습니다. 그래도 불러올까요?')) return;
      loadCurrent();
    };
    $('#sel-week').onchange = () => $('#btn-load').click();
    $('#sel-org').onchange = () => $('#btn-load').click();
    $('#btn-add-row').onclick = () => { addRow(null, false); state.dirty = true; };

    // － : 편집 중인 항목을 지운다. 편집 중인 칸이 없으면 마지막 항목.
    //      실수로 연속 클릭해 내용이 사라지지 않도록 항상 확인을 받는다.
    $('#btn-del-row').onclick = () => {
      if (!state.rows.length) return;

      const plain = (ed) => (ed ? ed.area.textContent.replace(/\s+/g, ' ').trim() : '');

      if (state.rows.length === 1) {
        const only = state.rows[0];
        const filled = [only.planEd, only.resultEd, only.nextEd].some((ed) => plain(ed));
        if (!filled) { toast('최소 1개의 항목이 필요합니다.', true); return; }
        if (!confirm(
          '마지막 항목이라 삭제할 수 없습니다.\n\n'
          + '대신 이 항목의 ①②③ 내용을 모두 비울까요?\n'
          + '(저장하기 전이라면 [취소] 후 새로고침하면 되돌릴 수 있습니다)'
        )) return;
        [only.planEd, only.resultEd, only.nextEd].forEach((ed) => ed.setHtml(''));
        state.dirty = true;
        toast('내용을 비웠습니다.');
        return;
      }

      const active = state.activeEditor;
      let target = active
        ? state.rows.find((r) => r.planEd === active || r.resultEd === active || r.nextEd === active)
        : null;
      const byActive = !!target;
      if (!target) target = state.rows[state.rows.length - 1];

      const no = state.rows.indexOf(target) + 1;
      const preview = [plain(target.planEd), plain(target.resultEd), plain(target.nextEd)]
        .find((t) => t) || '';

      const msg = `${no}번 항목을 삭제합니다.`
        + (byActive ? '' : '  (편집 중인 칸이 없어 마지막 항목을 지웁니다)')
        + (preview ? `\n\n  "${preview.slice(0, 60)}${preview.length > 60 ? '…' : ''}"` : '\n\n  (빈 항목)')
        + '\n\n계속할까요?';
      if (!confirm(msg)) return;

      if (byActive) setActiveEditor(null);
      state.rows = state.rows.filter((r) => r !== target);
      target.tr.remove();
      state.dirty = true;
      renumber();
      toast(`${no}번 항목을 삭제했습니다.`);
    };
  }

  // ==================================================================
  // ==================================================================
  // Excel 일괄등록 — 화면에서 고른 주차로 바로 등록된다
  // ==================================================================
  function bindExcelImport() {
    $('#btn-excel-template').onclick = () => {
      location.href = '/api/reports/excel/template';
    };
    $('#btn-excel-import').onclick = () => {
      if (!Number($('#sel-week').value)) { toast('보고 주차를 먼저 선택하세요.', true); return; }
      $('#excel-file-input').click();
    };
    $('#excel-file-input').onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;

      const weekId = Number($('#sel-week').value);
      const weekLabel = $('#sel-week').selectedOptions[0]?.textContent.trim() || '';
      if (!weekId) { toast('보고 주차를 먼저 선택하세요.', true); return; }

      const msg = state.report
        ? `"${weekLabel}" 에 이미 등록된 보고서가 있습니다.\n\n`
          + `Excel 내용으로 교체됩니다. 계속할까요?`
        : `"${weekLabel}" 보고서로 등록합니다.\n계속할까요?`;
      if (!confirm(msg)) return;

      const form = new FormData();
      form.append('file', file);
      form.append('week_id', String(weekId));

      const btn = $('#btn-excel-import');
      btn.disabled = true;
      btn.textContent = '등록 중...';
      try {
        const res = await api.post('/api/reports/excel/import', form);
        state.dirty = false;
        await loadCurrent();                 // 등록된 내용을 화면에 바로 반영
        toast(res.message);
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Excel 일괄등록';
      }
    };
  }


  // ==================================================================
  // 저장 / 삭제
  // ==================================================================
  function bindSaveButtons() {
    $('#btn-save').onclick = () => {
      const items = collectItems();
      if (!items.length) { toast('내용을 하나 이상 입력하세요.', true); return; }
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
  }

  /** @returns {Promise<object|null>} 저장된 report */
  async function save(status, opts = {}) {
    const weekId = Number($('#sel-week').value);
    const orgId = Number($('#sel-org').value);
    const payload = { week_id: weekId, org_id: orgId, note: $('#note').value, status, items: collectItems() };

    const btns = [$('#btn-save')];
    btns.forEach((b) => { b.disabled = true; });

    try {
      const res = state.report
        ? await api.put(`/api/reports/${state.report.id}`, payload)
        : await api.post('/api/reports', payload);

      state.dirty = false;
      applyReport(res.report, weekId, orgId);
      if (!opts.silent) toast('저장되었습니다.');
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
      const cols = document.querySelectorAll('#tab-list thead th:not(.hidden)').length || 9;
      tbody.innerHTML = `<tr><td colspan="${cols}" class="empty">조회된 보고서가 없습니다.</td></tr>`;
      $('#list-pager').innerHTML = '';
      return;
    }

    tbody.innerHTML = res.reports.map((r) => `
      <tr>
        <td>${esc(r.week_label)}${r.is_open ? '' : ' <span class="badge closed">마감</span>'}</td>
        <td class="col-org">${esc(r.org_name)}</td>
        <td class="col-author">${esc(r.author_name || '-')}</td>
        <td class="small summary"><div class="summary-text">${esc(r.summary || '')}</div></td>
        <td class="center">${statusBadge(r.status)}</td>
        <td class="center">${r.item_count}</td>
        <td class="center">${r.file_count}</td>
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

    // 행은 이 시점에 새로 만들어지므로 열 숨김을 다시 적용해야 헤더와 어긋나지 않는다
    applyListScopeUi();

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
