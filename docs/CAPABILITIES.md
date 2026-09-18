# Capability Matrix

| Capability | Status | Dependency | Risk |
|---|---|---|---|
| HTTP conversation | 🟢 | LLM provider | LOW |
| Tool registry | 🟢 | Runtime | LOW |
| Runtime permission policy | 🟢 | Runtime | HIGH |
| In-process memory | 🟢 | Runtime | MEDIUM |
| Persistent memory | 🟡 | PostgreSQL + retrieval | MEDIUM |
| Multi-step planner | 🟡 | Agent engine | HIGH |
| Browser/computer control | 🟡 | Controlled gateway | HIGH |
| Telephony | 🟠 | VoIP/SIP/OS/third parties | CRITICAL |
| Financial operations | 🟠 | Official APIs/Open Finance | CRITICAL |
| Smart home | 🟠 | Compatible hardware/protocol | CRITICAL |
| Universal app control | ❌ | Not universally guaranteed | HIGH |
