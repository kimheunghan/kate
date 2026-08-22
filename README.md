# 주간실적 보고 시스템 (Weekly Report System)

작성자별 **주간 추진실적(① 당초 계획 / ② 추진 실적 / ③ 향후 계획)** 을 웹에서 등록·수정·조회하고,
증적자료(문서·소스파일)를 첨부하며, 관리자가 전체 제출 현황을 한눈에 확인하는 시스템입니다.

- 프론트엔드: **순수 HTML/CSS/JS** — 프레임워크·빌드 도구·CDN 의존 없음 (폐쇄망에서 그대로 동작)
- 백엔드: **Node.js 20 + Express** (REST API)
- 데이터베이스: **PostgreSQL 16** (`wr` 스키마)
- 배포: **Podman 4.9+/5.x**, podman-compose 또는 Docker Compose V2 호환


## 시스템 아키텍처

### 프론트엔드

- 순수 HTML, CSS, JavaScript
- React, Vue 같은 프레임워크는 사용하지 않음
- Node.js 애플리케이션이 정적 파일로 제공
- 화면: `public/app.html`
- 동작: `public/js/app.js`
- 디자인: `public/css/style.css`

### 백엔드

- Node.js 20 + Express 기반 REST API
- 로그인·세션 인증, 보고서 CRUD, 관리자 기능, 첨부파일, Excel 일괄등록 처리
- Excel 처리: ExcelJS
- 파일 업로드: Multer

### 데이터베이스

- PostgreSQL 16
- `wr` 스키마 사용
- Node.js `pg` 드라이버로 연결

### 컨테이너 배포

- Podman/Docker Compose 호환 구성
- 앱 컨테이너: `wr-app`
- DB 컨테이너: `wr-db`
- `wr-app`이 프론트엔드 정적 파일과 백엔드 REST API를 함께 서비스

> 전체 구조: **순수 JavaScript 프론트엔드 + Node.js/Express 백엔드 + PostgreSQL**

## 현재 운영 배포

> 소스를 운영 서버에 반영하는 절차는 **[docs/DEPLOY.md](docs/DEPLOY.md)** 에 있습니다.
> 되돌리기와 주의사항까지 그대로 따라 하면 됩니다.

- APP: `192.168.200.115:16000` → `wr-app:8080`
- RDB: `192.168.200.116:16432` → `wr-db:5432`
- 내부 접속: `http://192.168.200.115:16000`
- 외부 접속: `http://183.101.26.137:16000`
- 도메인 접속: `http://aips.iptime.org:16000`
- DNAT: `183.101.26.137:16000` → `192.168.200.115:16000`
- APP 경로: `/home/bi/weekly-report-gcp`
- 첨부 경로: `/home/bi/weekly-report-gcp/uploads`
- DB 경로: `/home/bi/weekly-report-db/data/pgdata`

```bash
# APP 상태 및 헬스체크
podman ps --filter name=wr-app
curl http://192.168.200.115:16000/api/health

# APP 재기동
cd /home/bi/weekly-report-gcp
podman compose -f docker-compose.prod.yml up -d --no-build
```

---

## 1. 기술 구성

Node.js 애플리케이션 하나가 **프론트 정적 파일과 백엔드 API 를 함께 서비스**합니다.
별도의 웹서버(nginx 등)나 프론트엔드 빌드 과정이 없습니다.

```
브라우저
   │  HTML/CSS/JS 정적 파일 + REST API  (같은 포트)
   ▼
wr-app  (Node.js 20 + Express)
   │  pg 드라이버
   ▼
wr-db   (PostgreSQL 16, wr 스키마)
```

### 프론트엔드 — 순수 HTML · CSS · JavaScript

React, Vue 같은 프레임워크를 쓰지 않습니다. 빌드 도구·CDN 의존이 없어
폐쇄망 서버에 소스를 그대로 올려도 동작하며, 이관 시 빌드 실패 위험이 없습니다.

| 구분 | 파일 |
|---|---|
| 화면 | `public/app.html` (작성/조회), `admin.html`, `login.html`, `signup.html`, `reset.html` |
| 동작 | `public/js/app.js` (작성/조회), `admin.js`, `api.js`(공통), `editor.js`(리치텍스트) |
| 디자인 | `public/css/style.css` |

