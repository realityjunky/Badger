# Attribute Run Locks Independently of Hostnames

Status: accepted. New Run locks and takeover evidence carry a hashed `hostId`
independent of the hostname, which remains a display label
([#32](https://github.com/realityjunky/Badger/issues/32), handoff F21). A PID
is comparable only on the same boot and in the same PID namespace, so the
identity uses Linux's boot UUID and PID namespace, macOS's host UUID and boot
time, or Windows's machine UUID and boot time. Only the hash is persisted.

This preserves attribution after a hostname change and across fresh runtime
processes without treating a shared home directory or copied Run root as
proof of a shared process namespace. A changed boot or namespace, an
unavailable identity source, or an unsupported platform leaves the owner
unknown; even explicit recovery refuses takeover. An active matching owner
is protected, and only a proven-absent matching owner is stale. A machine
identity alone was rejected because containers may share it while their PIDs
refer to different processes.

`hostId` extends schema-1 lock records and takeover evidence. A new lock
whose identity cannot be read explicitly stores `null` and is never checked
by hostname. Old records with no field retain their existing hostname check;
a foreign legacy hostname remains unknown. Older runtimes fail closed on
the new field rather than stealing a lock they cannot interpret. Owner
tokens, file-identity fencing, quarantine, and explicit recovery remain
required.
