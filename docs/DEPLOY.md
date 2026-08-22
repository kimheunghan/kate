# 운영 서버 반영 절차 (192.168.200.115)

GCP 개발 서버에서 작업한 내용은 GitHub(`kate`)까지만 자동으로 올라갑니다.
운영 서버 반영은 **사람이 이 절차를 따라 실행**합니다. 자동 배포는 없습니다.

```
GCP 개발 서버 ──push──▶ GitHub (kate/main) ──✋사람──▶ 192.168.200.115:16000
```

| 항목 | 값 |
|---|---|
| 작업 위치 | `bi@192.168.200.115` 의 `/home/bi/weekly-report-gcp` |
| 소스 원격 | `kate` (`https://github.com/kimheunghan/kate.git`) 의 `main` |
| compose 정의 | `docker-compose.prod.yml` |
| 서비스 주소 | 내부 `http://192.168.200.115:16000` · 외부 `http://183.101.26.137:16000` · 도메인 `http://aips.iptime.org:16000` |
| 프로토콜 | 기본 HTTP. `.env` 로 HTTPS 전환 가능 → "HTTPS 켜기 / 끄기" 참고 |
| DB | `192.168.200.116:16432` (별도 서버, 이 절차에서 재기동하지 않음) |

---

## 0. 사전 확인 — 되돌릴 지점 만들기

서비스가 정상인 상태에서 시작합니다. 지우는 동작은 없습니다.

```bash
cd /home/bi/weekly-report-gcp

# 현재 소스 위치 (문제 시 이 커밋으로 되돌아갑니다)
git rev-parse --short HEAD

# 지금 도는 이미지에 되돌리기용 이름을 붙여 둡니다.
# reload.sh 가 :1.0 태그를 덮어쓰기 때문에 반드시 먼저 해 둡니다.
RUNNING="$(podman ps --filter name=wr-app --format '{{.Image}}')"
echo "현재 도는 이미지: $RUNNING"
podman tag "$RUNNING" localhost/weekly-report:rollback-ok

# 서비스 정상 확인
curl http://192.168.200.115:16000/api/health     # {"ok":true,"db":"up",...}
```

출력된 커밋 번호를 적어 두세요.

---

## 1. 소스 받기

**서비스에 영향이 없는 단계입니다.** 파일만 바뀌고 컨테이너는 그대로 돕니다.

```bash
git fetch kate
git merge --ff-only kate/main
git log --oneline -1
```

- `Already up to date.` → 받을 것이 없습니다. 여기서 끝내면 됩니다.
- **거부되면 서버에만 있는 변경이 있다는 뜻입니다. 절대 `reset --hard` 로 밀지 마세요.**
  `git status` 로 어느 쪽인지 먼저 가립니다.

**(가) 커밋 안 한 변경이 있을 때** — `Your local changes ... would be overwritten`

잠시 치워 두고 받은 뒤 되돌립니다. 받아 오는 커밋이 같은 파일을 건드리면
되돌릴 때 충돌하므로, 먼저 겹치는지 봅니다.

```bash
git status --short                               # 무엇이 바뀌어 있는지
git diff --name-only HEAD..kate/main             # 받아올 것이 건드리는 파일
git stash push -m "배포 중 임시 보관"
git merge --ff-only kate/main
git stash pop                                    # 충돌하면 여기서 해결
```

**(나) 서버에서 커밋까지 한 것이 있을 때** — `Not possible to fast-forward`

받아 온 것 위로 다시 쌓습니다(rebase). 커밋이 **아직 push 되지 않았을 때만**
안전합니다.

```bash
git log --oneline kate/main..HEAD                # 서버에만 있는 커밋
git rebase kate/main
git log --oneline -5                             # 순서 확인
```

> 서버에서 만든 커밋은 **되도록 그날 안에 `git push kate HEAD:main` 으로 올리세요.**
> 쌓아 둘수록 배포할 때마다 (나)를 반복하게 되고, 개발 서버에는 그 수정이 없어
> 같은 문제가 그쪽에서 다시 터집니다.

