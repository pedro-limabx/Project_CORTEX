# Memory

## Current implementation

- `InMemoryStore` is used when `DATABASE_URL` is not configured. Its data is lost when the process restarts.
- `PostgresMemoryStore` is selected when `DATABASE_URL` is configured. It creates the `neuron_memories` table and a user/update-time index on startup.
- Records are scoped by `userId`; search is a parameterized, case-insensitive substring match ordered by importance and recency.
- Saving an existing record ID updates its stored fields (upsert).

## Memory classes

Supported classes: `SESSION`, `PREFERENCE`, `FACT`, `TASK` and `ACTION`.

## Current limitations and safeguards

- Retrieval is lexical substring matching, not semantic/vector retrieval.
- There is not yet a user-facing retention or deletion workflow.
- Do not store passwords, API keys, financial credentials or other secrets in memory.
- Before production use, add authentication and enforce a trusted user identity; do not trust a client-supplied `userId`.
- Production hardening still requires retention policies, deletion, access control, audit and backup/restore procedures.
