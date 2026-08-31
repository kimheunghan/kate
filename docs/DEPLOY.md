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

## 소속 없는 총괄관리자 (2026-08-24 변경)

`admin` 은 기관·담당 역할 없이 운영하는 계정입니다. 무엇이 되고 무엇이 안 되는지
헷갈리기 쉬워 적어 둡니다.

| 기능 | 소속 없는 총괄관리자(`admin`) |
|---|---|
| 로그인·관리자 화면 | 됨 |
| 보고서 작성·저장·수정 | **됨** (`reports.org_id` 가 NULL 로 저장) |
| 한글·엑셀 다운로드 | 됨 |
| **등록 내역 조회 목록** | **안 나옴** |
| **기관별 제출 인원 집계** | **안 잡힘** |
| **활동 로그** | **안 남음** |

작성 화면에는 이 안내만 붙습니다.

```
admin 관리자는 소속 기관이 없어 보고서 작성은 등록 내역에 표시되지 않습니다.
```

왜 저절로 빠지는가 — 등록 내역과 기관별 집계는 `v_submission_status` 를 바탕으로
만드는데, 이 뷰는 **소속 기관이 있는 활성·승인 계정만** 대상으로 합니다
(`008_include_admin_authors.sql`). 따로 걸러 내는 코드가 없습니다.

### 마이그레이션 020 이 필요합니다

`reports.org_id` 는 원래 NOT NULL 이라 소속 없는 계정은 저장이 400 으로 막혔습니다.
`020_report_org_optional.sql` 이 그 제약을 풉니다. **이 마이그레이션을 돌리지 않고
앱만 올리면 admin 의 저장이 실패합니다.**

기존 보고서는 모두 `org_id` 를 갖고 있어 이 변경으로 달라지는 것은 없습니다.

> 참고 : `019` 번호는 `019_nipa_and_view_all.sql` 이 이미 쓰고 있어 `020` 을 씁니다.

---

## 사용자 삭제 동작 (2026-08-24 변경)

관리자 화면 → 사용자 관리 → `삭제` 는 **총괄관리자와 기관관리자**가 쓸 수 있습니다.

| 삭제하는 사람 | 지울 수 있는 대상 |
|---|---|
| 총괄관리자(ADMIN) | 전체 (본인 제외) |
| 기관관리자(ORG_ADMIN) | **자기 기관 사람만.** 총괄·감독 관리자는 못 지움 |
| 감독관리자(SUPERVISOR) | 없음 (조회만) |

`권한` 도 같은 기준입니다. 기관관리자는 총괄·감독 관리자를 수정하지도 삭제하지도
못하므로, 그 행의 `권한`·`삭제` 버튼은 **회색 비활성**으로 보입니다. 숨기지 않습니다.
마우스를 올리면 `상위 관리자는 변경할 수 없습니다.` 가 뜹니다.

화면 표시와 무관하게 서버가 다시 확인합니다.

| 요청 | 서버 응답 |
|---|---|
| 기관관리자가 다른 기관 사용자 삭제 | 403 `다른 기관 사용자는 삭제할 수 없습니다.` |
| 기관관리자가 총괄·감독 관리자 삭제 | 403 `총괄·감독 관리자는 삭제할 수 없습니다.` |
| 기관관리자가 총괄·감독 관리자 수정 | 403 `총괄·감독 관리자 권한은 변경할 수 없습니다.` |

사용자 목록의 `기관` 검색 필터도 기관관리자에게는 자기 기관만 표시되고 잠깁니다.
서버가 `scopeOrg()` 로 어차피 자기 기관으로 강제해, 골라도 결과가 바뀌지 않습니다.

삭제하면 다음이 **함께, 되돌릴 수 없게** 지워집니다.

| 대상 | 처리 |
|---|---|
| 그 사람이 쓴 보고서 (`wr.reports`) | 삭제 |
| 보고서 항목·첨부 레코드 | CASCADE 로 함께 삭제 |
| 증적자료 실제 파일 (`uploads/<보고서id>/`) | 디렉터리째 삭제 |
| 비밀번호 재설정 요청 이력 | CASCADE 로 함께 삭제 |
| **활동 로그 (`wr.audit_logs`)** | **함께 삭제** |

