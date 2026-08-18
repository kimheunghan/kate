# 주간실적 보고 시스템 (Weekly Report System)

작성자별 **주간 추진실적(① 당초 계획 / ② 추진 실적)** 을 웹에서 등록·수정·조회하고,
증적자료(문서·소스파일)를 첨부하며, 관리자가 전체 등록 현황을 한눈에 확인하는 시스템입니다.

- 백엔드: **Node.js 20 + Express + PostgreSQL 16**
- 프론트엔드: **순수 HTML/CSS/JS** — 빌드 도구·CDN 의존 없음 (폐쇄망에서 그대로 동작)
- 배포: **Podman 4.9+/5.x, podman-compose 또는 Docker Compose V2 호환 Compose Specification**

---

## 1. 서버 구성

| 역할 | 주소 | 사양 | OS | podman |
|---|---|---|---|---|
| **RDB** | `192.168.200.116` | 16 Core | Rocky Linux (최신) | 5.8.2 |
| **APP** (web/was) | `192.168.200.115` | 8 Core | Ubuntu 22.04 LTS | 4.9.3 |
| 외부 접속 | `http://183.101.26.137:<APP_PORT>` | — | 포트 미확정 → `.env` 의 `APP_PORT` 만 변경 | |

```
 인터넷 ──▶ 183.101.26.137:APP_PORT
                    │
                    ▼
        ┌───────────────────────┐         ┌──────────────────────┐
        │ APP  192.168.200.115  │  5432   │ RDB  192.168.200.116 │
        │  wr-app (Node 20)     │────────▶│  wr-db (PostgreSQL16)│
        │  볼륨: ./data/uploads │         │  볼륨: ./data/pgdata │
        └───────────────────────┘         └──────────────────────┘
```

---

## 2. 기능

### 사용자 (작성자)
- **로그인 / 비밀번호 변경** (세션 12시간, 로그인 10회 실패 시 5분 잠금)
- **주간보고 작성** — 업무별로 `업무명 / ① 당초 계획 / ② 추진 실적` 행을 추가·삭제·순서변경
- **서식 편집기** — 글꼴·크기·굵게·기울임·밑줄·취소선·글자색·형광펜·정렬·글머리표·번호·들여쓰기·인용·링크·표·이미지·서식지우기
  (붙여넣기 시 서식 유지, 화면 캡처 붙여넣기 지원)
- **증적자료 첨부** — 드래그&드롭 / 다중 업로드 / 한글 파일명 / 다운로드 / 삭제
- **임시저장 · 제출** 구분, 저장 즉시 화면에 반영
- **조회** — 주차·기관·상태·검색어(업무명 및 본문)로 검색, 페이징
- **직전 주차 불러오기** — 지난주 업무명·계획을 그대로 가져와 이어쓰기
- **인쇄 / PDF** — 보고서 양식 그대로 출력

### 관리자
- **등록 현황** — 선택 주차의 작성자별 제출 상태와 제출률
- **주차별 현황판** — 최근 N주 × 기관별 대상 인원/완료/임시/미등록 집계
- **기관 관리** — 추가·수정·사용중지·삭제
- **사용자 관리** — 계정 생성·수정·비밀번호 초기화·정지·삭제 (마지막 관리자 강등 방지)
- **주차 마감** — 마감 시 일반 사용자는 수정 불가, 관리자는 계속 수정 가능
- **활동 로그** — 로그인·저장·삭제·업로드 이력

> 요청하신 대로 **진도율 / 향후계획은 화면에 노출하지 않습니다.**
> 다만 나중에 추가할 때 DB 마이그레이션이 필요 없도록
> `report_items.progress_rate`, `report_items.next_plan_html` 컬럼은 미리 만들어 두었습니다.

---

## 3. 빠른 시작 (개발 서버)

```bash
cd weekly-report

# 1) .env 생성 + 비밀값 자동 생성
bash scripts/gen-secrets.sh

# 2) 기동 (DB + APP 한 번에)
podman-compose up -d --build

# 3) 확인
curl http://127.0.0.1:8080/api/health
podman logs -f wr-app
```

