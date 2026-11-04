# Quick start

With ComfyUI running and the node pack, models, and `ComfyUI-ClipProj`
extension installed ([setup](README.md#runtime-and-models)), launch the prompt
page from this repository:

```bash
python3 examples/basic_demo.py
```

Open `http://127.0.0.1:8765` and submit a prompt. Press `Ctrl+C` to stop the
server. Add `--platform` to use a ready Comfy Developer Platform deployment.

## Submit one MP4 through the ComfyUI API

```bash
curl -X POST http://127.0.0.1:8188/prompt \
  -H 'Content-Type: application/json' \
  --data-binary @examples/basic_text_to_video_api.json
```

The response includes a `prompt_id`; ComfyUI saves the clip under
`output/comfystreamerh3/quickstart/`.
