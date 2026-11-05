// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { expect, type Page } from "@playwright/test";

import { test } from "./helpers/e2e.ts";
import { HANG_MODEL_ID, installStubModels, type StubModels } from "./support/stub-models.js";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("session-run-queue-stop.spec", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@status:reviewed", "@model:mock", "@sandbox:bubblewrap"] }, () => {

async function createProject(page: Page, name: string) {
  await page.getByRole("button", { name: "Add project" }).click();
  const dialog = page.getByRole("dialog", { name: "Create Project" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Project name").fill(name);
  await dialog.getByRole("button", { name: "Create Project" }).click();
  await expect(dialog).toBeHidden();
}

/** One click creates the Session; its name is set through the inline rename
 *  editor that the sidebar's double-click opens. */
async function createSession(page: Page, name: string) {
  await page.getByRole("button", { name: "Add session" }).click();
  const activeSession = page.locator("#sessions-panel-content button.nav-item.active").first();
  await expect(activeSession).toBeVisible();
  await activeSession.dblclick();
  const editor = page.locator("input.nav-inline-rename");
  await expect(editor).toBeVisible();
  await editor.fill(name);
  await editor.press("Enter");
  await expect(page.locator("#sessions-panel-content button.nav-item", { hasText: name }).first()).toBeVisible();
}

async function selectHangingModel(page: Page) {
  await page.getByLabel("Model for this task").click();
  const option = page.getByRole("option").filter({ hasText: HANG_MODEL_ID }).first();
  await expect(option).toBeVisible();
  await option.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Choose a model" })).toBeHidden();
}

function runButton(page: Page) {
  return page.getByRole("button", { name: "Run analysis" });
}

let stubs: StubModels | undefined;

test.beforeAll(async ({ request }) => {
  stubs = await installStubModels(request);
});

test.afterAll(async () => {
  await stubs?.dispose();
});

/**
 * E2E-META
 * Purpose: 运行中的会话保持 Stop 可见，同时后续提示可以加入队列。
 * Steps:
 *   1. 创建项目与会话，并在 composer 模型弹窗中选择 hang-model。
 *   2. 输入首个提示并运行，断言 Stop 可见。
 *   3. 输入第二个提示，断言 Add to queue 可用。
 * Environment: 隔离本地栈；本 spec 自行注册 127.0.0.1 上的 hang-model 桩模型。
 * Type: mocked
 * LLM: 本地桩模型，接受流式请求后永不响应；不调用真实或付费模型。
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 浏览器与 API 请求均指向 127.0.0.1。
 * Credentials: 隔离实例的 E2E_API_TOKEN 与桩模型令牌。
 * CostSideEffects: none；桩模型在套件结束时删除。
 */
test("running Session keeps Stop visible while the next prompt can be queued", { tag: "@mocked" }, async ({ page }) => {
  const projectName = `Queue Stop E2E ${Date.now()}`;
  await page.goto("/");
  await createProject(page, projectName);
  await createSession(page, "Queue and stop");
  await selectHangingModel(page);

  await page.locator(".composer textarea").fill("first prompt");
  await runButton(page).click();
  await expect(page.getByRole("button", { name: "Stop the current run" })).toBeVisible();

  await page.locator(".composer textarea").fill("second prompt");
  await expect(page.getByRole("button", { name: "Add to queue" })).toBeEnabled();
});

});
