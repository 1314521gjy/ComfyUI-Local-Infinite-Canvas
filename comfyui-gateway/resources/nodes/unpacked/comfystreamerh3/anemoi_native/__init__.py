"""Isolated, prebuilt SM120 attention; never routes or compiles at runtime."""

from .adapter import (
    ABI_VERSION,
    SOURCE_REVISION,
    ExecutionResult,
    Prepared,
    allocate,
    available,
    fine_attention,
    native_phase_assign,
    prepare_chunk,
    set_global_vscale,
    v_physical_row,
)
from .integration import require_backend, run_chunked
from .mixed import allocate_mixed, fine_mixed, prepare_mixed_chunk
from .quota import PrecisionPolicy, assign_phases

__all__ = [
    "ABI_VERSION",
    "SOURCE_REVISION",
    "ExecutionResult",
    "PrecisionPolicy",
    "Prepared",
    "allocate",
    "allocate_mixed",
    "assign_phases",
    "available",
    "fine_attention",
    "fine_mixed",
    "native_phase_assign",
    "prepare_chunk",
    "prepare_mixed_chunk",
    "require_backend",
    "run_chunked",
    "set_global_vscale",
    "v_physical_row",
]
