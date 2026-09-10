# den-edge — a static musl binary built on Alpine, copied into `scratch`, like every den Rust service.
FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY app ./app
# rust:alpine's default host target is x86_64-unknown-linux-musl → a fully static binary.
RUN cargo build --release --locked && mkdir -p /out/data

FROM scratch AS runtime
ENV DATA_DIR=/data \
    PORT=8080
COPY --from=build /app/target/release/den-edge /den-edge
# The state directory. The box mounts /var/lib/den/edge-data over it; this empty one, owned by the service
# uid, is what a container without the mount (den-update's probe) writes to and then throws away.
COPY --from=build --chown=65532:65532 /out/data /data
EXPOSE 8080
# scratch has no /etc/passwd, so the uid is numeric: 65532, the one every den image runs as. No
# HEALTHCHECK: den-update probes /health and /config when it deploys.
USER 65532:65532
ENTRYPOINT ["/den-edge"]