---

## 2. DB 마이그레이션

```bash
bash scripts/migrate.sh
```

- `db/migrations/*.sql` 을 번호순으로 모두 실행합니다. **여러 번 돌려도 결과가 같습니다.**
- 이미 적용된 것은 `already exists, skipping` 으로 지나갑니다. 정상입니다.
- 새로 추가된 파일이 있으면 `[*] 적용: db/migrations/0NN_….sql` 로 표시됩니다.

### ⛔ `[✔] 마이그레이션 완료` 를 보기 전에는 3번으로 가지 마세요

마지막 줄이 `[✔] 마이그레이션 완료` 가 **아니면 거기서 멈춥니다.** `ERROR:` 가
보이면 그 파일에서 끊긴 것입니다.

**끊긴 자리에서 스키마가 반쯤 바뀌어 있을 수 있습니다.** 각 `.sql` 은 하나의
트랜잭션으로 감싸여 있지 않아서, 앞 문장은 반영되고 뒤 문장만 실패할 수 있습니다.
그 상태에서 새 앱을 올리면 원인을 찾기 어려운 오류가 납니다.

실제로 있었던 일 (2026-08-22):

```
[*] 적용: db/migrations/006_personal_reports.sql
ERROR:  check constraint "users_role_chk" of relation "users" is violated by some row
```

006 은 `users_role_chk` 를 지우고 `USER·ORG_ADMIN·ADMIN` 만 허용하도록 다시
만듭니다. `SUPERVISOR` 는 017 에서 생긴 권한이라, **감독관리자 계정이 하나라도
있으면** 지우기는 되고 다시 만들기가 실패해 **제약이 사라진 채로 남습니다.**
(006 에 `SUPERVISOR` 를 넣어 고쳐 두었습니다.)

막혔을 때:

```bash
# 어디까지 갔는지 다시 확인 (여러 번 돌려도 안전합니다)
bash scripts/migrate.sh

# 제약이 사라지지 않았는지 확인
podman exec wr-app node -e "
require('/app/server/src/lib/db')
 .query(\"select conname from pg_constraint where conrelid='wr.users'::regclass and contype='c'\")
 .then(r=>{console.log(r.rows.map(x=>x.conname).join('\\n'));process.exit(0)})"
#   users_role_chk / users_duty_chk / users_approval_status_chk 세 개가 나와야 합니다
```

원인을 고치기 전에는 **3번을 실행하지 않습니다.** 서비스는 옛 앱으로 계속 돌고
있으므로 급할 것이 없습니다.

---

## 3. 앱 교체

**여기서만 잠깐 끊깁니다.**

```bash
bash scripts/reload.sh
```

출력에서 **반드시 이 줄을 확인**하세요.

```
[*] 앱 컨테이너 교체 (podman compose · docker-compose.prod.yml)
                      ^^^^^^^^^^^^^^   ^^^^^^^^^^^^^^^^^^^^^^^
                      이 서버에 있는     운영 정의여야 합니다
                      compose 명령
```

`docker-compose.yml`(개발 정의)이라고 나오면 **즉시 Ctrl+C** 하고 5번으로 가세요.

정상이면 `[✔] 앱 재배포 완료 (N초)` 로 끝납니다.

---

## 4. 확인

```bash
# HTTPS 로 떠 있을 수도 있으므로 두 가지를 모두 시도합니다 (-k = 자체 서명 인증서)
curl -fsSk https://192.168.200.115:16000/api/health 2>/dev/null \
  || curl -fsS http://192.168.200.115:16000/api/health
podman ps --filter name=wr-app
```

컨테이너가 막 뜬 직후에는 `Connection reset by peer` 가 날 수 있습니다.
**5초쯤 뒤에 다시 해 보세요.**

화면에서는 브라우저 새로 고침 후 확인합니다.

- 로그인 → 작성 화면이 뜨는지
- 관리자 → 등록 현황이 나오는지

