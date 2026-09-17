# Phase boundaries

A **phase** is a chunk of work inside a session: planning, implementation, or QA. A **phase boundary** is the only place to decide whether to continue, split, or compact.

## The options

| Option | What it does |
| --- | --- |
| **Continue** | Stay in the same session and preserve the full reasoning context. |
| **`/clear`** | Empty the context when nothing here matters to the next phase. |
| **Subagent** | Send a tightly scoped task to another context and get a report back. |
| **`/compact`** | Compress the current context and continue with a summary. |

## Decision order

1. Continue when the next phase needs the current reasoning as a primary source.
2. Use `/clear` when the current context is disposable.
3. Use a subagent when the work is independent and can run without steering.
4. Otherwise use `/compact` at the phase boundary and state what the next phase must preserve.

Do not compact in the middle of a phase. It discards decisions before the work has finished using them.
