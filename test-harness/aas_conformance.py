"""
IDTA's own test engine against aas-api: what passes, measured, and what is not implemented, named.

    pip install aas_test_engines==1.0.3      # the version PINNED names; Python 3.13 or older
    python test-harness/aas_conformance.py --server URL --token TOKEN [--report-dir DIR]

URL is aas-api's base, such as http://127.0.0.1:18080/functions/v1/aas-api through a port-forward of
the gateway, and TOKEN a person's or a machine identity's access token. CI runs it in the stack job.

WHAT IT RUNS. `aas-test-engines` (admin-shell-io, Apache-2.0) tests a server against IDTA-01002's
service profiles. Its public package holds four, all read profiles; aas-api declares two of them, the
AAS Repository's and the Submodel Repository's, and this runs both. The AAS Registry, Submodel
Registry, Discovery and ConceptDescription Repository suites are for IDTA members only, so aas-api's
Registry and Discovery are not measured here: `supabase/functions/aas-api/test_a_registry_and_
discovery_resolve_a_shell.py` reads them on the stack instead.

THE TOKEN GOES IN BY A CLIENT OF OUR OWN. The engine's `check_server --header` stores the header and
never sends it (`aas_test_engines/http.py`, 1.0.3), so every request reached aas-api without a token
and answered 401. Its README's own answer for authentication is a client class, which BearerClient is.
1.0.3 does not import on Python 3.14: its reflection resolves the model's forward references at
import, which 3.14's deferred annotations break.

THE VERDICT IS "Compliant" ONLY WHEN EVERY OPERATION OF BOTH PROFILES PASSES. Short of that, the
run holds what was measured: each operation PASSING names must still pass, and a server error (5xx)
anywhere fails it. An operation that starts to pass is printed, to be recorded here and in the
README's statement (supabase/README.md, "What is verified, and by what"); it does not fail the run,
since which elements the engine finds to test depends on the stack's first shell. KNOWN_FAILURES says
why each other operation fails, for that statement and for whoever fixes one.
"""
import argparse
import json
import sys
from importlib import metadata
from pathlib import Path

PINNED = "1.0.3"

PROFILES = {
    "aas-repository": "https://admin-shell.io/aas/API/3/0/AssetAdministrationShellRepositoryServiceSpecification/SSP-002",
    "submodel-repository": "https://admin-shell.io/aas/API/3/0/SubmodelRepositoryServiceSpecification/SSP-002",
}

# What passed, measured with 1.0.3 on 2026-11-26 against a database of 4,950 devices. Four of these
# pass whatever aas-api answers: GetThumbnail and GetFileByPath (the first submodel holds no File)
# check no status, and GetSubmodelElementByPath's -Metadata and -Path accept its 404.
PASSING = {
    "aas-repository": [
        "GetAssetAdministrationShellById", "GetAssetInformation", "GetThumbnail",
        "GetSubmodelElementByPath-Metadata", "GetSubmodelElementByPath-Path", "GetFileByPath", "GetDescription",
    ],
    "submodel-repository": [
        "GetSubmodelElementByPath-Metadata", "GetSubmodelElementByPath-Path", "GetFileByPath", "GetDescription",
    ],
}

# Why each other operation fails, by what the engine met.
MODIFIER = "the $metadata, $reference and $path modifiers are not served (404, or 400 on a list)"
LEVEL = "an invalid level or extent is accepted (200), where the specification refuses it (400)"
PAGED = "limit is not applied: one page holds every one"
KNOWN_FAILURES = {
    "GetAllAssetAdministrationShells": "/shells reads no idShort filter, and an assetIds that is not base64url is accepted",
    "GetAllSubmodels": "on /submodels limit counts devices, so a page of 1 holds every submodel of one device",
    "GetAllSubmodels-ValueOnly": "on /submodels limit counts devices, so a page of 1 holds every submodel of one device",
    "GetAllSubmodelReferences": PAGED,
    "GetSubmodelById": LEVEL,
    "GetSubmodelById-ValueOnly": LEVEL,
    "GetAllSubmodelElements": f"{LEVEL}; {PAGED}",
    "GetAllSubmodelElements-ValueOnly": f"{LEVEL}; {PAGED}",
    "GetSubmodelElementByPath": LEVEL,
    "GetSubmodelElementByPath-ValueOnly": f"{LEVEL}; one element's ValueOnly form is its bare value, not an object",
    "GenerateSerializationByIds": "/serialization is not served; aas-export writes the files",
    **{op: MODIFIER for op in (
        "GetAllAssetAdministrationShells-Reference", "GetAssetAdministrationShellById-Reference",
        "GetSubmodelById-Metadata", "GetSubmodelById-Reference", "GetSubmodelById-Path",
        "GetAllSubmodels-Metadata", "GetAllSubmodels-Reference", "GetAllSubmodels-Path",
        "GetAllSubmodelElements-Metadata", "GetAllSubmodelElements-Reference", "GetAllSubmodelElements-Path",
        "GetSubmodelElementByPath-Reference",
    )},
}

