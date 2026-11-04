# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Neo4j-free units: the JSONL exporter, the lazy HTTP client and schema bootstrap."""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

from sciencediscovery_memory_graph import constraints, export_to_neo4j, neo4j_driver
from sciencediscovery_memory_graph.local_graph import Graph


class Rec(dict):
    def __getitem__(self, key):
        return dict.__getitem__(self, key)


class Result:
    def __init__(self, recs=()):
        self.recs = list(recs)

    def consume(self):
        return self

    def __iter__(self):
        return iter(self.recs)


class Session:
    def __init__(self, names=(), fail=()):
        self.calls = []
        self._names = list(names)
        self._fail = tuple(fail)

    def run(self, statement, **params):
        self.calls.append((statement, params))
        if any(fragment in statement for fragment in self._fail):
            raise RuntimeError("neo4j refused the statement")
        if statement.startswith("SHOW CONSTRAINTS"):
            return Result(Rec(name=name) for name in self._names)
        return Result()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class Driver:
    kind = "neo4j"

    def __init__(self, reachable=True, names=(), fail=()):
        self.reachable = reachable
        self.names = names
        self.fail = fail
        self.sessions = []

    def is_reachable(self):
        return self.reachable

    def session(self):
        session = Session(names=self.names, fail=self.fail)
        self.sessions.append(session)
        return session


def _graph():
    graph = Graph()
    paper = graph.create_node(["Paper"], {"title": "A paper"})
    record = graph.create_node(["DbRecord"], {"source": "pubmed"})
    graph.create_rel("CITES", paper, record, {"weight": 1})
    graph.create_rel("CITES", paper, record, {"weight": 2})
    return graph


def test_quote_escapes_backticks() -> None:
    assert export_to_neo4j._quote("Plain") == "`Plain`"
    assert export_to_neo4j._quote("back`tick") == "`back``tick`"


def test_batches_splits_rows_at_the_batch_size() -> None:
    rows = list(range(1001))
    chunks = list(export_to_neo4j._batches(rows))
    assert [len(chunk) for chunk in chunks] == [500, 500, 1]
    assert sum(chunks, []) == rows
    assert list(export_to_neo4j._batches([])) == []


def test_export_graph_merges_nodes_by_label_set_and_rels_by_type() -> None:
    session = Session()
    nodes, rels = export_to_neo4j.export_graph(_graph(), session)
    assert (nodes, rels) == (2, 2)

    statements = [statement for statement, _ in session.calls]
    node_merge = [s for s in statements if "MERGE (n" in s]
    rel_merge = [s for s in statements if "MERGE (a)-[e:" in s]
    assert len(node_merge) == 2
    assert len(rel_merge) == 1, "both relationships share the CITES type"
    assert ":`Paper`" in node_merge[0] or ":`Paper`" in node_merge[1]
    assert "`CITES`" in rel_merge[0]
    assert statements[-1] == "MATCH (n) WHERE n._local_id IS NOT NULL REMOVE n._local_id"

    rows = session.calls[0][1]["rows"]
    assert {"id", "props"} == set(rows[0])


def test_export_graph_batches_large_graphs() -> None:
    graph = Graph()
    for index in range(501):
        graph.create_node(["Code"], {"index": index})
    session = Session()
    assert export_to_neo4j.export_graph(graph, session) == (501, 0)
    assert [len(params["rows"]) for _, params in session.calls if "rows" in params] == [500, 1]


def test_export_main_requires_the_password_environment(monkeypatch, capsys) -> None:
    monkeypatch.delenv("NEO4J_PASSWORD", raising=False)
    assert export_to_neo4j.main([]) == 2
    assert "set NEO4J_PASSWORD to the Neo4j password" in capsys.readouterr().err


def test_export_main_imports_through_http_and_reports_counts(monkeypatch, capsys, tmp_path) -> None:
    monkeypatch.setenv("NEO4J_PASSWORD", "secret")
    session = Session()
    seen = {}

    class Client:
        def __init__(self, **kwargs):
            seen["client"] = kwargs

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    class HttpSession:
        def __init__(self, client, **kwargs):
            seen["session"] = kwargs

        def __enter__(self):
            return session

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(export_to_neo4j.httpx, "Client", Client)
    monkeypatch.setattr(export_to_neo4j, "_HttpSession", HttpSession)
    monkeypatch.setattr(export_to_neo4j, "Graph", lambda store: _graph())

    code = export_to_neo4j.main(["--data-dir", str(tmp_path), "--http", "http://example:7474",
                                 "--user", "reader", "--password-env", "NEO4J_PASSWORD"])

    assert code == 0
    assert seen["client"]["auth"] == ("reader", "secret")
    assert seen["session"]["base_url"] == "http://example:7474"
    assert "imported 2 nodes and 2 relationships into http://example:7474" in capsys.readouterr().out


