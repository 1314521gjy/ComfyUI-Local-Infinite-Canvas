"""Load the pack by path as `comfyui_idol` (its folder name has a dash) with ComfyUI on sys.path, on the CPU.

Run from the pack: pytest tests (ComfyUI is found at COMFYUI_PATH, default ~/AI/ComfyUI)

The preprocessing test needs the reference source in dev/reference_idol (github.com/speridlabs/idol-sdk, with
tensordict and plyfile importable, e.g. from dev/pydeps); the file test needs the converted weights. Both skip
without them.
"""
import importlib.util
import os
import sys

PACK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMFY = os.environ.get("COMFYUI_PATH", os.path.expanduser("~/AI/ComfyUI"))
sys.path.insert(0, COMFY)

import comfy.cli_args  # noqa: E402
comfy.cli_args.args.cpu = True

spec = importlib.util.spec_from_file_location("comfyui_idol", os.path.join(PACK, "__init__.py"), submodule_search_locations=[PACK])
sys.modules["comfyui_idol"] = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sys.modules["comfyui_idol"])
