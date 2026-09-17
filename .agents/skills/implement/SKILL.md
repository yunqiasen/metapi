---
name: implement
description: "Implement one approved spec or ticket through TDD, checks, and one final code review. Use when the work is already decided and ready to build."
---

Implement one approved ticket or spec. Do not use this skill to settle an unresolved idea or raw conversation; send that work back to `to-spec` or `to-tickets` first.

Capture the current `HEAD` as the fixed point before making changes and pass it to the final review

Call the Skill tool with "tdd" and implement at pre-agreed seams. The nested TDD run may contain a review handoff for standalone use, but `implement` owns this run's final review: ignore the nested `code-review` step and do not execute it.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once all TDD slices, implementation checks, and the full test suite pass, call the Skill tool with "code-review" exactly once for the complete ticket diff.

Fix every valid review finding. The `tdd` skill commits each completed slice, so only create an additional commit when review fixes changed the tree.
