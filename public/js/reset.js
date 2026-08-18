(function () {
  'use strict';
  const { api, esc, $ } = window.WR;

  const token = new URLSearchParams(location.search).get('token') || '';
  const err = $('#err');
  const done = $('#done');
  const btn = $('#submit');

  const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); };
  let needTemp = false;

  if (!token) {
    fail('잘못된 접근입니다. 메일의 링크로 접속해 주세요.');
  } else {
    // 링크가 아직 유효한지 먼저 확인
    api.post('/api/auth/reset-verify', { token }, { allowAnonymous: true })
      .then((res) => {
        $('#who').innerHTML = `<b>${esc(res.name)}</b> 님 (${esc(res.username)}) 의 비밀번호를 재설정합니다.`;
        needTemp = !!res.require_temp_password;
        if (needTemp) $('#temp-field').classList.remove('hidden');
        $('#form-body').classList.remove('hidden');
        (needTemp ? $('#temp') : $('#pw')).focus();
      })
      .catch((e) => fail(e.message));
  }

  // 브라우저가 다른 값을 채워 넣어도 확인할 수 있게
  $('#pw-show').onchange = (e) => {
    const t = e.target.checked ? 'text' : 'password';
    $('#pw').type = t; $('#pw2').type = t; $('#temp').type = t;
  };

  $('#reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.add('hidden');

    const temp = $('#temp').value;
    const pw = $('#pw').value;
    if (needTemp && !temp) return fail('임시 비밀번호를 입력하세요.');
    if (pw.length < 8) return fail('새 비밀번호는 8자 이상이어야 합니다.');
    if (pw !== $('#pw2').value) return fail('새 비밀번호가 서로 일치하지 않습니다.');
    if (needTemp && temp === pw) return fail('임시 비밀번호와 다른 비밀번호를 사용하세요.');

    btn.disabled = true;
    btn.textContent = '변경 중...';
    try {
      const res = await api.post('/api/auth/reset-complete',
        { token, temp_password: temp, new_password: pw }, { allowAnonymous: true });
      $('#form-body').classList.add('hidden');
      done.innerHTML = esc(res.message) + ' <a href="/login" style="font-weight:800">로그인 →</a>';
      done.classList.remove('hidden');
      setTimeout(() => { location.href = '/login'; }, 2500);
    } catch (e2) {
      fail(e2.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '비밀번호 변경';
    }
  });
})();
