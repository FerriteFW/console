# The desktop app's build box: the Linux bundles (.deb, .rpm, .AppImage) natively, and the Windows installer (NSIS
# setup.exe) cross-compiled with cargo-xwin, as Tauri's "Windows installer on Linux" guide does it. Used by
# tools/desktop-build.sh; nothing here is specific to one host.
FROM node:24

RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev libudev-dev libdbus-1-dev librsvg2-dev libayatana-appindicator3-dev \
      patchelf file xdg-utils \
      nsis clang lld llvm \
    && rm -rf /var/lib/apt/lists/*

# Rust at Console's pinned version (rust-toolchain.toml), with the browser and Windows targets.
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
ARG RUST=1.99
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain $RUST \
      --component clippy --component rustfmt \
      --target wasm32-unknown-unknown --target x86_64-pc-windows-msvc

# wasm-bindgen at the version wasm/Cargo.toml pins (scripts/build-wasm.mjs checks it), and cargo-xwin.
ARG WASM_BINDGEN=0.2.129
RUN cargo install --locked wasm-bindgen-cli --version $WASM_BINDGEN \
    && cargo install --locked cargo-xwin \
    && rm -rf $CARGO_HOME/registry \
    && chmod -R a+rwX $CARGO_HOME $RUSTUP_HOME
