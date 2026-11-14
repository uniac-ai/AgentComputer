# A Linux desktop for the screen's tests: a virtual display, a window manager that can make a
# window active, a terminal window to act on, and the pinned Cua Driver, its sigstore bundle
# checked before it is kept. The tests mount the built service into it; nothing here is the
# person's machine.
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

ARG DRIVER=0.49.7
ARG COSIGN=v2.4.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl xvfb openbox xterm libxi6 libxkbcommon0 \
  && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
  case "$(dpkg --print-architecture)" in \
    amd64) driver=x86_64 cosign=amd64 ;; \
    arm64) driver=arm64 cosign=arm64 ;; \
  esac; \
  cd /tmp; \
  curl -fsSLo cosign "https://github.com/sigstore/cosign/releases/download/${COSIGN}/cosign-linux-${cosign}"; \
  chmod +x cosign; \
  file="cua-driver-rs-${DRIVER}-linux-${driver}-binary.tar.gz"; \
  base="https://github.com/trycua/cua/releases/download/cua-driver-rs-v${DRIVER}"; \
  curl -fsSLO "${base}/${file}"; \
  curl -fsSLO "${base}/${file}.sigstore.json"; \
  ./cosign verify-blob --bundle "${file}.sigstore.json" \
    --certificate-identity-regexp '^https://github.com/trycua/cua/' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com "${file}"; \
  mkdir /opt/cua-driver; \
  tar -xzf "${file}" -C /opt/cua-driver cua-driver; \
  ln -s /opt/cua-driver/cua-driver /usr/local/bin/cua-driver; \
  rm -f cosign "${file}" "${file}.sigstore.json"

# What the tests start here sends no telemetry.
ENV DO_NOT_TRACK=1 DISPLAY=:99