서버에서 정적 파일로 제공하며, 파일이 바뀌면 URL 에 버전(`?v=…`)이 자동으로 붙어
브라우저가 옛 파일을 계속 쓰는 일이 없습니다.

### 백엔드 — Node.js 20 + Express (REST API)

| 기능 | 라우터 |
|---|---|
| 로그인·세션 인증, 회원가입, 비밀번호 재설정 | `server/src/routes/auth.js` |
| 보고서 CRUD, 인쇄·Word 내보내기 | `routes/reports.js` |
| 첨부파일(증적자료) 업로드·다운로드 | `routes/files.js` |
| Excel 일괄 등록·내보내기 | `routes/excel.js` |
| 관리자 기능(현황·사용자·기관·주차·승인) | `routes/admin.js` |
| 주차·기관 목록 | `routes/meta.js` |

의존성은 6개뿐입니다.

| 패키지 | 용도 |
|---|---|
| `express` | HTTP 서버·라우팅 |
| `pg` | PostgreSQL 드라이버 |
| `multer` | 파일 업로드 |
| `exceljs` | Excel 처리 |
| `cookie-parser` | 세션 쿠키 |
| `nodemailer` | 메일 발송(SMTP 설정 시에만 동작) |

비밀번호 해싱은 Node 내장 `crypto.scrypt`, HTML 정제(XSS 방어)는
`server/src/lib/sanitize.js` 자체 구현이라 네이티브 모듈 의존이 없습니다.

### 데이터베이스 — PostgreSQL 16

- `wr` 스키마 사용 (`public` 아님)
- Node.js `pg` 드라이버로 연결, 커넥션 풀 사용
- 스키마 정의 `db/init/01_schema.sql`, 변경 이력 `db/migrations/*.sql`

### 배포 — Podman / Docker Compose 호환 컨테이너

| 컨테이너 | 이미지 | 역할 |
|---|---|---|
| `wr-app` | `localhost/weekly-report:1.0` (Containerfile 로 빌드) | 웹 + API |
| `wr-db` | `postgres:16-alpine` | 데이터베이스 |

Compose 파일 3종을 용도에 따라 사용합니다.

| 파일 | 용도 |
|---|---|
| `docker-compose.yml` | 개발·올인원 (앱 + DB 한 호스트) |
| `docker-compose.db.yml` | 운영 DB 서버 전용 (192.168.200.116) |
| `docker-compose.prod.yml` | 운영 APP 서버 전용 (192.168.200.115) |

---

## 2. GCP 개발 서버

소스를 개발·검증하는 서버는 아래 GCP Compute Engine 인스턴스입니다.
운영은 사내 APP/RDB 서버로 이관을 마쳤고, 이 환경은 **개발 전용**입니다.

| 항목 | 현재 값 |
|---|---|
| GCP 인스턴스 | `instance-20260814-050936` |
| 리전/존 | `asia-northeast3-b` |
| GCP 내부 IP | `10.178.0.2` |
| GCP 외부 IP | `34.158.212.199` |
| 애플리케이션 접속 | `http://34.158.212.199:8080` |
| 상태 확인 | `http://34.158.212.199:8080/api/health` |
| APP 호스트 포트 | `8080` → 컨테이너 `8080` |
| DB 호스트 포트 | `15432` → 컨테이너 `5432` |
| DB 컨테이너 내부 접속 | `db:5432` |
| DB 이름 / 사용자 / 스키마 | `weekly_report` / `wruser` / `wr` (비밀번호는 서버 `.env`) |
| 실행 컨테이너 | `wr-app`, `wr-db` |
| Compose 파일 | `docker-compose.yml` (APP + DB 올인원) |

> 외부 IP가 임시(Ephemeral) 주소이면 인스턴스 재생성 시 바뀔 수 있습니다. 운영 접속에
> 사용할 경우 GCP에서 고정(Static) 외부 IP로 예약하세요. 포트 `8080`은 GCP VPC 방화벽에서
> 필요한 접속 대역에만 허용하고, DB 호스트 포트 `15432`는 인터넷 전체에 공개하지 마세요.

현재 GCP 개발 서버의 `.env` 핵심 설정은 다음과 같습니다. 실제 비밀번호와 세션 키는
보안상 Git에 올리지 않으며 서버의 `.env`에만 보관합니다.

