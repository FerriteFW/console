# The Linux bundles' build box: Ubuntu 22.04, as Tauri advises for AppImages (build on the oldest system to support:
# glibc 2.35 here, so the AppImage runs on Ubuntu 22.04, Debian 12 and anything newer; Debian 13's needed 2.39).
# Its WebKitGTK is also built with fewer extras than Debian 13's (no speech voices, fewer image codecs), so the
# AppImage is smaller. Used by tools/desktop-build.sh for linux; Windows stays on ../Dockerfile (NSIS 3.11).
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git build-essential pkg-config \
      libwebkit2gtk-4.1-dev libudev-dev libdbus-1-dev librsvg2-dev libayatana-appindicator3-dev \
      patchelf file xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Node at the version the Debian image has (node:24), from nodejs.org's own build.
ARG NODE=24.21.0
RUN curl -fsSL https://nodejs.org/dist/v$NODE/node-v$NODE-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1

# Rust at Console's pinned version (rust-toolchain.toml), with the browser target.
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
ARG RUST=1.99
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain $RUST \
      --component clippy --component rustfmt --target wasm32-unknown-unknown

# wasm-bindgen at the version wasm/Cargo.toml pins (scripts/build-wasm.mjs checks it).
ARG WASM_BINDGEN=0.2.129
RUN cargo install --locked wasm-bindgen-cli --version $WASM_BINDGEN \
    && rm -rf $CARGO_HOME/registry \
    && chmod -R a+rwX $CARGO_HOME $RUSTUP_HOME
