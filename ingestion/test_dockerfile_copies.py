"""
Every sibling module ingestion.py imports has to be COPY'd into the image: the Dockerfile lists
files one by one, and a module left off the list is a crash loop on the first boot
(`ModuleNotFoundError`), which is how directory_publish.py and then uns_publish.py were each
found missing. The Dockerfile's own comment says so three times; this is the check that does
not depend on anyone reading it.

Pure file inspection; no Docker, no network.
"""
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def local_imports(path):
    """The bare-module imports of a file that resolve to a sibling .py in this directory."""
    with open(path, "r", encoding="utf-8") as handle:
        source = handle.read()
    names = set()
    for match in re.finditer(r"^(?:import|from)\s+([A-Za-z_][A-Za-z0-9_]*)", source, re.MULTILINE):
        name = match.group(1)
        if os.path.exists(os.path.join(HERE, name + ".py")):
            names.add(name)
    return names


def copied_modules():
    """The modules the image holds: those COPY'd in, plus the one protoc generates at build time."""
    with open(os.path.join(HERE, "Dockerfile"), "r", encoding="utf-8") as handle:
        dockerfile = handle.read()
    copied = set(re.findall(r"^COPY ingestion/([A-Za-z_][A-Za-z0-9_]*)\.py ", dockerfile, re.MULTILINE))
    # `protoc --python_out=. sparkplug_b.proto` writes sparkplug_b_pb2.py inside the image; the
    # checked-in copy is for running the suites on a host without protoc.
    for proto in re.findall(r"^RUN protoc --python_out=\. ([A-Za-z_][A-Za-z0-9_]*)\.proto", dockerfile, re.MULTILINE):
        copied.add(proto + "_pb2")
    return copied


class TestDockerfileCopiesEveryImportedModule(unittest.TestCase):

    def test_every_module_ingestion_imports_is_copied(self):
        wanted = local_imports(os.path.join(HERE, "ingestion.py"))
        self.assertTrue(wanted, "ingestion.py imports no sibling module, which is not the layout")
        missing = sorted(wanted - copied_modules())
        self.assertEqual(
            missing, [],
            f"ingestion.py imports {missing} but ingestion/Dockerfile does not COPY them; "
            "the container would crash-loop on start"
        )

    def test_the_transitive_imports_are_copied_too(self):
        # A module the daemon imports may import a sibling of its own; the image needs that one
        # as well.
        seen, queue = set(), ["ingestion"]
        while queue:
            name = queue.pop()
            if name in seen:
                continue
            seen.add(name)
            queue.extend(local_imports(os.path.join(HERE, name + ".py")))
        seen.discard("ingestion")
        missing = sorted(seen - copied_modules())
        self.assertEqual(missing, [], f"transitively imported but not COPY'd: {missing}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
