(function () {
  'use strict';
  const { api, esc, $ } = window.WR;

  const form = $('#login-form');
  const err = $('#err');
  const msg = $('#msg');
  const btn = $('#submit');

  // 서버가 메일 발송을 할 수 있는지 확인해 안내 문구를 맞춘다
  let caps = { mail_enabled: false, reset_token_minutes: 30, reset_mode: 'DIRECT' };
  api.get('/api/auth/capabilities', { allowAnonymous: true })
    .then((c) => { caps = c; })
    .catch(() => { /* 기본값 사용 */ });

  // 이미 로그인 상태면 바로 이동
  api.get('/api/auth/me', { allowAnonymous: true })
    .then(() => { location.href = '/report'; })
    .catch(() => { /* 미로그인 - 정상 */ });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.add('hidden');
    msg.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = '로그인 중...';

    try {
      const res = await api.post('/api/auth/login', {
        username: $('#username').value.trim(),
        password: $('#password').value,
      }, { allowAnonymous: true });

      if (res.user.must_change_pw) sessionStorage.setItem('wr_force_pw', '1');
      location.href = res.user.role === 'ADMIN' ? '/admin' : '/report';
    } catch (e2) {
      err.textContent = e2.message;
      err.classList.remove('hidden');
      $('#password').value = '';
      $('#password').focus();
    } finally {
      btn.disabled = false;
      btn.textContent = '로그인';
    }
  });

  // ------------------------------------------------------------------
  // 공통 모달
  // ------------------------------------------------------------------
  function modal(title, bodyHtml, onOk, okLabel) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal" style="max-width:420px">
        <header>${esc(title)}</header>
        <div class="body">
          <div class="alert error hidden" id="m-err"></div>
          <div class="alert success hidden" id="m-ok"></div>
          <div id="m-body">${bodyHtml}</div>
        </div>
        <footer>
          <button class="btn" id="m-cancel">닫기</button>
          <button class="btn primary" id="m-ok-btn">${esc(okLabel || '확인')}</button>
        </footer>
      </div>`;
    document.body.appendChild(back);

    const close = () => back.remove();
    back.querySelector('#m-cancel').onclick = close;
    back.addEventListener('click', (e) => { if (e.target === back) close(); });

    const ctx = {
      back,
      close,
      fail(m) {
        const el = back.querySelector('#m-err');
        el.textContent = m; el.classList.remove('hidden');
      },
      succeed(html) {
        back.querySelector('#m-err').classList.add('hidden');
        back.querySelector('#m-body').classList.add('hidden');
        back.querySelector('#m-ok-btn').classList.add('hidden');
        const el = back.querySelector('#m-ok');
        el.innerHTML = html; el.classList.remove('hidden');
        back.querySelector('#m-cancel').textContent = '확인';
      },
    };

    back.querySelector('#m-ok-btn').onclick = () => {
      back.querySelector('#m-err').classList.add('hidden');
      onOk(ctx);
    };
    const first = back.querySelector('input');
    if (first) first.focus();
    back.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); back.querySelector('#m-ok-btn').click(); }
    });
    return ctx;
  }

  // ------------------------------------------------------------------
  // 아이디 찾기
  // ------------------------------------------------------------------
  $('#link-find-id').onclick = (e) => {
    e.preventDefault();
    modal('아이디 찾기', `
      <p class="small muted">가입할 때 등록한 <b>소속과 이름</b>으로 찾습니다.</p>
      <label class="field"><span>소속</span>
        <select id="fi-org"><option value="">불러오는 중...</option></select>
      </label>
      <label class="field"><span>이름</span><input type="text" id="fi-name"></label>
    `, async (ctx) => {
      const orgId = ctx.back.querySelector('#fi-org').value;
      const name = ctx.back.querySelector('#fi-name').value.trim();
      if (!orgId) return ctx.fail('소속을 선택하세요.');
      if (!name) return ctx.fail('이름을 입력하세요.');

      try {
        const res = await api.post('/api/auth/find-id', { name, org_id: Number(orgId) }, { allowAnonymous: true });
        ctx.succeed(
          '<b>찾은 아이디</b><br>' +
          res.accounts.map((a) =>
            `<span style="font-size:16px;letter-spacing:1px">${esc(a.username)}</span>` +
            (a.pending ? ' <span class="badge draft">승인대기</span>' : '')
          ).join('<br>') +
          '<div class="small mt8">보안을 위해 일부를 가렸습니다. 전체 아이디가 필요하면 관리자에게 문의하세요.</div>'
        );
      } catch (e2) { ctx.fail(e2.message); }
    }, '찾기');

    // 소속 목록을 채운다 (회원가입 화면과 같은 목록)
    api.get('/api/auth/signup-orgs', { allowAnonymous: true })
      .then((r) => {
        const sel = document.querySelector('#fi-org');
        if (!sel) return;
        sel.innerHTML = '<option value="">선택하세요</option>'
          + r.orgs.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
      })
      .catch(() => {
        const sel = document.querySelector('#fi-org');
        if (sel) sel.innerHTML = '<option value="">소속 목록을 불러오지 못했습니다</option>';
      });
  };

  // ------------------------------------------------------------------
  // 비밀번호 찾기 (재설정 요청)
  // ------------------------------------------------------------------
  $('#link-find-pw').onclick = (e) => {
    e.preventDefault();
    const intro = {
      EMAIL:  `<p class="small muted">본인 확인 후 가입 시 등록한 이메일로
                 <b>비밀번호 재설정 링크</b>를 보내드립니다. (${caps.reset_token_minutes}분 이내 유효)</p>`,
      DIRECT: `<p class="small muted">아이디와 이름으로 본인 확인 후
                 <b>바로 새 비밀번호를 설정</b>할 수 있습니다.</p>`,
      ADMIN:  `<p class="small muted">본인 확인 후 <b>재설정 요청</b>이 접수됩니다.
                 <br>관리자가 확인 후 임시 비밀번호를 알려드립니다.</p>`,
    }[caps.reset_mode || 'DIRECT'];

    modal('비밀번호 찾기', `
      ${intro}
      <label class="field"><span>아이디</span><input type="text" id="fp-username"></label>
      <label class="field"><span>이름</span><input type="text" id="fp-name"></label>
    `, async (ctx) => {
      const username = ctx.back.querySelector('#fp-username').value.trim();
      const name = ctx.back.querySelector('#fp-name').value.trim();
      if (!username || !name) return ctx.fail('아이디와 이름을 모두 입력하세요.');

      try {
        const res = await api.post('/api/auth/reset-request', { username, name }, { allowAnonymous: true });
        // 임시 비밀번호를 화면에 알려주고 재설정 화면으로 안내
        if (res.temp_password) {
          ctx.succeed(`
            <div style="margin-bottom:10px">본인 확인이 완료되었습니다.</div>
            <div style="background:#fff;border:1px solid #b3ddc3;border-radius:6px;padding:12px;text-align:center">
              <div class="small muted" style="margin-bottom:4px">임시 비밀번호</div>
              <div style="font-size:20px;font-weight:800;letter-spacing:2px;
                          font-family:Consolas,monospace;color:#14663a;word-break:break-all">${esc(res.temp_password)}</div>
            </div>
            <div class="small" style="margin-top:10px">
              이 비밀번호를 복사해 두세요. 창을 닫으면 다시 볼 수 없습니다.
              (${res.expire_minutes}분 이내 사용)
            </div>
            <div style="margin-top:12px">
              <a class="btn primary" href="${esc(res.reset_url)}"
                 style="width:100%;justify-content:center;text-decoration:none">새 비밀번호 설정하기 →</a>
            </div>`);
          return;
        }
        if (res.reset_url) { location.href = res.reset_url; return; }
        ctx.succeed(esc(res.message).replace(/\n/g, '<br>'));
      } catch (e2) { ctx.fail(e2.message); }
    }, '요청하기');
  };
})();
