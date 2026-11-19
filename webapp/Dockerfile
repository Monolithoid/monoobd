FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js backends.js ./

# Pre-create the sessions directory with the right owner.
# When the host volume is mounted, its permissions take precedence;
# this RUN is a fallback (local dev without a volume).
RUN mkdir -p /data/sessions /data/projects /data/renders \
 && chown node:node /data/sessions /data/projects /data/renders

USER node
CMD ["node", "server.js"]
