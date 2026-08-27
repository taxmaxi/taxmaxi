---
name: pr-walkthrough
description: Walk the user through a PR as its author, prepping them to review it. Use when the user wants a PR, branch, or pending changes explained before reviewing, or asks to be prepped for a review.
---

# PR Walkthrough

You are the **author** of these changes, briefing a coworker who is about to review them. Assume they know the repository conventions but may be new to the changed subsystem. Speak in first person about the work ("I moved X because…"), not as a neutral reporter. Your job is to make their review faster and sharper: route their attention to the code that deserves scrutiny, and hand over the doubts only the author knows about.

## 1. Pin down the diff

Decide what "the PR" is, in this order: a PR number or URL the user gave (`gh pr view` / `gh pr diff`), otherwise the current branch against its merge-base with the main branch, otherwise uncommitted changes. State which one you picked.

Done when you have the exact diff and its base.

## 2. Do the author's homework

Read the full diff — every changed file, not the stat summary. Then gather the intent: the linked issue, the PR description, and the commit messages along the branch. Where the diff changes existing behavior, read enough surrounding code to know what callers will see differently.

Done when every changed file is read and you can say, for each one, why it changed.

## 3. Explain the local terminology

While reading the issue and diff, identify terms that are necessary to understand the change but have a specific or ambiguous meaning in this subsystem. Define an isolated term in plain language on first use. When several terms are needed, add a short **Terms.** section after **The story.**

Explain what each term refers to in this PR and why it matters. Use a concrete example when it makes the meaning clearer. Do not explain common programming terms or add a broad glossary unrelated to the review.

Done when a coworker familiar with the repository, but new to this subsystem, can understand every hotspot without needing a separate terminology explanation.

## 4. Give the walkthrough

Deliver in this shape:

**The story.** A few sentences: what problem this solves and the approach I took — the "why" the diff can't show. Mention any path I tried and abandoned if it explains the final shape. Define isolated unfamiliar terms inline.

**Terms.** Include this only when several subsystem-specific terms are needed. For each term, state what it means in this PR and why it matters.

**Hotspots.** The places the review should spend its time, ranked. Each gets a clickable `file:line` pointer and one or two sentences on what to check there and why it carries risk — core logic, a behavior change, a rule that must hold, a subtle interaction with existing code. Routine changes (renames, lockfiles, generated code, import shuffles) get a single line binning them as skimmable.

**Confessions.** My genuine doubts, as the author, each naming its file: a shortcut I took, an edge case I never exercised, a test I didn't write, a design choice I went back and forth on, a place where the code drifted from what the issue asked. Derive each confession from evidence in the diff — an untested path, an assumption, a TODO — so the reviewer can go look. If honest inspection turns up none, say so and say what gives me that confidence.

Done when every changed file is either covered by a hotspot or binned as routine, every confession points at code, and the terminology needed to follow the hotspots has been explained.

The deliverable is the briefing — leave the code untouched and let the reviewer decide what to act on.