활동 로그도 지웁니다. `user_id` 만 비우면 `username`·`user_name` 이 값으로
남아 지운 사람이 계속 목록에 보입니다. 지운 사람은 흔적도 남기지 않습니다.

### 누가 지우느냐에 따라 기록이 달라집니다

`server/src/lib/audit.js` 는 **소속 기관이 없는 계정의 행동을 기록하지 않습니다.**
그래서 삭제를 수행한 사람에 따라 결과가 갈립니다.

| 삭제한 사람 | 활동 로그 | 보고서·증적자료 |
|---|---|---|
| 소속이 있는 총괄관리자 (`jakim1465`, `gscho`) | **남음** (`USER_DELETE`) | 사라짐 |
| 소속이 없는 `admin` | **안 남음** | 사라짐 |

`admin` 은 기관·담당 역할이 없는 운영용 계정이라 제출 현황 집계와 활동 로그에서
모두 빠져 있습니다. **되돌릴 수 없는 삭제를 흔적 없이 할 수 있으므로,
사용자 삭제는 소속이 있는 총괄관리자 계정으로 하세요.**

삭제 확인창이 지금 로그인한 계정 기준으로 이 사실을 알려줍니다.

### 삭제 대신 권할 것

퇴사자 정리라면 삭제보다 `권한` → `상태` 를 **중지**로 두세요.
로그인만 막히고 보고서·작성자 정보는 그대로 남습니다.

---

## 문서 내려받기 (2026-08-24~25 변경)

### 취합에 들어가는 대상

주차 한글 다운로드와 증적자료 묶음은 **등록 내역·기관별 집계와 같은 사람들**만
담습니다. 기준은 보고서에 남은 기관 스냅샷이 아니라 **작성자가 지금 참여 인력인가**
입니다.

| 조건 | 담김 |
|---|---|
| 소속 있는 활성·승인 계정 | O |
| 소속 없는 총괄관리자(`admin`) | X |
| 감독관리자(SUPERVISOR) | X |
| 지워진 계정이 남긴 보고서 | X |

스냅샷으로 거르면 안 됩니다. 소속을 뗀 뒤에도 예전 보고서에는 기관이 남아 있어
관리자가 쓴 것이 그대로 섞입니다. `v_submission_status` 와 같은 조건을 씁니다.

### 묶음 파일 이름

이름은 **실제로 담은 것**을 기준으로 짓습니다. 대상 목록이 아니라 담은 결과로
셉니다. 예전에는 목록 기준으로 짓고 담을 때 건너뛰어, "2개 주차" 인데 하나만
든 묶음이 나갔습니다.

| 구분 | 활동 로그 | 실제 파일 |
|---|---|---|
| 개별 | `㈜비아이매트릭스_김재안_주간보고_18주차(2026/8/20.목~8/26.수).hwpx` | 같되 `/` → `.` |
| 주차 | `주간보고_18주차(2026/8/20.목~8/26.수).hwpx` | 〃 |
| 전체 | `주간보고_18주차~23주차(2026/8/20.목~2026/9/30.수).zip` | 〃 |

**`/` 는 폴더 구분자라 파일 이름에 넣을 수 없습니다.** 그래서 활동 로그에 적는
이름과 실제 파일 이름을 따로 만듭니다 (`dlNames()`). 월·일 앞의 0 은 떼고,
요일 앞에 점을 찍고, 주차와 괄호는 붙입니다.

전체 묶음은 주차마다 한글 파일을 하나씩 만들어 담은 **`.zip`** 입니다.
`.hwpx` 로 이름 붙이면 한글이 열지 못합니다.

증적자료 묶음도 같습니다. 디스크에서 사라진 파일은 **먼저 걸러낸 뒤** 이름을 짓고
용량 상한도 그 목록으로 셉니다. 빠진 것이 있으면 로그에 남습니다.

```
[첨부ZIP] 파일이 없어 뺀 항목 N건
```

