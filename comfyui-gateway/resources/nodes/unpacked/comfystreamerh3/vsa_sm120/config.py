"""Process-wide VSA backend and Track B knobs. Default is Kitchen 0.2.34."""
from __future__ import annotations

from dataclasses import asdict, dataclass

BACKENDS = ("kitchen", "local_sm120", "native")
ATTENTION_OPTIONS = ("vsa", "vc", "anemoi", "combined", "cute_sol")
MASK_REUSE = ("off", "layers", "steps")
KV_QUANT = ("bf16", "int8", "fp8")
BLOCK_SIZES = (64, 128)

# B1 starts with token augmentation disabled; promotion requires GPU evidence.
PRODUCT_KITCHEN_PIN = "0.2.34"


@dataclass(frozen=True)
class VsaOptions:
    backend: str = "kitchen"
    attention_option: str = "vsa"
    topk_ratio: float = 0.10
    block_size: int = 64
    mask_reuse: str = "off"
    kv_quant: str = "bf16"
    token_aug: int = 0
    allow_compose: bool = False

    @property
    def quality_class(self) -> str:
        if self.attention_option != "vsa":
            return "experimental-reference"
        if self.token_aug != 0:
            return "experimental-token-augmentation"
        if self.kv_quant != "bf16":
            return "unsafe-requant"
        if self.mask_reuse != "off" or self.block_size != 64 or abs(self.topk_ratio - 0.10) > 1e-12:
            return "unsafe-workload"
        return "safe"

    @property
    def same_math(self) -> bool:
        return (
            self.attention_option == "vsa"
            and self.token_aug == 0
            and self.backend in ("kitchen", "local_sm120")
            and abs(self.topk_ratio - 0.10) <= 1e-12
            and self.block_size == 64
            and self.mask_reuse == "off"
            and self.kv_quant == "bf16"
        )


_state = VsaOptions()


def _validate(opts: VsaOptions) -> VsaOptions:
    if opts.backend not in BACKENDS:
        raise ValueError(
            f"unknown VSA backend {opts.backend!r}; VSA fail-closed (no dense fallback). "
            f"known: {BACKENDS}"
        )
    if opts.block_size not in BLOCK_SIZES:
        raise ValueError(f"vsa block_size must be one of {BLOCK_SIZES}")
    if opts.attention_option not in ATTENTION_OPTIONS:
        raise ValueError(
            f"unknown attention option {opts.attention_option!r}; known: {ATTENTION_OPTIONS}"
        )
    if opts.mask_reuse not in MASK_REUSE:
        raise ValueError(f"vsa mask_reuse must be one of {MASK_REUSE}")
    if opts.kv_quant not in KV_QUANT:
        raise ValueError(f"vsa kv_quant must be one of {KV_QUANT}")
    if opts.topk_ratio <= 0 or opts.topk_ratio > 1:
        raise ValueError("vsa topk_ratio must be in (0, 1]")
    if type(opts.token_aug) is not int or opts.token_aug not in (0, 64, 128, 256):
        raise ValueError("token_aug must be one of (0, 64, 128, 256)")
    if opts.token_aug and (opts.backend != "kitchen" or opts.attention_option != "vsa"):
        raise ValueError("token_aug requires stock Kitchen VSA; candidate support is unverified")
    unsafe = sum((
        abs(opts.topk_ratio - 0.10) > 1e-12,
        opts.mask_reuse != "off",
        opts.block_size != 64,
        opts.kv_quant != "bf16",
    ))
    if unsafe > 1 and not opts.allow_compose:
        raise ValueError(
            "Track B VSA arms must not be composed: change only one of "
            "topk_ratio, mask_reuse, block_size, kv_quant"
        )
    return opts


def set_vsa_options(
    *,
    backend: str | None = None,
    attention_option: str | None = None,
    topk_ratio: float | None = None,
    block_size: int | None = None,
    mask_reuse: str | None = None,
    kv_quant: str | None = None,
    token_aug: int | None = None,
    allow_compose: bool | None = None,
) -> dict:
    global _state
    current = _state
    opts = VsaOptions(
        backend=current.backend if backend is None else backend,
        attention_option=(current.attention_option if attention_option is None
                          else attention_option),
        topk_ratio=current.topk_ratio if topk_ratio is None else float(topk_ratio),
        block_size=current.block_size if block_size is None else int(block_size),
        mask_reuse=current.mask_reuse if mask_reuse is None else mask_reuse,
        kv_quant=current.kv_quant if kv_quant is None else kv_quant,
        token_aug=current.token_aug if token_aug is None else token_aug,
        allow_compose=current.allow_compose if allow_compose is None else bool(allow_compose),
    )
    _state = _validate(opts)
    return asdict(_state)


def reset_vsa_options() -> dict:
    global _state
    _state = VsaOptions()
    return asdict(_state)


def vsa_options() -> VsaOptions:
    return _state


def kitchen_version() -> str | None:
    try:
        from importlib.metadata import PackageNotFoundError, version
        return version("comfy-kitchen")
    except (ImportError, PackageNotFoundError):
        return None
