# Handoff: Primer Designer on Badger, Phase 1 (paused 2026-10-27)

## Next-session focus

Resume the Primer Designer test after the Badger dashboard exists. Its spec is
https://github.com/realityjunky/Badger/issues/24. The test has two goals:

- a correct workflow over the primer design expert's three Skills;
- a list of Badger design and code improvements that only this real case
  reveals.

The test paused at the start of the questionnaire because the questionnaire
will move from CLI exchanges to the dashboard. Most of what was learned is
domain knowledge, and it stays valid: sections 3–6. The CLI procedure does not
survive the move: section 8. Use section 7 as a regression list for the new
design.

## 1. Where it stopped

- Harness: `/home/hugo/AI/Badger-workflows/primer_designer_harness` at
  `223fb54` ("docs: rewrite the source Skills against the expert's
  originals"). The tree is clean; the test wrote no files there. There is no
  `.badger/` and no `plans/` directory.
- Badger: `/home/hugo/AI/Badger` at `5166b67`, with `dist/` built from the
  current `src/`.
- Done:
  - `badger guide` reported `firstUse: true`, with no FactoryPlan and no
    Creator state.
  - Exchange 1 was answered. Intent: `new-skill`. Sources: exactly
    `genome-download`, `primer-design` and `primer-pool-add` from `skills/`.
    Workflow name: `primer-designer`.
- Not done:
  - `badger candidates`. The command was handed to the owner, but no output
    came back.
  - Every step after it: the semantic exchanges, the dossier, the
    FactoryPlan, `questionnaire-handoff`, `propose`, `init --confirm`, and the
    `.badger/` commit decision.

## 2. Rules that still bind

From the owner's Phase 1 brief (`/home/hugo/badger-phase1-prompt.md`, which
lives outside any repository) and the harness `AGENTS.md`:

- Protected and read-only material:
  - `raw_data/` holds protected real data: never list, search, or read it.
    Locate installed packages with `python3 -c "import pkg;
    print(pkg.__file__)"`, never `find`.
  - `raw_skills/` is read-only.
- Language: the Skills' formal text stays English. The owner may answer in
  Chinese; the dossier and the FactoryPlan are written in English.
- Go-ahead: biological jobs, NCBI downloads, scheduler submissions, and
  installs run only with the owner's explicit go-ahead.
- Recording: record each translation decision in that Skill's
  `reference/source-audit.md`.
- Questions: ask in small batches, highest value first, one idea per question.
- Changes: change Badger code or file issues only with the owner's go-ahead.
- Confirmations: the owner performs every confirming write. Under the CLI
  that meant typing every `--confirm` command. Under the dashboard it becomes
  a role assignment: the owner holds the confirming role.

## 3. Ledger carried forward

Re-enter these in the new questionnaire, keeping their provenance.

**Confirmed by the owner (2026-10-26/27)**

- U1: the workflow is built from the expert's three Skills.
- U2: formal text is English; locale `en`.
- U3: the owner performs every confirming write (see section 2).
- U4: the three declared Skills are the complete source set. Intent is
  `new-skill`; name is `primer-designer`.

**Source-derived (evidence in the harness at `223fb54`)**

- S1: `genome-download` ships no scripts. Downloads run on the local host
  through the proxy, never on SGE.
- S2: `primer-design` runs Steps 1–2 locally and Steps 3–10 as an SGE job, and
  produces a table of candidate pairs.
- S3: `primer-pool-add` produces `step10_final_selected.txt`; no script writes
  it into the pool.
- S4: questions settled before this test: genome-download 3 and 4,
  primer-design 4, primer-pool-add 24.
- S5: primer-design's final tables put `F_id F_seq R_id R_seq` in columns 1–4
  (zero-based). primer-pool-add Step 1 reads columns 3–6 unless overridden.
  - Evidence: `primer-design/scripts/primer_pipeline_core.py:1912-1930` and
    `primer-pool-add/scripts/step1_extract_primers.py`.
  - Fed directly, Step 1 reads `R_id R_seq amp_len amp_seq` as a primer pair,
    and every Step 1 Done-when check still passes.
  - It needs `--col-f-id 1 --col-f-seq 2 --col-r-id 3 --col-r-seq 4`, plus one
    species per file named `<label>.xls`.
