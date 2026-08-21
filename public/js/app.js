/* =====================================================================
   주간보고 작성 / 조회 화면
   ===================================================================== */
(function () {
  'use strict';
  const { api, toast, esc, fmtBytes, fmtDateTime, statusBadge, openPrint, downloadReport, downloadReportHwpx, downloadWeekHwpx, $, $$ } = window.WR;

  const PAGE_SIZE = 10;                  // 목록 한 쪽에 보여 줄 건수

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
      `<option value="${w.id}">${esc(w.label)}</option>`
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

    // 보고서는 언제나 "본인 소속 기관" 으로 저장된다.
    // 총괄관리자도 마찬가지이므로 선택박스 없이 기관명만 보여준다.
    const orgSel = $('#sel-org');
    const orgText = $('#sel-org-text');
    orgSel.value = state.me.org_id || '';
    orgSel.classList.add('hidden');
    if (orgText) {
      orgText.textContent = state.me.org_name || '소속 없음';
      orgText.title = '기관은 상단 [내 정보]에서 변경할 수 있습니다.';
      orgText.classList.remove('hidden');
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

    // 내려받기 단추 정리 (지우지 않고 감추기만 한다)
    //   작성자   : 저장만
    //   관리자   : 저장 + 한글 다운로드
    //   인쇄/PDF, Word 다운로드는 아무에게도 보이지 않는다
    ['#btn-print', '#btn-export'].forEach((sel) => {
      const b = $(sel);
      if (b) b.classList.add('hidden');
    });
    const hwpxBtn = $('#btn-export-hwpx');
    if (hwpxBtn) hwpxBtn.classList.toggle('hidden', onlyMine);

    // 등록 내역 조회는 관리자만 본다. 작성자에게는 탭을 감춘다.
    // (지우지 않고 감추기만 하므로 필요하면 이 줄만 빼면 다시 보인다)
    const listTab = $$('.tabs button').find((b) => b.dataset.tab === 'list');
    if (listTab) {
      listTab.classList.toggle('hidden', onlyMine);
      // 감춘 탭에 머물러 있으면 작성 화면으로 돌려보낸다
      if (onlyMine && listTab.classList.contains('active')) {
        $$('.tabs button').find((b) => b.dataset.tab === 'write').click();
      }
    }

    // 기관 필터는 전체 관리자만 (기관 관리자는 자기 기관으로 고정되므로 불필요)
    const orgField = $('#f-org-field');
    if (orgField) orgField.classList.toggle('hidden', role !== 'ADMIN');
    const note = $('#list-scope-note');
    if (note) {
      note.textContent = onlyMine
        ? '본인이 작성한 보고서만 표시됩니다.'
        : (role === 'ORG_ADMIN'
            ? `${state.me.org_name || '소속 기관'} 소속 전체 보고서가 표시됩니다.`
            : '전체 기관의 보고서가 표시됩니다.');
    }
    // 소속·참여인력 열은 권한과 무관하게 항상 표시한다
    document.querySelectorAll('.col-org, .col-author').forEach((el) => {
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

  const KOR_DOW = ['일', '월', '화', '수', '목', '금', '토'];

  /** 2026-08-13 → 8/13.목 */
  function fmtDay(iso) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y || !m || !d) return '';
    return `${m}/${d}.${KOR_DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}`;
  }

  function fmtRange(start, end) {
    const a = fmtDay(start); const b = fmtDay(end);
    return a && b ? `${a}~${b}` : '';
  }

  /** 표 제목에 대상 기간을 표시. 향후 계획은 다음 주차 기간을 쓴다. */
  function updateTableHeads(week) {
    const cur = week ? fmtRange(week.start_date, week.end_date) : '';
    // weeks 는 최신순 정렬이므로 바로 앞 항목이 다음 주차
    const idx = week ? state.weeks.findIndex((w) => w.id === week.id) : -1;
    const nextWeek = idx > 0 ? state.weeks[idx - 1] : null;
    const nxt = nextWeek ? fmtRange(nextWeek.start_date, nextWeek.end_date) : '';

    $('#th-plan').innerHTML = `① 당초 계획${cur ? `<span class="th-date">(${cur})</span>` : ''}`;
    $('#th-result').innerHTML = `② 추진 실적${cur ? `<span class="th-date">(${cur})</span>` : ''}`;
    $('#th-next').innerHTML = `③ 향후 계획${nxt ? `<span class="th-date">(${nxt})</span>` : ''}`;
  }

  function applyReport(report, weekId, orgId) {
    state.report = report;
    state.dirty = false;

    const week = state.weeks.find((w) => w.id === weekId);
    const org = state.orgs.find((o) => o.id === orgId);
    const readOnly = report ? !report.can_edit : false;

    $('#editor-title').textContent = `${org ? org.name : ''} · ${week ? week.label : ''}`;
    updateTableHeads(week);
    $('#editor-badge').innerHTML = report ? statusBadge(report.status) : statusBadge('NONE');

    const msgs = [];
    if (report) {
      msgs.push(`<div class="alert success">등록된 보고서입니다. (작성자 ${esc(report.author_name || '-')} · 최종수정 ${fmtDateTime(report.updated_at)})</div>`);
    } else {
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
    // 남이 쓴 보고서를 열어 둔 상태에서는 엑셀 일괄등록도 막는다
    $('#btn-excel-import').disabled = readOnly;
    $('#btn-excel-import').title = readOnly
      ? '본인이 작성한 보고서에서만 사용할 수 있습니다.' : '';
    $('#btn-print').disabled = !report;
    $('#btn-export').disabled = !report;
    $('#btn-export-hwpx').disabled = !report;
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
    // Tab / Shift+Tab 으로도 들여쓰기·내어쓰기 (툴바 버튼과 같은 동작)
    const onIndent = (ed, delta) => {
      setActiveEditor(ed);
      state.toolbar._indent(delta);
    };

    // 세 칸 모두 같은 편집기를 사용한다 (위쪽 공용 툴바가 그대로 적용됨)
    const planEd = new window.WR.Editor(tr.querySelector('.ed-plan'), {
      html: item ? item.plan_html : '',
      placeholder: '이번 주 계획을 입력하세요', readOnly, onChange, onFocus, onIndent,
    });
    const resultEd = new window.WR.Editor(tr.querySelector('.ed-result'), {
      html: item ? item.result_html : '',
      placeholder: '실제 수행한 내용을 입력하세요', readOnly, onChange, onFocus, onIndent,
    });
    const nextEd = new window.WR.Editor(tr.querySelector('.ed-next'), {
      html: item ? (item.next_plan_html || '') : '',
      placeholder: '다음 주 계획을 입력하세요', readOnly, onChange, onFocus, onIndent,
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

  /**
   * 비어 있는 첫 칸을 찾는다. 다 채워져 있으면 null.
   * 화면에 보이는 글자가 없으면 비어 있는 것으로 본다.
   */
  function findEmptyCell() {
    const blank = (html) => String(html || '')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;|[\s\u00a0\u200b]/g, '') === '';

    for (let i = 0; i < state.rows.length; i++) {
      const r = state.rows[i];
      const cells = [
        ['① 당초 계획', r.planEd],
        ['② 추진 실적', r.resultEd],
        ['③ 향후 계획', r.nextEd],
      ];
      // 아무것도 안 쓴 줄은 저장에서 빠지므로 검사하지 않는다
      if (cells.every(([, ed]) => blank(ed.getHtml()))) continue;
      const empty = cells.find(([, ed]) => blank(ed.getHtml()));
      if (empty) return { no: i + 1, label: empty[0], editor: empty[1] };
    }
    return null;
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
    //      항목이 하나만 남았을 때만 확인을 받는다 (그 외에는 바로 삭제).
    $('#btn-del-row').onclick = () => {
      if (!state.rows.length) return;

      const plain = (ed) => (ed ? ed.area.textContent.replace(/\s+/g, ' ').trim() : '');

      if (state.rows.length === 1) {
        const only = state.rows[0];
        const filled = [only.planEd, only.resultEd, only.nextEd].some((ed) => plain(ed));
        if (!filled) { toast('최소 1개의 항목이 필요합니다.', true); return; }
        if (!confirm('주간보고 작성 내용이 전부 삭제됩니다.')) return;
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
      window.WR.downloadFile('/api/reports/excel/template', '주간보고_양식.xlsx');
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

      // 화면에 쓰던 내용이 있으면 지워도 되는지 먼저 묻는다
      const strip = (h) => String(h || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim();
      const hasContent = collectItems()
        .some((it) => strip(it.plan_html) || strip(it.result_html) || strip(it.next_plan_html));
      if (hasContent
          && !confirm(`${weekLabel} 화면에 작성한 내용이 있습니다.\n엑셀 내용으로 바꿀까요?\n\n(저장을 눌러야 실제로 등록됩니다)`)) return;

      const form = new FormData();
      form.append('file', file);

      const btn = $('#btn-excel-import');
      btn.disabled = true;
      btn.textContent = '읽는 중...';
      try {
        // 엑셀은 화면으로 불러오기만 한다. 등록은 [저장] 을 눌러야 이뤄진다.
        const res = await api.post('/api/reports/excel/preview', form);
        renderItems(res.items, false);
        state.dirty = true;
        toast(`엑셀에서 ${res.count}건을 불러왔습니다. 확인 후 [저장]을 누르세요.`);
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

      // 세 칸(당초 계획·추진 실적·향후 계획)을 모두 채워야 한다
      const missing = findEmptyCell();
      if (missing) {
        toast(`${missing.no}번 항목의 ${missing.label} 을(를) 입력하세요.`, true);
        missing.editor.area.focus();
        return;
      }
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
    $('#btn-export-hwpx').onclick = () => {
      if (!state.report) return;
      downloadReportHwpx(state.report.id);
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
    // 아직 저장 전이면 먼저 저장한다 (첨부는 보고서 id 가 필요)
    if (!state.report) {
      toast('보고서를 먼저 저장합니다...');
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

    // 건수는 아래 별도 줄이 아니라 제목 옆 괄호에 표시한다
    const cnt = $('#files-count');
    if (cnt) cnt.textContent = list && list.length ? `(${list.length}건)` : '';

    if (!list || !list.length) return;

    list.forEach((a) => {
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="fname"><a href="#" data-dl="${a.id}">${esc(a.original_name)}</a></span>
        <span class="fmeta">${fmtBytes(a.byte_size)} · ${fmtDateTime(a.created_at)}</span>
        ${readOnly ? '' : '<button class="btn sm danger" type="button">삭제</button>'}`;
      const link = li.querySelector('[data-dl]');
      if (link) {
        link.onclick = (e) => {
          e.preventDefault();
          window.WR.downloadFile(`/api/attachments/${a.id}/download`, a.original_name);
        };
      }

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
  // 주차를 고르면 그 주차 한 파일, 안 고르면 주차마다 한 파일씩 묶은 ZIP
  function updateWeekDownloadButton() {
    const btn = $('#btn-week-hwpx');
    if (!btn) return;
    const one = !!$('#f-week').value;
    $('#dl-label').textContent = one ? '해당 주차 한글 다운로드(HWPX)' : '전체 주차 ZIP 다운로드';
    btn.title = one
      ? '선택한 주차의 보고서를 한글 문서 한 개로 내려받습니다.'
      : '주차마다 한글 문서를 만들어 ZIP 한 개로 묶어 내려받습니다.';
    $('#dl-note').innerHTML = one
      ? '<span class="mark">※</span> 선택한 주차만 한글 문서로 내려받습니다.'
      : '<span class="mark">※</span> 한 주차만 받으시려면 위에서 주차를 먼저 선택하세요.';
  }

  function bindListTab() {
    $('#btn-search').onclick = () => searchList(1);
    ['#f-week', '#f-org'].forEach((s) => { $(s).onchange = () => searchList(1); });
    $('#f-week').addEventListener('change', updateWeekDownloadButton);
    updateWeekDownloadButton();

    $('#btn-week-hwpx').onclick = () => {
      const weekId = $('#f-week').value;
      if (!weekId) toast('전체 주차는 ZIP으로 묶어 다운로드됩니다.');
      downloadWeekHwpx(weekId, $('#f-org') ? $('#f-org').value : '');
    };
  }

  async function searchList(page) {
    state.listPage = page || 1;
    const p = new URLSearchParams({ page: state.listPage, size: PAGE_SIZE });
    if ($('#f-week').value)   p.set('week_id', $('#f-week').value);
    if ($('#f-org').value)    p.set('org_id', $('#f-org').value);

    try {
      const res = await api.get('/api/reports?' + p.toString());
      renderList(res);
    } catch (e) { toast(e.message, true); }
  }

  /** 내용 요약에서 한 번에 보여줄 항목 줄 수 (넘치면 '외 N건') */
  const MAX_SUMMARY_LINES = 5;

  function renderList(res) {
    const tbody = $('#list-body');
    if (!res.reports.length) {
      const cols = document.querySelectorAll('#tab-list thead th:not(.hidden)').length || 9;
      tbody.innerHTML = `<tr><td colspan="${cols}" class="empty">조회된 보고서가 없습니다.</td></tr>`;
      $('#list-count').textContent = '보고서 목록 (총 0건)';
      $('#list-pager-bottom').innerHTML = '';
      return;
    }

    tbody.innerHTML = res.reports.map((r) => `
      <tr>
        <td class="col-org">${esc(r.org_name)}</td>
        <td class="col-author">${esc(r.author_name || '-')}</td>
        <td>${esc(r.week_label)}</td>
        <td class="small summary">${
          (r.summary_lines || []).slice(0, MAX_SUMMARY_LINES)
            .map((line) => `<div class="sum-line">${esc(line)}</div>`).join('')
          + ((r.summary_lines || []).length > MAX_SUMMARY_LINES
              ? `<div class="sum-more">… 외 ${(r.summary_lines || []).length - MAX_SUMMARY_LINES}건</div>` : '')
        }</td>
        <td class="center">${statusBadge(r.status)}</td>
        <td class="center">${r.file_count}</td>
        <td class="small">${fmtDateTime(r.updated_at)}</td>
        <td class="center nowrap">
          <button class="btn sm" data-open="${r.id}">열기</button>
          <button class="btn sm" data-hwpx="${r.id}" title="아래한글 문서(HWPX)로 내려받기">한글</button>
        </td>
      </tr>`).join('');

    tbody.querySelectorAll('[data-open]').forEach((b) => {
      b.onclick = async () => {
        $$('.tabs button').find((x) => x.dataset.tab === 'write').click();
        await openReportById(Number(b.dataset.open));
        window.scrollTo({ top: 0, behavior: 'smooth' });
      };
    });
    tbody.querySelectorAll('[data-hwpx]').forEach((b) => {
      b.onclick = () => downloadReportHwpx(b.dataset.hwpx);
    });

    // 행은 이 시점에 새로 만들어지므로 열 숨김을 다시 적용해야 헤더와 어긋나지 않는다
    applyListScopeUi();

    const pages = Math.ceil(res.total / res.size);
    $('#list-count').textContent = `보고서 목록 (총 ${res.total}건)`;
    // 쪽 이동은 표 아래 가운데 (몇 쪽인지도 거기 나온다)
    window.WR.renderPager($('#list-pager-bottom'), {
      page: res.page, pages, onGo: (n) => searchList(n),
    });
  }

  init();
})();
