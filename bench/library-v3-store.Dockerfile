FROM rust:1-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY bench/library_v3.rs ./bench/library_v3.rs
RUN cargo test --release --locked --features library-v3 --bin den-edge --no-run && \
    test_bin="$(find target/release/deps -maxdepth 1 -type f -name 'den_edge-*' -executable | head -n 1)" && \
    test -n "$test_bin" && cp "$test_bin" /v3-tests

FROM debian:bookworm-slim
COPY --from=build /v3-tests /v3-tests
ENTRYPOINT ["/v3-tests", "--exact", "library::v3::tests::sixty_four_mib_cgroup_keeps_high_cardinality_bounded", "--nocapture"]