```ini
APP_PORT=8080
DB_HOST=db
DB_PORT=5432
DB_EXPOSE_PORT=15432
DB_NAME=weekly_report
DB_USER=wruser
DB_PASSWORD=<서버 .env에서 관리>
```

현재 상태 확인 명령:

```bash
cd ~/weekly-report
podman ps
podman port wr-app                 # 0.0.0.0:8080
podman port wr-db                  # 0.0.0.0:15432
curl http://127.0.0.1:8080/api/health
podman exec wr-db psql -U wruser -d weekly_report
```

소스 파일을 수정했다고 컨테이너나 사내 서버에 자동 동기화되지는 않습니다. GCP 개발
환경에 반영하려면 이미지를 다시 빌드하고 APP 컨테이너를 교체해야 합니다.

```bash
podman-compose -f docker-compose.yml build app
podman rm -f wr-app
podman-compose -f docker-compose.yml up -d app
```

`192.168.200.115:16000`은 현재 GCP 개발 서버와 연결되거나 자동 동기화된 주소가 아닙니다.
사내 서버 배포는 아래 운영 이관 절차를 별도로 수행해야 합니다.

---

## 3. 사내 운영 서버 구성 (이관 완료)

| 역할 | 주소 | 사양 | OS | podman |
|---|---|---|---|---|
| **RDB** | `192.168.200.116` | 16 Core | Rocky Linux (최신) | 5.8.2 |
| **APP** (web/was) | `192.168.200.115` | 8 Core | Ubuntu 22.04 LTS | 4.9.3 |
| 외부 주소 | `http://183.101.26.137:16000` | — | NAT 설정 완료 | |
| 도메인 | `http://aips.iptime.org:16000` | — | 위 외부 주소를 가리킵니다 | |

```
 인터넷 ──▶ aips.iptime.org:16000  =  183.101.26.137:16000
                    │ DNAT
                    ▼ 192.168.200.115:16000
                    │
                    ▼
        ┌───────────────────────┐         ┌──────────────────────┐
        │ APP  192.168.200.115  │ 16432   │ RDB  192.168.200.116 │
        │  wr-app (Node 20)     │────────▶│  wr-db (PostgreSQL16)│
        │  볼륨: ./uploads │         │  볼륨: ./data/pgdata │
        └───────────────────────┘         └──────────────────────┘
```

> ### 포트 정책
> **두 서버 모두 `16000~16999` 만 개방되어 있습니다.** 이 범위를 벗어나면 서버 안에서는
> 접속되지만 외부·서버 간 통신이 되지 않습니다.
>
> | 용도 | 포트 | 비고 |
> |---|---|---|
> | 웹 서비스 (APP 내부) | `16000` | `.env` 의 `APP_PORT` |
> | 외부 포트 | `16000` | DNAT 로 내부 `16000` 에 그대로 전달 |
> | PostgreSQL (RDB) | `16432` | `.env` 의 `DB_PORT`. 컨테이너 내부는 5432 그대로 |
>
> 포트를 바꾸려면 `.env` 값만 수정하면 되며, 코드 수정은 필요 없습니다.

---

## 4. 기능

### 사용자 (작성자)
- **로그인 / 비밀번호 변경** (세션 12시간, 로그인 10회 실패 시 5분 잠금)
- **주간보고 작성** — 항목별로 `① 당초 계획 / ② 추진 실적 / ③ 향후 계획` 행을 추가·삭제·순서변경
  (보고서는 **작성자 1명 × 주차 1건**. 기관은 작성 당시 소속으로 기록되어 기관별 집계에 쓰입니다)
- **서식 편집기** — 글꼴·크기·굵게·기울임·밑줄·취소선·글자색·형광펜·정렬·글머리표·번호·들여쓰기·인용·링크·표·이미지·서식지우기
  (붙여넣기 시 서식 유지, 화면 캡처 붙여넣기 지원)
- **증적자료 첨부** — 드래그&드롭 / 다중 업로드 / 한글 파일명 / 다운로드 / 삭제
- **임시저장 · 제출** 구분, 저장 즉시 화면에 반영
- **조회** — 주차·상태·검색어(본문)로 검색, 페이징. **본인이 작성한 보고서만** 표시
- **직전 주차 불러오기** — 지난주 `③ 향후 계획` 을 이번 주 `① 당초 계획` 으로 가져와 이어쓰기
- **Excel 일괄등록** — 주차를 화면에서 선택하지 않고 `.xlsx` 한 파일의 시작일·종료일을 기준으로 여러 주차를 자동 분류하여 미리보기 후 등록
- **인쇄 / PDF · Word 다운로드** — 보고서 양식 그대로 출력 (Word 파일은 한글에서 열어 .hwp 로 저장 가능)

