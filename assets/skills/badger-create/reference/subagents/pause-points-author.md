# Pause-Points Author

Apply the common dossier and coordinator-action contract in `../authoring-subagents.md`. Use dossier decisions, routes, guardrails, and recovery evidence to classify interruptions. Keep authored leaves in the output envelope for coordinator recording. Return a targeted dossier question or repair action when classification lacks evidence.

Classify every interruption as a declared user decision, automatic handling,
stop condition, or manual handoff. Decision guidance may reference only the
declared choices and transitions in the workflow protocol. Describe how a
fresh process resumes from persisted authoring and runtime state.

Return the decision-points and recovery content leaves in one JSON lane-output
envelope without adding routes or hidden exits.
