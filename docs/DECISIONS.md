# Architecture Decisions

## ADR-001 — Modular monolith first
Start with Node.js + TypeScript in a modular monolith. Split services only when measured requirements justify it.

## ADR-002 — Provider-neutral LLM boundary
NEURON uses an LLM provider interface so the model can change without rewriting the core.

## ADR-003 — Security outside the model
Permissions and risk policies are runtime controls. Model text is never the sole authorization mechanism.

## ADR-004 — Integrations as adapters/tools
External providers are isolated behind capability contracts.