- S6: primer-design Step 9 returns without writing when it skips, and Step 10
  checks only that `NT_mapped_result.xls` exists. A stale table from an earlier
  round can become the "final" table.
  - Evidence: `primer_pipeline_core.py:1834-1842` and `2048-2056`.

**Still open**

- A1: source paths and content hashes. These need `candidates` or its
  dashboard equivalent, run against the Skills as they stand at resume time.
- A2: the 68 open audit questions in section 4.
- Process question: should answers that settle a numbered audit question be
  written back into that Skill's `source-audit.md`, marked "Answered
  <date>"? A write-back changes the Skill's content hash (F5), so batch the
  write-backs before the final source-identity check.

## 4. Open audit questions: first-pass triage

Each Skill's `reference/source-audit.md` ends with numbered open questions.
68 are open:

| Skill | Open | Settled |
| --- | --- | --- |
| genome-download (GD) | 19 of 21 | 3, 4 |
| primer-design (PD) | 26 of 27 | 4 |
| primer-pool-add (PPA) | 23 of 24 | 24 |

The split below is the agent's inference; the owner has not confirmed it.

**Contract-binding: 35.** These shape Nodes, routes, decisions, guardrails, or
the hand-offs between Skills, so the questionnaire must settle them.

| Dossier topic | Questions |
| --- | --- |
| Scope and finalization | PPA 20 (end at `step10_final_selected.txt`, or merge into the pool?); PD 1 (is Step 10 always part of a run?); PD 26 (does primer analysis of existing primers join the workflow?) |
| Inter-Skill interfaces | GD 19 = PD 25 (genome directory and reference file naming); PD 15 = PPA 1–2 (deliverable file, its columns, species label); see section 5 |
| Decisions and go-ahead points | GD 12; PD 3 (`qsub`, Step 1–2 downloads, `pip install hget`, `qdel`); PPA 5 (when to use `--skip-pcr`) |
| Capabilities and hosts | PD 2 (may Steps 3–10 run locally?); GD 16 (dRep host and threads); PPA 14 (foreground dimer runs vs SGE) |
| Prerequisites and configuration | PD 23 (configuration homes); PPA 3 (working directory); GD 20 (snapshot and TaxonKit provenance); PPA 22 (`qstat` name width) |
| Inputs | GD 6 (genus expansion and directory layout); GD 7 (per-species or combined cap and dRep); GD 15 (dRep `-sa` per run?); PD 9 (probe off for conventional PCR) |
| Routes and bounded cycles | GD 13 (retry bound); GD 14 (failure routes); PD 16 (remedy and qPCR redesign rounds); PD 17 (batch failure); PPA 6 (`NA` positions); PPA 7 (rerun Step 1 after a pool change); PPA 18 (species below `Required`) |
| Completion evidence | PD 14 (NT specificity rule); PPA 10 (Step 5 acceptance); PPA 19 (what proves a result belongs to the current input); GD 18 (recorded sampling seed) |
| Recovery | PD 24 (resume sentence); PPA 21 (resubmit failed parts or the whole step) |

**Skill-internal: 33.** Code defects, conflicting defaults, or missing
parameters inside one Skill. They do not change the workflow contract, so they
can wait for a revision of that Skill:

- GD 1, 2, 5, 8, 9, 10, 11, 17, 21
- PD 5, 6, 7, 8, 10, 11, 12, 13, 18, 19, 20, 21, 22, 27
- PPA 4, 8, 9, 11, 12, 13, 15, 16, 17, 23

Today's questionnaire has no disposition for this class: every unresolved
item blocks completion (G1).

**Proposed first batch**, highest value first:

1. Where the workflow ends: PPA 20, PD 1.
2. Which stages are optional, and the entry routes: start from existing
   genomes, or from an existing primer table?
3. The two interfaces in section 5.
4. The go-ahead points: GD 12, PD 3.

## 5. The workflow's real hand-offs

- **genome-download → primer-design** (GD 19 = PD 25). Which directory does
  primer-design read: `<Genus>_<species>` in the genome database directory,
  or dRep's `dereplicated_genomes/`?
  - primer-design Step 1 looks for the reference as
    `<ftp_path basename>_genomic.fna`.
  - genome-download Step 5 names files
    `<species>_<ftp_path basename>_<asm_name>.fna`.
  - So Step 1 downloads the reference again, writes it into the genome
    directory, outside its output directory, and the directory ends up holding
    it twice.
- **primer-design → primer-pool-add** (PD 15 = PPA 1–2). There is a column
  mismatch (S5). primer-pool-add also derives the species label from the file
  name:
  - It strips `.onecopy.strict2.xls`, `.xls`, or `.xlsx` with a chain of
    replace calls, which match anywhere in the name.
  - The label must match `species_requirements.txt`.
  - It lists files with an unsorted `os.listdir`.
- **primer-pool-add → pool** (PPA 20). No script merges the selection into
  the pool.

## 6. Script evidence beyond the audits

Static reading only; nothing was executed. The subagent audits found these
facts, and the agent verified the starred ones against the code.

**primer-pool-add**

- ★ Step 1 parsing:
  - It reads `.xls`, `.xlsx`, and `.tsv` files (case-sensitive, unsorted
    `listdir`).
  - It discards line 1 unread, then splits each line with `strip().split('\t')`.
  - It reads columns 3–6 by default and ignores column 0 (`species_name`).
  - It keeps a row when F_ID is non-empty and F_Seq starts with A, C, G, or T.
- The 30,000-record cap applies per file, not per label. Files with the same
  label merge without a cap.
- Step 1's line-count Done-when compares two files built from one list, so it
  cannot fail; zero records passes.
- Foreground dimer runs (Steps 5, 6, 8, 9) exit 0 after `Error in batch`, and
  their Done-when strings never check for it.
- F_ID is the join key everywhere. Duplicates collide, and nothing checks
  uniqueness.
- No per-species floor exists after Step 5, so a species can vanish silently
  by Step 10.
- A Step 0 rerun can merge stale part files. `logs/` is shared across runs:
  scope `Error in batch` checks to the current job prefix.
- SGE jobs in `Eqw` never leave `qstat`, so "qstat lists none of the job IDs"
  never holds, and those jobs keep their throttle slots.
- Wrapper "job IDs" are qsub's full stdout line; extract the number.
- `qsub` runs without `-V` or `-S`, so the job environment is the queue's, not
  the submitting shell's.
- Output is non-deterministic:
  - Step 0 writes in completion order.
  - Step 1's species order comes from `listdir`, which shifts Step 7's part
    boundaries.
  - The dimer Score2 tie-break comes from hash-randomised sets.
- Thresholds compare printed (truncated or rounded) values.
- Nine deep-filter patterns can never match, because leading spaces are
  stripped.
- Step 4 misreads 7-column rows from unparseable F_IDs as fake windows.
- All 13 Chinese Done-when strings in `SKILL.md` appear verbatim in the code.

**primer-design**

- ★ The `NT_mapped_result.xls` header has 34 columns:
  - `species_name F_id F_seq R_id R_seq amp_len amp_seq`
  - `F_entropy_sum R_entropy_sum`
  - `F_lowercase_3end5bp R_lowercase_3end5bp F_lowercase_total R_lowercase_total`
  - `blast_id_NT`, then `NT_hit_species1..10` and `NT_hit_count1..10`

  `_usearch.xls` adds 11 columns, for 45.
- ★ Step 8's annotated file is built with `f"{line.strip()}\t..."`. The strip
  drops the empty trailing `probe_issues` field, so the four lowercase counts
  shift one column left for pairs whose probe has no issue.