브라우저에서 `http://<서버IP>:8080` 접속 →
`scripts/gen-secrets.sh` 가 출력한 **admin / (생성된 비밀번호)** 로 로그인 →
최초 로그인 시 비밀번호 변경 안내가 뜹니다.

### podman-compose 설치
```bash
# Rocky Linux
sudo dnf install -y python3-pip && python3 -m pip install --user podman-compose
export PATH="$HOME/.local/bin:$PATH"          # ~/.bashrc 에 추가 권장

# Ubuntu 22.04
sudo apt update && sudo apt install -y python3-pip && pip3 install --user podman-compose
export PATH="$HOME/.local/bin:$PATH"
```

---

## 4. 운영 이관 절차 (소스·이미지)

이관 대상은 세 묶음입니다.

1. `weekly-report-deploy-YYYYMMDD.tar.gz`: 소스, DB 스키마/마이그레이션, Compose, 운영 스크립트
2. `weekly-report-YYYYMMDD.tar`: APP 컨테이너 이미지
3. `postgres-16-alpine.tar`: PostgreSQL 컨테이너 이미지

`.env`, DB 데이터, 첨부파일은 보안과 데이터 보호를 위해 소스 패키지에 포함하지 않습니다.

### 4-1. 이관 패키지 만들기 (개발 서버에서)

```bash
bash scripts/deploy.sh package
```

`dist/` 에 다음이 생성됩니다.

| 파일 | 용도 |
|---|---|
| `weekly-report-YYYYMMDD.tar` | APP 컨테이너 이미지 (인터넷 없는 서버용) |
| `postgres-16-alpine.tar` | DB 컨테이너 이미지 |
| `weekly-report-deploy-YYYYMMDD.tar.gz` | 소스·스키마·compose·스크립트 |

> 대상 서버가 인터넷이 되면 이미지 tar 없이 소스를 옮긴 뒤
> `bash scripts/deploy.sh build`로 APP 이미지를 만들 수 있습니다.

### 4-2. DB 서버 (192.168.200.116, Rocky Linux)

```bash
scp dist/postgres-16-alpine.tar dist/weekly-report-deploy-*.tar.gz  user@192.168.200.116:~/
ssh user@192.168.200.116

podman load -i postgres-16-alpine.tar
mkdir -p ~/weekly-report && tar xzf weekly-report-deploy-*.tar.gz -C ~/weekly-report
cd ~/weekly-report

cp .env.example .env
bash scripts/gen-secrets.sh          # ← 여기서 나온 DB_PASSWORD 를 APP 서버에도 동일하게 사용
podman-compose -f docker-compose.db.yml up -d

# 방화벽: APP 서버에서만 5432 접근 허용
sudo firewall-cmd --permanent \
  --add-rich-rule='rule family=ipv4 source address=192.168.200.115/32 port port=5432 protocol=tcp accept'
sudo firewall-cmd --reload
```

최초 기동 시 `db/init/01_schema.sql`, `02_seed.sql` 이 **자동 실행**되어
스키마 · 기관 · 주차(2025~2027, 수요일~화요일 주기 157주)가 그대로 생성됩니다.

### 4-3. APP 서버 (192.168.200.115, Ubuntu 22.04)

```bash
scp dist/weekly-report-*.tar dist/weekly-report-deploy-*.tar.gz  user@192.168.200.115:~/
ssh user@192.168.200.115

podman load -i weekly-report-*.tar
mkdir -p ~/weekly-report && tar xzf weekly-report-deploy-*.tar.gz -C ~/weekly-report
cd ~/weekly-report

cp .env.example .env
vi .env
```

`.env` 에서 다음 값을 채웁니다.

```ini
APP_PORT=8080                       # ← 외부 공개 포트 확정되면 이 값만 변경
DB_HOST=192.168.200.116
DB_PASSWORD=<DB 서버에서 생성된 값과 동일하게>
SESSION_SECRET=<openssl rand -hex 32>
ADMIN_PASSWORD=<초기 관리자 비밀번호>
UPLOAD_HOST_DIR=/opt/weekly-report/uploads
```

