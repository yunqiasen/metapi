---
name: ask-matt
description: Route a task to the right skill or workflow in this repository.
disable-model-invocation: true
---

# Ask Matt

Use this router when the user does not know which skill fits the task.

## Main delivery flow

1. No project setup step is needed. Every skill picks its own tracker: GitHub Issues when the repository has a GitHub remote, `.scratch/` otherwise.
2. Use `/grill-with-docs` for repository-bound planning. It invokes `grilling` and `domain-modeling` and records `CONTEXT.md` and ADR decisions.
3. Use `to-spec` when the conversation is settled and needs a formal specification. After the user confirms the spec, it calls `to-tickets`.
4. Use `to-tickets` when the work must be split into tracer-bullet vertical slices with blocking edges. After the user confirms the frontier ticket, it calls `implement` for one ticket.
5. `implement` builds from the confirmed spec or ticket. It invokes `tdd`, ignores TDD's nested review handoff, then calls `code-review` once for the complete ticket.

For a small task, start with `grilling`. After the user confirms the shared understanding, it enters the minimal execution flow: `tdd`, then one `code-review`.

## Large or unclear work

Use `/wayfinder` when the destination is clear enough to name but the route is too foggy or too large for one session. It creates a map and resolves research, prototype, grilling, and task tickets one at a time. When the route is clear, continue with `to-spec`, then its confirmed downstream chain.

## Standalone choices

| Situation | Skill |
| --- | --- |
| Small task or general interview with no codebase | `grilling` |
| Repository interview with domain documents | `/grill-with-docs` |
| Hard bug or performance regression | `diagnosing-bugs` |
| High-trust primary-source investigation | `research` |
| Logic or UI question that needs a concrete artifact | `prototype` |
| Architecture scan and HTML report | `/improve-codebase-architecture` |
| Test-first implementation of one behavior | `tdd` |
| Review a diff against standards and a specification | `code-review` |

## Automatic foundations

- `grilling`: the reusable interview primitive.
- `domain-modeling`: maintains domain vocabulary, `CONTEXT.md`, and ADRs.
- `codebase-design`: supplies deep-module, interface, seam, and UI design vocabulary.
- `tdd`: runs red, green, refactor, commit, then one standalone code review.
- `code-review`: reviews standards and specification compliance in parallel.
- `diagnosing-bugs`: runs reproduce, minimize, hypothesize, fix, regression-test.
- `research`: produces a cited Markdown research artifact.
- `prototype`: answers design questions with throwaway logic or UI artifacts.

## Workflow boundaries

- `grill-with-docs` ends its alignment phase at a confirmation gate, then calls `to-spec` when the user approves.
- `wayfinder` ends when the decision map is clear; it does not implement decision tickets.
- `improve-codebase-architecture` ends at a settled refactoring decision; it does not modify code or call `implement`.
- `to-spec` and `to-tickets` pause at confirmation gates before their downstream calls.
- `implement` is the only owner of the final review in its run; nested TDD review is ignored.
- `diagnosing-bugs` calls `code-review` once after its review gate and before commit.

## Boundary rule

Do not route to a skill outside this repository's 16 entries. If a task needs several skills, name the full sequence and explain the transition point between them.
