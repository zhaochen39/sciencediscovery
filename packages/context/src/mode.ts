// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

export type ContextAssemblyMode = "dynamic" | "dynamic-shadow" | "legacy" | "shadow" | "projection";

export function resolveContextAssemblyMode(
  env: NodeJS.ProcessEnv = process.env,
): ContextAssemblyMode {
  const value = env.SCIENCE_AGENT_CONTEXT_MODE?.trim().toLowerCase() || "dynamic";
  if (value === "dynamic-shadow" || value === "dynamic" || value === "legacy" || value === "shadow" || value === "projection") return value;
  throw new Error("SCIENCE_AGENT_CONTEXT_MODE must be dynamic, dynamic-shadow, legacy, shadow, or projection");
}