### 관리자
- **등록 현황** — 선택 주차의 **작성자별** 제출 상태. 미제출자까지 모두 표시되며
  기관·상태·이름으로 필터. 제출률은 `제출 인원 / 대상 인원` (대상 인원은 가입자 수로 자동 산정)
- **주차별 현황판** — 최근 N주 × 기관별 대상 인원/완료/임시/미등록 집계
- **기관 관리** — 추가·수정·사용중지·삭제
- **사용자 관리** — 계정 생성·수정·비밀번호 초기화·정지·삭제 (마지막 관리자 강등 방지)
- **가입 승인** — 승인제로 운영할 경우 신청 승인·반려, 비밀번호 재설정 요청 처리
- **보고서 소속변경** — 잘못된 기관으로 등록된 보고서를 올바른 기관으로 이관
- **활동 로그** — 로그인·저장·삭제·업로드 이력

### 권한 체계

| 권한 | 보고서 열람 범위 | 관리 기능 |
|---|---|---|
| `USER` (작성자) | **본인이 작성한 것만** | — |
| `ORG_ADMIN` (기관관리자) | 자기 기관 소속 전체 | — (관리자 화면 없음) |
| `SUPERVISOR` (감독관리자) | 전부 (조회 전용) | 주차별 현황판 |
| `ADMIN` (총괄관리자) | 전부 | 등록 현황·주차별 현황판·사용자·기관·활동 로그 |

`can_view_all` (중복권한) 을 켠 3사 소속 사용자는 권한과 소속을 그대로 둔 채
등록 내역을 전 기관으로 보고 주차별 현황판을 쓸 수 있습니다. 참여 인력 자격은
유지되므로 대상 인원에 한 명으로 남습니다.

관리자 화면(`/admin`)은 **총괄관리자 · 감독관리자 · 중복권한자**만 들어갑니다.
작성자와 기관관리자는 주간보고 화면만 씁니다.

목록뿐 아니라 상세 조회·인쇄·Word 내보내기·첨부 다운로드에도 동일한 범위가 적용됩니다.
보고서 **수정**은 권한과 무관하게 언제나 작성 본인만 할 수 있습니다.

> **감독관리자는 참여 인력이 아닙니다.** 등록 현황의 대상 인원에 들어가지 않습니다.
> 본인이 쓴 보고서는 등록 내역에 나오지 않으며 본인 화면에서 한글로만 내려받을 수
> 있습니다. 활동 로그는 다른 사람과 똑같이 남습니다.

> **진도율(`report_items.progress_rate`)은 화면에 노출하지 않습니다.**
> 나중에 추가할 때 DB 마이그레이션이 필요 없도록 컬럼은 미리 만들어 두었습니다.

---

## 5. 빠른 시작 (신규 개발 서버)

```bash
cd weekly-report-gcp

# 1) .env 생성 + 비밀값 자동 생성
bash scripts/gen-secrets.sh

# 2) 기동 (DB + APP 한 번에)
podman-compose up -d --build

# 3) 확인
curl http://127.0.0.1:16000/api/health     # .env.example 의 APP_PORT 기본값 16000
podman logs -f wr-app
```

브라우저에서 `http://<서버IP>:16000` 접속 → (`.env` 의 `APP_PORT`)
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

## 6. 운영 이관 절차 (소스·이미지)

이관 대상은 세 묶음입니다.

1. `weekly-report-deploy-YYYYMMDD.tar.gz`: 소스, DB 스키마/마이그레이션, Compose, 운영 스크립트
2. `weekly-report-YYYYMMDD.tar`: APP 컨테이너 이미지
3. `postgres-16-alpine.tar`: PostgreSQL 컨테이너 이미지

`.env`, DB 데이터, 첨부파일은 보안과 데이터 보호를 위해 소스 패키지에 포함하지 않습니다.

### 6-1. 이관 패키지 만들기 (개발 서버에서)

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

### 6-2. DB 서버 (192.168.200.116, Rocky Linux)

