"""FastH3 sampling contracts; no runtime or GPU dependencies."""

from typing import TypedDict


class SamplingContract(TypedDict):
    positions: tuple[float, ...]
    shift: float

SAMPLING_CONTRACTS: dict[str, SamplingContract] = {
    # PDMD's MiniMax-H3 adapter is distilled for two model evaluations. Keep
    # this opt-in schedule separate from the existing FastH3 checkpoint arms.
    "pdmd-2step": {
        "positions": (0.999, 0.5, 0.0),
        "shift": 12.0,
    },
    "preview-v1-4step": {
        "positions": (0.999, 0.749, 0.5, 0.25, 0.0),
        "shift": 12.0,
    },
    "v2-8step": {
        "positions": (0.999, 0.874, 0.749, 0.624, 0.5, 0.375, 0.25, 0.125, 0.0),
        "shift": 10.0,
    },
    # Exploratory benchmark only: every other published V2 timestep plus the
    # terminal zero. FastH3 V2 was trained for eight evaluations.
    "v2-4step-subsampled": {
        "positions": (0.999, 0.749, 0.5, 0.25, 0.0),
        "shift": 10.0,
    },
}
# Compatibility aliases used by the existing Preview v1 workflows and checks.
POSITIONS = SAMPLING_CONTRACTS["preview-v1-4step"]["positions"]
CHECKPOINT = "minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors"


def video_sigmas(contract: str = "preview-v1-4step") -> tuple[float, ...]:
    try:
        value = SAMPLING_CONTRACTS[contract]
    except KeyError as error:
        raise ValueError(f"unknown FastH3 sampling contract: {contract}") from error
    shift = value["shift"]
    return tuple(shift * t / (1.0 + (shift - 1.0) * t) for t in value["positions"])


def validate_geometry(width: int, height: int, length: int) -> None:
    if width % 32 or height % 32 or min(width, height) < 384:
        raise ValueError("FastH3 requires a /32 canvas with a minimum 384px edge")
    if length < 107 or length > 362 or (length - 5) % 17:
        raise ValueError("Frame count must be 107..362 on the 17k+5 grid")
