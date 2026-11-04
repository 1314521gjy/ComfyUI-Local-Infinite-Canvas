"""Opt-in metadata caches, retained only for one native H3 decode."""
from contextlib import contextmanager, nullcontext
from typing import Any

import torch

try:
    from .nvtx import nvtx_range
except ImportError:
    def nvtx_range(_name: str):  # type: ignore[misc]
        return nullcontext()


@contextmanager
def decoder_metadata_cache(vae, skip_contiguous: bool = False):
    decoder = vae.decoder
    if type(decoder).__name__ != "ViT3DDecoder" or type(decoder).__module__ != "comfy.ldm.minimax.vae":
        raise ValueError("metadata cache requires native H3 ViT3DDecoder")
    if torch.is_grad_enabled():
        raise ValueError("metadata cache is inference-only")
    if getattr(decoder, "_fasth3_metadata_cache_active", False):
        raise ValueError("nested metadata cache is unsupported")
    position = decoder.pos_embed
    if type(position).__name__ != "RotaryEmbeddingND" or type(position).__module__ != "comfy.ldm.minimax.vae":
        raise ValueError("metadata cache requires native H3 RotaryEmbeddingND")
    # Reject instance overrides rather than guessing their positional semantics.
    if "forward" in decoder.__dict__ or "forward" in position.__dict__ or "blend" in vae.__dict__:
        raise ValueError("metadata cache conflicts with existing instance overrides")
    original_forward, original_position = decoder.forward, position.forward
    tables: dict[Any, Any] = {}
    weights: dict[Any, Any] = {}
    token_ids: dict[Any, Any] = {}
    suffix_h: dict[Any, Any] = {}
    suffix_ids: dict[Any, Any] = {}
    active_shape = None
    report = {
        "rope_hits": 0, "rope_misses": 0, "blend_hits": 0, "blend_misses": 0,
        "token_hits": 0, "token_misses": 0, "suffix_hits": 0, "suffix_misses": 0,
        "restored": False,
    }
    forward_fn = getattr(original_forward, "__func__", original_forward)
    globals_map = getattr(forward_fn, "__globals__", None)
    original_create_token_ids = (
        globals_map.get("create_token_ids") if isinstance(globals_map, dict) else None)

    def cached_create_token_ids(patch_dims, device, dtype):
        key = (tuple(int(d) for d in patch_dims), device, dtype)
        hit = token_ids.get(key)
        if hit is not None:
            report["token_hits"] += 1
            return hit
        report["token_misses"] += 1
        assert callable(original_create_token_ids)
        table = original_create_token_ids(patch_dims, device, dtype)
        size = table.numel() * table.element_size()
        if size <= 64 * 1024 * 1024:
            while token_ids and (len(token_ids) >= 4 or
                    sum(t.numel() * t.element_size() for t in token_ids.values()) + size > 64 * 1024 * 1024):
                del token_ids[next(iter(token_ids))]
            token_ids[key] = table
        return table

    def cached_position(ids):
        # Native decoder builds deterministic local coordinates from this shape;
        # never generalize this key to arbitrary caller-supplied position IDs.
        if active_shape is None:
            return original_position(ids)
        key = (active_shape, tuple(ids.shape), ids.device, ids.dtype,
               id(position.inv_freq), position.angle_scale)
        if key in tables:
            report["rope_hits"] += 1
            return tables[key]
        report["rope_misses"] += 1
        table = original_position(ids)
        size = table.numel() * table.element_size()
        # Bound retention even for unusually large or variable-shape inputs.
        if size <= 64 * 1024 * 1024:
            while tables and (len(tables) >= 4 or
                    sum(t.numel() * t.element_size() for t in tables.values()) + size > 64 * 1024 * 1024):
                del tables[next(iter(tables))]
            tables[key] = table
        return table

    def _suffix_h(h):
        key = (h.shape[0], h.dtype, h.device)
        cached = suffix_h.get(key)
        if cached is not None:
            report["suffix_hits"] += 1
            return cached
        report["suffix_misses"] += 1
        import comfy.ops
        register = comfy.ops.cast_to_input(decoder.register_tokens, h).expand(h.shape[0], -1, -1)
        zeros = h.new_zeros(h.shape[0], 1, h.shape[-1])
        cached = torch.cat([register, zeros], dim=1)
        suffix_h[key] = cached
        return cached

    def _suffix_ids(batch, device, dtype):
        key = (batch, device, dtype)
        cached = suffix_ids.get(key)
        if cached is not None:
            return cached
        num_suffix = 1 + decoder.num_register_tokens
        cached = torch.zeros((batch, num_suffix, 3), device=device, dtype=dtype)
        suffix_ids[key] = cached
        return cached

    def _cached_vit3d(x):
        try:
            from .decoder_layout import fold_vit3d_output
        except ImportError:
            from decoder_layout import fold_vit3d_output  # type: ignore[import-not-found, no-redef]
        B, _C, latent_T, latent_H, latent_W = x.shape
        with nvtx_range("decode_embed"):
            h = decoder.x_embedder(x.flatten(2).transpose(1, 2))
            num_patches = h.shape[1]
            h = torch.cat([h, _suffix_h(h)], dim=1)
            if original_create_token_ids is not None:
                img_ids = cached_create_token_ids(
                    (latent_T, latent_H, latent_W), x.device, x.dtype).expand(B, -1, -1)
            else:
                img_ids = original_forward.__func__.__globals__["create_token_ids"](
                    (latent_T, latent_H, latent_W), x.device, x.dtype).expand(B, -1, -1)
            img_ids = torch.cat([img_ids, _suffix_ids(B, x.device, img_ids.dtype)], dim=1)
            rotary_pos_emb = position(img_ids)
        with nvtx_range("decode_attn"):
            for block in decoder.transformer_blocks:
                h = block(h, rotary_pos_emb)
            output = decoder.proj_out(decoder.norm_out(h))
            output = output[:, :num_patches, :]
            output = output.view(
                B, latent_T, latent_H, latent_W,
                decoder.out_channels, decoder.patch_size_t, decoder.patch_size, decoder.patch_size,
            )
        with nvtx_range("decode_fold"):
            return fold_vit3d_output(output, decoder, skip_contiguous=skip_contiguous)

    def forward(x):
        nonlocal active_shape
        previous = active_shape
        active_shape = tuple(x.shape)
        try:
            if (hasattr(decoder, "register_tokens") and hasattr(decoder, "x_embedder")
                    and hasattr(decoder, "transformer_blocks") and hasattr(decoder, "proj_out")):
                return _cached_vit3d(x)
            with nvtx_range("decode_attn"):
                return original_forward(x)
        finally:
            active_shape = previous

    def blend(a, b, blend_extent, dim):
        extent = min(a.shape[dim], b.shape[dim], blend_extent)
        key = (extent, b.device, b.dtype)
        if key not in weights:
            report["blend_misses"] += 1
            positions = torch.arange(extent, device=b.device, dtype=b.dtype)
            pair = (1 - positions / extent, positions / extent)
            if len(weights) >= 16:
                del weights[next(iter(weights))]
            weights[key] = pair
        else:
            report["blend_hits"] += 1
        wa, wb = weights[key]
        shape = [1] * a.ndim
        shape[dim] = extent
        sa, sb = [slice(None)] * a.ndim, [slice(None)] * b.ndim
        sa[dim], sb[dim] = slice(-extent, None), slice(0, extent)
        with nvtx_range("decode_blend"):
            # tiled_decode/decode_temporal clone overlap tails before blend, then
            # only consume the return value. Writing the seam into `b` avoids a
            # full-tile torch.cat and is value-identical to cat(blended, rest).
            b_s = b[tuple(sb)]
            b_s.copy_(a[tuple(sa)] * wa.view(shape) + b_s * wb.view(shape))
            return b

    decoder._fasth3_metadata_cache_active = True
    try:
        if original_create_token_ids is not None and isinstance(globals_map, dict):
            globals_map["create_token_ids"] = cached_create_token_ids
        decoder.forward, position.forward, vae.blend = forward, cached_position, blend
        yield report
    finally:
        if original_create_token_ids is not None and isinstance(globals_map, dict):
            globals_map["create_token_ids"] = original_create_token_ids
        # Restore class descriptors, not new bound-method instance attributes.
        for obj, name in ((decoder, "forward"), (position, "forward"), (vae, "blend")):
            obj.__dict__.pop(name, None)
        del decoder._fasth3_metadata_cache_active
        tables.clear()
        weights.clear()
        token_ids.clear()
        suffix_h.clear()
        suffix_ids.clear()
        report["restored"] = True
