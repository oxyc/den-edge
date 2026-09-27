FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY bench/probe.rs bench/stage.rs bench/upstream.rs /bench/
RUN cargo build --release --locked \
    && rustc --edition=2021 -C opt-level=2 -C target-feature=+crt-static /bench/probe.rs -o /probe \
    && rustc --edition=2021 -C opt-level=2 -C target-feature=+crt-static /bench/stage.rs -o /stage \
    && rustc --edition=2021 -C opt-level=2 -C target-feature=+crt-static /bench/upstream.rs -o /upstream

FROM scratch AS edge
ENV DATA_DIR=/data WEB_DIR=/web PORT=8080
COPY --from=build /app/target/release/den-edge /den-edge
COPY --from=build /probe /probe
COPY --from=build /stage /stage
USER 65532:65532
ENTRYPOINT ["/stage"]

FROM scratch AS upstream
COPY --from=build /upstream /upstream
USER 65532:65532
ENTRYPOINT ["/upstream"]