이 줄이 보이면 DB에는 있는데 파일이 없다는 뜻입니다. `uploads/` 를 손댄 뒤에
확인해 보세요.

### 한글 문서 서식

`hwp-convert` 가 만든 HWPX 를 `fixHwpxLayout()` 이 다시 손봅니다.

| 항목 | 값 |
|---|---|
| 글꼴 | 휴먼명조 (전부) |
| 본문 | 7pt · 표 제목 8.5pt · 문서 제목 15pt |
| 줄간격 | 160% · 왼쪽 정렬 |
| 열 너비 | 기관명 12% · 참여인력 8% · 당초 25% · 실적 27.5% · 향후 27.5% |

**글자 크기는 charPr 을 id 로 하나씩 짚지 마세요.** 다른 곳(엑셀·워드·한글·웹)에서
붙여넣어 색·배경색이 따라온 글은 변환기가 charPr 을 새로 만들어 씁니다. 그 id 가
목록에 없으면 한글 기본값 10pt 로 남아 그 칸만 커집니다. 아는 자리만 지정하고
나머지는 전부 본문 크기로 맞춥니다.

들여쓰기는 편집기에서 들여쓴 글은 `padding-left` 로, 붙여넣은 글은 줄머리 기호로
정합니다. `0.` 0칸 · `■` 2칸 · `-` 4칸. 공백은 **여는 태그 안쪽**에 넣어야 합니다.
태그 밖에 두면 변환기가 지워버립니다.

열 너비를 바꾸려면 세 곳을 함께 고칩니다. 어긋나면 같은 보고서가 경로마다 다르게
보입니다.

- `routes/reports.js` 개별 한글 · 주차 한글 : `fixHwpxLayout(buf, [비율…])`
- `routes/reports.js` 인쇄·Word : `<colgroup>` 의 `width:%`

---

## 활동 로그 (2026-08-26 변경)

기록은 `wr.audit_logs` 한 테이블에 쌓입니다.

| 칸 | 화면 | 내용 |
|---|---|---|
| `created_at` | 일시 | KST |
| `username` / `user_name` | 사용자ID / 사용자 | 계정이 지워져도 남도록 값으로 복사해 둔다 |
| `action` | 동작 | 아래 표 |
| `detail` | 내용 | 무엇에 대한 기록인지 |
| `ip` | IP | `X-Forwarded-For` 우선, 없으면 소켓 주소 |

### 내용 칸 표기

무엇에 대한 기록인지 알아볼 수 있어야 합니다. 두 가지 모양을 씁니다.

| 대상 | 모양 | 보기 |
|---|---|---|
| 사람 | `기관 / 아이디 / 이름` | `㈜비아이매트릭스 / hykim / 김학영` |
| 보고서 | `기관_주차(연/월/일.요일~월/일.요일)` | `㈜비아이매트릭스_18주차(2026/8/20.목~8/26.수)` |
| 증적자료 | 위 + 파일 이름 | `㈜비아이매트릭스_18주차(...) 주간보고_양식.xlsx` |
| 내려받기 | 파일 이름 | `주간보고_18주차(2026/8/20.목~8/26.수).hwpx` |

`status=SUBMITTED` 처럼 코드값을 그대로 남기지 마세요. 임시저장을 없앤 뒤로
상태는 늘 같아 아무 정보가 없습니다.

### 한글 다운로드는 셋으로 나뉜다

| 코드 | 행위 | 언제 |
|---|---|---|
| `REPORT_EXPORT_HWPX` | 개별 한글 다운로드 | 목록의 `한글` 단추 |
| `REPORT_EXPORT_HWPX_WEEK` | 주차 한글 다운로드 | 주차를 골라 받을 때 |
| `REPORT_EXPORT_HWPX_ALL` | 전체 한글 다운로드 | 전체 주차 묶음 |

행위 고르는 목록은 `public/js/admin.js` 의 `ACTION_ORDER` 차례로 늘어놓습니다.
성격이 같은 것끼리 붙여 두되 묶음(`optgroup`)으로 나누지는 않습니다.
목록에 없는 코드는 맨 뒤에 붙어 빠지지 않습니다.

