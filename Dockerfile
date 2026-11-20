# No dependencies to install: the service uses only the Node.js standard library.
FROM node:22-alpine
WORKDIR /app
COPY package.json LICENSE ./
COPY src ./src
ENV OUT_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["node", "src/main.js"]
CMD ["--config", "/config/config.json"]
