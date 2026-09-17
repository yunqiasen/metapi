# GitHub issue tracker operations

Use the `gh` CLI from the project checkout. The tracker choice in SKILL.md already confirmed `gh auth status` succeeds; if a command still fails with an auth error, fall back to the local `.scratch/` tracker and say so in one line.

## Operations

- Create: `gh issue create --title "..." --body "..."`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open --json number,title,body,labels,comments`
- Comment: `gh issue comment <number> --body "..."`
- Close: `gh issue close <number> --comment "..."`

## Labels

Never create labels. Apply a label only when it already exists on the repository:

1. Check with `gh label list --json name`
2. If the label exists: `gh issue edit <number> --add-label "<label>"`
3. If it does not: skip the `gh` label call and record the label name as a `Label: <name>` line near the top of the issue body instead

## Blocking edges

Use GitHub's native blocking or sub-issue relationship where available. Otherwise record `Blocked by: #<number>` near the top of the issue body. Publish tickets in dependency order, blockers first, so blocking edges reference real issue numbers.
