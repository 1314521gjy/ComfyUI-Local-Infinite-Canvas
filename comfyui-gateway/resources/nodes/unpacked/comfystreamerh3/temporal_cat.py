"""C5: opt-in lower-precision tiled-decode canvas. Default off.

Not a latency win. It cuts peak VRAM of the spatial canvas. Env
``MINIMAX_H3_VAE_DECODER_TEMPORAL_CAT_DTYPE`` (fp16/bf16/float16/bfloat16)
matches the vLLM-omni name so a worker can enable it without a widget.
"""
from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager

_STATE_ATTR = "_fasth3_temporal_cat_dtype"

_DTYPES = {
    "fp16": "float16",
    "float16": "float16",
    "bf16": "bfloat16",
    "bfloat16": "bfloat16",
}


def resolve_temporal_cat_dtype(name: str | None) -> str | None:
    if not name:
        env = os.environ.get("MINIMAX_H3_VAE_DECODER_TEMPORAL_CAT_DTYPE", "").strip()
        name = env or None
    if not name or str(name).lower() in ("", "default", "fp32", "float32", "off"):
        return None
    key = str(name).lower()
    if key not in _DTYPES:
        raise ValueError(f"temporal_cat_dtype must be fp16/bf16/off, got {name!r}")
    return _DTYPES[key]


def apply_temporal_cat_dtype(vae, dtype_name: str | None) -> str | None:
    restore_temporal_cat_dtype(vae)
    resolved = resolve_temporal_cat_dtype(dtype_name)
    if resolved is None:
        return None
    setattr(vae, _STATE_ATTR, resolved)
    return resolved


def restore_temporal_cat_dtype(vae) -> bool:
    if not hasattr(vae, _STATE_ATTR):
        return False
    delattr(vae, _STATE_ATTR)
    return True


def canvas_dtype_name(vae) -> str | None:
    return getattr(vae, _STATE_ATTR, None)


@contextmanager
def temporal_cat_dtype(vae, dtype_name: str | None = None) -> Iterator[str | None]:
    applied = apply_temporal_cat_dtype(vae, dtype_name)
    try:
        yield applied
    finally:
        restore_temporal_cat_dtype(vae)
