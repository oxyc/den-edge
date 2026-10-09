group "default" {
  targets = ["edge", "cast"]
}

target "common" {
  context    = "."
  dockerfile = "Dockerfile"
  platforms  = ["linux/amd64"]
  pull       = true
  cache-from = ["type=gha,scope=release-images"]
  attest = [
    "type=provenance,mode=max",
    "type=sbom",
  ]
}

target "edge" {
  inherits = ["common"]
  target   = "edge"
}

target "cast" {
  inherits = ["common"]
  target   = "cast"
}
