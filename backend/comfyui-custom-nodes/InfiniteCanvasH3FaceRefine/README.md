# Infinite Canvas H3 Post-Generation Refine

This package provides two confirmation-phase nodes. `MiniMaxH3PostGenerationFullFrameRefine` resamples the decoded first-pass video in H3's joint AV latent at the requested resolution, then reuses the original audio. `InfiniteCanvasH3FaceRefine` tracks a face, resamples its crops, and stitches them back; each original image reference stays a separate input. Both use ComfyUI's native MiniMax H3 conditioning and sampling nodes. AIMixer Director is not required.

Copy this folder into `ComfyUI/custom_nodes/InfiniteCanvasH3FaceRefine/`, then restart ComfyUI. Full-frame refinement only needs the dependencies already used by ComfyUI and H3. Face-only refinement additionally needs `ultralytics` and the selected detector (default `face_yolov8m.pt`) under `ComfyUI/models/ultralytics/bbox/`. A missing face-only node must not silently fall back to a whole-video rerender.

The tracker follows the largest detected face and maintains temporal continuity with the nearest face in each frame. The Clip's original image references condition the crop resampling pass.
