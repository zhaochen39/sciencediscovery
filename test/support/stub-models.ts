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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { APIRequestContext } from "@playwright/test";

import { apiBaseUrl, authorizationHeader } from "../e2e-auth.js";

/**
 * Stub models the Stop/queue/buffering specs need from the stack.
 *
 * Both are plain OpenAI-compatible endpoints registered through `/api/models`,
 * so a Session that selects one never reaches a real provider:
 *
 * - `hang-model` accepts the streaming request and then answers nothing. The
 *   run stays at the model boundary, which is exactly the "stuck" state the
 *   Stop button exists for.
 * - `slow-model` streams one reasoning fragment and a fixed series of content
 *   fragments, then holds the connection silently. The silence is the point:
 *   a fragment the client dropped cannot be replayed later, so a buffered
 *   background timeline is distinguishable from one that was never cleared.
 */

export const HANG_MODEL_NAME = "Issue44 Hanging Model";
export const HANG_MODEL_ID = "hang-model";
export const SLOW_MODEL_NAME = "Issue44 Slow Model";
export const SLOW_MODEL_ID = "slow-model";

/** The last content fragment the slow stub emits before going silent. */
export const SLOW_LAST_CONTENT_STEP = 6;
/** `Partial finding <step>.` — the visible progress the slow stub streams. */
export const slowFragment = (step: number): string => `Partial finding ${step}.`;

/** Time after the first fragment before the rest arrive, so they land while
 *  the user is working in another Session. */
const SLOW_REMAINING_DELAY_MS = 4_000;
const SLOW_FRAGMENT_INTERVAL_MS = 180;
const STUB_API_TOKEN = "e2e-stub-model-token";

export interface StubModels {
  hangModelId: string;
  slowModelId: string;
  dispose: () => Promise<void>;
}

interface StubEndpoint {
  close: () => Promise<void>;
  origin: string;
}

function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ endpoint: StubEndpoint; server: Server }> {
  const server: Server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const close = async () => {
        server.closeAllConnections?.();
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      };
      resolve({ endpoint: { close, origin }, server });
    });
  });
}

function isChatCompletion(request: IncomingMessage): boolean {
  return request.method === "POST" && (request.url ?? "").endsWith("/chat/completions");
}

function readRequest(request: IncomingMessage, onBody: () => void): void {
  request.on("data", () => undefined);
  request.on("end", onBody);
}

/** Accepts the request, then never writes a completion or ends the response. */
async function startHangingEndpoint(): Promise<StubEndpoint> {
  const pending = new Set<ServerResponse>();
  const { endpoint, server } = await listen((request, response) => {
    readRequest(request, () => {
      if (!isChatCompletion(request)) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "stub route not found" }));
        return;
      }
      pending.add(response);
      response.on("close", () => pending.delete(response));
      response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
      response.write(": hanging\n\n");
    });
  });
  return {
    close: async () => {
      for (const response of pending) response.end();
      pending.clear();
      await endpoint.close();
      server.unref();
    },
    origin: endpoint.origin,
  };
}

/** Streams fixed reasoning/content fragments, then stays silent but open. */
async function startSlowEndpoint(): Promise<StubEndpoint> {
  const timers = new Set<NodeJS.Timeout>();
  const open = new Set<ServerResponse>();
  const { endpoint, server } = await listen((request, response) => {
    readRequest(request, () => {
      if (!isChatCompletion(request)) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "stub route not found" }));
        return;
      }
      open.add(response);
      response.on("close", () => open.delete(response));
      response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
      const send = (delta: Record<string, unknown>) => {
        if (response.writableEnded || response.destroyed) return;
        response.write(`data: ${JSON.stringify({
          choices: [{ delta, finish_reason: null, index: 0 }],
          created: 1,
          id: "chatcmpl-issue44-slow",
          model: SLOW_MODEL_ID,
          object: "chat.completion.chunk",
        })}\n\n`);
      };
      send({ reasoning_content: "Considering the data step by step.", role: "assistant" });
      for (let step = 1; step <= SLOW_LAST_CONTENT_STEP; step += 1) {
        const delay = step === 1 ? 0 : SLOW_REMAINING_DELAY_MS + (step - 2) * SLOW_FRAGMENT_INTERVAL_MS;
        const timer = setTimeout(() => {
          timers.delete(timer);
          send({ content: slowFragment(step) });
        }, delay);
        timers.add(timer);
      }
    });
  });
  return {
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const response of open) response.end();
      open.clear();
      await endpoint.close();
      server.unref();
    },
    origin: endpoint.origin,
  };
}

/** A stack can outlive a failed run, and a profile that Sessions still
 *  reference cannot be deleted. Reuse such a profile by pointing it at this
 *  run's endpoint instead of leaving a duplicate behind. */
async function ensureStubModel(
  request: APIRequestContext,
  name: string,
  model: string,
  origin: string,
): Promise<string> {
  const listing = await request.get(`${apiBaseUrl()}/api/models`, { headers: authorizationHeader() });
  if (!listing.ok()) throw new Error(`Listing models failed: ${listing.status()}`);
  const existing = (await listing.json() as Array<{ id: string; model: string }>)
    .filter((candidate) => candidate.model === model);
  const data = { apiToken: STUB_API_TOKEN, baseUrl: `${origin}/v1`, model, name };
  const headers = { ...authorizationHeader(), "content-type": "application/json" };
  const [stale, ...extra] = existing;

  let id: string;
  if (stale) {
    const update = await request.put(`${apiBaseUrl()}/api/models/${encodeURIComponent(stale.id)}`, { data, headers });
    if (!update.ok()) throw new Error(`Pointing stale ${model} at the stub failed: ${update.status()} ${await update.text()}`);
    id = stale.id;
  } else {
    const created = await request.post(`${apiBaseUrl()}/api/models`, { data, headers });
    if (!created.ok()) throw new Error(`Registering ${model} failed: ${created.status()} ${await created.text()}`);
    id = (await created.json() as { id: string }).id;
  }
  for (const profile of extra) {
    // A duplicate is best-effort: if Sessions still reference it, it stays.
    await request.delete(`${apiBaseUrl()}/api/models/${encodeURIComponent(profile.id)}`, { headers: authorizationHeader() })
      .catch(() => undefined);
  }
  return id;
}

export async function installStubModels(request: APIRequestContext): Promise<StubModels> {
  const hang = await startHangingEndpoint();
  const slow = await startSlowEndpoint();

  let hangModelId: string;
  let slowModelId: string;
  try {
    hangModelId = await ensureStubModel(request, HANG_MODEL_NAME, HANG_MODEL_ID, hang.origin);
    slowModelId = await ensureStubModel(request, SLOW_MODEL_NAME, SLOW_MODEL_ID, slow.origin);
  } catch (error) {
    await hang.close();
    await slow.close();
    throw error;
  }

  return {
    dispose: async () => {
      const headers = authorizationHeader();
      await request.delete(`${apiBaseUrl()}/api/models/${encodeURIComponent(hangModelId)}`, { headers }).catch(() => undefined);
      await request.delete(`${apiBaseUrl()}/api/models/${encodeURIComponent(slowModelId)}`, { headers }).catch(() => undefined);
      await hang.close();
      await slow.close();
    },
    hangModelId,
    slowModelId,
  };
}
