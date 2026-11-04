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

"""Pure shaping helpers behind the memory-graph read endpoints."""

from __future__ import annotations

import datetime

import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

from sciencediscovery_memory_graph.query import (
    _excerpt,
    _iso,
    _json_safe,
    _node_identity,
    _node_label,
    _to_hit,
    _to_trace_node,
)


class Node:
    def __init__(self, labels=(), **props):
        self.labels = frozenset(labels)
        self.props = props

    def __getitem__(self, key):
        return self.props[key]

    def __iter__(self):
        return iter(self.props.items())

    def get(self, key, default=None):
        return self.props.get(key, default)

    def items(self):
        return self.props.items()


class Temporal:
    def __init__(self, iso=None, iso_raises=False, native_raises=False):
        self._iso = iso
        self._iso_raises = iso_raises
        self._native_raises = native_raises

    def to_iso(self):
        if self._iso_raises:
            raise RuntimeError("not an ISO type")
        return self._iso

    def to_native(self):
        if self._native_raises:
            raise RuntimeError("not a native type")
        return "native"


class NativeOnly:
    def __init__(self, native):
        self._native = native

    def to_native(self):
        return self._native


@pytest.mark.parametrize(("label", "props", "expected"), [
    ("ResearchGoal", {"goal_id": "g1"}, "g1"),
    ("Task", {"task_id": "t1"}, "t1"),
    ("ToolCall", {"task_id": "t1"}, "t1"),
    ("SubTask", {"task_id": "t1"}, "t1"),
    ("Paper", {"link": "https://example.org/p"}, "https://example.org/p"),
    ("Evidence", {"evidence_id": "e1"}, "e1"),
    ("Claim", {"claim_id": "c1"}, "c1"),
    ("Code", {"code_id": "k1"}, "k1"),
    ("SearchRun", {"search_id": "s1"}, "s1"),
    ("SourceFile", {"file_id": "f1"}, "f1"),
    ("DbRecord", {"identifier": "d1"}, "d1"),
    ("Mystery", {"id": "x"}, None),
])
def test_node_identity_reads_the_key_of_each_readable_label(label, props, expected) -> None:
    assert _node_identity(label, props) == expected


def test_node_identity_encodes_the_composite_keys() -> None:
    assert _node_identity("SearchNode", {"search_id": "s1", "node_index": 3}) == "s1#n3"
    assert _node_identity("SearchNode", {"search_id": "s1"}) is None
    assert _node_identity("SearchCell", {
        "search_id": "s1", "island": 1, "complexity_bin": 2, "diversity_bin": 0,
    }) == "s1#c1.2.0"
    assert _node_identity("SearchCell", {"search_id": "s1", "island": 1}) is None
    assert _node_identity("Artifact", {"artifact_id": "a1", "version": 3}) == "a1#v3"
    assert _node_identity("Artifact", {"artifact_id": "a1"}) == "a1"


def test_node_identity_falls_back_to_the_web_page_url() -> None:
    assert _node_identity("WebPage", {"identifier": "wiki/page"}) == "wiki/page"
    assert _node_identity("WebPage", {"url": "https://example.org"}) == "url:https://example.org"
    assert _node_identity("WebPage", {"identifier": ""}) == ""
    assert _node_identity("WebPage", {"identifier": None}) is None
    assert _node_identity("WebPage", {}) is None


def test_node_identity_accepts_any_pair_sequence() -> None:
    assert _node_identity("Task", [("task_id", "t9")]) == "t9"


def test_excerpt_prefers_the_label_field_and_trims_to_the_limit() -> None:
    assert _excerpt({"title": "A paper", "identifier": "p1"}, "Paper") == "A paper"
    assert _excerpt({"identifier": "p1"}, "Paper") == "p1"
    assert _excerpt({"title": "x" * 500}, "Paper") == "x" * 240
    assert _excerpt({"content": "", "locator": "p. 3"}, "Evidence") == "p. 3"
    assert _excerpt({"id": "node-1"}, "Unknown") == "node-1"
    assert _excerpt({}, "Unknown") == "Unknown"


def test_iso_uses_the_neo4j_projection_and_falls_back_to_str() -> None:
    assert _iso(None) is None
    assert _iso(Temporal(iso="2026-01-01T00:00:00Z")) == "2026-01-01T00:00:00Z"
    broken = Temporal(iso="ignored", iso_raises=True)
    assert _iso(broken) == str(broken)
    assert _iso("plain") == "plain"


def test_json_safe_walks_containers_and_converts_temporal_types() -> None:
    moment = datetime.datetime(2026, 1, 2, 3, 4, 5)
    payload = {
        "at": moment,
        "day": datetime.date(2026, 1, 2),
        "clock": datetime.time(3, 4, 5),
        "nested": {"values": [Temporal(iso="2026-01-01T00:00:00Z"), 1]},
        "tuple": (NativeOnly(datetime.date(2026, 2, 3)),),
        "plain": "text",
    }
    assert _json_safe(payload) == {
        "at": "2026-01-02T03:04:05",
        "day": "2026-01-02",
        "clock": "03:04:05",
        "nested": {"values": ["2026-01-01T00:00:00Z", 1]},
        "tuple": ["2026-02-03"],
        "plain": "text",
    }


def test_json_safe_keeps_values_it_cannot_convert() -> None:
    unconvertible = Temporal(iso_raises=True, native_raises=True)
    assert _json_safe(unconvertible) is unconvertible
    assert _json_safe({"bad": unconvertible})["bad"] is unconvertible


def test_node_label_reads_the_first_label() -> None:
    assert _node_label(Node(["Paper"])) == "Paper"
    assert _node_label(Node([])) is None
    assert _node_label(object()) is None


def test_to_hit_shapes_a_known_node_and_drops_an_unknown_label() -> None:
    node = Node(["Paper"], session_id="s1", link="https://example.org", title="A paper",
                created_at=Temporal(iso="2026-01-01T00:00:00Z"))
    hit = _to_hit(node, "Paper")
    assert hit == {
        "label": "Paper",
        "id": "https://example.org",
        "session_id": "s1",
        "session_title": None,
        "excerpt": "A paper",
        "extra": {"link": "https://example.org", "title": "A paper"},
        "created_at": "2026-01-01T00:00:00Z",
    }
    assert _to_hit(Node(["Mystery"]), "Mystery") is None


def test_to_trace_node_carries_the_content_hash_of_hash_bearing_labels() -> None:
    artifact = Node(["Artifact"], artifact_id="a1", version=2, content_hash="sha256:abc")
    assert _to_trace_node(artifact) == {
        "label": "Artifact", "id": "a1#v2", "excerpt": "a1", "content_hash": "sha256:abc",
    }
    code = Node(["Code"], code_id="k1", code_hash="sha256:def")
    assert _to_trace_node(code, "Code")["content_hash"] == "sha256:def"
    paper = Node(["Paper"], link="https://example.org", title="A paper", content_hash="ignored")
    assert _to_trace_node(paper) == {
        "label": "Paper", "id": "https://example.org", "excerpt": "A paper",
    }


def test_to_trace_node_drops_nodes_it_cannot_identify() -> None:
    assert _to_trace_node(object()) is None
    assert _to_trace_node(Node(["Mystery"])) is None
    assert _to_trace_node(Node(["Paper"]), "Paper") is None
