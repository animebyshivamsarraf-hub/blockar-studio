import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const BASE_URL = "https://api.hyper3d.com/api/v2";

function getKey() {
  const key = process.env["RODIN_API_KEY"];
  if (!key) throw new Error("Rodin is not configured. Add RODIN_API_KEY to the server secrets.");
  return key;
}

async function parseRodinResponse(res: Response) {
  const body = await res.text();
  let json: any = {};
  try { json = JSON.parse(body); } catch { /* handled below */ }
  if (!res.ok) {
    if (res.status === 401) throw new Error("Rodin API key is invalid.");
    if (res.status === 429) throw new Error("Rodin is rate-limiting requests. Please try again shortly.");
    throw new Error(json?.message || `Rodin request failed (HTTP ${res.status}).`);
  }
  if (json?.error) throw new Error(json.message || `Rodin rejected the request: ${json.error}`);
  return json;
}

export const rodinGenerate = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({
    prompt: z.string().trim().min(8).max(1024),
  }).parse(d))
  .handler(async ({ data }) => {
    const form = new FormData();
    form.set("prompt", data.prompt);
    form.set("tier", "Gen-2.5-Medium");
    form.set("mesh_mode", "Raw");
    form.set("quality", "medium");
    form.set("geometry_file_format", "glb");

    const res = await fetch(`${BASE_URL}/rodin`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getKey()}` },
      body: form,
    });
    const json = await parseRodinResponse(res);
    if (!json.uuid || !json.jobs?.subscription_key) {
      throw new Error("Rodin did not return a valid generation task.");
    }
    return {
      taskUuid: json.uuid as string,
      subscriptionKey: json.jobs.subscription_key as string,
      consumed: Number(json.consumed ?? 0),
    };
  });

export const rodinStatus = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({
    subscriptionKey: z.string().min(1),
  }).parse(d))
  .handler(async ({ data }) => {
    const res = await fetch(`${BASE_URL}/status`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ subscription_key: data.subscriptionKey }),
    });
    const json = await parseRodinResponse(res);
    const jobs = Array.isArray(json.jobs) ? json.jobs : [];
    const states = jobs.map((job: any) => String(job.status || "").toLowerCase());
    if (states.includes("failed")) return { status: "failed" as const };
    if (states.length > 0 && states.every((s: string) => s === "done")) return { status: "done" as const };
    return { status: "processing" as const };
  });

export const rodinDownload = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({
    taskUuid: z.string().min(1),
  }).parse(d))
  .handler(async ({ data }) => {
    const res = await fetch(`${BASE_URL}/download`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ task_uuid: data.taskUuid }),
    });
    const json = await parseRodinResponse(res);
    const files = Array.isArray(json.list) ? json.list : [];
    const glb = files.find((f: any) => String(f.name || "").toLowerCase().endsWith(".glb"));
    if (!glb?.url) throw new Error("Rodin finished, but no GLB download was returned.");
    return { url: String(glb.url), name: String(glb.name || "rodin-model.glb") };
  });
