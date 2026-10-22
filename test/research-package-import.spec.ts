// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { expect } from "@playwright/test";
import { createResearchPackage, sha256 } from "../packages/research-package/src/index.ts";
import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession, type JourneyFixture } from "./helpers/journeys.ts";

/**
 * E2E-META
 * Purpose: Import a complete research package from a Session menu and see its history and workspace file in the product.
 * Steps:
 * 1. Create a Project and Session.
 * 2. Open the Session export menu and import a complete .sdresearch package.
 * 3. Confirm the imported Prompt appears in the conversation and the file is available to the Session.
 * Environment: Isolated local API, Runner and web stack.
 * Type: mocked
 * LLM: none; package fixture contains a historical transcript and workspace file.
 * WebSearch: none.
 * PaperSources: none.
 * MCP: none.
 * OtherExternal: none.
 * Credentials: E2E_API_TOKEN for the isolated stack only.
 * CostSideEffects: Temporary Project and Session are removed; no paid calls.
 */
test("complete research package import restores a visible Session history", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@arch:arm64", "@mocked"] }, async ({ page, journey }) => {
  await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "en-US"));
  let fixture: JourneyFixture | undefined;
  const fileBytes = Buffer.from("value\n42\n");
  const date = "2026-10-20T10:00:00.000Z";
  const packageBytes = createResearchPackage({ source: { projectId: "fixture-project", title: "Complete import fixture", sessionIds: ["fixture-session"] }, records: {
    sessions: [{ session: { id: "fixture-session", title: "Imported history" }, messages: [
      { id: "fixture-prompt", role: "user", content: "Imported evidence prompt visible in history", createdAt: date },
      { id: "fixture-answer", role: "assistant", content: "Imported evidence result visible in history", createdAt: date },
    ], workspace: [{ path: "results/verified.csv", objectPath: sha256(fileBytes), size: fileBytes.length, modifiedAt: date }] }],
  }, objects: [{ path: sha256(fileBytes), bytes: fileBytes }] }).bytes;
  journey.scenario({ goal: "Restore research history and files by importing a complete evidence package.", preconditions: ["Isolated product stack", "Local package fixture only"] });
  try {
    await journey.step("Create a Project and Session", "The target Session is ready to receive the package.", async () => {
      fixture = await createProjectAndSession(page, { projectName: `Package import ${Date.now()}`, sessionTitle: "Package target" });
      await openProjectSession(page, fixture);
    });
    await journey.step("Import from the Session export menu", "The package import action is available beneath the Session menu's Export item.", async () => {
      await page.getByRole("button", { name: /More actions for Package target/ }).click();
      await page.getByRole("menuitem", { name: "导出", exact: true }).click();
      await page.getByRole("menuitem", { name: "导出证据包", exact: true }).click();
      const chooser = page.locator(".research-export-dialog input[type=file]");
      await chooser.setInputFiles({ name: "complete.sdresearch", mimeType: "application/octet-stream", buffer: Buffer.from(packageBytes) });
      await expect(page.getByRole("status")).toContainText("1 个会话");
      await page.getByRole("button", { name: "关闭", exact: true }).click();
    });
    await journey.step("Verify restored history and file", "The imported transcript is visible and its workspace object is readable from the target Session.", async () => {
      await expect(page.getByText("Imported evidence prompt visible in history")).toBeVisible();
      const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${encodeURIComponent(fixture!.session.id)}/file?path=results%2Fverified.csv`, { headers: authorizationHeader() });
      expect(response.ok()).toBeTruthy();
      expect(await response.text()).toBe("value\n42\n");
    });
  } finally {
    if (fixture) await cleanupJourney(page, fixture);
  }
});