---

## 5. 되돌리기

**3번에서 실패했을 때** — 먼저 이것부터.

```bash
podman compose -f docker-compose.prod.yml up -d
sleep 5
curl -fsSk https://192.168.200.115:16000/api/health 2>/dev/null || curl -fsS http://192.168.200.115:16000/api/health
```

그래도 안 되면 0번에서 만들어 둔 이미지로 되돌립니다.

```bash
podman tag localhost/weekly-report:rollback-ok localhost/weekly-report:1.0
podman compose -f docker-compose.prod.yml up -d
sleep 5
curl -fsSk https://192.168.200.115:16000/api/health 2>/dev/null || curl -fsS http://192.168.200.115:16000/api/health
```

소스까지 되돌리려면 0번에서 적어 둔 커밋으로.

```bash
git checkout <적어둔_커밋>
podman build -t localhost/weekly-report:1.0 -f Containerfile .
podman compose -f docker-compose.prod.yml up -d
```

> **DB 마이그레이션은 되돌리지 않습니다.** 015~018 은 열을 더하거나 뷰를 다시
> 정의하는 것이라, 예전 앱이 돌아도 문제가 없습니다.

---

## 하지 말아야 할 것

실제로 서비스를 내렸던 것들입니다. 같은 실수를 막기 위해 적어 둡니다.

| 하지 말 것 | 이유 |
|---|---|
| `git reset --hard kate/main` | 서버에만 있는 파일(`scripts/fix-runtime-permissions.sh` 등)이 사라집니다 |
| `podman-compose` 를 있다고 가정 | 이 서버에는 없습니다. `podman compose`(띄어쓰기) 입니다 |
| `curl http://127.0.0.1:16000` 로 판정 | 포트가 `192.168.200.115` 에만 묶여 있어 닿지 않습니다 |
| `-f` 없이 compose 실행 | 개발 정의(`docker-compose.yml`)가 잡혀 기동에 실패합니다 |
| 0번을 건너뛰고 3번 실행 | 되돌릴 이미지가 없어집니다 (`:1.0` 이 덮어써집니다) |
| **2번 결과를 안 보고 3번 실행** | 스키마가 반쯤 바뀐 채로 새 앱이 뜹니다. `[✔] 마이그레이션 완료` 를 눈으로 확인하세요 |
| 2번과 3번을 한 줄에 이어서 실행 | 위와 같은 이유입니다. `&&` 로 묶더라도 출력을 반드시 확인하세요 |
| 개발 서버에서 만든 계정·기관이 운영에도 있으리라 가정 | **DB 가 서로 다릅니다.** 아래 "소스는 넘어오고 데이터는 안 넘어온다" 참고 |
| 운영에서 만든 커밋을 push 하지 않고 쌓아 두기 | 배포할 때마다 `--ff-only` 가 막히고, 개발 쪽에는 그 수정이 없습니다 |

---

## 소스는 넘어오고, 데이터는 안 넘어온다

가장 자주 헷갈리는 지점입니다. 두 서버는 **DB 가 완전히 다릅니다.**

```
GCP 개발  34.158.212.199:8080   ──소스 push──▶  GitHub  ──✋사람──▶  운영 16000
   └ 개발용 DB (GCP 안)                                              └ 운영 DB (192.168.200.116)
        ▲                                                                  ▲
        └──────────────  이 둘은 아무 관계가 없습니다  ──────────────┘
```

그래서 **개발 서버에서 만든 사용자·기관·보고서는 운영에 나타나지 않습니다.**
소스만 GitHub 를 거쳐 넘어옵니다.

- 마이그레이션이 만드는 것(표·열·`NIPA기관` 같은 기준 데이터)은 양쪽에 다 생깁니다.
- 사람이 화면에서 만든 것(계정, 보고서, 권한 체크박스)은 **각 서버에서 따로** 해야 합니다.
- 예: 019 가 `can_view_all` 열을 만들지만 값은 전부 `FALSE` 입니다. **중복권한 별표(★)는
  운영에서 그 사용자를 직접 켜 줘야 보입니다.** 개발에서 켠 것은 넘어오지 않습니다.

