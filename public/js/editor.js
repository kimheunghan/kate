/* =====================================================================
   경량 리치텍스트 에디터 (외부 라이브러리 없음)

   구조:
     Editor        - 입력 영역만 담당 (툴바 없음)
     SharedToolbar - 화면 위쪽에 하나만 두고, 현재 편집 중인 Editor 에 적용

   칸마다 툴바를 붙이면 표가 툴바로 가득 차므로 툴바를 하나로 합쳤다.
   버튼을 눌러도 편집 영역의 선택 범위가 유지되도록 Range 를 저장/복원한다.
   ===================================================================== */
(function (global) {
  'use strict';

  const FONTS = [
    ['', '글꼴'],
    ['Malgun Gothic', '맑은 고딕'],
    ['Gulim', '굴림'],
    ['Dotum', '돋움'],
    ['Batang', '바탕'],
    ['Nanum Gothic', '나눔고딕'],
    ['Arial', 'Arial'],
    ['Times New Roman', 'Times'],
    ['Consolas', 'Consolas'],
  ];

  const SIZES = [
    ['', '크기'], ['1', '8pt'], ['2', '10pt'], ['3', '12pt'],
    ['4', '14pt'], ['5', '18pt'], ['6', '24pt'], ['7', '36pt'],
  ];

  const PASTE_TAGS = new Set([
    'P','DIV','SPAN','BR','HR','B','STRONG','I','EM','U','S','STRIKE','DEL','INS','SUB','SUP','MARK','FONT',
    'UL','OL','LI','BLOCKQUOTE','PRE','CODE','H1','H2','H3','H4','H5','H6',
    'TABLE','THEAD','TBODY','TFOOT','TR','TH','TD','CAPTION','COLGROUP','COL','A','IMG',
  ]);
  const PASTE_ATTRS = new Set(['style','href','src','alt','width','height','colspan','rowspan','align','border','color','face','size','start','type']);

  // 붙여넣기 때 딸려오는, 사용자가 의도하지 않은 스타일
  //  - text-indent : 한글/워드에서 음수 값이 넘어와 글자가 칸 밖으로 밀려난다
  //  - background-color 가 흰색에 가까우면 편집기 배경이 복사된 것이므로 버린다
  const DROP_CSS = new Set(['text-indent', 'letter-spacing', 'line-height', 'margin', 'margin-left', 'margin-right']);

  function isNearWhite(v) {
    const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(v);
    if (m) return Number(m[1]) > 245 && Number(m[2]) > 245 && Number(m[3]) > 235;
    return /^#(f{3}|f{6}|fff[0-9a-f]{3}|f[0-9a-f]f{4})$/i.test(v.trim()) || /^(white|transparent)$/i.test(v.trim());
  }

  function cleanStyle(raw) {
    const out = [];
    for (const decl of String(raw).split(';')) {
      const i = decl.indexOf(':');
      if (i < 1) continue;
      const prop = decl.slice(0, i).trim().toLowerCase();
      const val = decl.slice(i + 1).trim();
      if (!prop || !val) continue;
      if (DROP_CSS.has(prop)) continue;
      if ((prop === 'background-color' || prop === 'background') && isNearWhite(val)) continue;
      out.push(`${prop}: ${val}`);
    }
    return out.join('; ');
  }

  function cleanFragment(html) {
    const doc = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html');
    const walk = (node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 8) { child.remove(); continue; }
        if (child.nodeType !== 1) continue;

        if (!PASTE_TAGS.has(child.tagName)) {
          if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' || child.tagName === 'IFRAME') {
            child.remove();
          } else {
            while (child.firstChild) child.parentNode.insertBefore(child.firstChild, child);
            child.remove();
          }
          continue;
        }
        for (const attr of Array.from(child.attributes)) {
          const n = attr.name.toLowerCase();
          if (!PASTE_ATTRS.has(n) || n.startsWith('on')) { child.removeAttribute(attr.name); continue; }
          if ((n === 'href' || n === 'src') && /^\s*(javascript|vbscript|data:text)/i.test(attr.value)) {
            child.removeAttribute(attr.name);
          }
          if (n === 'style') {
            const cleaned = cleanStyle(attr.value);
            if (cleaned) child.setAttribute('style', cleaned);
            else child.removeAttribute('style');
          }
        }
        walk(child);
      }
    };
    walk(doc.body);
    return doc.body.innerHTML;
  }

  // ===================================================================
  //  Editor : 입력 영역
  // ===================================================================
  class Editor {
    /**
     * @param {HTMLElement} host
     * @param {{placeholder?:string, html?:string, readOnly?:boolean,
     *          onChange?:Function, onFocus?:Function}} opts
     */
    constructor(host, opts = {}) {
      this.opts = opts;
      this.readOnly = !!opts.readOnly;
      this.savedRange = null;

      host.classList.add('editor');
      host.innerHTML = '';

      this.area = document.createElement('div');
      this.area.className = 'editor-area';
      this.area.contentEditable = this.readOnly ? 'false' : 'true';
      this.area.spellcheck = false;
      this.area.setAttribute('data-placeholder', opts.placeholder || '내용을 입력하세요');
      this.area.innerHTML = opts.html || '';
      host.appendChild(this.area);

      if (!this.readOnly) this._bind();
    }

    // ---------------------------------------------------------------- API
    getHtml() {
      const h = this.area.innerHTML.trim();
      if (h === '<br>' || h === '<p><br></p>' || h === '<div><br></div>') return '';
      return h;
    }

    setHtml(html) { this.area.innerHTML = html || ''; }

    isEmpty() { return !this.area.textContent.trim() && !this.area.querySelector('img'); }

    focus() { this.area.focus(); this.restoreRange(); }

    /** 현재 선택 범위를 기억해 둔다 (툴바 클릭으로 포커스가 옮겨가도 복원 가능) */
    saveRange() {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const r = sel.getRangeAt(0);
      if (this.area.contains(r.commonAncestorContainer)) this.savedRange = r.cloneRange();
    }

    restoreRange() {
      if (!this.savedRange) return;
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(this.savedRange);
    }

    /** 서식 명령 실행 (SharedToolbar 가 호출) */
    exec(cmd, value) {
      if (this.readOnly) return;
      this.area.focus();
      this.restoreRange();
      try { document.execCommand('styleWithCSS', false, true); } catch (e) { /* noop */ }
      document.execCommand(cmd, false, value ?? null);
      this.saveRange();
      this._changed();
    }

    insertHtml(html) {
      if (this.readOnly) return;
      this.area.focus();
      this.restoreRange();
      document.execCommand('insertHTML', false, html);
      this.saveRange();
      this._changed();
    }

    /** 외부(툴바)에서 내용을 바꾼 뒤 변경을 알릴 때 사용 */
    touch() { this.saveRange(); this._changed(); }

    _changed() { if (this.opts.onChange) this.opts.onChange(this); }

    _bind() {
      this.area.addEventListener('input', () => { this.saveRange(); this._changed(); });

      const track = () => {
        this.saveRange();
        if (this.opts.onFocus) this.opts.onFocus(this);
      };
      this.area.addEventListener('focus', track);
      this.area.addEventListener('keyup', track);
      this.area.addEventListener('mouseup', track);

      // 붙여넣기: 서식은 살리되 위험 요소 제거
      this.area.addEventListener('paste', (e) => {
        const dt = e.clipboardData;
        if (!dt) return;

        const imgItem = Array.from(dt.items || []).find((i) => i.type.startsWith('image/'));
        if (imgItem) {
          const file = imgItem.getAsFile();
          if (file) {
            e.preventDefault();
            if (file.size > 1.5 * 1024 * 1024) {
              global.WR.toast('붙여넣는 이미지는 1.5MB 이하만 가능합니다. 큰 파일은 첨부를 이용하세요.', true);
              return;
            }
            const fr = new FileReader();
            fr.onload = () => this.insertHtml(`<img src="${fr.result}" style="max-width: 100%">`);
            fr.readAsDataURL(file);
            return;
          }
        }

        const html = dt.getData('text/html');
        if (html) {
          e.preventDefault();
          this.insertHtml(cleanFragment(html));
        }
      });

      // Tab 으로 포커스가 빠져나가지 않게 (들여쓰기로 사용)
      this.area.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          this.exec(e.shiftKey ? 'outdent' : 'indent');
        }
      });
    }
  }

  // ===================================================================
  //  SharedToolbar : 화면 위쪽에 하나만 존재
  // ===================================================================
  class SharedToolbar {
    /**
     * @param {HTMLElement} host
     * @param {{getActive: () => Editor|null}} opts
     */
    constructor(host, opts) {
      this.getActive = opts.getActive;
      this.el = host;
      this.el.className = 'editor-toolbar shared';
      this.el.innerHTML = '';
      this.copiedFormat = null;
      this._build();
      this.setEnabled(false);

      // 선택 위치가 바뀌면 버튼 눌림 상태 갱신
      document.addEventListener('selectionchange', () => this.syncState());

      // 서식 복사가 켜진 상태에서 글자를 드래그해 놓으면 바로 적용한다
      document.addEventListener('mouseup', () => {
        if (!this.copiedFormat) return;
        setTimeout(() => this.applyBrush(), 0);   // 선택이 확정된 뒤 실행
      });
      // ESC 로 취소
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.copiedFormat) this._disarmBrush();
      });
    }

    /** 편집 대상이 없으면 툴바를 흐리게 */
    setEnabled(on) {
      this.el.classList.toggle('disabled', !on);
      this.el.querySelectorAll('button, select, input').forEach((n) => { n.disabled = !on; });
    }

    _exec(cmd, value) {
      const ed = this.getActive();
      if (!ed) return;
      ed.exec(cmd, value);
      this.syncState();
    }

    _btn(title, html, onClick, cmdName) {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = title;
      b.innerHTML = html;
      if (cmdName) b.dataset.cmd = cmdName;
      b.addEventListener('mousedown', (e) => e.preventDefault());  // 선택 범위 유지
      b.addEventListener('click', onClick);
      this.el.appendChild(b);
      return b;
    }

    _sep() {
      const s = document.createElement('span');
      s.className = 'sep';
      this.el.appendChild(s);
    }

    _select(items, title, onChange) {
      const sel = document.createElement('select');
      sel.title = title;
      sel.innerHTML = items.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
      sel.addEventListener('change', () => { onChange(sel.value); sel.selectedIndex = 0; });
      this.el.appendChild(sel);
      return sel;
    }

    _build() {
      this._select(FONTS, '글꼴', (v) => v && this._exec('fontName', v));
      this._select(SIZES, '크기', (v) => v && this._exec('fontSize', v));
      this._sep();

      this._btn('굵게 (Ctrl+B)', '<b>가</b>', () => this._exec('bold'), 'bold');
      this._btn('기울임 (Ctrl+I)', '<i>가</i>', () => this._exec('italic'), 'italic');
      this._btn('밑줄 (Ctrl+U)', '<u>가</u>', () => this._exec('underline'), 'underline');
      this._btn('취소선', '<s>가</s>', () => this._exec('strikeThrough'), 'strikeThrough');

      const fc = document.createElement('input');
      fc.type = 'color'; fc.title = '글자색'; fc.value = '#c0392b';
      fc.addEventListener('input', () => this._exec('foreColor', fc.value));
      this.el.appendChild(fc);

      const bc = document.createElement('input');
      bc.type = 'color'; bc.title = '배경색(형광펜)'; bc.value = '#ffff00';
      bc.addEventListener('input', () => this._exec('hiliteColor', bc.value));
      this.el.appendChild(bc);

      this._btn('윗첨자', 'x²', () => this._exec('superscript'));
      this._btn('아랫첨자', 'x₂', () => this._exec('subscript'));
      this._sep();

      this._btn('왼쪽 정렬', '⯇', () => this._exec('justifyLeft'), 'justifyLeft');
      this._btn('가운데 정렬', '⯈⯇', () => this._exec('justifyCenter'), 'justifyCenter');
      this._btn('오른쪽 정렬', '⯈', () => this._exec('justifyRight'), 'justifyRight');
      this._sep();

      this._btn('글머리 기호', '• 목록', () => this._exec('insertUnorderedList'), 'insertUnorderedList');
      this._btn('번호 매기기', '1. 목록', () => this._exec('insertOrderedList'), 'insertOrderedList');
      this._btn('내어쓰기', '◀', () => this._exec('outdent'));
      this._btn('들여쓰기', '▶', () => this._exec('indent'));
      this._sep();

      this._btn('인용', '❝', () => this._exec('formatBlock', 'blockquote'));
      this._btn('링크 삽입', 'URL', () => this._insertLink());
      this._btn('링크 제거', 'URL✕', () => this._exec('unlink'));
      this._btn('표 삽입', '▦', () => this._insertTable());
      this._btn('이미지 삽입', '🖼', () => this._insertImage());
      this._btn('가로줄', '―', () => this._exec('insertHorizontalRule'));
      this._sep();

      this.brushBtn = this._btn(
        '서식 복사 — 원본 글자를 선택하고 누른 뒤, 적용할 글자를 드래그하세요',
        '서식복사', () => this._toggleBrush());
      this._btn('서식 지우기', '지움', () => { this._exec('removeFormat'); this._exec('unlink'); });
      this._btn('실행 취소 (Ctrl+Z)', '↶', () => this._exec('undo'));
      this._btn('다시 실행 (Ctrl+Y)', '↷', () => this._exec('redo'));
    }

    _insertLink() {
      const ed = this.getActive();
      if (!ed) return;
      const sel = window.getSelection();
      const hasText = sel && !sel.isCollapsed;
      const url = prompt('연결할 주소를 입력하세요 (http:// 또는 https://)', 'https://');
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) { alert('http:// 또는 https:// 로 시작하는 주소만 사용할 수 있습니다.'); return; }
      if (hasText) this._exec('createLink', url);
      else ed.insertHtml(`<a href="${url.replace(/"/g, '&quot;')}">${url.replace(/</g, '&lt;')}</a>&nbsp;`);
    }

    _insertTable() {
      const ed = this.getActive();
      if (!ed) return;
      const spec = prompt('표 크기를 입력하세요 (행 x 열)', '3x3');
      if (!spec) return;
      const m = /^\s*(\d+)\s*[xX*]\s*(\d+)\s*$/.exec(spec);
      if (!m) { alert('형식이 올바르지 않습니다. 예: 3x3'); return; }
      const rows = Math.min(Number(m[1]), 30);
      const cols = Math.min(Number(m[2]), 12);
      if (!rows || !cols) return;

      let html = '<table style="border-collapse: collapse; width: 100%">';
      for (let r = 0; r < rows; r++) {
        html += '<tr>';
        for (let c = 0; c < cols; c++) {
          const tag = r === 0 ? 'th' : 'td';
          const style = r === 0
            ? 'border: 1px solid #999; padding: 4px 7px; background: #f2f5f9'
            : 'border: 1px solid #999; padding: 4px 7px';
          html += `<${tag} style="${style}"><br></${tag}>`;
        }
        html += '</tr>';
      }
      html += '</table><p><br></p>';
      ed.insertHtml(html);
    }

    _insertImage() {
      const ed = this.getActive();
      if (!ed) return;
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = () => {
        const f = input.files && input.files[0];
        if (!f) return;
        if (f.size > 1.5 * 1024 * 1024) {
          alert('본문에 넣는 이미지는 1.5MB 이하만 가능합니다.\n용량이 큰 자료는 아래 "증적자료 첨부"를 이용하세요.');
          return;
        }
        const fr = new FileReader();
        fr.onload = () => ed.insertHtml(`<img src="${fr.result}" style="max-width: 100%">`);
        fr.readAsDataURL(f);
      };
      input.click();
    }

    // ---------------- 서식 복사 (Word 의 서식 붓과 동일한 사용감) ----------------
    _toggleBrush() {
      if (this.copiedFormat) { this._disarmBrush(); return; }   // 이미 켜져 있으면 취소

      const fmt = this._captureFormat();
      if (!fmt) {
        global.WR.toast('먼저 복사할 서식이 있는 글자를 선택하거나 그 위치에 커서를 두세요.', true);
        return;
      }
      this.copiedFormat = fmt;
      this.brushBtn.classList.add('on');
      document.body.classList.add('brush-armed');
      global.WR.toast('서식을 복사했습니다. 적용할 글자를 드래그하세요.');
    }

    _disarmBrush() {
      this.copiedFormat = null;
      this.brushBtn.classList.remove('on');
      document.body.classList.remove('brush-armed');
    }

    /** 현재 커서 위치의 글자 서식을 읽는다 */
    _captureFormat() {
      const ed = this.getActive();
      if (!ed) return null;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return null;

      let node = sel.getRangeAt(0).startContainer;
      if (node.nodeType === 3) node = node.parentElement;
      if (!node || !ed.area.contains(node)) return null;

      const cs = getComputedStyle(node);
      const bg = cs.backgroundColor;
      return {
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        fontStyle: cs.fontStyle,
        textDecorationLine: cs.textDecorationLine === 'none' ? '' : cs.textDecorationLine,
        color: cs.color,
        // 투명이면 배경은 복사하지 않는다
        backgroundColor: /rgba?\([^)]*,\s*0\s*\)$/.test(bg) ? '' : bg,
      };
    }

    /** 선택 영역에 복사해 둔 서식을 입힌다 */
    applyBrush() {
      const fmt = this.copiedFormat;
      const ed = this.getActive();
      if (!fmt || !ed) return false;

      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || sel.isCollapsed) return false;
      if (!ed.area.contains(sel.getRangeAt(0).commonAncestorContainer)) return false;

      // 기존 인라인 서식(굵게·색 등)을 먼저 지워야 새 서식이 그대로 적용된다
      try {
        document.execCommand('styleWithCSS', false, true);
        document.execCommand('removeFormat');
      } catch (e) { /* noop */ }

      const sel2 = window.getSelection();
      if (!sel2.rangeCount || sel2.isCollapsed) { this._disarmBrush(); return false; }
      const range = sel2.getRangeAt(0);

      const span = document.createElement('span');
      for (const [k, v] of Object.entries(fmt)) if (v) span.style[k] = v;

      try {
        const frag = range.extractContents();
        // 안쪽에 남은 같은 속성들은 제거해 바깥 서식이 이기도록
        frag.querySelectorAll('*').forEach((el) => {
          if (!el.style) return;
          ['font-family', 'font-size', 'font-weight', 'font-style',
           'text-decoration', 'text-decoration-line', 'color', 'background-color']
            .forEach((prop) => el.style.removeProperty(prop));
          if (!el.getAttribute('style')) el.removeAttribute('style');
        });
        span.appendChild(frag);
        range.insertNode(span);

        const r2 = document.createRange();
        r2.selectNodeContents(span);
        sel2.removeAllRanges();
        sel2.addRange(r2);
      } catch (e) {
        console.error('[editor] 서식 적용 실패:', e);
        this._disarmBrush();
        return false;
      }

      ed.touch();
      this._disarmBrush();
      global.WR.toast('서식을 적용했습니다.');
      return true;
    }

    syncState() {
      const ed = this.getActive();
      if (!ed) return;
      for (const b of this.el.querySelectorAll('button[data-cmd]')) {
        let on = false;
        try { on = document.queryCommandState(b.dataset.cmd); } catch (e) { /* noop */ }
        b.classList.toggle('on', !!on);
      }
    }
  }

  global.WR = global.WR || {};
  global.WR.Editor = Editor;
  global.WR.SharedToolbar = SharedToolbar;
  global.WR.cleanFragment = cleanFragment;
})(window);
