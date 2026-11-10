# The computer image: AgentExec, Playwright MCP and a browser, run by the service, one container a
# computer. Run `npm run build` first; this copies what that made.
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS modules

# node-pty, for the terminal, compiles here, so the toolchain stays out of the image.
WORKDIR /opt/agentcomputer
COPY package.json package-lock.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && npm ci --omit=dev

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers HOME=/home/computer

WORKDIR /opt/agentcomputer
COPY --from=modules /opt/agentcomputer/node_modules ./node_modules
COPY package.json package-lock.json LICENSE NOTICE ./
COPY dist ./dist
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git python3 \
  && node node_modules/playwright-core/cli.js install --with-deps --only-shell chromium \
  && ln -s /opt/browsers/chromium_headless_shell-*/*/chrome-headless-shell /opt/browsers/headless-shell \
  && rm -rf /var/lib/apt/lists/* "$HOME/.npm"

# Any user can be its home's owner: the service runs a computer as whoever runs the service.
RUN mkdir -p /home/computer /workspace && chmod 1777 /home/computer /workspace
USER 1000:1000
WORKDIR /workspace

ENTRYPOINT ["node", "/opt/agentcomputer/dist/agentcomputer.js"]
