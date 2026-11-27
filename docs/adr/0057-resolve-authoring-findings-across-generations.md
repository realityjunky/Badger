# Resolve Authoring findings across package generations

**Proposed.** Give an Authoring finding an identity within a Workflow version. Keep the reports that observed it, the work that can resolve it, and the evidence that verifies it against a specific target. The six lanes continue to own the claims and authored leaves defined by the Authoring protocol. Resolution work goes to the owner of the thing that must change.

ADR 0053 gives a lane report one follow-up target. ADR 0056 combines Plan follow-ups from a finished wave. A single report can identify both a Plan error and a missing implementation owned by a source maintainer. Today the Plan Agent can record that evidence is missing, the Engineer can accept that Plan, and the next generation can send the same two problems back to Plan. Information about the first repair exists in job history, outside the next lane's input. [Stage follow-ups](0053-authoring-stage-follow-ups.md) · [Wave Plan repairs](0056-wave-plan-repairs.md)

Under this proposal, submitted reports can immediately contribute draft observations. The Engineer can review their grouping and dispatch several kinds of work in one operation. Eligible Plan edits still use one consolidated Plan draft. Independent implementation and evidence requests use the existing Drafting session lifecycle in a designated workspace. The stage or repository that owns a change decides how it is adopted. The kernel evaluates which evidence applies to each generation and which existing gate needs it.

This requires a durable relation between findings, reports, work and verified inputs. It also lets one change serve several independent claims without treating their agreement as proof. Extending a lane's write permissions would couple the lane that happened to discover a problem to the repository or runner that owns it. Keeping resolution with the Workflow version lets those responsibilities vary independently.

The companion design specifies dashboard operations, Drafting job inputs and outputs, verification, compatibility, and an end-to-end acceptance case. [Authoring finding resolution](../authoring-finding-resolution.md)