class Response:
    def __init__(self, payload, status_ok=True):
        self._payload = payload
        self._ok = status_ok

    def raise_for_status(self):
        if not self._ok:
            raise RuntimeError("500")

    def json(self):
        return self._payload


class Client:
    def __init__(self, payload=None, error=None, close_error=None):
        self.payload = payload
        self.error = error
        self.close_error = close_error
        self.closed = False
        self.posts = []

    def post(self, url, json=None):
        self.posts.append((url, json))
        if self.error is not None:
            raise self.error
        return Response(self.payload)

    def close(self):
        self.closed = True
        if self.close_error is not None:
            raise self.close_error


def test_handle_reads_connection_settings_from_the_environment(monkeypatch) -> None:
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_NEO4J_HTTP", "http://db:7474")
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_NEO4J_USER", "reader")
    handle = neo4j_driver.Neo4jHandle()
    assert handle._http_uri == "http://db:7474"
    assert handle._user == "reader"
    assert handle.has_password is False


def test_set_password_builds_and_clears_the_client(monkeypatch) -> None:
    built = []
    monkeypatch.setattr(neo4j_driver.httpx, "Client", lambda **kwargs: built.append(kwargs) or Client())
    handle = neo4j_driver.Neo4jHandle()

    handle.set_password("secret")
    assert handle.has_password is True
    assert built[0]["auth"] == ("neo4j", "secret")

    handle.set_password(None)
    assert handle.has_password is False
    assert handle._client is None
    assert handle.is_reachable() is False


def test_set_password_survives_a_client_that_refuses_to_close(monkeypatch) -> None:
    class BadClient(Client):
        def close(self):
            raise RuntimeError("socket already gone")

    monkeypatch.setattr(neo4j_driver.httpx, "Client", lambda **kwargs: BadClient())
    handle = neo4j_driver.Neo4jHandle()
    handle.set_password("secret")
    handle.set_password("rotated")
    assert handle.has_password is True


def test_configure_rebuilds_only_when_the_connection_changes(monkeypatch) -> None:
    built = []
    monkeypatch.setattr(neo4j_driver.httpx, "Client", lambda **kwargs: built.append(kwargs) or Client())
    handle = neo4j_driver.Neo4jHandle()

    handle.configure("http://other:7474", "reader")
    assert built == [], "no password yet means nothing to rebuild"
    assert handle._http_uri == "http://other:7474"
    assert handle._user == "reader"

    handle.set_password("secret")
    handle.configure(None, "neo4j")
    assert built[-1]["base_url"] == "http://other:7474"
    assert built[-1]["auth"] == ("neo4j", "secret")
    handle.configure("http://other:7474", "neo4j")
    assert len(built) == 3, "a stored password rebuilds the client on every push"
    assert built[-1]["auth"] == ("neo4j", "secret")


def test_configure_degrades_when_the_new_client_cannot_be_built(monkeypatch) -> None:
    calls = {"n": 0}

    def client(**kwargs):
        calls["n"] += 1
        if calls["n"] > 1:
            raise RuntimeError("bad uri")
        return Client()

    monkeypatch.setattr(neo4j_driver.httpx, "Client", client)
    handle = neo4j_driver.Neo4jHandle()
    handle.set_password("secret")
    handle.configure("http://bad:7474", None)
    assert handle._client is None
    assert handle.is_reachable() is False