# The engine's levels (aas_test_engines/result.py): INFO, WARNING, ERROR, CRITICAL.
ERROR, CRITICAL = 2, 3


def operations(tree):
    """{operation: node} of one profile's result, as the engine's to_dict() writes it."""
    found = {}
    for node in tree.get("s", []):
        message = node.get("m", "")
        if message.startswith("Checking "):
            found[message[len("Checking "):]] = node
    return found


def worst(node):
    """The highest level anywhere in a node."""
    return max([node.get("l", 0), *(worst(child) for child in node.get("s", []))])


def failures(node, path=()):
    """The failing leaves of a node, each as the path of messages that leads to it."""
    here = (*path, node.get("m", "").strip())
    children = node.get("s", [])
    if not children:
        return [" > ".join(here)] if node.get("l", 0) >= ERROR else []
    return [line for child in children for line in failures(child, here)]


def reached(tree):
    """Whether the engine reached the server at all."""
    return any(node.get("m", "").startswith("Trying to reach") and node.get("l", 0) < ERROR
               for node in tree.get("s", []))


def judge(results, passing=None, known=None):
    """
    (verdict, problems, lines) for {profile: tree}. The verdict is "Compliant", "As recorded" or
    "Regressed"; each problem is a reason the run fails.
    """
    passing = PASSING if passing is None else passing
    known = KNOWN_FAILURES if known is None else known
    problems, lines = [], []
    every_passes = True
    for name, tree in results.items():
        if not reached(tree):
            problems.append(f"{name}: the engine did not reach the server")
            continue
        ops = operations(tree)
        if not ops:
            problems.append(f"{name}: the engine ran no operation")
        passed = [op for op, node in ops.items() if node.get("l", 0) < ERROR]
        lines.append(f"{name}: {len(passed)} of {len(ops)} operations pass")
        for op, node in ops.items():
            ok = node.get("l", 0) < ERROR
            every_passes = every_passes and ok
            if worst(node) >= CRITICAL:
                problems.append(f"{name}: {op} met a server error or an engine fault: "
                                + "; ".join(failures(node)[:3]))
            elif not ok and op in passing.get(name, []):
                problems.append(f"{name}: {op} passed and now fails: " + "; ".join(failures(node)[:3]))
            elif ok and op not in passing.get(name, []):
                lines.append(f"  NOW PASSES: {op}; record it in PASSING and the README")
            elif not ok:
                lines.append(f"  fails: {op} -- {known.get(op, 'not yet explained: read the report')}")
        for op in passing.get(name, []):
            if op not in ops:
                problems.append(f"{name}: {op} passed and was not run")
    if problems:
        return "Regressed", problems, lines
    return ("Compliant" if every_passes else "As recorded"), problems, lines


def run(server, token, report_dir):
    """{profile: tree}, running the engine once a profile, with each report written to report_dir."""
    from aas_test_engines import api, config
    from aas_test_engines.http import HttpClient

    class BearerClient(HttpClient):
        """The engine's client, sending the token on every request it makes, below every prefix too."""

        def __init__(self, host, verify=True):
            super().__init__(host=host, verify=verify)

        def descend(self, prefix):
            child = BearerClient(self.host, self.verify)
            child.prefixes = [*self.prefixes, prefix]
            return child

        def send(self, request):
            request.headers["Authorization"] = f"Bearer {token}"
            return super().send(request)

    results = {}
    for name, profile in PROFILES.items():
        result, _ = api.execute_tests(BearerClient(server.rstrip("/")), config.CheckApiConfig(suite=profile))
        tree = result.to_dict()
        results[name] = tree
        if report_dir:
            (report_dir / f"{name}.json").write_text(json.dumps(tree, indent=1), encoding="utf-8")
            (report_dir / f"{name}.html").write_text(result.to_html(), encoding="utf-8")
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("--server", required=True, help="aas-api's base URL")
    parser.add_argument("--token", required=True, help="a person's or a machine identity's access token")
    parser.add_argument("--report-dir", type=Path, help="where to write each profile's JSON and HTML report")
    args = parser.parse_args(argv)

    try:
        installed = metadata.version("aas_test_engines")
    except metadata.PackageNotFoundError:
        print(f"aas_test_engines is not installed: pip install aas_test_engines=={PINNED}")
        return 2
    if installed != PINNED:
        print(f"aas_test_engines {installed} is installed, and this is written for {PINNED}. Read its "
              "changes, run this against the dev stack, and move PINNED, NOT_IMPLEMENTED and the README together.")
        return 2

    if args.report_dir:
        args.report_dir.mkdir(parents=True, exist_ok=True)
    verdict, problems, lines = judge(run(args.server, args.token, args.report_dir))
    print(f"IDTA aas-test-engines {PINNED} against {args.server}")
    for line in lines:
        print(f"  {line}")
    for problem in problems:
        print(f"  PROBLEM: {problem}")
    print(f"Result: {verdict}")
    return 0 if verdict in ("As recorded", "Compliant") else 1


if __name__ == "__main__":
    sys.exit(main())
