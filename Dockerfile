# den-edge and den-cast are one source release but remain separate minimal runtime images. BuildKit evaluates
# both targets as one graph, so npm dependencies, sources, and the Rust release build are paid for once.
ARG PREVIOUS_IMAGE=scratch
FROM ${PREVIOUS_IMAGE} AS previous

FROM node:26-alpine AS web-source
WORKDIR /web
COPY web/package.json web/package-lock.json ./
# No install scripts: nothing here needs one (Vite's native bundler ships as optional packages), and a
# dependency's script is the usual way a compromised package runs code at install time.
RUN npm ci --ignore-scripts
COPY web ./

FROM web-source AS edge-web
RUN npm run build
COPY --from=previous / /previous
RUN node scripts/keep-previous-assets.mjs

FROM web-source AS cast-web
ARG DEN_PARENT_ORIGINS=https://d.oxy.fi
ENV VITE_DEN_PARENT_ORIGINS=$DEN_PARENT_ORIGINS
RUN npm run build:cast

FROM rust:1-alpine AS rust-build
RUN apk add --no-cache musl-dev
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
# The default package targets include den-edge and den-cast. Compiling them together avoids a second LTO build.
RUN cargo build --release --locked && mkdir -p /out/data

# Both runtime targets copy this marker, so missing release metadata fails before an image can be pushed. The
# version only reaches the final image configuration and does not invalidate the expensive Rust build.
FROM node:26-alpine AS release-metadata
ARG DEN_VERSION
RUN printf '%s\n' "$DEN_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
    || { echo "DEN_VERSION must be X.Y.Z, got '$DEN_VERSION'" >&2; exit 1; }; \
    printf '%s' "$DEN_VERSION" > /den-version

FROM scratch AS edge
ARG DEN_VERSION
ARG GIT_REVISION
ENV DATA_DIR=/data \
    WEB_DIR=/web \
    PORT=8080 \
    DEN_VERSION=$DEN_VERSION
LABEL org.opencontainers.image.version=$DEN_VERSION \
      org.opencontainers.image.revision=$GIT_REVISION
COPY --from=release-metadata /den-version /den-version
COPY --from=rust-build /app/target/release/den-edge /den-edge
COPY --from=edge-web /web/dist /web
# The state directory. The box mounts /var/lib/den/edge-data over it; this empty one, owned by the service
# uid, is what a container without the mount (den-update's probe) writes to and then throws away.
COPY --from=rust-build --chown=65532:65532 /out/data /data
EXPOSE 8080
USER 65532:65532
ENTRYPOINT ["/den-edge"]

FROM scratch AS cast
ARG DEN_VERSION
ARG GIT_REVISION
ENV WEB_DIR=/web \
    PORT=8080 \
    DEN_VERSION=$DEN_VERSION
LABEL org.opencontainers.image.version=$DEN_VERSION \
      org.opencontainers.image.revision=$GIT_REVISION
COPY --from=release-metadata /den-version /den-version
COPY --from=rust-build /app/target/release/den-cast /den-cast
COPY --from=cast-web /web/dist-cast /web
EXPOSE 8080
USER 65532:65532
ENTRYPOINT ["/den-cast"]
