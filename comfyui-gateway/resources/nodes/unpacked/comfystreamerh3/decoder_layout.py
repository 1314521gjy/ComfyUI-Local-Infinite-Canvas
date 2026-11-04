"""C4: fold ViT3DDecoder permute+contiguous into a single reshape.

Default path keeps ``permute().contiguous().reshape()``. The opt-in
``reshape`` mode drops the explicit contiguous; PyTorch still copies if the
permuted view is not compatible with the destination layout.
"""
from __future__ import annotations


def fold_vit3d_output(output, decoder, *, skip_contiguous: bool = False):
    B = output.shape[0]
    folded = output.permute(0, 4, 1, 5, 2, 6, 3, 7)
    if not skip_contiguous:
        folded = folded.contiguous()
    return folded.reshape(
        B,
        decoder.out_channels,
        output.shape[1] * decoder.patch_size_t,
        output.shape[2] * decoder.patch_size,
        output.shape[3] * decoder.patch_size,
    )
