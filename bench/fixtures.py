#!/usr/bin/env python3
"""Create deterministic, disposable benchmark state; no provider credentials required."""

import json
import hashlib
import os
import pathlib
import sys
import urllib.parse

root = pathlib.Path(sys.argv[1])
web = root / "web"
ratings = root / "data" / "ratings"
web.mkdir(parents=True, exist_ok=True)
ratings.mkdir(parents=True, exist_ok=True)
libraries = root / "data" / "lib"
libraries.mkdir(parents=True, exist_ok=True)
tmdb = root / "data" / "tmdb"
tmdb.mkdir(parents=True, exist_ok=True)

(web / "index.html").write_text("<!doctype html><title>den-edge bench</title>\n")
(web / "static-1m.bin").write_bytes(bytes(range(256)) * 4096)

# Close to the endpoint's 256 KiB limit while remaining representative valid JSON.
record = {
    "Response": "True",
    "imdbRating": "8.8",
    "imdbVotes": "2,345,678",
    "Awards": "benchmark fixture",
    "Ratings": [{"Source": "Internet Movie Database", "Value": "8.8/10"}],
    "padding": "x" * 245_000,
}
(ratings / "tt0137523.json").write_text(json.dumps(record, separators=(",", ":")))

token = "bench-token"
token_hash = hashlib.sha256(token.encode()).hexdigest()


def library_log(library_id, rows, value_bytes):
    lines = [json.dumps({"token": token_hash}, separators=(",", ":"))]
    for sequence in range(1, rows + 1):
        lines.append(
            json.dumps(
                {"s": sequence, "k": f"{sequence:016x}", "v": "v" * value_bytes},
                separators=(",", ":"),
            )
        )
    name = hashlib.sha256(library_id.encode()).hexdigest() + ".log"
    (libraries / name).write_text("\n".join(lines) + "\n")


# One response just under the prepared-page ceiling, plus enough independent logs to
# keep a cold-unique run from becoming an exact-page cache benchmark.
hot_id = "0000000000000001"
library_log(hot_id, 200, 2200)
cold_paths = []
for number in range(2, 162):
    library_id = f"{number:016x}"
    library_log(library_id, 8, 4096)
    cold_paths.append(f"/lib/{library_id}/changes?since=0&limit=500")
(root / "library-cold.paths").write_text("\n".join(cold_paths) + "\n")
# Same shape, outside the measured rotation: its response size can be learned
# without warming any of the 160 cold libraries.
library_log("0000000000000162", 8, 4096)

# Four independent v2 authorities are migrated and durably rewritten throughout the mixed soak.
for writer in range(4):
    library_id = f"{0x300 + writer:016x}"
    library_log(library_id, 1, 16)


def tmdb_key(path, query=""):
    pairs = [(name, value) for name, value in urllib.parse.parse_qsl(query) if name not in ("api_key", "session_id")]
    pairs.sort()
    escape = lambda value: value.replace("%", "%25").replace("&", "%26").replace("=", "%3D")
    return path + "?" + "".join(f"{escape(name)}={escape(value)}&" for name, value in pairs)


def tmdb_file(path, query, body):
    name = hashlib.sha256(tmdb_key(path, query).encode()).hexdigest() + ".json"
    (tmdb / name).write_text(json.dumps(body, separators=(",", ":")))


tmdb_file("/3/trending/all/week", "", {"page": 1, "results": [{"id": i, "title": f"Title {i}"} for i in range(200)]})
tmdb_file(
    "/3/search/multi",
    "query=matrix&language=en-US",
    {"page": 1, "results": [{"id": i, "name": f"Matrix result {i}"} for i in range(200)]},
)
movie_appends = "credits,external_ids,recommendations,release_dates,videos,watch/providers"
detail = {
    "id": 550,
    "title": "Benchmark movie",
    "overview": "o" * 250_000,
    "credits": {"cast": [{"id": i, "name": "n" * 48} for i in range(5000)]},
    "external_ids": {"imdb_id": "tt0137523"},
    "recommendations": {"results": [{"id": i} for i in range(500)]},
    "release_dates": {"results": []},
    "videos": {"results": []},
    "watch/providers": {"results": {}},
}
tmdb_file("/3/movie/550", f"append_to_response={movie_appends}", detail)

mixed_tmdb_paths = []
for number in range(1000, 1064):
    path = f"/3/movie/{number}/credits"
    tmdb_file(path, "", {"id": number, "cast": [{"id": i, "name": "actor"} for i in range(100)]})
    mixed_tmdb_paths.append(f"/tmdb{path}")
(root / "tmdb-mixed.paths").write_text("\n".join(mixed_tmdb_paths) + "\n")
# Calibration key with the same four-digit/body shape, excluded from rotation.
tmdb_file("/3/movie/1064/credits", "", {"id": 1064, "cast": [{"id": i, "name": "actor"} for i in range(100)]})

# The scratch image runs as the same unprivileged uid as production.
for path in (root, web, root / "data", ratings, libraries, tmdb):
    os.chmod(path, 0o777)
