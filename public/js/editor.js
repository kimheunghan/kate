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

  /**
   * <ul>/<ol> 을 줄머리에 기호를 붙인 보통 줄로 바꾼다.
   * 예전에 목록으로 저장된 내용도 열 때 바꿔 두면 편집 중에 깨지지 않는다.
   * @param {HTMLElement} area  편집 영역
   * @param {Element[]} blocks  대상 (없으면 영역 전체)
   * @returns {Element[]} 바뀐 뒤의 줄 목록
   */
  function listsToLines(area, blocks) {
    const src = blocks && blocks.length ? blocks : Array.from(area.children);
    const out = [];

    src.forEach((b) => {
      if (!b || (b.tagName !== 'UL' && b.tagName !== 'OL')) { if (b) out.push(b); return; }

      const ordered = b.tagName === 'OL';
      // 목록 자체의 왼쪽 여백은 줄 들여쓰기로 옮긴다 (24px 은 기본값이라 뺀다)
      const base = Math.max(0, (parseFloat(b.style.paddingLeft) || 0) - 24)
                 + (parseFloat(b.style.marginLeft) || 0);
      const listMk = b.dataset.mk || b.style.listStyleType || '';
      let no = 1;
      const made = [];

      Array.from(b.children).forEach((li) => {
        if (li.tagName !== 'LI') return;
        const div = document.createElement('div');
        const pad = base + (parseFloat(li.style.marginLeft) || 0);
        if (pad) div.style.paddingLeft = `${pad}px`;

        const mk = li.dataset.mk || li.style.listStyleType || listMk;
        const q = /['"]\s*(\S+)/.exec(mk);
        const mark = ordered
          ? `${no++}.${NB}`
          : `${q ? q[1] : (BULLET_CHAR[mk] || '•')}${NB}`;

        while (li.firstChild) div.appendChild(li.firstChild);
        div.insertBefore(document.createTextNode(mark), div.firstChild);
        made.push(div);
      });

      made.forEach((d) => area.insertBefore(d, b));
      b.remove();
      out.push(...made);
    });

    return out;
  }

  /** 다음 줄에 이어 붙일 기호. 번호면 하나 올린다. */
  const INDENT_SPACES = 2;               // 들여쓰기 한 단계 = 공백 두 칸
  const NB = '\u00a0';                    // 줄 끝에서도 지워지지 않는 공백

  function nextMarker(mark) {
    const m = /^([\s\u00a0]*)(\d{1,3})([.)])([\s\u00a0]+)$/.exec(mark);
    if (m) return `${m[1]}${Number(m[2]) + 1}${m[3]}${NB}`;
    // 기호 뒤에는 늘 공백을 붙인다. 줄 끝에서 지워지지 않는 공백을 쓴다.
    // (공백 없이 '■글자' 로 저장된 줄에서도 다음 줄에 '■ ' 가 나오게 한다)
    return mark.replace(/[\s\u00a0]*$/, NB);
  }

  /** 그 칸 안의 첫 글자 노드 (없으면 null) */
  function firstTextNode(el) {
    for (const n of el.childNodes) {
      if (n.nodeType === 3) return n;
      if (n.nodeType === 1) {
        const t = firstTextNode(n);
        if (t) return t;
      }
    }
    return null;
  }

  /** 눈에 보이는 글자가 없는 칸인가 (공백·줄바꿈만 있으면 빈 것으로 본다) */
  const isBlank = (el) => el.textContent.replace(/[\s\u00a0\u200b]/g, '') === '';

  // 글머리표 종류. value 는 CSS list-style-type 값.
  //  브라우저가 그리는 네모(square)는 글자보다 훨씬 작다. 본문에서 손으로
  //  찍는 ■ 와 크기를 맞추려고 글자로 직접 지정한다. 점·원은 기본 그대로.
  // 글머리표는 HTML 목록이 아니라 '글자' 로 넣는다.
  // 목록으로 만들면 브라우저가 편집 중에 목록을 제멋대로 다시 짜면서
  // 기호가 바뀌거나 줄이 위로 붙어 버린다. 글자로 넣으면 백스페이스·
  // 엔터·복사붙여넣기 어디서도 그대로 남는다.
  const BULLET_CHAR = { disc: '•', square: '■', circle: '○', dash: '−' };
  // 줄머리에 이미 붙어 있는 기호 (바꿀 때 먼저 떼어낸다)
  //  ■ • ○ 처럼 글머리표로만 쓰는 기호는 뒤에 공백이 없어도 알아본다.
  //  (예전에 공백이 지워져 '■글자' 로 저장된 것도 살린다)
  //  − 나 숫자는 '−5', '1.5' 같은 보통 글과 헷갈리므로 공백을 요구한다.
  const MARKER_RE = /^[\s\u00a0]*(?:[•■○◦▪‣·][\s\u00a0]*|(?:[−–—-]|\d{1,3}[.)])[\s\u00a0]+)/;
  const BULLETS = [
    ['',        '글머리표'],
    ['disc',    '•  점'],
    ['square',  '■  사각'],
    ['circle',  '○  원'],
    ['dash',    '−  대시'],
    ['decimal', '1.  번호'],
    ['off',     '해제'],
  ];

  // 브라우저 기본 명령(execCommand fontSize)은 1~7 단계만 지원해
  // 8·10·12·14·18·24·36pt 밖에 못 쓴다. pt 를 직접 지정하는 방식으로 처리한다.
  const SIZES = [
    ['', '크기'],
    ...[8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 36]
      .map((n) => [String(n), `${n}pt`]),
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
      // 예전에 목록으로 저장된 내용은 글자 줄로 바꿔 둔다
      listsToLines(this.area, null);
      host.appendChild(this.area);

      if (!this.readOnly) this._bind();
    }

    // ---------------------------------------------------------------- API
    getHtml() {
      const h = this.area.innerHTML.trim();
      if (h === '<br>' || h === '<p><br></p>' || h === '<div><br></div>') return '';
      return h;
    }

    setHtml(html) {
      this.area.innerHTML = html || '';
      listsToLines(this.area, null);
    }

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
      this.area.addEventListener('input', () => {
        this._dropTrailingBreaks();
        this._restoreMarkers();
        this.saveRange();
        this._changed();
      });

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
          if (this.opts.onIndent) this.opts.onIndent(this, e.shiftKey ? -1 : 1);
          return;
        }
        // 엔터로 새 줄을 만들면 들여쓰기를 물려받지 않고 맨 앞에서 시작한다.
        // 들여쓴 줄 끝에서 엔터를 치고 붙여넣으면 통째로 밀려 들어가기 때문이다.
        // 줄 가운데서 엔터를 쳐 글이 나뉘는 경우는 그대로 둔다.
        // 줄 맨 앞에서 백스페이스를 누르면 윗줄과 붙지 않고
        // 그 줄의 들여쓰기를 한 칸 되돌린다. 커서는 그 자리에 남는다.
        if (e.key === 'Backspace' && this._atLineStartWithIndent()) {
          e.preventDefault();
          if (this.opts.onIndent) this.opts.onIndent(this, -1);
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          // 글머리표 줄에서 엔터를 치면 다음 줄에도 같은 기호를 이어 붙인다.
          // 기호만 있고 내용이 없는 줄이면 기호를 떼어 목록을 끝낸다.
          const block = this._currentBlock();
          if (block) {
            const m = MARKER_RE.exec(block.textContent);
            if (m) {
              const rest = block.textContent.slice(m[0].length);
              if (rest.replace(/[\s\u00a0\u200b]/g, '') === '') {
                // 기호만 남은 줄 → 기호와 들여쓰기를 떼고 그 자리에 선다
                e.preventDefault();
                this._clearLine(block);
                return;
              }
              setTimeout(() => this._afterEnter(nextMarker(m[0]), block.style.paddingLeft), 0);
              return;
            }
          }
          setTimeout(() => this._afterEnter(), 0);
        }
      });
    }

    /**
     * 지워진 글머리표 기호를 되살린다.
     * 백스페이스로 줄을 지우면 브라우저가 목록을 다시 짜면서 스타일을
     * 흘려버려 ■ 가 • 로 돌아가는 일이 있다. data-mk 값으로 되돌린다.
     */
    _restoreMarkers() {
      this.area.querySelectorAll('[data-mk]').forEach((el) => {
        const want = el.dataset.mk;
        if (want && el.style.listStyleType !== want) el.style.listStyleType = want;
      });
    }

    /** 커서가 놓인 글머리표 항목 (없으면 null) */
    _currentListItem() {
      const sel = global.getSelection();
      if (!sel || !sel.rangeCount) return null;
      let node = sel.getRangeAt(0).startContainer;
      if (node.nodeType === 3) node = node.parentNode;
      if (!node || !node.closest) return null;
      const li = node.closest('li');
      return li && this.area.contains(li) ? li : null;
    }

    /**
     * 빈 글머리표 항목에서 목록을 끝내고 맨 앞에서 새 줄을 시작한다.
     * 가운데 항목이면 목록을 둘로 나눠 뒤쪽을 그대로 살린다.
     */
    _exitList(li) {
      const list = li.parentNode;
      if (!list || !this.area.contains(list)) return;

      // 편집 영역 바로 아래에 놓일 자리를 찾는다 (목록이 중첩돼 있을 수 있다)
      let top = list;
      while (top.parentNode && top.parentNode !== this.area) top = top.parentNode;
      if (top.parentNode !== this.area) return;

      const line = document.createElement('div');
      line.appendChild(document.createElement('br'));

      // 뒤에 남은 항목이 있으면 새 목록으로 떼어 낸다
      const after = [];
      for (let n = li.nextSibling; n; n = n.nextSibling) after.push(n);

      this.area.insertBefore(line, top.nextSibling);
      if (after.length) {
        const rest = list.cloneNode(false);
        after.forEach((n) => rest.appendChild(n));
        this.area.insertBefore(rest, line.nextSibling);
      }
      li.remove();
      if (!list.querySelector('li')) top.remove();

      const range = document.createRange();
      range.setStart(line, 0);
      range.collapse(true);
      const sel = global.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      this.saveRange();
      this.touch();
    }

    /** 엔터를 친 뒤 정리 : 목록 빠져나오기(보조) + 새 줄 들여쓰기 없애기 */
    _afterEnter(carry, pad) {
      const sel = global.getSelection();
      if (!sel || !sel.rangeCount) return;
      let node = sel.getRangeAt(0).startContainer;
      if (node.nodeType === 3) node = node.parentNode;
      if (!node || !node.closest) return;

      const li = node.closest('li');
      if (li && this.area.contains(li)) {
        // 엔터를 치기 전 판단이 빗나갔을 때를 위한 보조 처리.
        // 빈 항목이 둘 연달아 있으면 빈 줄에서 또 엔터를 친 것이다.
        const prev = li.previousElementSibling;
        if (isBlank(li) && prev && prev.tagName === 'LI' && isBlank(prev)) {
          li.remove();
          this._exitList(prev);
          return;
        }
        // 목록 안이면 들여쓰기가 곧 단계이므로 손대지 않는다
        return;
      }

      // 편집 영역 바로 아래 칸(문단)까지 올라간다
      while (node && node !== this.area && node.parentNode !== this.area) node = node.parentNode;
      if (!node || node === this.area || !node.style) return;
      if (node.tagName === 'UL' || node.tagName === 'OL') return;
      // 글이 들어 있는 줄(가운데서 나뉜 경우)은 그대로 둔다
      if (!isBlank(node)) return;

      if (carry) {
        // 앞 줄의 기호와 들여쓰기를 이어받는다
        if (pad) node.style.paddingLeft = pad;
        const t = document.createTextNode(carry);
        node.insertBefore(t, node.firstChild);
        const range = document.createRange();
        range.setStart(t, carry.length);
        range.collapse(true);
        const s2 = global.getSelection();
        s2.removeAllRanges();
        s2.addRange(range);
        this.saveRange();
        this._renumber();
        this.touch();
        return;
      }

      node.style.removeProperty('padding-left');
      node.style.removeProperty('margin-left');
      if (!node.getAttribute('style')) node.removeAttribute('style');
      this.saveRange();
    }

    /** 커서가 줄 맨 앞에 있고 그 줄에 들여쓰기가 있는가 */
    _atLineStartWithIndent() {
      const sel = global.getSelection();
      if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
      const range = sel.getRangeAt(0);
      if (range.startOffset !== 0) return false;

      const block = this._currentBlock();
      if (!block || !block.style) return false;
      const pad = parseFloat(block.style.paddingLeft) || parseFloat(block.style.marginLeft) || 0;
      if (!pad) return false;

      // 커서 앞에 글자가 하나도 없어야 '줄 맨 앞' 이다
      const before = range.cloneRange();
      before.selectNodeContents(block);
      before.setEnd(range.startContainer, range.startOffset);
      return before.toString().replace(/[\s\u00a0\u200b]/g, '') === '';
    }

    /**
     * 글이 있는 줄 끝에 남은 <br> 을 없앤다.
     * 백스페이스로 빈 줄을 지우면 브라우저가 <br> 만 앞줄로 옮겨 붙여,
     * 글은 없는데 한 줄이 더 있는 것처럼 벌어져 보인다.
     */
    _dropTrailingBreaks() {
      Array.from(this.area.children).forEach((el) => {
        if (!el.lastElementChild || el.lastElementChild.tagName !== 'BR') return;
        if (isBlank(el)) return;                    // 빈 줄의 <br> 은 남겨 둔다
        el.removeChild(el.lastElementChild);
      });
    }

    /**
     * 번호 매긴 줄을 다시 세어 붙인다.
     * 들여쓰기가 같은 줄끼리 한 묶음으로 보고, 사이에 글머리표 줄이 끼어도
     * 이어서 센다. 1. 2. 4. 5. 처럼 어긋난 번호가 1. 2. 3. 4. 로 정리된다.
     */
    _renumber() {
      const NUM_RE = /^([\s\u00a0]*)(\d{1,3})([.)])([\s\u00a0]+)/;
      const sel = global.getSelection();
      const saved = sel && sel.rangeCount
        ? { node: sel.getRangeAt(0).startContainer, offset: sel.getRangeAt(0).startOffset }
        : null;

      const counters = new Map();          // 들여쓰기 → 다음 번호
      let moved = false;

      Array.from(this.area.children).forEach((el) => {
        const t = firstTextNode(el);
        if (!t) return;
        const m = NUM_RE.exec(t.nodeValue);
        if (!m) return;

        const level = Math.round(parseFloat(el.style.paddingLeft) || 0);
        const next = (counters.get(level) || 0) + 1;
        counters.set(level, next);
        if (String(next) === m[2]) return;

        t.nodeValue = `${m[1]}${next}${m[3]}${m[4]}` + t.nodeValue.slice(m[0].length);
        moved = true;

        // 커서가 이 줄에 있으면 늘거나 준 만큼 자리를 맞춘다
        if (saved && saved.node === t) {
          saved.offset = Math.max(0, saved.offset + (String(next).length - m[2].length));
        }
      });

      if (moved && saved && saved.node && saved.node.parentNode) {
        try {
          const range = document.createRange();
          const max = saved.node.nodeType === 3
            ? saved.node.nodeValue.length : saved.node.childNodes.length;
          range.setStart(saved.node, Math.min(saved.offset, max));
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        } catch (err) { /* 자리를 못 잡으면 그대로 둔다 */ }
        this.saveRange();
      }
    }

    /** 커서가 놓인 줄 (편집 영역 바로 아래 칸) */
    _currentBlock() {
      const sel = global.getSelection();
      if (!sel || !sel.rangeCount) return null;
      let n = sel.getRangeAt(0).startContainer;
      if (n.nodeType === 3) n = n.parentNode;
      while (n && n !== this.area && n.parentNode !== this.area) n = n.parentNode;
      return n && n !== this.area && n.parentNode === this.area ? n : null;
    }

    /** 줄머리 기호와 들여쓰기를 떼어 빈 줄로 만든다 */
    _clearLine(block) {
      const t = firstTextNode(block);
      if (t) t.nodeValue = t.nodeValue.replace(MARKER_RE, '');

      // 들여쓰기는 그 칸의 첫 줄에 맞춘다.
      // 0 으로 밀어 버리면 '1.' 로 시작하는 줄보다 더 왼쪽으로 나가 어긋난다.
      const first = this.area.firstElementChild;
      const base = first && first !== block ? first.style.paddingLeft : '';
      block.style.removeProperty('margin-left');
      if (base) block.style.paddingLeft = base;
      else block.style.removeProperty('padding-left');
      if (!block.getAttribute('style')) block.removeAttribute('style');
      if (block.textContent === '' && !block.querySelector('br')) {
        block.appendChild(document.createElement('br'));
      }
      const range = document.createRange();
      range.setStart(block, 0);
      range.collapse(true);
      const sel = global.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      this.saveRange();
      this._renumber();
      this.touch();
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
      this._select(SIZES, '글자 크기', (v) => v && this._applyFontSize(v));
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

      this._select(BULLETS, '글머리표 / 번호 매기기', (v) => v && this._applyBullet(v));
      this._btn('내어쓰기', '◀', () => this._indent(-1));
      this._btn('들여쓰기', '▶', () => this._indent(1));
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

    /**
     * 선택한 글자에 크기(pt)를 적용한다.
     * execCommand 로는 1~7 단계(8·10·12·14·18·24·36pt)밖에 못 쓰므로
     * 선택 영역을 span 으로 감싸 원하는 pt 를 직접 지정한다.
     */
    _applyFontSize(pt) {
      const ed = this.getActive();
      if (!ed || ed.readOnly) return;
      ed.area.focus();
      ed.restoreRange();

      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || sel.isCollapsed) {
        global.WR.toast('크기를 바꿀 글자를 먼저 선택하세요.', true);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!ed.area.contains(range.commonAncestorContainer)) return;

      const span = document.createElement('span');
      span.style.fontSize = `${pt}pt`;

      try {
        const frag = range.extractContents();
        // 안쪽에 남은 크기 지정을 지워 바깥 값이 적용되게 한다
        frag.querySelectorAll('*').forEach((el) => {
          if (el.tagName === 'FONT') el.removeAttribute('size');
          if (!el.style) return;
          el.style.removeProperty('font-size');
          if (!el.getAttribute('style')) el.removeAttribute('style');
        });
        span.appendChild(frag);
        range.insertNode(span);

        const r2 = document.createRange();
        r2.selectNodeContents(span);
        sel.removeAllRanges();
        sel.addRange(r2);
      } catch (e) {
        console.error('[editor] 글자 크기 적용 실패:', e);
        return;
      }

      ed.saveRange();
      ed.touch();
    }

    // ---------------- 들여쓰기 / 내어쓰기 ----------------
    // execCommand('indent') 는 Chrome 에서 <blockquote> 를 만들어 인용문처럼 보이고,
    // 엑셀에서 들어온 padding-left 들여쓰기는 outdent 로 되돌려지지 않는다.
    // 그래서 선택된 줄의 여백을 직접 조절한다. (엑셀 등록과 같은 방식)
    /**
     * 들여쓰기 한 칸 = 실제 공백 한 칸 폭.
     * 글꼴·크기에 따라 다르므로 편집 영역의 실제 글꼴로 측정한다.
     * (고정값을 쓰면 스페이스로 조절할 때와 간격이 어긋난다)
     */
    _spaceWidth(ed) {
      const probe = document.createElement('span');
      probe.textContent = '\u00a0'.repeat(20);
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-9999px';
      ed.area.appendChild(probe);
      const w = probe.getBoundingClientRect().width / 20;
      probe.remove();
      return w > 1 ? Math.round(w * 100) / 100 : 4;
    }

    /** 선택 영역에 걸친 최상위 블록들 (편집 영역의 직계 자식) */
    _selectedBlocks(ed) {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return [];
      const range = sel.getRangeAt(0);

      const topOf = (node) => {
        let n = node;
        if (n === ed.area) return null;
        while (n && n.parentNode && n.parentNode !== ed.area) n = n.parentNode;
        return n && n.parentNode === ed.area ? n : null;
      };

      let start = topOf(range.startContainer);
      let end = topOf(range.endContainer) || start;
      const kids = Array.from(ed.area.childNodes);

      // 블록이 하나도 없으면(맨 텍스트) div 로 감싼다
      if (!start) {
        if (!ed.area.childNodes.length) return [];
        const wrap = document.createElement('div');
        while (ed.area.firstChild) wrap.appendChild(ed.area.firstChild);
        ed.area.appendChild(wrap);
        return [wrap];
      }

      let i = kids.indexOf(start);
      let j = kids.indexOf(end);
      if (i === -1) return [];
      if (j === -1) j = i;

      const out = [];
      for (let k = Math.min(i, j); k <= Math.max(i, j); k++) {
        const n = kids[k];
        if (n.nodeType === 1) out.push(n);
        else if (n.nodeType === 3 && n.textContent.trim()) {
          const d = document.createElement('div');
          n.parentNode.insertBefore(d, n);
          d.appendChild(n);
          out.push(d);
        }
      }
      return out;
    }

    /** delta = +1 들여쓰기 / -1 내어쓰기 */
    _indent(delta) {
      const ed = this.getActive();
      if (!ed || ed.readOnly) return;
      ed.area.focus();
      ed.restoreRange();

      // 한 번에 공백 두 칸씩 민다. 한 칸(약 4px)씩이면 눌러도 티가 나지 않는다.
      const step = this._spaceWidth(ed) * INDENT_SPACES;

      // 한 칸 미는 공통 처리
      const shift = (el, prop) => {
        const cur = parseFloat(el.style[prop]) || 0;
        const next = Math.max(0, Math.round((cur + delta * step) * 100) / 100);
        if (next) el.style[prop] = `${next}px`;
        else el.style.removeProperty(prop === 'marginLeft' ? 'margin-left' : 'padding-left');
        if (!el.getAttribute('style')) el.removeAttribute('style');
      };

      // 글머리표 항목은 하나씩 민다. 목록(<ul>) 을 밀면 그 안의 줄이
      // 고르지 않은 것까지 전부 같이 움직인다.
      const items = this._selectedListItemsIn(ed);

      // 일반 줄. 항목을 따로 밀 목록은 여기서 뺀다 (두 번 밀리지 않게)
      const blocks = this._selectedBlocks(ed).filter((el) => {
        if (el.tagName !== 'UL' && el.tagName !== 'OL') return true;
        return !items.some((li) => el.contains(li));
      });

      if (!items.length && !blocks.length) return;

      // 일반 줄과 글머리표 항목이 함께 걸려 있으면 둘 다 움직인다
      items.forEach((li) => shift(li, 'marginLeft'));
      blocks.forEach((el) => {
        // 목록은 padding-left 가 글머리표 위치를 결정하므로 margin 으로 민다
        shift(el, (el.tagName === 'UL' || el.tagName === 'OL') ? 'marginLeft' : 'paddingLeft');
      });

      ed.saveRange();
      ed.touch();
    }

    /**
     * 고른 줄들을 그 자리에서 목록으로 만든다.
     * 위아래에 있는 다른 목록과 합치지 않는다.
     */
    _makeList(ed, wantOrdered, type) {
      const blocks = this._selectedBlocks(ed)
        .filter((el) => el.tagName !== 'UL' && el.tagName !== 'OL');
      if (!blocks.length) return false;

      const list = document.createElement(wantOrdered ? 'ol' : 'ul');
      list.style.paddingLeft = '24px';
      if (!wantOrdered && type) { list.style.listStyleType = type; list.dataset.mk = type; }
      ed.area.insertBefore(list, blocks[0]);

      let last = null;
      blocks.forEach((b) => {
        const li = document.createElement('li');
        // 줄에 준 들여쓰기는 항목 여백으로 옮겨 자리를 지킨다
        const pad = parseFloat(b.style.paddingLeft) || parseFloat(b.style.marginLeft) || 0;
        if (pad) li.style.marginLeft = `${pad}px`;
        if (b.textContent === '') li.appendChild(document.createElement('br'));
        while (b.firstChild) li.appendChild(b.firstChild);
        list.appendChild(li);
        b.remove();
        last = li;
      });

      if (last) {
        const range = document.createRange();
        range.selectNodeContents(last);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        ed.saveRange();
      }
      return true;
    }

    /** 선택 영역이 들어 있는 목록(UL/OL) 노드를 찾는다 */
    _currentList(ed) {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return null;
      let n = sel.getRangeAt(0).startContainer;
      if (n.nodeType === 3) n = n.parentElement;
      while (n && n !== ed.area) {
        if (n.tagName === 'UL' || n.tagName === 'OL') return n;
        n = n.parentElement;
      }
      return null;
    }

    /** 편집 영역 안에서 선택 범위에 걸린 글머리표 항목 전부 */
    _selectedListItemsIn(ed) {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return [];
      const range = sel.getRangeAt(0);

      // 드래그 없이 커서만 둔 경우에는 그 줄 하나만 고른다.
      // (범위가 비어 있으면 옆 줄까지 걸린 것으로 잡히는 브라우저가 있다)
      if (range.collapsed) {
        let n = range.startContainer;
        if (n.nodeType === 3) n = n.parentElement;
        const li = n && n.closest ? n.closest('li') : null;
        return li && ed.area.contains(li) ? [li] : [];
      }

      return Array.from(ed.area.querySelectorAll('li'))
        .filter((li) => range.intersectsNode(li))
        // 목록이 겹쳐 있으면 안쪽 항목만 남긴다.
        // 바깥 항목을 밀면 그 안에 든 줄이 전부 따라 움직인다.
        .filter((li, i, all) => !all.some((o) => o !== li && li.contains(o)));
    }

    /** 선택 범위에 걸린 글머리표 항목들 (그 목록의 바로 아래 항목만) */
    _selectedListItems(list) {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !list) return [];
      const range = sel.getRangeAt(0);
      const own = Array.from(list.children).filter((n) => n.tagName === 'LI');

      // 커서만 둔 경우에는 그 줄 하나만 (옆 줄까지 걸리는 브라우저가 있다)
      if (range.collapsed) {
        let n = range.startContainer;
        if (n.nodeType === 3) n = n.parentElement;
        const li = n && n.closest ? n.closest('li') : null;
        const mine = own.find((o) => o === li || o.contains(li));
        return mine ? [mine] : [];
      }
      return own.filter((li) => range.intersectsNode(li));
    }

    /** 줄머리의 기호를 떼어낸다 */
    _stripMarker(el) {
      const t = firstTextNode(el);
      if (t) t.nodeValue = t.nodeValue.replace(MARKER_RE, '');
    }

    /** 줄머리에 기호를 붙인다 */
    _prependMarker(el, mark) {
      const t = firstTextNode(el);
      if (t) t.nodeValue = mark + t.nodeValue;
      else el.insertBefore(document.createTextNode(mark), el.firstChild);
    }

    /**
     * 고른 줄에 글머리표를 넣거나 뺀다.
     * HTML 목록을 만들지 않고 줄머리에 글자를 붙인다.
     */
    _applyBullet(kind) {
      const ed = this.getActive();
      if (!ed || ed.readOnly) return;
      ed.area.focus();
      ed.restoreRange();

      const blocks = listsToLines(ed.area, this._selectedBlocks(ed));
      if (!blocks.length) return;

      let no = 1;
      blocks.forEach((b) => {
        this._stripMarker(b);
        if (kind === 'off') return;
        this._prependMarker(b, kind === 'decimal' ? `${no++}.${NB}` : `${BULLET_CHAR[kind] || '•'}${NB}`);
      });

      // 커서는 기호 바로 뒤에 둔다.
      // 칸 끝에 두면 <br> 뒤로 밀려, 글자가 기호와 공백 사이로 끼어든다.
      const last = blocks[blocks.length - 1];
      const range = document.createRange();
      const head = firstTextNode(last);
      const onlyMarker = MARKER_RE.test(last.textContent)
        && last.textContent.replace(MARKER_RE, '').replace(/[\s\u00a0\u200b]/g, '') === '';
      if (onlyMarker && head) {
        // 기호만 있는 줄 : 기호 끝에 커서를 둔다
        range.setStart(head, head.nodeValue.length);
        range.collapse(true);
      } else {
        range.selectNodeContents(last);
        range.collapse(false);
      }
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      ed.saveRange();
      ed._renumber();
      ed.touch();
      this.syncState();
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

  // 어떤 판이 돌고 있는지 콘솔에서 바로 확인할 수 있게 남긴다
  console.log('[편집기] 글머리표: 글자 방식 (목록 태그를 쓰지 않음)');

  global.WR = global.WR || {};
  global.WR.Editor = Editor;
  global.WR.SharedToolbar = SharedToolbar;
  global.WR.cleanFragment = cleanFragment;
})(window);