```bash
bash scripts/deploy.sh up          # load한 이미지를 그대로 기동 + health 확인
bash scripts/deploy.sh status
bash scripts/deploy.sh logs
```

접속: `http://192.168.200.115:8080` → 외부 `http://183.101.26.137:8080`

### 4-4. 포트가 확정되면

`.env` 의 `APP_PORT` 만 바꾸고 재기동하면 됩니다. 코드 수정 불필요.

```bash
sed -i 's/^APP_PORT=.*/APP_PORT=9090/' .env
bash scripts/deploy.sh down && bash scripts/deploy.sh up
```

> **1024 미만 포트(80 등)** 를 쓰려면 rootless podman 에서는 아래 중 하나가 필요합니다.
> ```bash
> sudo sysctl -w net.ipv4.ip_unprivileged_port_start=80
> echo 'net.ipv4.ip_unprivileged_port_start=80' | sudo tee /etc/sysctl.d/99-podman.conf
> ```
> 또는 앞단에 nginx 를 두고 8080 으로 프록시하세요.

### 4-5. 서버 재부팅 시 자동 기동

```bash
podman generate systemd --new --name wr-app --files --restart-policy=always
mkdir -p ~/.config/systemd/user && mv container-wr-app.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now container-wr-app.service
sudo loginctl enable-linger $USER     # 로그아웃 후에도 유지
```

DB 서버(`wr-db`)도 동일하게 등록하세요.

---

## 5. 환경변수 (`.env`)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `APP_PORT` | `8080` | 호스트에 노출할 포트 (외부 공개 포트) |
| `SESSION_SECRET` | — | **필수**. 세션 쿠키 서명 키. `openssl rand -hex 32` |
| `SESSION_TTL_SECONDS` | `43200` | 세션 유지 시간(초). 기본 12시간 |
| `COOKIE_SECURE` | `false` | HTTPS 로 서비스하면 `true` |
| `MAX_UPLOAD_MB` | `50` | 첨부파일 1개 최대 크기 |
| `UPLOAD_HOST_DIR` | `./data/uploads` | 증적자료를 보관할 호스트 경로 |
| `DB_HOST` | `db` | 개발=`db`, 운영=`192.168.200.116` |
| `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | `5432` / `weekly_report` / `wruser` / — | DB 접속 정보 |
| `DB_EXPOSE_PORT` | `15432` | 개발 구성에서 호스트로 노출할 DB 포트 |
| `PGDATA_HOST_DIR` | `./data/pgdata` | DB 데이터 디렉터리 (DB 서버) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_NAME` | `admin` / — / `관리자` | 관리자 계정이 하나도 없을 때만 자동 생성 |

---

## 6. DB 스키마 및 이관

스키마 이름은 **`wr`** 입니다. 전체 정의는 `db/init/01_schema.sql`.

| 테이블 | 설명 |
|---|---|
| `wr.organizations` | 기관 (보고 작성 단위) |
| `wr.users` | 사용자 (`USER` / `ORG_ADMIN` / `ADMIN`, scrypt 해시) |
| `wr.report_weeks` | 주차 마스터. `is_open=false` 면 마감 |
| `wr.reports` | 주간보고 헤더. **(주차 × 작성자) 유니크**, `org_id`는 작성 당시 소속 |
| `wr.report_items` | 업무별 `task_title` / `plan_html` / `result_html`<br>+ `progress_rate`, `next_plan_html` (향후 확장용, 현재 미사용) |
| `wr.attachments` | 증적자료. 원본 파일명은 DB, 실제 파일은 `uploads/<report_id>/<uuid><확장자>` |
| `wr.audit_logs` | 활동 이력 |
| `wr.v_submission_status` | 관리자 현황판용 뷰 (작성자 × 주차 → `NONE`/`DRAFT`/`SUBMITTED`) |
| `wr.v_org_week_summary` | 주차 × 기관별 대상/완료/임시/미등록 인원 집계 |

작성 본문은 `wr.reports`가 아니라 `wr.report_items`에 저장됩니다.

