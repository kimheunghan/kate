# =====================================================================
#  주간보고 시스템 - 애플리케이션 이미지
#  podman build -t weekly-report:1.0 -f Containerfile .
#  (Dockerfile 로도 동일하게 동작합니다)
# =====================================================================
FROM docker.io/library/node:20-alpine

# 한국 시간대 (로그·타임스탬프 표기용. DB 는 timestamptz 라 무관)
RUN apk add --no-cache tzdata curl && \
    cp /usr/share/zoneinfo/Asia/Seoul /etc/localtime && \
    echo "Asia/Seoul" > /etc/timezone
ENV TZ=Asia/Seoul
ENV NODE_ENV=production

WORKDIR /app

# 의존성 레이어 분리 (소스만 바뀔 때 npm install 재실행 방지)
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# 애플리케이션
COPY server ./server
COPY public ./public

# 업로드 디렉터리 (볼륨으로 마운트됨)
RUN mkdir -p /app/uploads && chown -R node:node /app

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "server/src/index.js"]
