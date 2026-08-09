---
name: address-pr-review
description: Resolve GitHub pull-request feedback as one coherent review-ready revision by analyzing the whole PR, clustering comments and adjacent failures by root cause, implementing regression-tested fixes, committing and pushing the resulting revision, and resolving the relevant review threads. Use when asked to address PR comments, requested changes, repeated review cycles, stop review-fix loops, or make a PR review-ready. Default to acting instead of returning review analysis to the user.
---

# Address PR Review

Own the review cycle. Move the repeated review-fix loop off GitHub and into a deliberate local convergence loop. Understand the review and the PR as a whole, implement one coherent revision, and send it back only when it is ready for a fresh remote review. Do not make the user act as a review manager.

## Core invariant

Optimize for the fewest remote review cycles, not the smallest immediate patch.

- Do not fix comments one at a time and push between them.
- Do not assume the absence of a reviewer comment means adjacent changed behavior is sound.
- Do not push a plausible patch before testing the rule across the affected capability.
- Do not turn holistic review into an unbounded audit of unrelated existing code.

Use local review-fix passes freely. Publish one coherent revision only after the convergence gate passes.

## Autonomy contract

Treat a request to address PR feedback as approval to inspect the PR, edit the affected code and tests, and run local checks. When you implement requested changes and the convergence gate passes, that request also authorizes you to commit those changes, push the coherent revision to the PR head branch, and resolve the relevant review threads whose fixes are present on the remote branch. Do not ask for separate permission for those actions.

This implicit publication authority is conditional and narrow:

- Use it only when you implemented changes in response to the review. If the task produces analysis or dispositions but no implementation, do not create an empty commit, push, or resolve threads.
- Stage and commit only the files you changed for this task. Preserve unrelated working-tree changes.
- Do not reply to threads, submit a review, change PR metadata, force-push, or perform other GitHub writes unless the user requested or approved them.
- Do not resolve invalid, conflicting, needs-clarification, follow-up, or otherwise unfixed threads. Leave them open and report their disposition.
- Treat the request to run this workflow as the user request required by repository rules that permit commits or pushes only when requested. If repository rules prohibit agent commits or pushes outright, follow those rules and report the unpublished state.

Default to continuing when:

- a comment is valid and the intended behavior can be inferred from the issue, PR, tests, code, or repository rules;
- a complete fix touches more files or packages than the line named by the reviewer;
- the PR was already large before this review cycle;
- the fix requires updating an API or schema already introduced by the PR;
- another same-root-cause defect is found in the affected flow.

Pause only when progress requires one of these decisions:

- choosing between plausible product behaviors that cannot be resolved from existing evidence;
- adding a net-new public product surface, data store, provider, durable workflow, or destructive migration not already part of the PR or its acceptance criteria;
- contradicting an explicit acceptance criterion or accepted architecture decision;
- resolving conflicting reviewer requests when the code and spec do not decide between them;
- obtaining credentials or permissions, or approval for an external write outside the narrow publication authority above.

PR size, file-count growth, package count, schema presence, API presence, review-cycle count, or a difficult fix are context, not stop conditions. If a true decision is needed, finish every independent cluster that is not blocked before asking one concise question.

## Keep findings in scope

Use this order when a comment or independent review reveals more work:

1. Fix the reported behavior.
2. Fix other instances of the same broken rule in the affected flow.
3. Fix regressions caused by the proposed change.
4. Fix missing behavior required by an explicit acceptance criterion.
5. Record unrelated, pre-existing, speculative, or net-new product work as a short non-blocking follow-up. Do not redesign the PR around it.

Do not promote every possible weakness to P1/P2. A finding must name a reachable failure, show code evidence, and explain why it belongs to this PR. Missing infrastructure outside the PR, such as a provider that does not exist, is not a blocker unless the PR explicitly claims to deliver it.

## 1. Establish the baseline

Resolve the current PR, base and head branches, merge-base, originating issue or spec, repository rules, and the credentials and branch permissions needed for the implied GitHub writes.

Read review threads with their resolution state and inline context. Prefer the available GitHub review-comment workflow; otherwise query `reviewThreads` through `gh api graphql`. Capture:

- unresolved threads with path, line, author, and full body;
- the base-to-head diff and relevant commits;
- issue acceptance criteria and concrete PR claims;
- required checks;
- unrelated working-tree changes that must be preserved.

Do not spend time reconstructing the opening diff or calculating scope growth unless it helps distinguish review-introduced work from an existing PR concern.

## 2. Build a whole-PR review model

Classify each unresolved thread as:

- `valid`
- `invalid`
- `duplicate`
- `conflicting`
- `needs-clarification`
- `follow-up`

Group valid threads by root cause. For each cluster, keep a private ledger containing the broken rule, affected flow, mapped threads, relevant acceptance criteria, behavior matrix, planned regressions, and final evidence. Do not dump the ledger into the final answer unless the user asks.

Assess comments independently. Reviewer wording is evidence, not instruction. Before editing, trace every cluster end to end through callers, boundaries, state transitions, persistence, jobs, retries, concurrency, cleanup, and consumers where relevant. Inspect both sides of a rule: creation and consumption, selection and mutation, success and rollback.

