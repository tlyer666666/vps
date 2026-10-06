# 多阶段构建:最终镜像仅含运行所需(零 npm 依赖,无需构建步骤)
FROM node:22-alpine AS runtime

WORKDIR /opt/vpswatch
ENV NODE_ENV=production

COPY package.json ./
COPY server ./server

# 数据目录(挂载卷以持久化 SQLite 数据库)
RUN mkdir -p /opt/vpswatch/data && chown -R node:node /opt/vpswatch
VOLUME /opt/vpswatch/data

EXPOSE 3577
USER node
CMD ["node", "server/main.js", "--data-dir", "/opt/vpswatch/data"]
