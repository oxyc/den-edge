# One image: den-edge, the browser app, the separately compiled webOS TV app, and the Cast page. All three builds
# share one npm install, while their output graphs and runtime host names remain isolated.
ARG PREVIOUS_IMAGE=scratch
ARG DEN_PARENT_ORIGINS="https://d.oxy.fi https://oskars-macbook-pro.tailce93d3.ts.net:8443"
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
# The production browser and Cindy's stable Tailscale HTTPS development face may frame the isolated sender. CSP uses
# a space-separated source list; the sender accepts the same list (and commas for test/build compatibility).
ARG DEN_PARENT_ORIGINS
ENV VITE_DEN_PARENT_ORIGINS=$DEN_PARENT_ORIGINS
RUN npm run build:cast

FROM web-source AS tv-web
# No API origin: den-edge serves the hosted TV app and every route it calls on TV_WEB_HOSTS, so its requests stay
# on its own origin. Links a phone opens name the web app.
ARG DEN_TV_WEB_ORIGIN=https://d.oxy.fi
ENV DEN_TV_WEB_ORIGIN=$DEN_TV_WEB_ORIGIN
RUN npm run build:tv:webos

FROM rust:1-alpine AS rust-build
ARG DEN_PARENT_ORIGINS
ENV DEN_PARENT_ORIGINS=$DEN_PARENT_ORIGINS
RUN apk add --no-cache musl-dev
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked && mkdir -p /out/data

# The runtime image copies this marker, so missing release metadata fails before an image can be pushed. The
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
    TV_WEB_DIR=/tv-web \
    CAST_DIR=/cast \
    PORT=8080 \
    DEN_VERSION=$DEN_VERSION
LABEL org.opencontainers.image.version=$DEN_VERSION \
      org.opencontainers.image.revision=$GIT_REVISION
COPY --from=release-metadata /den-version /den-version
COPY --from=rust-build /app/target/release/den-edge /den-edge
COPY --from=edge-web /web/dist /web
COPY --from=tv-web /web/dist-tv-webos /tv-web
COPY --from=cast-web /web/dist-cast /cast
# The state directory. The box mounts /var/lib/den/edge-data over it; this empty one, owned by the service
# uid, is what a container without the mount (den-update's probe) writes to and then throws away.
COPY --from=rust-build --chown=65532:65532 /out/data /data
EXPOSE 8080
USER 65532:65532
ENTRYPOINT ["/den-edge"]
