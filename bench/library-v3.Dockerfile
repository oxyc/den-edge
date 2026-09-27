FROM rust:1-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY bench/library_v3.rs ./bench/library_v3.rs
RUN cargo build --release --locked --features library-v3-bench --bin library-v3-bench

FROM debian:bookworm-slim
COPY --from=build /app/target/release/library-v3-bench /library-v3-bench
ENTRYPOINT ["/library-v3-bench"]