- ★ Step 9's skip paths `return` without writing (S6).
- Skip paths leave earlier outputs in place: the Step 2 auto-skip, the Step 3-2
  skips, the Step 9 skips, and the Step 10 error returns. `calEntropy/`,
  `usearch_snp_analysis/<pair>/`, and `02_intra_genome/*.extracted.fna`
  accumulate across reruns and are read again.
- Step 1 writes the reference into the genome directory. A failed `gunzip`
  leaves a partial file that later counts as a genome.
- It writes `./primer_design_debug.log` in the current directory as well as the
  log in the output directory.
- There is no `pipefail`, so a failed first pipeline stage yields empty output
  instead of a stop.
- Failures are scored as perfect conservation (entropy 0 or NA), so "Total
  selected" overstates templates.
- A Step 6 worker crash drops templates with only a DEBUG line. Use "Primer
  design complete. Raw output:" as the completion marker.
- The stops at core lines 389, 434, 1353, 1510, and 1543 log no ERROR line, so
  `grep ERROR` misses them.
- Environment:
  - `hget` works only under the fork start method.
  - `requests` is an unlisted dependency.
  - It needs pandas >= 1.3 and the muscle v3 syntax.
- Paths are unquoted in shell strings, so paths must contain no whitespace or
  shell metacharacters.
- Not reproducible: `addEntropy` row order follows thread completion, so score
  ties break differently on each rerun.

## 7. Badger findings from this test

Against Badger `5166b67`. Dispositions:

- **Core**: still to fix in the kernel.
- **Dashboard**: the dashboard design should make it impossible; verify that
  it does.
- **Docs**: a documentation fix.
- **Now**: worth fixing before the dashboard work.

"Inferred" means a survey deduction that has not been verified.

