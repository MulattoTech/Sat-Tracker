"""Low-cost, metadata-only PR backlog management for agent-driven repositories.

No PR code is checked out/executed. Never closes a PR or bypasses protections.
"""
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

REPO = os.environ["GITHUB_REPOSITORY"]
OWNER = REPO.split("/")[0].lower()
TOKEN = os.environ["GITHUB_TOKEN"]
P = "/repos/" + REPO
NOW = dt.datetime.now(dt.timezone.utc)
KINDS = ("ready", "running", "failed", "behind", "conflict", "stale", "draft", "review")
MANAGED = {"agent-triage:" + kind for kind in KINDS}


def api(method, path, payload=None, *, graphql=False):
    url = "https://api.github.com/graphql" if graphql else "https://api.github.com" + path
    req = urllib.request.Request(
        url, method=method, data=None if payload is None else json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + TOKEN,
                 "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28",
                 "Content-Type": "application/json",
                 "User-Agent": "agent-pr-backlog-triage"})
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"GitHub API HTTP {exc.code}: {exc.read(250).decode('utf-8', 'replace')}") from None


def get(path):
    return api("GET", P + path)


def timestamp(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def prs():
    found = []
    for page in (1, 2, 3):
        batch = get("/pulls?state=open&sort=updated&direction=desc&per_page=100&page=" + str(page))
        found.extend(batch)
        if len(batch) < 100:
            break
    return found


def code_age_days(pr):
    # Labels/comments mutate pull_request.updated_at; use the actual head
    # commit timestamp so classification cannot refresh itself indefinitely.
    try:
        commit = get("/commits/" + pr["head"]["sha"])
        date = commit["commit"]["committer"]["date"]
        return max(0, (NOW - timestamp(date)).days)
    except (RuntimeError, KeyError, TypeError, ValueError):
        return 365  # Fail closed: never auto-merge a commit with unknown age.


def checks(sha):
    runs = get("/commits/" + sha + "/check-runs?per_page=100").get("check_runs", [])
    statuses = get("/commits/" + sha + "/status").get("statuses", [])
    if not runs and not statuses:
        return False, False
    failed = any(r.get("status") == "completed" and r.get("conclusion") not in
                 ("success", "neutral", "skipped") for r in runs)
    failed |= any(s.get("state") in ("failure", "error") for s in statuses)
    pending = any(r.get("status") != "completed" for r in runs)
    pending |= any(s.get("state") == "pending" for s in statuses)
    return not failed and not pending, failed


def classify(pr):
    age = code_age_days(pr)
    state = pr.get("mergeable_state")
    if pr["draft"]:
        return "draft", False
    if state == "dirty":
        return "conflict", False
    if age >= 30:
        return "stale", False
    if state == "behind":
        return "behind", False
    good, failed = checks(pr["head"]["sha"])
    if failed:
        return "failed", False
    if not good:
        return "running", False
    return ("ready" if state == "clean" else "review"), good


def docs_only(pr):
    if (pr["user"]["login"].lower() != OWNER or
            pr.get("changed_files", 9999) > 8 or
            pr.get("additions", 9999) > 250 or
            pr.get("deletions", 9999) > 100):
        return False
    files = get("/pulls/" + str(pr["number"]) + "/files?per_page=100")
    if not files:
        return False
    for obj in files:
        name = obj["filename"].lower()
        if not (name.startswith("docs/") and name.endswith(".md")):
            return False
        if any(x in name for x in (
            "/security/", "/spec/", "/runbooks/", "/private/", "/policy",
            "/maintainer", "auth", "secret", "credential", "/agents/")):
            return False
    return True


def set_label(pr, kind):
    desired = "agent-triage:" + kind
    existing = {l["name"] for l in pr["labels"]}
    if desired not in existing:
        api("POST", P + "/issues/" + str(pr["number"]) + "/labels",
            {"labels": [desired]})
    for old in (MANAGED & existing) - {desired}:
        api("DELETE", P + "/issues/" + str(pr["number"]) +
            "/labels/" + urllib.parse.quote(old, safe=""))
    return existing


def main():
    repo = get("")
    if repo.get("archived") or repo.get("disabled"):
        return
    if os.environ.get("GITHUB_EVENT_NAME") == "pull_request_target":
        with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as f:
            event = json.load(f)
        target = event.get("number")
    else:
        target = None
    for name in sorted(MANAGED | {"agent:automerge", "agent:hold"}):
        try:
            api("POST", P + "/labels", {
                "name": name, "color": "c2d3dc",
                "description": "Managed by read-only PR triage and guarded native auto-merge"})
        except RuntimeError as exc:
            if "HTTP 422" not in str(exc):
                raise
    opened = prs()
    selected = [p for p in opened if p["number"] == target] if target else opened
    # Do not stack concurrent integration enrollments. Old stalled ones don't block.
    busy = any(p.get("auto_merge") and (NOW - timestamp(p["updated_at"])).days < 3
               for p in opened)
    arms, updates, counts = 0, 0, {}
    for item in selected:
        pr = get("/pulls/" + str(item["number"]))
        kind, good = classify(pr)
        counts[kind] = counts.get(kind, 0) + 1
        try:
            current = set_label(pr, kind)
        except RuntimeError as exc:
            print(f"PR #{pr['number']} couldn't be labeled: {exc}")
            continue
        age = code_age_days(pr)
        trusted = (pr["user"]["login"].lower() == OWNER and pr["head"].get("repo") and
                   pr["head"]["repo"]["full_name"].lower() == REPO.lower())
        if (not trusted or pr["draft"] or "agent:hold" in current or age >= 30 or
                pr["base"]["ref"] != repo["default_branch"]):
            continue
        opt_in = "agent:automerge" in current
        if opt_in and kind == "behind" and updates == 0:
            try:
                api("PUT", P + "/pulls/" + str(pr["number"]) + "/update-branch",
                    {"expected_head_sha": pr["head"]["sha"]})
                updates += 1
                print(f"PR #{pr['number']}: updated branch for CI")
            except RuntimeError as exc:
                print(f"PR #{pr['number']}: branch update deferred: {exc}")
            continue
        if (kind != "ready" or not good or pr.get("auto_merge") or
                not repo.get("allow_auto_merge") or busy or arms or
                not (opt_in or docs_only(pr))):
            continue
        try:
            result = api("POST", "/graphql", {
                "query": ("mutation($id:ID!){enablePullRequestAutoMerge("
                          "input:{pullRequestId:$id,mergeMethod:SQUASH})"
                          "{clientMutationId}}"),
                "variables": {"id": pr["node_id"]}
            }, graphql=True)
            if result.get("errors"):
                raise RuntimeError(str(result["errors"])[:240])
            arms = 1
            print(f"PR #{pr['number']}: native auto-merge armed")
        except RuntimeError as exc:
            print(f"PR #{pr['number']}: auto-merge deferred: {exc}")
    print("Triage summary:", json.dumps(counts, sort_keys=True),
          "armed:", arms, "branch updates:", updates)


if __name__ == "__main__":
    main()
