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
- `--ff-only` 가 **거부되면 서버에만 있는 변경이 있다는 뜻입니다.** 절대 `reset --hard` 로 밀지 마세요.
  아래로 확인한 뒤, 살릴 것이 있으면 곁가지로 올려 개발 쪽에서 합칩니다.

  ```bash
  git diff --stat $(git merge-base HEAD kate/main) HEAD   # 서버에만 있는 변경
  git push kate HEAD:server-local                          # 곁가지로 보존
  ```

---

## 2. DB 마이그레이션

```bash
bash scripts/migrate.sh
```

- `db/migrations/*.sql` 을 번호순으로 모두 실행합니다. **여러 번 돌려도 결과가 같습니다.**
- 이미 적용된 것은 `already exists, skipping` 으로 지나갑니다. 정상입니다.
- 마지막에 `[✔] 마이그레이션 완료` 가 나와야 합니다.
- 새로 추가된 파일이 있으면 `[*] 적용: db/migrations/0NN_….sql` 로 표시됩니다.

> `./.env: line NN: … command not found` 가 보이면, `.env` 에 **띄어쓰기가 있는 값에
> 따옴표가 없는 줄**이 있다는 뜻입니다. 그 줄만 무시되고 나머지는 정상 처리됩니다.
> `sed -n 'NN p' .env` 로 확인해 `KEY="값 값"` 처럼 감싸 두면 사라집니다.

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
curl http://192.168.200.115:16000/api/health
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
curl http://192.168.200.115:16000/api/health
```

그래도 안 되면 0번에서 만들어 둔 이미지로 되돌립니다.

```bash
podman tag localhost/weekly-report:rollback-ok localhost/weekly-report:1.0
podman compose -f docker-compose.prod.yml up -d
sleep 5
curl http://192.168.200.115:16000/api/health
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

---

## 한눈에 보기

```bash
cd /home/bi/weekly-report-gcp

# 0) 안전망
git rev-parse --short HEAD
podman tag "$(podman ps --filter name=wr-app --format '{{.Image}}')" localhost/weekly-report:rollback-ok

# 1) 소스
git fetch kate && git merge --ff-only kate/main

# 2) DB
bash scripts/migrate.sh

# 3) 앱  (출력의 compose 정의가 prod 인지 확인)
bash scripts/reload.sh

# 4) 확인
sleep 5 && curl http://192.168.200.115:16000/api/health
```
