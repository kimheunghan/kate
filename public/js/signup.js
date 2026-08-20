(function () {
  'use strict';
  const { api, $ } = window.WR;

  const err = $('#err');
  const done = $('#done');
  const btn = $('#submit');

  const fail = (m) => {
    err.textContent = m;
    err.classList.remove('hidden');
    err.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  // 서버 설정에 맞춰 상단 안내 문구를 맞춘다
  api.get('/api/auth/capabilities', { allowAnonymous: true })
    .then((c) => {
      const el = $('#signup-notice');
      if (!el) return;
      el.innerHTML = c.signup_auto_approve
        ? '가입 후 바로 로그인하실 수 있습니다.'
        : '가입 신청 후 <b>관리자 승인</b>을 받아야 로그인할 수 있습니다.';
    })
    .catch(() => { /* 기본 문구 유지 */ });

  // 기관 목록 채우기
  api.get('/api/auth/signup-orgs', { allowAnonymous: true })
    .then((res) => {
      if (!res.orgs.length) {
        fail('등록된 기관이 없습니다. 관리자에게 문의하세요.');
        btn.disabled = true;
        return;
      }
      $('#org_id').innerHTML =
        '<option value="">선택하세요</option>' +
        res.orgs.map((o) => `<option value="${o.id}">${window.WR.esc(o.name)}</option>`).join('');
    })
    .catch((e) => fail(e.message));

  $('#signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.add('hidden');

    const username = $('#username').value.trim();
    const password = $('#password').value;
    const password2 = $('#password2').value;
    const name = $('#name').value.trim();
    const email = $('#email').value.trim();

    if (!/^[A-Za-z0-9._-]{4,50}$/.test(username)) return fail('아이디는 영문/숫자/._- 조합 4자 이상이어야 합니다.');
    if (password.length < 8) return fail('비밀번호는 8자 이상이어야 합니다.');
    if (password !== password2) return fail('비밀번호가 서로 일치하지 않습니다.');
    if (!name) return fail('이름을 입력하세요.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('올바른 이메일을 입력하세요.');
    if (!$('#org_id').value) return fail('기관을 선택하세요.');
    if (!$('#duty').value) return fail('담당 역할을 선택하세요.');

    btn.disabled = true;
    btn.textContent = '신청 중...';

    try {
      const res = await api.post('/api/auth/signup', {
        username, password, name, email,
        phone: $('#phone').value.trim(),
        org_id: Number($('#org_id').value),
        duty: $('#duty').value || null,
      }, { allowAnonymous: true });

      $('#form-body').classList.add('hidden');
      done.innerHTML = window.WR.esc(res.message)
        + (res.auto_approved
            ? ' <a href="/login" style="font-weight:800">로그인하러 가기 →</a>'
            : '');
      done.classList.remove('hidden');
      if (res.auto_approved) setTimeout(() => { location.href = '/login'; }, 2500);
    } catch (e2) {
      fail(e2.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '가입 신청';
    }
  });
})();
