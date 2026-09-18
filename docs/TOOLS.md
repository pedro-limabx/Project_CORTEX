# Tool Engine

Tools are the capability boundary between NEURON and external systems.

Each tool declares name, version, description, input schema, output contract, risk and permissions. Execution must validate policy before side effects and must return a verified result or an explicit failure.

The registry is intentionally provider-neutral so future integrations can be adapters rather than dependencies inside NEURON Core.