@pytest.mark.parametrize(("payload", "expected"), [
    ({"results": [{"data": [{"row": [1]}]}]}, True),
    ({"results": [{"data": [{"row": [2]}]}]}, False),
    ({"results": []}, False),
    ({"results": [{}]}, False),
    ({"results": [{"data": []}]}, False),
    ({"errors": [{"code": "N/A"}]}, False),
    ({}, False),
])
def test_is_reachable_reads_the_probe_row(monkeypatch, payload, expected) -> None:
    client = Client(payload=payload)
    monkeypatch.setattr(neo4j_driver.httpx, "Client", lambda **kwargs: client)
    handle = neo4j_driver.Neo4jHandle()
    handle.set_password("secret")
    assert handle.is_reachable() is expected
    assert client.posts[0][0] == "/db/neo4j/tx/commit"
    assert client.posts[0][1]["statements"][0]["statement"] == "RETURN 1 AS ok"


def test_is_reachable_absorbs_a_failing_probe(monkeypatch) -> None:
    client = Client(error=OSError("connection refused"))
    monkeypatch.setattr(neo4j_driver.httpx, "Client", lambda **kwargs: client)
    handle = neo4j_driver.Neo4jHandle()
    handle.set_password("secret")
    assert handle.is_reachable() is False


def test_session_requires_an_initialised_client(monkeypatch) -> None:
    monkeypatch.setattr(neo4j_driver.httpx, "Client", lambda **kwargs: Client())
    handle = neo4j_driver.Neo4jHandle()
    with pytest.raises(RuntimeError, match="neo4j driver not initialised"):
        handle.session()

    seen = {}

    class FakeHttpSession:
        def __init__(self, client, **kwargs):
            seen["kwargs"] = kwargs

    monkeypatch.setattr(neo4j_driver, "_HttpSession", FakeHttpSession)
    handle.set_password("secret")
    handle.session()
    assert seen["kwargs"]["auth"] == ("neo4j", "secret")


def test_handle_singleton_is_stable(monkeypatch) -> None:
    monkeypatch.setattr(neo4j_driver, "_handle", None)
    assert neo4j_driver.handle() is neo4j_driver.handle()


def test_ensure_schema_is_a_no_op_for_the_local_backend(monkeypatch) -> None:
    driver = Driver()
    driver.kind = "local"
    monkeypatch.setattr(constraints, "handle", lambda: driver)
    constraints.ensure_schema()
    assert driver.sessions == []


def test_ensure_schema_skips_an_unreachable_server(monkeypatch) -> None:
    driver = Driver(reachable=False)
    monkeypatch.setattr(constraints, "handle", lambda: driver)
    constraints.ensure_schema()
    assert driver.sessions == []


def test_ensure_schema_migrates_drops_legacy_constraints_and_bootstraps(monkeypatch) -> None:
    driver = Driver(names=["legacy_name"])
    monkeypatch.setattr(constraints, "handle", lambda: driver)
    constraints.ensure_schema()

    assert len(driver.sessions) == 4 + len(constraints._SCHEMA)
    migration, paper, artifact, webpage, *schema = driver.sessions
    assert "MATCH (n:SubTask {task_type: 'subagent'})" in migration.calls[0][0]
    assert "MATCH (n:SubTask)" in migration.calls[1][0]
    for session, label in ((paper, "Paper"), (artifact, "Artifact"), (webpage, "WebPage")):
        assert session.calls[0][1]["label"] == label
        assert session.calls[1][0] == "DROP CONSTRAINT `legacy_name`"
    assert [call[0] for call in schema[0].calls] == [constraints._SCHEMA[0]]


def test_ensure_schema_keeps_going_when_a_statement_fails(monkeypatch) -> None:
    driver = Driver(fail=("CREATE CONSTRAINT",))
    monkeypatch.setattr(constraints, "handle", lambda: driver)
    constraints.ensure_schema()
    assert len(driver.sessions) == 4 + len(constraints._SCHEMA), "every statement still runs"


def test_legacy_migration_swallows_a_write_failure() -> None:
    class Broken(Session):
        def run(self, statement, **params):
            raise RuntimeError("no write access")

    constraints._migrate_legacy_subtask_label(Broken())


def test_legacy_drop_helpers_report_how_many_they_dropped() -> None:
    session = Session(names=["a", "b"])
    assert constraints._drop_legacy_paper_link_constraint(session) == 2
    assert constraints._drop_legacy_artifact_id_constraint(session) == 2
    assert constraints._drop_legacy_webpage_identifier_constraint(session) == 2
    assert [call[0] for call in session.calls if call[0].startswith("DROP")] == [
        "DROP CONSTRAINT `a`", "DROP CONSTRAINT `b`",
    ] * 3
