#!/usr/bin/env python3
"""Fixture + semantics tests for check-self-hosted-guard.py."""
import importlib.util
import pathlib
import re
import sys
import tempfile

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "guard", pathlib.Path(__file__).with_name("check-self-hosted-guard.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
G = guard.SELF_HOSTED_GUARD


def run(files):
    with tempfile.TemporaryDirectory() as d:
        for name, text in files.items():
            pathlib.Path(d, name).write_text(text)
        return guard.check(d)


def wf(runs_on, cond=None, on="workflow_dispatch", extra=""):
    c = f"    if: >-\n      {cond}\n" if cond else ""
    return f"on: {on}\njobs:\n  j:\n{c}    runs-on: {runs_on}\n    steps: [{{run: 'true'}}]\n{extra}"


def expect(errors, ok, label):
    assert (not errors) == ok, f"{label}: {errors}"


# Runner detection: everything that is not exactly one GitHub-hosted label needs the guard.
for runs_on in ["[self-hosted, macOS]", "SELF-HOSTED", "mcpfinder-snapshot", "[macOS, ARM64]",
                "[ubuntu-latest, mcpfinder-snapshot]", "'${{ matrix.os }}'", "{group: macs}",
                "{group: macs, labels: [x]}", "ubuntu-latest-mac", "''", "macos-999", "ubuntu-99.99",
                "windows-9999-arm", "Ubuntu-Latest", "macos-15-xlarge"]:
    expect(run({"a.yml": wf(runs_on)}), False, f"unguarded {runs_on}")
    expect(run({"a.yml": wf(runs_on, G)}), True, f"guarded {runs_on}")
for hosted in ["ubuntu-latest", "[ubuntu-24.04]", "ubuntu-24.04-arm", "macos-15", "windows-latest"]:
    expect(run({"a.yml": wf(hosted)}), True, f"hosted {hosted}")
expect(run({"a.yml": "on: push\njobs:\n  j:\n    steps: []\n"}), False, "missing runs-on")
# Guard must be exact (normalized); ${{ }} wrapper ok; weaker guards rejected.
expect(run({"a.yml": wf("self-hosted", "${{ " + G + " }}")}), True, "wrapped")
expect(run({"a.yml": wf("self-hosted", G.replace("'lksrz'", "'dependabot[bot]'", 1))}), False, "bot")
expect(run({"a.yml": wf("self-hosted", "github.event_name == 'push'")}), False, "weak")
expect(run({"a.yml": wf("self-hosted", G + " || true")}), False, "or-true")
# Triggers.
for on in ["pull_request_target", "[push, workflow_run]", "{workflow_run: {workflows: [x]}}"]:
    expect(run({"a.yml": wf("ubuntu-latest", on=on)}), False, f"trigger {on}")
expect(run({"a.yml": f'"on": pull_request_target\njobs: {{}}\n'}), False, "quoted on")
# Reusable workflows: local ok, remote rejected anywhere.
expect(run({"a.yml": "on: push\njobs:\n  r:\n    uses: org/repo/.github/workflows/x.yml@main\n"}), False, "remote uses")
expect(run({"a.yml": "on: push\njobs:\n  r:\n    uses: ./.github/workflows/b.yml\n",
            "b.yml": wf("self-hosted", on="workflow_call")}), False, "local callee unguarded")
expect(run({"a.yml": "on: push\njobs:\n  r:\n    uses: ./.github/workflows/b.yml\n",
            "b.yml": wf("self-hosted", G, on="workflow_call")}), True, "local callee guarded")
expect(run({}), False, "empty dir")
expect(run({"a.yml": "on: push\njobs: [x]\n"}), False, "bad jobs")


# Semantics: evaluate the guard against GitHub contexts.
def evaluate(ctx):
    def lookup(m):
        cur = ctx
        for part in m.group(0).split(".")[1:]:
            cur = cur.get(part) if isinstance(cur, dict) else None
        return repr(cur)
    py = re.sub(r"github(\.[a-z_]+)+", lookup, G).replace("&&", " and ").replace("||", " or ")
    return eval(py, {"__builtins__": {}})


def pr(head="mcpfinder/mcpfinder", user="lksrz"):
    return {"pull_request": {"head": {"repo": {"full_name": head} if head else None}, "user": {"login": user}}}


def ctx(event, actor="lksrz", trig="lksrz", payload=None):
    return {"event_name": event, "actor": actor, "triggering_actor": trig,
            "repository": "mcpfinder/mcpfinder", "event": payload or {}}


cases = [
    (ctx("schedule"), True), (ctx("push"), True), (ctx("workflow_dispatch"), True),
    (ctx("pull_request", payload=pr()), True),
    (ctx("pull_request", payload=pr(head="evil/mcpfinder")), False),
    (ctx("pull_request", payload=pr(head=None)), False),
    (ctx("pull_request", payload=pr(user="mallory")), False),
    (ctx("pull_request", actor="mallory", payload=pr()), False),
    (ctx("pull_request", trig="mallory", payload=pr()), False),
    (ctx("push", actor="dependabot[bot]", trig="dependabot[bot]"), False),
    (ctx("workflow_dispatch", trig="mallory"), False),
    (ctx("schedule", trig="mallory"), False),
    (ctx("pull_request_target", payload=pr()), False),
    (ctx("merge_group"), False), (ctx("issue_comment"), False), (ctx("workflow_run"), False),
    ({"event_name": "push"}, False),
]
for c, want in cases:
    assert evaluate(c) is want, f"semantics {c}"
print("check-self-hosted-guard tests: OK")
