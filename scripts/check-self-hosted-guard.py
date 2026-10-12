#!/usr/bin/env python3
"""Fail closed unless every non-GitHub-hosted job is unreachable from public/fork PRs.

Policy (Łukasz, 2026-10-12): the self-hosted runners are personal Macs and must
never run code from public or fork pull requests. For every workflow in
.github/workflows this check requires:

  * no `pull_request_target` or `workflow_run` trigger anywhere (both run with
    the base repository's secrets and runners on behalf of untrusted code);
  * every job whose `runs-on` is not exactly one known GitHub-hosted label
    (custom labels alone, `self-hosted` in any case, runner groups and
    expressions all count as self-hosted) carries exactly SELF_HOSTED_GUARD as
    its job-level `if:`: actor and (re-)triggering actor are allowlisted, and
    the event is schedule / push / workflow_dispatch, or a same-repository
    pull request opened by an allowlisted login;
  * no job-level reusable workflow other than a local ./.github/workflows/
    file (which is itself checked here; called jobs see the caller's context).

Bots are deliberately not on the allowlist: fail closed.
NOTE: in a public repo a fork PR controls its own copy of these files, so this
is a guard against our own mistakes; the hard barrier there is the fork-PR
approval setting (all_external_contributors) — never approve Mac-labelled runs.
Usage: check-self-hosted-guard.py [workflows-dir]
"""
import pathlib
import sys

import yaml

ALLOWED_LOGINS = ("lksrz",)
SELF_HOSTED_GUARD = (
    "github.actor == 'lksrz' && github.triggering_actor == 'lksrz' && "
    "(github.event_name == 'schedule' || github.event_name == 'push' || "
    "github.event_name == 'workflow_dispatch' || "
    "(github.event_name == 'pull_request' && "
    "github.event.pull_request.head.repo.full_name == github.repository && "
    "github.event.pull_request.user.login == 'lksrz'))"
)
FORBIDDEN_TRIGGERS = {"pull_request_target", "workflow_run"}
# Finite allowlist of GitHub-hosted labels (no patterns: a custom runner label
# such as macos-999 must not be exempted). Extend deliberately when needed.
GITHUB_HOSTED = frozenset({
    "ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04", "ubuntu-24.04-arm", "ubuntu-22.04-arm",
    "windows-latest", "windows-2025", "windows-2022",
    "macos-latest", "macos-15", "macos-14", "macos-13",
})


def normalize(expr):
    text = " ".join(str(expr).split())
    if text.startswith("${{") and text.endswith("}}"):
        text = " ".join(text[3:-2].split())
    return text


def triggers(doc):
    # PyYAML (YAML 1.1) reads the bare key `on` as boolean True.
    on = doc.get("on", doc.get(True))
    if isinstance(on, str):
        return {on}
    if isinstance(on, (list, dict)):
        return {str(t) for t in on}
    return set()


def is_github_hosted(runs_on):
    if isinstance(runs_on, list) and len(runs_on) == 1:
        runs_on = runs_on[0]
    return isinstance(runs_on, str) and runs_on in GITHUB_HOSTED


def check(directory):
    errors = []
    files = sorted(p for p in pathlib.Path(directory).glob("*.y*ml") if p.suffix in (".yml", ".yaml"))
    if not files:
        errors.append(f"no workflows found in {directory}")
    for path in files:
        doc = yaml.safe_load(path.read_text()) or {}
        bad = triggers(doc) & FORBIDDEN_TRIGGERS
        if bad:
            errors.append(f"{path.name}: forbidden trigger(s) {sorted(bad)}")
        jobs = doc.get("jobs") or {}
        if not isinstance(jobs, dict):
            errors.append(f"{path.name}: unreadable jobs")
            continue
        for name, job in jobs.items():
            if not isinstance(job, dict):
                errors.append(f"{path.name}: unreadable job '{name}'")
                continue
            if "uses" in job:
                if not str(job["uses"]).startswith("./.github/workflows/"):
                    errors.append(f"{path.name}: job '{name}' calls a non-local reusable workflow")
                continue
            if is_github_hosted(job.get("runs-on")):
                continue
            guard = job.get("if")
            if guard is None or normalize(guard) != SELF_HOSTED_GUARD:
                errors.append(f"{path.name}: self-hosted job '{name}' lacks the exact self-hosted guard")
    return errors


def main():
    directory = sys.argv[1] if len(sys.argv) > 1 else ".github/workflows"
    errors = check(directory)
    for error in errors:
        print(f"::error::{error}")
    if errors:
        sys.exit(1)
    print("self-hosted guard: OK")


if __name__ == "__main__":
    main()
