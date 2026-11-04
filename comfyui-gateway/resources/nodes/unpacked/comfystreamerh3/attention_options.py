"""Explicit attention-option contract for the FastH3 deployment.

VSA uses stock Kitchen. Production candidates require their packaged native
extension; CPU/Triton references remain directly callable diagnostic modules.
"""

from __future__ import annotations

from dataclasses import dataclass

DEFAULT_ATTENTION_OPTION = "vsa"
ATTENTION_OPTIONS = ("vsa", "vc", "anemoi", "combined", "cute_sol")


class AttentionOptionError(RuntimeError):
    """Base error for an unavailable or invalid attention option."""


class AttentionOptionUnavailable(AttentionOptionError):
    """Raised when an explicitly requested backend is not installed."""


@dataclass(frozen=True)
class AttentionOption:
    """A stable workflow-facing name and its current implementation status."""

    name: str
    ready: bool
    description: str


_OPTIONS = {
    "vsa": AttentionOption(
        "vsa", True, "FastH3 VSA sparse attention through Kitchen Sol-Attn"
    ),
    "vc": AttentionOption(
        "vc", True, "Native Kitchen-derived VC residual attention"
    ),
    "anemoi": AttentionOption(
        "anemoi", True, "Native Anemoi arithmetic with preserved Kitchen routes"
    ),
    "combined": AttentionOption(
        "combined", True, "Native Anemoi arithmetic with VC residual restoration"
    ),
    "cute_sol": AttentionOption(
        "cute_sol", True,
        "Optional NVIDIA CuTe Sol-Attn kernel for an experimental H3 route",
    ),
}


def resolve_attention_option(value: str | None) -> AttentionOption:
    """Resolve an omitted or explicit workflow option without guessing."""
    name = DEFAULT_ATTENTION_OPTION if value is None else value
    if not isinstance(name, str) or name not in _OPTIONS:
        choices = ", ".join(ATTENTION_OPTIONS)
        raise ValueError(f"attention option must be one of {choices}")
    return _OPTIONS[name]


def require_attention_option(value: str | None, *, native: bool = False) -> AttentionOption:
    """Return a ready option or fail before model/GPU work starts."""
    option = resolve_attention_option(value)
    if native and option.name == "cute_sol":
        try:
            from .cute_sol import require
            require()
        except (ImportError, OSError, RuntimeError) as error:
            raise AttentionOptionUnavailable(
                f"attention option '{option.name}' requires the optional CuTe Sol runtime: {error}"
            ) from error
    elif native and option.name != "vsa":
        try:
            from .native_attention import require_backend
            require_backend(option.name)
        except (ImportError, OSError, RuntimeError) as error:
            raise AttentionOptionUnavailable(
                f"attention option '{option.name}' requires the packaged native backend: {error}"
            ) from error
    if not option.ready:
        raise AttentionOptionUnavailable(
            f"attention option '{option.name}' is unavailable: {option.description}; "
            "the native kernel is not included in this deployment"
        )
    return option


__all__ = [
    "ATTENTION_OPTIONS",
    "DEFAULT_ATTENTION_OPTION",
    "AttentionOption",
    "AttentionOptionError",
    "AttentionOptionUnavailable",
    "require_attention_option",
    "resolve_attention_option",
]
