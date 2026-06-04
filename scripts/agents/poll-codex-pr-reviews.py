#!/usr/bin/env python3
"""Poll TaxMaxi PRs for Codex review-loop state.

This v1 script is intentionally conservative: it discovers open PRs, reads
reviews/comments/checks via gh, stores idempotent state, and prints a concise
status report. It does not launch Codex or send Telegram by itself.

Hermes can use this script as pre-run context for a cron job whose prompt
decides whether to start a Codex review-fix session or notify the maintainer.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO = "taxmaxi/taxmaxi"
DEFAULT_STATE_PATH = Path.home() / ".hermes" / "state" / "taxmaxi-codex-loop.json"
CODEX_LOGIN_HINTS = ("codex", "openai-codex", "openai")
NON_ACTIONABLE_CODEX_PHRASES = (
    "create a codex account",
    "connect to github",
    "codex cloud/settings/connectors",
    "to use codex here",
    "didn't find any major issues",
    "did not find any major issues",
    "what shall we delve into next",
)


@dataclass(frozen=True)
class GhResult:
    stdout: str
    stderr: str
    returncode: int


def run_gh(args: list[str], *, cwd: str | None = None) -> GhResult:
    proc = subprocess.run(
        ["gh", *args],
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    return GhResult(proc.stdout, proc.stderr, proc.returncode)


def gh_json(args: list[str], *, default: Any) -> Any:
    result = run_gh(args)
    if result.returncode != 0:
        return default
    try:
        return json.loads(result.stdout or "null")
    except json.JSONDecodeError:
        return default


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"prs": {}}
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError:
        return {"prs": {}}
    if not isinstance(data, dict):
        return {"prs": {}}
    data.setdefault("prs", {})
    return data


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
    tmp.replace(path)


def user_login(item: dict[str, Any], *path: str) -> str:
    cur: Any = item
    for key in path:
        if not isinstance(cur, dict):
            return ""
        cur = cur.get(key)
    if isinstance(cur, str):
        return cur.lower()
    return ""


def looks_like_codex_author(login: str) -> bool:
    lower = login.lower()
    return any(hint in lower for hint in CODEX_LOGIN_HINTS)


def looks_non_actionable_codex_body(body: str) -> bool:
    lower = body.lower()
    return any(phrase in lower for phrase in NON_ACTIONABLE_CODEX_PHRASES)


def actionable_review_items(
    reviews: list[dict[str, Any]],
    inline_comments: list[dict[str, Any]],
    issue_comments: list[dict[str, Any]],
    head_sha: str,
) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []

    for review in reviews:
        author = user_login(review, "user", "login")
        body = str(review.get("body") or "").strip()
        state = str(review.get("state") or "").upper()
        commit_id = str(review.get("commit_id") or "")
        if head_sha and commit_id and commit_id != head_sha:
            continue
        if looks_like_codex_author(author) and state in {"CHANGES_REQUESTED", "COMMENTED"} and body and not looks_non_actionable_codex_body(body):
            items.append(
                {
                    "kind": "review",
                    "id": str(review.get("id")),
                    "author": author,
                    "summary": body[:500],
                }
            )

    for comment in inline_comments:
        author = user_login(comment, "user", "login")
        body = str(comment.get("body") or "").strip()
        commit_id = str(comment.get("commit_id") or "")
        if head_sha and commit_id and commit_id != head_sha:
            continue
        if looks_like_codex_author(author) and body and not looks_non_actionable_codex_body(body):
            path = str(comment.get("path") or "")
            line = comment.get("line") or comment.get("original_line") or "?"
            items.append(
                {
                    "kind": "inline_comment",
                    "id": str(comment.get("id")),
                    "author": author,
                    "summary": f"{path}:{line} — {body[:450]}",
                }
            )

    for comment in issue_comments:
        author = user_login(comment, "user", "login")
        body = str(comment.get("body") or "").strip()
        if looks_like_codex_author(author) and body and not looks_non_actionable_codex_body(body):
            items.append(
                {
                    "kind": "issue_comment",
                    "id": str(comment.get("id")),
                    "author": author,
                    "summary": body[:500],
                }
            )

    # Deduplicate by kind/id.
    seen: set[tuple[str, str]] = set()
    deduped: list[dict[str, str]] = []
    for item in items:
        key = (item["kind"], item["id"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def checks_summary(pr_number: int) -> str:
    result = run_gh(["pr", "checks", str(pr_number), "--repo", REPO])
    if result.returncode != 0:
        text = (result.stderr or result.stdout).strip()
        return f"unavailable: {text[:300]}" if text else "unavailable"
    output = result.stdout.strip()
    if not output:
        return "no checks reported"
    lowered = output.lower()
    if "fail" in lowered or "error" in lowered or "cancel" in lowered:
        return "failing or cancelled checks present"
    if "pending" in lowered or "in_progress" in lowered or "queued" in lowered:
        return "pending"
    return "green or no failing checks detected"


def main() -> int:
    state_path = Path(os.environ.get("TAXMAXI_CODEX_LOOP_STATE", DEFAULT_STATE_PATH))
    state = load_state(state_path)
    prs_state: dict[str, Any] = state.setdefault("prs", {})

    auth = run_gh(["auth", "status", "-h", "github.com"])
    if auth.returncode != 0:
        print("ERROR: gh is not authenticated for github.com.")
        print((auth.stderr or auth.stdout).strip())
        return 1

    prs = gh_json(
        [
            "pr",
            "list",
            "--repo",
            REPO,
            "--state",
            "open",
            "--json",
            "number,title,url,author,headRefName,headRefOid,isDraft,updatedAt,labels",
            "--limit",
            "50",
        ],
        default=[],
    )
    if not isinstance(prs, list):
        print("ERROR: failed to parse gh PR list output.")
        return 1

    now = datetime.now(timezone.utc).isoformat()
    report: list[str] = []
    report.append(f"TaxMaxi Codex PR poll at {now}")
    report.append(f"Open PRs scanned: {len(prs)}")

    interesting_count = 0
    ready_count = 0
    needs_fix_count = 0

    for pr in prs:
        if not isinstance(pr, dict):
            continue
        number = int(pr["number"])
        key = str(number)
        pr_state = prs_state.setdefault(key, {})
        head_sha = str(pr.get("headRefOid") or "")
        if pr_state.get("head_sha") != head_sha:
            pr_state["head_sha"] = head_sha
            pr_state["fix_pass_count"] = 0
            pr_state["notified_ready"] = False

        if pr.get("isDraft"):
            pr_state["last_seen_at"] = now
            pr_state["last_status"] = "draft_skipped"
            continue

        reviews = gh_json(["api", f"repos/{REPO}/pulls/{number}/reviews"], default=[])
        inline_comments = gh_json(["api", f"repos/{REPO}/pulls/{number}/comments"], default=[])
        issue_comments = gh_json(["api", f"repos/{REPO}/issues/{number}/comments"], default=[])

        if not isinstance(reviews, list):
            reviews = []
        if not isinstance(inline_comments, list):
            inline_comments = []
        if not isinstance(issue_comments, list):
            issue_comments = []

        actionable = actionable_review_items(reviews, inline_comments, issue_comments, head_sha)
        check_status = checks_summary(number)
        pass_count = int(pr_state.get("fix_pass_count") or 0)

        pr_state["last_seen_at"] = now
        pr_state["last_check_status"] = check_status
        pr_state["last_actionable_count"] = len(actionable)
        pr_state["last_actionable_ids"] = [f"{i['kind']}:{i['id']}" for i in actionable]

        if actionable:
            interesting_count += 1
            needs_fix_count += 1
            pr_state["last_status"] = "needs_review_fix" if pass_count < 3 else "blocked_after_3_passes"
            report.append("")
            report.append(f"PR #{number}: {pr.get('title')} — {pr.get('url')}")
            report.append(f"Status: {pr_state['last_status']} ({len(actionable)} actionable Codex item(s), pass_count={pass_count}, checks={check_status})")
            for item in actionable[:5]:
                report.append(f"- {item['kind']} {item['id']} by {item['author']}: {item['summary']}")
            if len(actionable) > 5:
                report.append(f"- ... {len(actionable) - 5} more")
        elif "pending" not in check_status.lower() and "failing" not in check_status.lower() and not pr_state.get("notified_ready"):
            interesting_count += 1
            ready_count += 1
            pr_state["last_status"] = "ready_candidate"
            report.append("")
            report.append(f"PR #{number}: {pr.get('title')} — {pr.get('url')}")
            report.append(f"Status: ready_candidate (no actionable Codex comments detected, checks={check_status})")
        else:
            pr_state["last_status"] = "waiting"

    state["last_poll_at"] = now
    save_state(state_path, state)

    report.append("")
    report.append(f"Summary: interesting={interesting_count}, needs_fix={needs_fix_count}, ready_candidates={ready_count}")
    report.append(f"State file: {state_path}")

    print("\n".join(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
