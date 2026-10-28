# A Skill's Identity Is Its Content, and Sources Stay in Scope

Status: accepted. A Skill's identity hash covers the files that make it behave the same on every host, and nothing else. A fixed, documented list of operating-system metadata, editor state, and interpreter cache files is excluded from the identity hash: `.DS_Store`, `._*`, `.Spotlight-V100`, `.Trashes`, `.fseventsd`, `.TemporaryItems`, `Thumbs.db`, `desktop.ini`, `.idea`, `.vscode`, `.settings`, `.project`, `.classpath`, `*.swp`, `*.swo`, `*~`, `.#*`, `__pycache__`, `*.pyc`, `*.pyo`, `.pytest_cache`, `.mypy_cache`, and `.ruff_cache`. The list is fixed in `packages/kernel/src/skill/identity.ts`; extending it is a decision for a new file class that is environment noise on every host, never for content. The inventory still lists every file, configuration and excluded entries included, with its SHA-256 hash, so the check shows what it ignored.

The same identity rule is the one notion of a source hash throughout the kernel. The source check, upgrade-source evidence, authoring readiness, and publication readiness all compute it with `hashSkillSource`, so a hash recorded in one place is comparable with a hash recomputed in another.

An absolute source location must resolve inside the project or a registered root. Registered roots come from `--source-root` on the command line, `roots` in a source manifest, or `sourceRoots` in a FactoryPlan; both lexical and resolved paths are checked, so a symbolic link cannot widen the boundary. Relative locations stay confined to the project. An upgrade plan's `sourceRoot` follows the same rule wherever the kernel inspects it. A location outside the boundary is refused, not guessed at. A symbolic link inside a Skill tree is refused outright, so `SKILL.md` and every inventoried file are real files at real paths.

## Consequences

- Adding or removing an excluded file leaves a Skill's identity hash unchanged, while the inventory still reports it. Audit write-backs no longer stale a recorded version, as long as they are not content the Skill reads.
- A source manifest declares each script's side effect by relative path, using one of `none`, `local-writes`, `network`, `scheduler-submission`, or `installs`. A script with no declaration is reported as undeclared, never blocked implicitly.
- Multi-tenant or hosted use cannot point a declaration at an arbitrary host path. Operators who keep Skills outside the project register the roots their deployment trusts.
- Identity hashes change for every existing source once, because the hash function changed. Recorded evidence from before this decision is stale, which is correct: it described a different identity.

## Considered Options

- Ignore files by a user-supplied pattern list. Rejected: identity must be comparable across hosts, so the rule has to be the same everywhere.
- Keep hashing every file and let callers carry a separate "content hash". Rejected: two hashes invite drift between evidence records, which is what F5 was.
- Allow any absolute location and rely on the operating system's permissions. Rejected: an inspection path that can read any host path is a multi-tenant escape (F22).
