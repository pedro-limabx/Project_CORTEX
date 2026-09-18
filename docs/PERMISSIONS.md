# Permissions

Security policy is enforced by runtime code, never by model output alone.

Risk levels: LOW, MEDIUM, HIGH, CRITICAL.

HIGH and CRITICAL actions require explicit approval. CRITICAL actions also require the corresponding permission and should later support stronger controls such as re-authentication, limits and idempotency.

Initial permissions: calendar.read, calendar.write, message.send, file.read, file.write, financial.transfer, physical.control, admin.