| ID | Finding | Disposition |
| --- | --- | --- |
| F1 | `init` does not bind to the reviewed proposal. `cli.ts` rebuilds the proposal and `initializeState` compares it with itself, so a plan edited after `propose` initializes anyway. Manual §3.2 says a stale proposal is rejected, which is not true through the CLI. | Core: bind init to the confirmed proposal record |
| F2 | `init --confirm` silently overwrites an existing `.badger/states/<name>.json`. It resets status to draft and drops generated, eval, and review records. | Core |
| F3 | Path bases differ by command. `questionnaire-handoff` resolves files against `--project`; `propose`, `init`, `authoring-record --file`, and `distribute --destination` resolve against the cwd. Manual §3.5 mixes the two. | Core (CLI); moot in the UI |
| F4 | CreatorState stores absolute `projectRoot`, `planPath`, `draftPath`, and package paths, and `readState` rejects a moved project. A committed `.badger/` is not portable, and host and container paths will differ. | Core; decides the harness `.badger/` policy |
| F5 | The source hash covers the whole Skill tree: `source-audit.md`, `__pycache__`, `.DS_Store`. Any audit write-back stales the dossier's `contentHash`. | Core: immutable Skill versions plus ignore rules |
| F6 | The candidate inventory skips `config/` (primer-pool-add thresholds and tool paths), and every script gets `sideEffect: "unknown"`. | Core |
| F7 | `planHash = sha256(JSON.stringify(plan))` depends on key order. Only the dossier hash is canonical. | Core |
| F8 | `questionnaire-handoff` prints the plan with the dossier embedded but writes nothing, so the dossier ends up stored twice. | Dashboard |
| F9 | Artifacts must be Run-root-relative and at most 2 MiB, with at most 256 glob matches. Nothing proves an artifact came from the current Attempt. This workflow's outputs live outside any Run root and include multi-MB FASTA, and stale outputs are its dominant silent failure. | Core: external artifact references with receipts |
| F10 | `new-skill` packages do not bundle the source Skills. `resolved-skills.json` records build-host absolute roots, so a Run on another host (the SGE login node) cannot find them. Inferred: package hashes depend on location. | Core |
| F11 | "Candidate" is undefined in the glossary and manual, and collides with the domain's "candidate primers". | Docs; UI naming |
| F12 | No durable home for an in-progress questionnaire. After a session ends, `guide` reports first use again. | Dashboard |
| F13 | `/badger-create` and the questionnaire both own intent, guide, and candidates. Neither defines an exchange, ledger accumulation, or ledger display. | Dashboard; rewrite both Skills |
| F14 | Manual §7 lists `primer-designer-v1/plan.json`, which does not exist. §2.4 still shows the v1 contract (26 Nodes). | Docs |
| F15 | The FactoryPlan has both `goal` and `workflow.goal`, but the dossier binds only the top-level `goal`. | Core |
| F16 | "Read every inventoried script before any semantic question" means about 315 KB across 21 files here, with no guidance on depth or delegation. | Dashboard: a source-study stage with its own records |
| F17 | Badger's uncommitted `.gitignore` edit turns `.npmrc` into `.npmr`. That un-ignores `.npmrc`, which can hold npm tokens. | Now |
| F18 | `generate` has no `--confirm`. It re-reads the plan file at `state.planPath` and overwrites `planHash` and `confirmedProposal` (`cli.ts:305-352`), so a plan edited after `init` is adopted silently. Verified. | Core; widens F1 |
| F19 | Creator state keeps no history, actor, or time for confirmations. The reviewer is a free string. eval, approve, publish, and init read, modify, and write without a lock, so the last writer wins. | Dashboard and core |
| F20 | There is no Run list or index API. The Run read models (`projectWorkflowState`, `inspectWorkflowRun`) are not exported from `public.ts`. | Core |
| F21 | The Run lock records the hostname, and a foreign hostname reads as "unknown". Inferred: containers with changing hostnames would strand locks. | Core (verify) |
| F22 | An absolute source location may point anywhere on the host. Inferred: a multi-tenant escape. | Core |
| F23 | `AGENTS.md`, README ("Platform and dashboard integration" is out of scope), `release-artifacts.md:65`, and `CHANGELOG.md:13` exclude dashboards. | Docs, once the scope decision is made |
| F24 | The glossary lacks Run, Attempt, Cycle, Project, and Evaluation. | Docs |
| F25 | `--json` is a no-op; output is always JSON. | Core (minor) |
| G1 | The ledger has no disposition for a Skill's own open questions ("deferred: Skill-internal"). Every unresolved item blocks completion. | Dashboard |
| G2 | No dossier topic names the inter-Node data contracts, which are this workflow's real hand-offs (section 5). | Dashboard and core |

## 8. Outdated after the dashboard

- The CLI exchange protocol:
  - paste-ready commands for the owner;
  - the five-part ledger printed in chat after each exchange;
  - the fact IDs U1–U4, S1–S6, A1–A2. The service will assign its own IDs;
    keep the text and the provenance.
- File locations proposed but never written:
  - `plans/primer-designer.dossier.json`
  - `plans/primer-designer.json`

  The service now owns where the questionnaire and dossier live.
- The proposed process for exchange 2 ("show the changes plus everything still
  open").

## 9. How to resume

1. Check the harness. Inspect `git log` and `git status`. If `skills/` changed
   after `223fb54`, re-verify S5, S6, and section 6 against the scripts before
   reusing them.
2. Set up the dashboard:
   - Create `primer-designer` in the owner's group.
   - Attach the three Skills from the harness's `skills/` as an immutable
     source version.
   - Assign roles: the owner confirms, the primer design expert answers.
3. Run the source-identity check (today's `candidates`), which resolves A1.
4. Seed the questionnaire with section 3, then confirm or correct the triage
   in section 4. Publish the first batch.
5. Continue through the dossier, the FactoryPlan, the proposal, and `init`.
   Then decide whether the harness commits or ignores `.badger/`, with F4 as
   the input.
6. Walk the section 7 table against the new implementation, and report what
   still reproduces.
7. Refresh manual §2.4, which still shows the v1 contract, once the new
   contract exists.
