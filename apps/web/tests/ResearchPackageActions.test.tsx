// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { ApiClient } from "../src/api.js";
import { LocaleProvider } from "../src/i18n/index.js";
import { ResearchPackageDialogs } from "../src/research-package/ResearchPackageActions.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function button(renderer: ReactTestRenderer, name: string): ReactTestInstance {
  return renderer.root.find((item) => item.type === "button" && (item.children.join("") === name || item.findAllByType("strong").some((child) => child.children.join("") === name)));
}

test("evidence export choices update the estimate and custom workspace selection", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Document;
  const previews: Array<{ level: string; paths?: string[] }> = [];
  const client = {
    previewResearchPackage: async (_projectId: string, _sessionId: string, level: string, paths?: string[]) => {
      previews.push({ level, paths });
      return { estimatedBytes: level === "complete" ? 2048 : 1024, files: [{ path: "data/result.csv", size: 20 }, { path: "analysis.ipynb", size: 40 }], omissions: [] };
    },
    exportResearchPackage: async () => new Blob(),
  } as unknown as ApiClient;
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(ResearchPackageDialogs, {
        client,
        onClose: () => undefined,
        target: { projectId: "project-a", sessionId: "session-a", kind: "package" },
      })));
    });
    assert.ok(renderer!.root.findByProps({ role: "dialog" }));
    assert.ok(renderer!.root.findAllByType("strong").some((node) => node.children.join("").includes("预计 1.0 KiB")));
    await act(async () => { button(renderer!, "完整导出").props.onClick(); });
    await act(async () => { await Promise.resolve(); });
    assert.ok(previews.some((item) => item.level === "complete"));
    const checkboxes = renderer!.root.findAll((item) => item.type === "input" && item.props.type === "checkbox");
    await act(async () => { checkboxes[0]!.props.onChange({ target: { checked: false } }); });
    await act(async () => { await Promise.resolve(); });
    assert.ok(previews.some((item) => item.paths?.length === 1 && item.paths[0] === "analysis.ipynb"));
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    globalThis.document = previousDocument;
  }
});
