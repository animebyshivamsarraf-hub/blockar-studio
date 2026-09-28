<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Hand control V1 lives in src/components/blockar/hand/HandSystemRuntime.ts (one render loop drives WebXR/MediaPipe/demo sampling -> 21-joint skeleton -> PinchStateMachine -> GrabController3D); tested at /hand-lab. Why: single unified pipeline keeps hand logic independent of the builder engine.
