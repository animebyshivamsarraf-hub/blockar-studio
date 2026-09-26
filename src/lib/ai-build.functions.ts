import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const COLORS = ["#2f8cff", "#3ee8ff", "#c04dff", "#ff4fb8", "#ff8a2b", "#b8c2cc", "#4dd66b", "#8a5a2b", "#ffffff", "#222831", "#ffd43b", "#e03131"];

export const aiBuild = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ prompt: z.string().min(1).max(300) }).parse(d))
  .handler(async ({ data }) => {
    const key = process.env["LOVABLE_API_KEY"];
    if (!key) throw new Error("AI is not configured");
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          {
            role: "system",
            content: `You design voxel (Minecraft-style) models. Grid: x and z from -10 to 10, y from 0 (ground) to 20 (up). Every block must be supported (connected down to y=0). Use 20-300 blocks, recognizable shape, solid walls. Allowed colors: ${COLORS.join(", ")}. Shapes: cube (default), sphere, cylinder, pyramid (good for roofs/tips). Call the build tool.`,
          },
          { role: "user", content: data.prompt },
        ],
        tools: [{
          type: "function",
          function: {
            name: "build",
            description: "Place voxel blocks",
            parameters: {
              type: "object",
              properties: {
                blocks: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      x: { type: "integer" }, y: { type: "integer" }, z: { type: "integer" },
                      color: { type: "string", enum: COLORS },
                      shape: { type: "string", enum: ["cube", "sphere", "cylinder", "pyramid"] },
                    },
                    required: ["x", "y", "z", "color"],
                  },
                },
              },
              required: ["blocks"],
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "build" } },
      }),
    });
    if (res.status === 429) throw new Error("Too many requests — wait a moment and try again.");
    if (res.status === 402) throw new Error("AI credits are used up for this workspace.");
    if (!res.ok) throw new Error("AI build failed");
    const json = await res.json();
    const args = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    const parsed = JSON.parse(args ?? "{}") as { blocks?: { x: number; y: number; z: number; color: string; shape?: string }[] };
    const shapes = ["cube", "sphere", "cylinder", "pyramid"];
    return (parsed.blocks ?? []).slice(0, 600).map((b) => ({
      x: Math.max(-12, Math.min(12, Math.round(b.x))),
      y: Math.max(0, Math.min(24, Math.round(b.y))),
      z: Math.max(-12, Math.min(12, Math.round(b.z))),
      color: COLORS.includes(b.color) ? b.color : COLORS[0]!,
      shape: (shapes.includes(b.shape ?? "") ? b.shape : "cube") as "cube" | "sphere" | "cylinder" | "pyramid",
    }));
  });
