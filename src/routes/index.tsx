import { createFileRoute } from "@tanstack/react-router";
import { BlockAR } from "@/components/blockar/BlockAR";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "BlockAR — 3D Voxel Builder in AR" },
      { name: "description", content: "Build 3D voxel structures on real-world surfaces with your phone camera. Tap, drag and snap 10 cm blocks." },
      { property: "og:title", content: "BlockAR — 3D Voxel Builder in AR" },
      { property: "og:description", content: "Build 3D voxel structures on real-world surfaces with your phone camera." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: BlockAR,
});
