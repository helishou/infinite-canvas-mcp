# Infinite Canvas H3 Face Refine

This Infinite Canvas-owned ComfyUI node takes decoded first-pass frames and each of the Clip's original image references as separate inputs, preserving their order and aspect ratios. Face tracking, crop-latent injection, and face-only stitching are bundled in this package. Crop resampling uses ComfyUI's native MiniMax H3 reference-conditioning and sampling nodes; AIMixer Director is not required.

Copy this folder into `ComfyUI/custom_nodes/InfiniteCanvasH3FaceRefine/`, then restart ComfyUI. Install `ultralytics` and place the selected face detector (default `face_yolov8m.pt`) under `ComfyUI/models/ultralytics/bbox/`. The app's ComfyUI graph uses this node for face-only confirmation; when the node is missing, it must not silently fall back to a whole-video rerender.

The tracker follows the largest detected face and maintains temporal continuity with the nearest face in each frame. The Clip's original image references condition the crop resampling pass.