### 남기지 않는 것

- **소속이 없는 계정** — `admin` 같은 운영용. `lib/audit.js` 가 걸러 냅니다.
- **지워진 사용자** — 계정을 지우면 그 사람의 활동 로그도 함께 지웁니다.
- **화면만 보는 동작** — 목록 조회, 탭 전환, 현판 보기 등. 서버를 부르지 않습니다.

관리자 화면을 거치지 않고 **DB 를 직접 고치면 아무 기록도 남지 않습니다.**
사람이 SQL 로 정리한 내용은 따로 적어 두세요.

---

## 시간대 (2026-08-26 확인)

앱과 DB 모두 **Asia/Seoul** 입니다. 호스트 OS 는 UTC 지만 컨테이너가 덮어씁니다.

```
Containerfile            ENV TZ=Asia/Seoul
docker-compose.prod.yml  TZ: Asia/Seoul
DB                       TimeZone = Asia/Seoul
```

**날짜를 다룰 때 `toISOString()` 을 쓰지 마세요.** 이 함수는 어떤 시간대 설정을
하든 UTC 로 바꿉니다. 한국은 아홉 시간 빠르므로 **밤 9시부터 자정까지 날짜가
하루 밀립니다.** 주차가 바뀌는 수요일 밤에만 드러나 알아채기 어렵습니다.

```js
// 쓰지 말 것
const today = new Date().toISOString().slice(0, 10);

// 이렇게
const now = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const today = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
```

`new Date(Date.UTC(y, m - 1, d)).getUTCDay()` 로 **요일만** 구하는 것은 안전합니다.
연·월·일을 직접 넣어 만들기 때문에 시간대와 무관합니다.

---

## 등록 내역 조회의 두 시각 열 (2026-08-31 변경)

목록에 **등록일시** 를 더하고, 옆의 **최종수정** 을 **수정일시** 로 바꿨습니다.
`수정일시` 만으로는 "언제 처음 냈는지" 를 알 수 없어 지각 제출을 가릴 수 없었습니다.

| 화면의 이름 | 실제 값 | 언제 채워지나 |
|---|---|---|
| 등록일시 | `wr.reports.submitted_at` | **첫 제출 때 한 번.** 이후 수정해도 그대로입니다. |
| 수정일시 | `wr.reports.updated_at` | 저장할 때마다 트리거가 자동으로 갱신합니다. |

등록일시가 첫 제출 시각으로 남는 것은 저장 SQL 이 `COALESCE` 로 기존 값을
지키기 때문입니다. 덮어쓰지 않도록 주의하세요.

```sql
-- server/src/routes/reports.js
submitted_at = CASE WHEN $2::varchar = 'SUBMITTED'
                    THEN COALESCE(submitted_at, now()) ELSE NULL END
```

**DB 는 바뀌지 않았습니다. 마이그레이션이 없습니다.** `submitted_at` 은 원래
있던 열이고 목록 API 가 이미 내려주고 있어서, 화면만 고쳤습니다. 그래서 **예전
보고서도 과거의 제출 시각이 그대로 보입니다.** (`014_drop_draft.sql` 이 값이 없던
옛 행을 `updated_at`·`created_at` 으로 채워 둔 덕입니다.)

미등록(`NONE`) 행은 두 칸 모두 `-` 입니다.

이름을 바꾼 곳은 네 군데입니다. **한 곳만 고치면 같은 값이 화면마다 다른 이름으로
보입니다.**

```
public/app.html                     주간보고 > 등록 내역 조회 표 머리
public/js/app.js                    같은 표의 각 줄 + 작성 화면의 "등록된 보고서입니다" 안내
public/js/admin.js                  관리화면 > 등록 내역 조회, 작성자 제출 현황
server/src/routes/admin-export.js   제출 현황 엑셀 내려받기 머리글
```

좁은 화면(820px 이하)에서는 두 열이 **함께** 접힙니다 (`style.css` 의
`.col-submitted`·`.col-updated`). 한쪽만 접으면 표가 어긋납니다.

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
