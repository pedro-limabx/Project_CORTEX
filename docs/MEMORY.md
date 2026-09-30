# Memory

## Current implementation

- `InMemoryStore` is used when `DATABASE_URL` is not configured. Its data is lost when the process restarts.
- `PostgresMemoryStore` is selected when `DATABASE_URL` is configured. It creates the `neuron_memories` table and a user/update-time index on startup.
- `PostgresAuditStore` is also enabled with `DATABASE_URL`; it records parsed tool-call outcomes in `neuron_audit_events`, including user/request IDs, tool name, success, approval status, timestamp and a bounded error message. Invalid-JSON tool calls are not yet included.
- Without `DATABASE_URL`, audit events are kept in memory and disappear when the process restarts.
- Records are scoped by `userId`; search is a parameterized, case-insensitive substring match ordered by importance and recency.
- Saving an existing record ID updates its stored fields (upsert).

## Memory classes

Supported classes: `SESSION`, `PREFERENCE`, `FACT`, `TASK` and `ACTION`.

## Current limitations and safeguards

- Retrieval is lexical substring matching, not semantic/vector retrieval.
- There is not yet a user-facing retention or deletion workflow.
- Do not store passwords, API keys, financial credentials or other secrets in memory.
- Before production use, add authentication and enforce a trusted user identity; do not trust a client-supplied `userId`.
- Audit records intentionally exclude raw tool arguments and outputs to reduce accidental capture of sensitive data.
- A database audit-write error currently fails the chat request, even if a tool may already have executed. This failure mode must be handled deliberately before production.
- Production hardening still requires authentication, retention/deletion policies, access control, audit review and backup/restore procedures.