```bash
scp dist/postgres-16-alpine.tar dist/weekly-report-deploy-*.tar.gz  user@192.168.200.116:~/
ssh user@192.168.200.116

podman load -i postgres-16-alpine.tar
mkdir -p ~/weekly-report-db && tar xzf weekly-report-deploy-*.tar.gz -C ~/weekly-report-db
cd ~/weekly-report-db

cp .env.example .env
bash scripts/gen-secrets.sh          # ← 여기서 나온 DB_PASSWORD 를 APP 서버에도 동일하게 사용
podman-compose -f docker-compose.db.yml up -d

# 방화벽: APP 서버에서만 16432 접근 허용
#   192.168.200.116 도 개방 포트가 16000~16999 이므로 PostgreSQL 을 16432 로 노출한다.
#   (컨테이너 내부는 5432 그대로, 호스트에만 16432 로 매핑)
sudo firewall-cmd --permanent \
  --add-rich-rule='rule family=ipv4 source address=192.168.200.115/32 port port=16432 protocol=tcp accept'
sudo firewall-cmd --reload
```

최초 기동 시 `db/init/01_schema.sql`, `02_seed.sql` 이 **자동 실행**되어
스키마 · 기관 · 주차(1주차 2026-04-23 ~ 49주차 2027-03-31, 목~수 주기 49주)가 그대로 생성됩니다.

### 6-3. APP 서버 (192.168.200.115, Ubuntu 22.04)

```bash
scp dist/weekly-report-*.tar dist/weekly-report-deploy-*.tar.gz  user@192.168.200.115:~/
ssh user@192.168.200.115

podman load -i weekly-report-*.tar
mkdir -p ~/weekly-report-gcp && tar xzf weekly-report-deploy-*.tar.gz -C ~/weekly-report-gcp
cd ~/weekly-report-gcp

cp .env.example .env
vi .env
```

`.env` 에서 다음 값을 채웁니다.

```ini
APP_PORT=16000                      # ← 16000~16999 범위에서만 외부 접속 가능
DB_HOST=192.168.200.116
DB_PORT=16432                       # ← RDB 가 호스트에 노출한 포트
DB_PASSWORD=<DB 서버에서 생성된 값과 동일하게>
SESSION_SECRET=<openssl rand -hex 32>
ADMIN_PASSWORD=<초기 관리자 비밀번호>
UPLOAD_HOST_DIR=./uploads
```

```bash
bash scripts/deploy.sh up          # load한 이미지를 그대로 기동 + health 확인
bash scripts/deploy.sh status
bash scripts/deploy.sh logs
```

내부 접속: `http://192.168.200.115:16000`

외부 접속: `http://183.101.26.137:16000`

도메인 접속: `http://aips.iptime.org:16000`

`183.101.26.137:16000` → `192.168.200.115:16000` DNAT 와 인바운드 방화벽 허용이 모두 적용되어 있습니다.

### 6-4. 포트가 확정되면

`.env` 의 `APP_PORT` 만 바꾸고 재기동하면 됩니다. 코드 수정 불필요.

> **`192.168.200.115` 는 16000~16999 포트만 개방되어 있습니다.**
> 이 범위를 벗어난 포트로 띄우면 서버 안에서는 접속되지만 외부에서는 닿지 않습니다.

```bash
sed -i 's/^APP_PORT=.*/APP_PORT=16000/' .env
bash scripts/deploy.sh down && bash scripts/deploy.sh up
```

> 운영 포트 범위(16000~16999)는 모두 1024 이상이라 rootless podman 에서 그대로 바인딩됩니다.
> 만약 80/443 같은 낮은 포트를 써야 한다면 아래 설정이 추가로 필요합니다.
> ```bash
> echo 'net.ipv4.ip_unprivileged_port_start=80' | sudo tee /etc/sysctl.d/99-podman.conf
> sudo sysctl --system
> ```

### 6-5. 서버 재부팅 시 자동 기동

```bash
podman generate systemd --new --name wr-app --files --restart-policy=always
mkdir -p ~/.config/systemd/user && mv container-wr-app.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now container-wr-app.service
sudo loginctl enable-linger $USER     # 로그아웃 후에도 유지
```

DB 서버(`wr-db`)도 동일하게 등록하세요.

---

