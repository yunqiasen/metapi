---
name: grill-with-docs
description: A relentless interview to sharpen a plan or design, which also creates docs (ADR's and glossary) as we go.
disable-model-invocation: true
---

Call the Skill tool twice, for "grilling" and "domain-modeling".

After the user confirms that the repository-bound alignment is complete, open a handoff gate. Show the decisions recorded in `CONTEXT.md` and ADRs, ask whether to formalize them as a spec, and only after confirmation call the Skill tool with "to-spec"

Do not call `to-tickets` or `implement` here. `to-spec` owns the next confirmation gate, then continues to `to-tickets` and `implement`
