import { createFileRoute } from "@tanstack/react-router";
import { HandLab } from "@/components/blockar/hand/HandLab";

export const Route = createFileRoute("/hand-lab")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Hand Lab — BlockAR Hand Control" },
      { name: "description", content: "Test BlockAR hand tracking: 3D hand skeleton, pinch detection and grabbing a cube with your real hand." },
      { property: "og:title", content: "Hand Lab — BlockAR Hand Control" },
      { property: "og:description", content: "Pinch, grab and move a 3D cube with your real hand in AR." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: HandLab,
});