## 7. 환경변수 (`.env`)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `APP_PORT` | `16000` | 호스트에 노출할 포트. **운영 서버는 16000~16999 만 개방** |
| `SESSION_SECRET` | — | **필수**. 세션 쿠키 서명 키. `openssl rand -hex 32` |
| `SESSION_TTL_SECONDS` | `43200` | 세션 유지 시간(초). 기본 12시간 |
| `COOKIE_SECURE` | `false` | HTTPS 로 서비스하면 `true` |
| `MAX_UPLOAD_MB` | `50` | 첨부파일 1개 최대 크기 |
| `UPLOAD_HOST_DIR` | `./data/uploads` | 증적자료를 보관할 호스트 경로 |
| `DB_HOST` | `db` | 개발=`db`, 운영=`192.168.200.116` |
| `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | `16432` / `weekly_report` / `wruser` / — | DB 접속 정보. **운영 RDB 도 16000~16999 만 개방** |
| `DB_EXPOSE_PORT` | `15432` | 개발 구성에서 호스트로 노출할 DB 포트 |
| `PGDATA_HOST_DIR` | `./data/pgdata` | DB 데이터 디렉터리 (DB 서버) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_NAME` | `admin` / — / `관리자` | 관리자 계정이 하나도 없을 때만 자동 생성 |

---

## 8. DB 스키마 및 이관

스키마 이름은 **`wr`** 입니다. 전체 정의는 `db/init/01_schema.sql`.

| 테이블 | 설명 |
|---|---|
| `wr.organizations` | 기관 (보고 작성 단위) |
| `wr.users` | 사용자 (`USER` / `ORG_ADMIN` / `ADMIN`, scrypt 해시) |
| `wr.report_weeks` | 주차 마스터 |
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

### 8-1. 신규 DB 서버에 빈 스키마 생성

`docker-compose.db.yml`로 빈 데이터 디렉터리를 최초 기동하면 `db/init/*.sql`이 자동 실행됩니다.

```bash
cp .env.example .env
# DB_PASSWORD, PGDATA_HOST_DIR 등 설정
podman-compose -f docker-compose.db.yml up -d
podman logs -f wr-db
```

`db/init` 자동 실행은 **PGDATA가 비어 있는 최초 1회만** 수행됩니다.

### 8-2. 기존 DB를 최신 스키마로 갱신

```bash
DB_HOST=192.168.200.116 bash scripts/apply-schema.sh
```

스크립트는 `wr` 스키마 존재 여부를 확인합니다.

- 스키마가 없으면 `db/init/01_schema.sql`, `02_seed.sql` 실행
- 스키마가 있으면 기존 데이터 유지
- 이후 `db/migrations/*.sql`을 파일명 순서대로 적용

마이그레이션 적용 전에는 반드시 `scripts/backup.sh`로 백업하십시오.
`psql`이 없으면 PostgreSQL 컨테이너를 이용합니다.

### 8-3. 기존 데이터까지 다른 DB 서버로 이관

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

### 8-4. 스키마 버전 파일

- 신규 설치 기준: `db/init/01_schema.sql`, `db/init/02_seed.sql`
- 기존 설치 변경 이력: `db/migrations/001_*.sql`부터 번호 순서대로 적용
- 적용 명령: `scripts/apply-schema.sh`
- 기존 DB에 마이그레이션만 다시 적용: `scripts/migrate.sh`

### 주차 생성 주기 변경

주간보고는 **매주 수요일**에 작성하며 대상 기간은 직전 목요일 ~ 당일 수요일입니다.
따라서 주차는 **목~수** 주기이고, 1주차 시작일은 `2026-04-23(목)` 입니다.
(`2026-04-23 + 16주 = 2026-08-13` → `2026/08/13목~08/19수` 가 **17주차**)

마지막 주차는 사업 종료일에 맞춰 **49주차(2027/03/25목~03/31수)** 까지만 만듭니다.

기준일이나 마지막 주차를 바꾸려면 `db/init/02_seed.sql` 의 `WEEK_BASELINE` /
`WEEK_END` 주석이 달린 날짜를 바꾸고 다시 적용하세요.
이미 운영 중인 DB 에서 기간만 줄이려면 `db/migrations/013_week_end_2027.sql`
처럼 기준일 이후 주차를 지우는 마이그레이션을 추가하면 됩니다.
(보고서가 달린 주차는 지우지 않습니다) 이미 운영 중인 DB 는
`db/migrations/007_week_thu_wed.sql` 처럼 기준일을 바꾼 마이그레이션을 추가하면
기존 보고서가 겹치는 기간이 가장 큰 새 주차로 자동 이관됩니다.