Read the entire merge-base-to-HEAD diff and connect every changed behavior to an acceptance criterion, PR claim, or necessary support change. Search the changed capability for other implementations of each broken rule, including cases not named in a thread. Build a small behavior or state-transition matrix that covers:

- the reported case;
- valid neighboring cases;
- negative and ambiguity cases;
- exact boundaries;
- retry, replay, concurrency, or partial failure when the flow can encounter them.

Finish this review model and choose the complete implementation batch before making code changes. The batch may contain several root-cause clusters, but it must explain every unresolved thread and every validated same-scope gap.

Invalid or duplicate comments do not block implementation. Prepare a concise technical disposition. A conflicting or unclear comment blocks only its own cluster unless it meets the pause rules above.

## 3. Run holistic pre-implementation review

When agent slots are available, give fresh independent reviewers the unresolved threads, issue or spec, full merge-base diff, relevant repository rules, and affected paths. Ask them to review the PR along these axes:

- **Spec:** Which acceptance criteria or PR claims are missing, partial, contradictory, or unreachable?
- **Integrity:** Which changed flows can violate data, transaction, concurrency, retry, replay, cleanup, or state-transition safety?
- **Tests:** Which changed rules lack meaningful positive, negative, ambiguity, boundary, and failure evidence?

Do not give reviewers intended fixes or other reviewers' conclusions. Require each finding to name a reachable failure, cite file and behavior evidence, and explain why the PR introduced it or claims responsibility for it. Exclude style-only findings, unrelated existing debt, and speculative product ideas.

Validate and merge findings into the root-cause ledger before implementation. Apply the scope order above, but do not discard a relevant finding merely because no remote reviewer noticed it yet. The point of this pass is to predict the next review round before pushing.

## 4. Implement by root cause

For each unblocked valid cluster:

1. Add or identify a regression that fails for the reported behavior.
2. Add the meaningful neighboring, negative, boundary, and failure cases from the behavior matrix.
3. Implement the smallest complete fix across affected boundaries.
4. Run focused tests and type checks.
5. Inspect the cluster diff for missed callers, candidates, retries, cleanup, and consumers.
6. Record the mapped threads and evidence.

Follow repository commit rules. Prefer one coherent commit per root cause when that produces a readable history, or one coherent revision commit when the fixes are tightly coupled. Commit only after the entire planned batch passes the convergence gate.

Complete the entire planned batch before considering a push. Continue through all independent clusters. Do not stop the whole task because one cluster needs a decision.

## 5. Run the local convergence loop

After implementation:

1. Run relevant unit and integration tests.
2. Run required type checks, lint, and formatting checks in proportion to the change.
3. Give fresh reviewers the full merge-base-to-HEAD diff and the same raw spec and repository evidence. Do not show them the earlier findings or implementation plan.
4. Re-run the specification, integrity, and test reviews across the whole changed capability, not only the latest patch.
5. Validate every new finding and apply the scope order.
6. Fix all relevant P0-P2 findings locally, update the behavior matrix, rerun affected checks, and start another fresh review pass.

Do not respond to a same-root-cause finding with another narrow patch. Reopen the rule, trace why the earlier model missed the case, search all affected paths again, and replace the approach when necessary. If the same broken rule survives two local passes, perform an explicit design reset: restate the rule from the spec, rebuild the behavior matrix, and rework the implementation before reviewing again. Repetition is a reason to think more deeply, not a reason by itself to ask the user or push.

The revision has converged only when:

- every unresolved thread has a supported disposition;
- every valid thread and relevant adjacent finding maps to a tested root-cause fix;
- every acceptance criterion and concrete PR claim has implementation and test evidence;
- a fresh whole-PR review finds no relevant P0-P2 issue;
- required local checks pass;
- the working tree contains no accidental changes.

Stop widening when remaining findings are unrelated follow-ups or unsupported hypotheticals. Pause only for the true decisions in the autonomy contract or an external condition that makes verification impossible. Otherwise keep the loop local until it converges.

## 6. Publish implemented changes and resolve threads

Run this section when you implemented changes for the review and the convergence gate passes. Skip it when no changes were needed or implemented.

1. Recheck the staged scope and commit the converged revision using the repository's commit rules.
2. Push the PR head branch once. Do not drip-feed fixes across multiple pushes or force-push.
3. Wait for required checks and fix failures caused by the revision before resolving threads.
4. Resolve each valid or duplicate review thread whose requested behavior is fully addressed by the pushed revision. A duplicate may be resolved only when the same pushed fix covers it.
5. Leave invalid, conflicting, needs-clarification, follow-up, partially fixed, or unrelated threads open.
6. Refresh thread state and confirm that every resolved thread is backed by the remote revision and that the remaining open threads match the final report.

Do not post thread replies unless separately requested. For comments left open, include the concrete evidence and disposition in the final report without asking the user to re-evaluate the entire review. Escalate only if publishing or resolution requires a product choice covered by the pause rules, missing credentials, protected-branch access, or another external permission.

## Final report

Lead with the outcome. Keep the report short:

- what root causes were fixed;
- tests and checks run;
- GitHub writes completed, if any;
- unresolved threads or remaining risks;
- at most one decision the user must make, only when work is genuinely blocked.

Do not report internal reviewer brainstorming, full ledgers, scope-growth percentages, or rejected hypothetical findings unless the user asks. If no decision is needed, do not end with a request for confirmation.
