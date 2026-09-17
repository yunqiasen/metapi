---
name: to-spec
description: "Turn an agreed conversation into a formal spec, publish it to the project issue tracker, and after user confirmation continue to to-tickets. Use when the plan is settled and needs a written specification."
---

This skill takes the current conversation context and codebase understanding and produces a spec. Do NOT interview the user; just synthesize what you already know.

Pick the issue tracker without any project setup step: use GitHub Issues via the `gh` CLI when `git remote -v` points at GitHub and `gh auth status` succeeds, otherwise write Markdown under `.scratch/<feature-slug>/`. State which one you chose in one line before publishing anything. If `docs/agents/issue-tracker.md` exists, follow it instead. When the tracker is GitHub, read `references/github-tracker.md` (bundled next to this SKILL.md) for exact `gh` command shapes and the label rule before publishing.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the spec, and respect any ADRs in the area you're touching.

2. Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better - the ideal number is one.

Check with the user that these seams match their expectations.

3. Write the spec using the template below, then publish it to the tracker chosen above. On GitHub, apply a `ready-for-agent` label only when that label already exists; skip labelling rather than creating labels.

<spec-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this spec.

## Further Notes

Any further notes about the feature.

</spec-template>

4. Open a confirmation gate. Show the published spec reference, the chosen seams, and the remaining scope. Ask the user to confirm that the spec is ready to split into implementation tickets.

5. Only after explicit confirmation, call the Skill tool with "to-tickets". If the user rejects the spec, revise it and repeat this gate. Do not call "to-tickets" before confirmation.