```sql
SELECT r.id, w.label, u.name AS author_name,
       i.sort_order, i.task_title, i.plan_html, i.result_html
  FROM wr.reports r
  JOIN wr.report_items i ON i.report_id = r.id
  JOIN wr.report_weeks w ON w.id = r.week_id
  LEFT JOIN wr.users u ON u.id = r.author_id
 ORDER BY r.id, i.sort_order;
```

### 6-1. 신규 DB 서버에 빈 스키마 생성

`docker-compose.db.yml`로 빈 데이터 디렉터리를 최초 기동하면 `db/init/*.sql`이 자동 실행됩니다.

```bash
cp .env.example .env
# DB_PASSWORD, PGDATA_HOST_DIR 등 설정
podman-compose -f docker-compose.db.yml up -d
podman logs -f wr-db
```

`db/init` 자동 실행은 **PGDATA가 비어 있는 최초 1회만** 수행됩니다.

### 6-2. 기존 DB를 최신 스키마로 갱신

```bash
DB_HOST=192.168.200.116 bash scripts/apply-schema.sh
```

스크립트는 `wr` 스키마 존재 여부를 확인합니다.

- 스키마가 없으면 `db/init/01_schema.sql`, `02_seed.sql` 실행
- 스키마가 있으면 기존 데이터 유지
- 이후 `db/migrations/*.sql`을 파일명 순서대로 적용

마이그레이션 적용 전에는 반드시 `scripts/backup.sh`로 백업하십시오.
`psql`이 없으면 PostgreSQL 컨테이너를 이용합니다.

### 6-3. 기존 데이터까지 다른 DB 서버로 이관

원본 서버:

```bash
bash scripts/backup.sh /backup
```

생성된 두 파일을 대상 DB/APP 서버로 복사합니다.

- `wr-YYYYMMDD-HHMMSS.sql.gz`: 계정, 기관, 주차, 보고서, 업무 계획/실적, 감사 로그
- `wr-YYYYMMDD-HHMMSS.uploads.tar.gz`: 첨부파일 원본

대상 서버에서 복원:

```bash
bash scripts/restore.sh \
  /backup/wr-YYYYMMDD-HHMMSS.sql.gz \
  /backup/wr-YYYYMMDD-HHMMSS.uploads.tar.gz
bash scripts/apply-schema.sh
bash scripts/deploy.sh restart
```

복원은 대상 DB의 기존 데이터를 교체하는 작업이므로 스크립트가 `yes` 확인을 요구합니다.

### 6-4. 스키마 버전 파일

- 신규 설치 기준: `db/init/01_schema.sql`, `db/init/02_seed.sql`
- 기존 설치 변경 이력: `db/migrations/001_*.sql`부터 번호 순서대로 적용
- 적용 명령: `scripts/apply-schema.sh`
- 기존 DB에 마이그레이션만 다시 적용: `scripts/migrate.sh`

### 주차 생성 주기 변경

현재 보고서 양식(`8/13(수)~8/19(화)`)에 맞춰 **수요일 시작**으로 생성됩니다.
월요일 시작으로 바꾸려면 `db/init/02_seed.sql` 의 `generate_series` 시작일
`'2025-01-01'`(수) 을 `'2024-12-30'`(월) 으로 바꾸고 다시 적용하세요.

---

## 7. 백업 / 복원

```bash
# 백업 (DB 덤프 + 증적자료). 30일 지난 백업은 자동 삭제
bash scripts/backup.sh /backup

# cron 등록 예 — 매일 새벽 2시
0 2 * * * cd /opt/weekly-report && bash scripts/backup.sh /backup >> /var/log/wr-backup.log 2>&1

# 복원
bash scripts/restore.sh /backup/wr-20260818-020000.sql.gz /backup/wr-20260818-020000.uploads.tar.gz
```

---

## 8. 보안

적용된 항목:

- 비밀번호 **scrypt** 해싱 (네이티브 모듈 의존 없음)
- 세션: **HttpOnly + SameSite=Lax** 서명 쿠키
- **CSRF 방어**: 상태 변경 요청에 `X-Requested-With` 커스텀 헤더 요구
- **XSS 방어**: 편집기 HTML 을 서버에서 allowlist 기반으로 재정제
  (`<script>`, `on*` 이벤트, `javascript:`, `data:text/html`, `url()`, `expression()`, `<iframe>`, `<svg>` 차단 — 20종 공격 벡터 테스트 통과)