---

### 활동 로그 보관 기간

활동 로그는 기본으로 **1년(365일)** 만 보관합니다. 그보다 오래된 기록은
앱이 뜰 때 한 번, 그 뒤로는 하루에 한 번 자동으로 지워집니다.

`.env` 의 `AUDIT_RETENTION_DAYS` 로 바꿉니다.

| 값 | 뜻 |
|---|---|
| `365` | 1년 보관 (기본) |
| `1095` | 3년 보관 |
| `0` | 지우지 않음 |

기록을 오래 남겨야 하면 지우기 전에 활동 로그 탭에서 엑셀로 내려받아
따로 보관하세요.

---

## 9. 백업 / 복원

```bash
# 백업 (DB 덤프 + 증적자료). 30일 지난 백업은 자동 삭제
bash scripts/backup.sh /backup

# cron 등록 예 — 매일 새벽 2시
0 2 * * * cd /home/bi/weekly-report-gcp && bash scripts/backup.sh /backup >> /var/log/wr-backup.log 2>&1

# 복원
bash scripts/restore.sh /backup/wr-20260818-020000.sql.gz /backup/wr-20260818-020000.uploads.tar.gz
```

---

## 10. 보안

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
4. DB 포트(16432)는 APP 서버 IP 에서만 접근 허용

---

## 11. 디렉터리 구조

```
weekly-report-gcp/
├── Containerfile                 APP 이미지 (멀티스테이지 불필요 — 프론트 빌드 없음)
├── docker-compose.yml            개발/올인원 (DB + APP)
├── docker-compose.db.yml         DB 서버 전용 (192.168.200.116)
├── docker-compose.prod.yml       APP 서버 전용 (192.168.200.115)
├── .env.example                  환경변수 템플릿
├── db/
│   ├── init/
│   │   ├── 01_schema.sql         테이블·인덱스·트리거·뷰
│   │   └── 02_seed.sql           기관·주차 초기 데이터
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
├── uploads/                      증적자료 호스트 저장소 (git 제외)
│   └── <report_id>/<uuid>.<ext>  보고서별 실제 첨부파일
└── scripts/
    ├── gen-secrets.sh            .env 비밀값 생성
    ├── apply-schema.sh           기존 DB 에 스키마 적용
    ├── migrate.sh                기존 DB 마이그레이션만 순차 적용
    ├── deploy.sh                 package / up / down / logs / status
    ├── backup.sh / restore.sh
```

---

## 12. 트러블슈팅

| 증상 | 확인 |
|---|---|
| `[db] 연결 대기 중` 반복 | DB 서버 방화벽(16432), `DB_HOST`/`DB_PORT`/`DB_PASSWORD` 확인. `podman logs wr-db` |
| 로그인 후 계속 로그인 화면 | `SESSION_SECRET` 미설정 또는 재기동 시 변경됨. `.env` 고정값 사용 |
| `SESSION_SECRET 환경변수가 설정되지 않았습니다` | `bash scripts/gen-secrets.sh` 실행 |
| 첨부 업로드 실패 | `UPLOAD_HOST_DIR` 쓰기 권한, `MAX_UPLOAD_MB` 확인 |
| SELinux 로 볼륨 접근 거부 (Rocky) | compose 의 `:z` 옵션 유지, 또는 `sudo setsebool -P container_manage_cgroup on` |
| 포트 바인딩 실패 | rootless podman 은 1024 미만 포트 불가 → 5-4 항목 참고 |
| 스키마가 안 만들어짐 | `db/init` 은 **최초 기동 시에만** 실행됨 → `scripts/apply-schema.sh` 사용 |
| 이미지 재빌드가 반영 안 됨 | `bash scripts/deploy.sh build` 후 APP 컨테이너 재생성 |

### 상태 확인 명령

```bash
podman ps
podman logs -f wr-app
podman logs -f wr-db
curl http://127.0.0.1:16000/api/health         # {"ok":true,"db":"up",...}
podman exec -it wr-db psql -U wruser -d weekly_report -c '\dt wr.*'
```
