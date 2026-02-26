---
name: Product Strategy
description: This skill should be used when analyzing product opportunities, evaluating strategic direction, assessing adoption and growth gaps, or continuing from previous planning session priorities. Provides a systematic framework for product analysis that produces concrete, evidence-grounded findings comparable in specificity to technical audit findings.
user-invocable: false
---

# Product Strategy Framework

A systematic framework for product analysis during planning sessions. Produces concrete, evidence-grounded product findings that are specific enough to become Linear issues with machine-verifiable acceptance criteria.

---

## Strategic Continuity

Before brainstorming new opportunities, establish what direction has already been set.

Fetch previous initiative status updates (last 2-3) using `get_status_updates`. Extract **recommended focus areas** from each update. Track the status of each previous recommendation:

- **Completed**: shipped and verifiable in the codebase or Linear (issue Done)
- **In progress**: active issues or PRs addressing it
- **Unaddressed**: no issues filed, no work started
- **Superseded**: no longer relevant due to changed circumstances (state why)

Identify **persistent themes** — priorities that appear across multiple updates. Unaddressed recommendations from previous updates should be re-evaluated and either championed or explicitly retired with rationale — not silently dropped.

**Report a continuity summary** showing which previous recommendations have been addressed and which remain open, before moving to new analysis.

---

## Product Gap Dimensions

Investigate each dimension that applies to this project. Skip dimensions that are clearly irrelevant to the product type (e.g., skip "Onboarding Flow" for an internal library). Report specific evidence (issue IDs, file paths, git history, user-facing behaviors) — not generic advice.

### User Journey Friction

Trace the critical user journeys and identify where friction exists:

- **Discovery**: Can a new user understand what this product does and whether it solves their problem?
- **Getting started**: How many steps from "I want to try this" to "I see it working"? What fails or confuses?
- **Core workflow**: In the primary use case, where do users get stuck, confused, or have to work around limitations?
- **Recovery**: When something goes wrong, can users diagnose and fix the problem themselves?

**What to look for:** README clarity, setup scripts, error messages, configuration complexity, number of prerequisites, documented vs. actual workflow.

### Capability Gaps

Identify missing capabilities that would meaningfully expand what users can do:

- **Adjacent use cases**: What are users likely to try next after the primary use case? Does the product support it?
- **Integration points**: What external systems do users expect to connect with? Which are supported, which are missing?
- **Automation potential**: What manual steps could be eliminated? What repetitive workflows lack support?
- **Configuration flexibility**: Are there reasonable use cases the product cannot support because it is not configurable enough?

**What to look for:** GitHub issues and feature requests, README "limitations" sections, hardcoded assumptions, missing extension points.

### Feedback and Visibility

Analyze what users can observe about the product's behavior:

- **During operation**: Does the product communicate what it is doing and whether it is working correctly?
- **After completion**: Can users verify the product did what they expected?
- **On failure**: Are errors specific and actionable, or generic and opaque?
- **Over time**: Can users see trends, history, or patterns in how the product has behaved?

**What to look for:** Logging, status reporting, progress indicators, error messages, output formats, history/audit capabilities.

### Scaling Limits

Identify where the product's design will constrain users as their usage grows:

- **Volume**: What happens when input size, concurrency, or frequency increases significantly?
- **Scope**: Can the product handle the next logical expansion of its domain (more projects, more teams, more data)?
- **Operational**: What manual intervention is required to keep the product running as usage grows?

**What to look for:** Hardcoded limits, single-instance assumptions, O(n^2) patterns, shared state that does not partition, manual steps that do not scale.

### Competitive Position

Analyze what makes this product distinct and where that advantage could grow:

- **Core differentiator**: What does this do that alternatives do not, or do significantly better?
- **Differentiator visibility**: Can users easily see and experience what makes this different?
- **Extension potential**: Can the differentiator be deepened or applied to more use cases?
- **Vulnerability**: What could an alternative do to erode this advantage?

**What to look for:** Unique architectural features, novel workflows, capabilities absent from named alternatives, features that are technically difficult to replicate.

### Unlocked Possibilities

After cataloging what exists, ask what the current state of the product now makes possible that was not possible before:

- **Composability**: Can recently shipped capabilities be combined in ways not yet explored?
- **Adjacent use cases**: What is now within reach because of recent architecture or feature work?
- **Changed assumptions**: What constraints from the original design no longer hold, opening new design space?
- **Natural next step**: What would a user who fully adopted the current product want to do next?

**What to look for:** Recent PRs and shipped features, architecture changes that removed limitations, new integration points, features that are building blocks for something larger. Focus on concrete possibilities grounded in what actually exists today — not speculative wishlists.

---

## Opportunity Quality Standards

Before including an opportunity in the report, verify it passes these checks. Drop or rework opportunities that fail 2 or more.

1. **Evidence-grounded**: Connected to specific issues, failures, git history, or architecture — not hypothetical
2. **Concrete**: Specific enough to become 1-3 Linear issues with machine-verifiable acceptance criteria
3. **Sized**: Effort estimate with rationale (which files/modules change, roughly how many issues)
4. **Outcome-oriented**: Framed as user-facing improvement, not internal engineering preference
5. **Strategically aligned**: Advances a persistent theme from previous updates, or opens a new theme with clear justification
6. **Not already covered**: Cross-referenced against the existing backlog and in-progress work

---

## Reporting Format

Structure each opportunity to be directly comparable with technical findings:

```
### [Opportunity Title] (verb + object)
- **Evidence**: [specific issue IDs, file paths, failure patterns, or user-facing behaviors]
- **Effort**: [Small (1-2 issues) | Medium (3-5 issues) | Large (6+ issues)]
- **Strategic theme**: [which theme this advances — existing or new]
- **Unblocks**: [what becomes possible after this ships]
- **Blocked by**: [what must happen first, or "nothing"]
- **Affected areas**: [specific modules, files, or architecture components]
```

This format ensures product opportunities carry the same specificity as technical findings — file paths, issue IDs, and concrete sizing — so they can be evaluated on equal footing during synthesis.
