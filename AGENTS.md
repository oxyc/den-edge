# Working in den-edge

## Testing

- Do not add a regression test mechanically for every change. Trivial styling changes, copy edits, and straightforward substitutions of an existing shared component usually need the relevant static checks, not a new test.
- When a regression test is warranted, prefer an end-to-end test of the user-visible behavior over a component or unit test. Cover the real route and interaction across the browser boundary when practical.
- Use unit tests for isolated logic with meaningful branches, invariants, or failure cases that end-to-end coverage would make slow, opaque, or impractical.
- Keep tests proportional to the risk. Do not assert implementation details merely to prove that a small refactor happened.