- **CSP** 헤더 (`script-src 'self'`), `X-Frame-Options`, `nosniff`
- 실행 가능 확장자(`.exe .sh .php .jsp .js …`) 업로드 차단, 다운로드는 항상 `application/octet-stream`
- 업로드 경로 이탈(Path Traversal) 검사
- 기관 단위 권한 격리 — 타 기관 보고서 수정/삭제/첨부 불가
- 로그인 실패 10회 시 5분 잠금

**운영 전 반드시 확인:**
1. 초기 관리자 비밀번호 변경
2. `.env` 권한 `600` 유지, git 커밋 금지
3. 외부에 HTTP 로 공개하므로, 가능하면 앞단에 HTTPS 리버스 프록시를 두고 `COOKIE_SECURE=true` 설정
4. DB 5432 포트는 APP 서버 IP 에서만 접근 허용

---

## 9. 디렉터리 구조

```
weekly-report/
├── Containerfile                 APP 이미지 (멀티스테이지 불필요 — 프론트 빌드 없음)
├── docker-compose.yml            개발/올인원 (DB + APP)
├── docker-compose.db.yml         DB 서버 전용 (192.168.200.116)
├── docker-compose.prod.yml       APP 서버 전용 (192.168.200.115)
├── .env.example                  환경변수 템플릿
├── db/
│   ├── init/
│   ├── 01_schema.sql             테이블·인덱스·트리거·뷰
│   └── 02_seed.sql               기관·주차 초기 데이터
│   └── migrations/               기존 DB 순차 마이그레이션
├── server/
│   ├── package.json              의존성 4개 (express, pg, multer, cookie-parser)
│   └── src/
│       ├── index.js              기동·미들웨어·정적파일
│       ├── lib/                  config, db, auth, sanitize, audit
│       └── routes/               auth, meta, reports, files, admin
├── public/
│   ├── login.html / app.html / admin.html
│   ├── css/style.css
│   └── js/                       api, editor, login, app, admin
└── scripts/
    ├── gen-secrets.sh            .env 비밀값 생성
    ├── apply-schema.sh           기존 DB 에 스키마 적용
    ├── migrate.sh                기존 DB 마이그레이션만 순차 적용
    ├── deploy.sh                 package / up / down / logs / status
    ├── backup.sh / restore.sh
```

---

## 10. 트러블슈팅

| 증상 | 확인 |
|---|---|
| `[db] 연결 대기 중` 반복 | DB 서버 방화벽(5432), `DB_HOST`/`DB_PASSWORD` 확인. `podman logs wr-db` |
| 로그인 후 계속 로그인 화면 | `SESSION_SECRET` 미설정 또는 재기동 시 변경됨. `.env` 고정값 사용 |
| `SESSION_SECRET 환경변수가 설정되지 않았습니다` | `bash scripts/gen-secrets.sh` 실행 |
| 첨부 업로드 실패 | `UPLOAD_HOST_DIR` 쓰기 권한, `MAX_UPLOAD_MB` 확인 |
| SELinux 로 볼륨 접근 거부 (Rocky) | compose 의 `:z` 옵션 유지, 또는 `sudo setsebool -P container_manage_cgroup on` |
| 포트 바인딩 실패 | rootless podman 은 1024 미만 포트 불가 → 4-4 항목 참고 |
| 스키마가 안 만들어짐 | `db/init` 은 **최초 기동 시에만** 실행됨 → `scripts/apply-schema.sh` 사용 |
| 이미지 재빌드가 반영 안 됨 | `bash scripts/deploy.sh build` 후 APP 컨테이너 재생성 |

### 상태 확인 명령

```bash
podman ps
podman logs -f wr-app
podman logs -f wr-db
curl http://127.0.0.1:8080/api/health          # {"ok":true,"db":"up",...}
podman exec -it wr-db psql -U wruser -d weekly_report -c '\dt wr.*'
```
