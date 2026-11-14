# A Linux desktop for the screen's tests: a virtual display, a window manager that can make a
# window active, a terminal window to act on, and the pinned Cua Driver. Its checksum and its
# sigstore bundle, from the project's release workflow at its tag, are checked before it is kept.
# The tests mount the built service into it; nothing here is the person's machine.
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

ARG DRIVER=0.49.7
ARG COSIGN=v2.4.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl xvfb openbox xterm libxi6 libxkbcommon0 \
  && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
  case "$(dpkg --print-architecture)" in \
    amd64) driver=x86_64 cosign=amd64 \
      driver_sha=bbbc76763df81d8f80a5030a3fde855b744d6d1703fa15da8a38ecdab0cdbd3a \
      cosign_sha=8b24b946dd5809c6bd93de08033bcf6bc0ed7d336b7785787c080f574b89249b ;; \
    arm64) driver=arm64 cosign=arm64 \
      driver_sha=eda50ac8c9a08231263c514a27b8023c8b84ccb7dcb6499c10ee088c509ea493 \
      cosign_sha=3b2e2e3854d0356c45fe6607047526ccd04742d20bd44afb5be91fa2a6e7cb4a ;; \
  esac; \
  cd /tmp; \
  curl -fsSLo cosign "https://github.com/sigstore/cosign/releases/download/${COSIGN}/cosign-linux-${cosign}"; \
  echo "${cosign_sha}  cosign" | sha256sum -c -; \
  chmod +x cosign; \
  file="cua-driver-rs-${DRIVER}-linux-${driver}-binary.tar.gz"; \
  base="https://github.com/trycua/cua/releases/download/cua-driver-rs-v${DRIVER}"; \
  curl -fsSLO "${base}/${file}"; \
  curl -fsSLO "${base}/${file}.sigstore.json"; \
  echo "${driver_sha}  ${file}" | sha256sum -c -; \
  # Signed by the project's own release workflow, at this release's tag, and nothing else.
  ./cosign verify-blob --bundle "${file}.sigstore.json" \
    --certificate-identity "https://github.com/trycua/cua/.github/workflows/cd-rust-cua-driver.yml@refs/tags/cua-driver-rs-v${DRIVER}" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com "${file}"; \
  mkdir /opt/cua-driver; \
  tar -xzf "${file}" -C /opt/cua-driver cua-driver; \
  ln -s /opt/cua-driver/cua-driver /usr/local/bin/cua-driver; \
  rm -f cosign "${file}" "${file}.sigstore.json"

# What the tests start here sends no telemetry.
ENV DO_NOT_TRACK=1 DISPLAY=:99