화면이 똑같이 생겨서 어느 쪽을 보고 있는지 헷갈립니다. **주소창 포트로 구분하세요.**
`:8080` 은 개발, `:16000` 은 운영입니다.

운영 DB 를 직접 확인할 때:

```bash
podman exec wr-app node -e "
require('/app/server/src/lib/db')
 .query('select username, name, role from wr.users order by id')
 .then(r=>{r.rows.forEach(x=>console.log(x.username, x.name, x.role));process.exit(0)})"
```

---

## HTTPS 켜기 / 끄기

HTTP 로 서비스하면 브라우저가 "안전하지 않음"으로 표시하고, 로그인 비밀번호와
세션 쿠키가 **평문으로** 인터넷을 지납니다. 자체 서명 인증서로 암호화만이라도
켤 수 있습니다. (주소창 경고는 공인 인증서가 아니면 남습니다.)

준비물은 이미 만들어져 있습니다 — `certs/server.crt`, `certs/server.key`.
없으면 다시 만듭니다.

```bash
bash scripts/gen-cert.sh aips.iptime.org 183.101.26.137 192.168.200.115
```

**켜기** — `.env` 의 아래 세 줄에서 `#` 을 지우고 재기동합니다.

```
SSL_CERT_FILE=/app/certs/server.crt
SSL_KEY_FILE=/app/certs/server.key
COOKIE_SECURE=true
```

```bash
bash scripts/reload.sh
podman logs wr-app | grep 기동      # "[app] HTTPS 로 기동합니다." 가 나와야 합니다
```

**끄기** — 세 줄을 다시 주석 처리하고 `bash scripts/reload.sh`. 2초면 됩니다.

### 켜기 전에 알아야 할 것

| | |
|---|---|
| 접속 주소가 바뀝니다 | `http://aips.iptime.org:16000` → **`https://`**. 한 포트에서 둘 다는 안 됩니다 |
| 기존 북마크는 오류가 납니다 | 리다이렉트해 줄 HTTP 서버가 남지 않습니다. **사용자 공지가 필요합니다** |
| 최초 접속 시 경고 | 브라우저마다 한 번 [고급] → [계속 진행]. 브라우저를 완전히 껐다 켜면 다시 뜹니다 |
| `COOKIE_SECURE` 단독 금지 | 인증서 없이 `true` 로 두면 **로그인이 안 됩니다.** 쿠키가 저장되지 않습니다 |
| 활동 로그의 접속 IP | 그대로 남습니다. 앱이 직접 TLS 를 풀고 프록시가 없어서(`network_mode: pasta`) 영향이 없습니다 |

인증서 파일 권한은 `scripts/fix-runtime-permissions.sh` 가 맞춥니다
(`reload.sh`·`deploy.sh` 가 자동으로 부릅니다). 호스트 소유 그대로 두면 컨테이너
안에서 `root:root 600` 으로 보여 앱이 개인키를 못 읽고 기동에 실패합니다.

---

## 한눈에 보기

```bash
cd /home/bi/weekly-report-gcp

# 0) 안전망
git rev-parse --short HEAD
podman tag "$(podman ps --filter name=wr-app --format '{{.Image}}')" localhost/weekly-report:rollback-ok

# 1) 소스
git fetch kate && git merge --ff-only kate/main

# 2) DB   ← 마지막 줄이 "[✔] 마이그레이션 완료" 인지 눈으로 확인하고 넘어갈 것
bash scripts/migrate.sh

# 3) 앱  (출력의 compose 정의가 prod 인지 확인)
bash scripts/reload.sh

# 4) 확인
sleep 5 && { curl -fsSk https://192.168.200.115:16000/api/health 2>/dev/null \
             || curl -fsS http://192.168.200.115:16000/api/health; }
```
