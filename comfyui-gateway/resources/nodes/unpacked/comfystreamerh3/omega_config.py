"""OMEGA baseline experiment registry and configuration resolution.

OMEGA deliberately has a small, explicit control plane.  The registry does
not enable an experiment or infer one from ``attention_policy``; it records
which flags were requested, whether they are eligible for the selected
baseline, and whether an implementation is actually wired at this seam.
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from typing import Any

OMEGA_SCHEMA = "fasth3-omega/1"
OMEGA_IDENTITIES = ("stock_reference", "omega_unfused")
OMEGA_BASELINE_BACKEND = "kitchen"


@dataclass(frozen=True)
class OmegaFlagSpec:
    name: str
    owner: str
    supported_backends: tuple[str, ...] = (OMEGA_BASELINE_BACKEND,)
    implemented: bool = False
    existing_control: str | None = None
    conflicts: tuple[str, ...] = ()
    description: str = ""


# Keep this list in the same order as the implementation plan.  ``implemented``
# means that the current Python seam can engage the existing control; it does
# not claim a kernel fusion or a measured speedup.
_SPECS = (
    OmegaFlagSpec("omega_skip_measure_gate", "producer", implemented=True,
                  existing_control="producer_skip_bootstrap_gate",
                  description="skip the disposable bootstrap measurement gate"),
    OmegaFlagSpec("omega_masked_retile", "producer", implemented=True,
                  existing_control="producer_masked_retile",
                  description="gather live rows without a sentinel concat"),
    OmegaFlagSpec("omega_native_masked_retile", "producer", implemented=True,
                  existing_control="producer_native_masked_retile",
                  conflicts=("omega_masked_retile",),
                  description="use the native masked retile implementation"),
    OmegaFlagSpec("omega_fusion_scratch_pool", "producer", implemented=True,
                  existing_control="fusion_scratch_pool",
                  conflicts=("omega_masked_retile",),
                  description="reuse bounded producer retile scratch buffers"),
    OmegaFlagSpec("omega_measure_only", "producer", description="omit producer stores with no measurement consumer"),
    OmegaFlagSpec("omega_fused_stats_finalize", "producer", description="fuse scale/statistics finalization"),
    OmegaFlagSpec("omega_static_metadata", "dispatch",
                  description="reuse immutable descriptors only"),
    OmegaFlagSpec("omega_producer_direct_carriers", "producer",
                  description="write carriers directly from the producer"),
    OmegaFlagSpec("omega_threshold_epilogue", "attention",
                  description="fuse threshold preprocessing with the score epilogue"),
    OmegaFlagSpec("omega_finish_route_launch", "dispatch",
                  description="keep finish/threshold/route submission in one native call"),
    OmegaFlagSpec("omega_output_scatter", "output", conflicts=("omega_coarse_epilogue",),
                  description="emit source-order output without an index-select copy"),
    OmegaFlagSpec("omega_coarse_epilogue", "output", conflicts=("omega_output_scatter",),
                  description="fuse coarse gate/add and final conversion"),
    OmegaFlagSpec("omega_decoder_qk_inplace", "decoder",
                  existing_control="decoder_qk_inplace",
                  description="reuse owned decoder Q/K output buffers"),
    OmegaFlagSpec("omega_decoder_scale_casts", "decoder",
                  existing_control="cache_scale_casts",
                  description="cache invariant decoder scale casts"),
    OmegaFlagSpec("omega_decoder_clone_elision", "decoder",
                  existing_control="elide_owned_clone",
                  description="elide clones only for independently owned outputs"),
    OmegaFlagSpec("omega_decoder_staging", "decoder",
                  existing_control="reuse_staging",
                  description="reuse bounded decoder tile staging"),
    OmegaFlagSpec("omega_decoder_pointwise", "decoder",
                  description="fuse one profiled decoder pointwise family"),
    OmegaFlagSpec("omega_segment_graph", "runtime",
                  description="capture fixed baseline segments for graph replay"),
)

OMEGA_FLAG_REGISTRY: dict[str, OmegaFlagSpec] = {spec.name: spec for spec in _SPECS}
OMEGA_FLAG_NAMES = tuple(OMEGA_FLAG_REGISTRY)


class OmegaConfigError(ValueError):
    """Raised before model construction for an incompatible OMEGA request."""


def _flag_record(spec: OmegaFlagSpec, requested: bool, *, eligible: bool,
                 reason: str, applied: bool, evidence: Mapping[str, Any] | None = None) -> dict[str, Any]:
    evidence = evidence or {}
    return {
        "requested": requested,
        "eligible": eligible,
        "applied": applied,
        "reason": reason,
        "owner": spec.owner,
        "existing_control": spec.existing_control,
        "description": spec.description,
        # Unknown evidence stays null.  Zero is a measured count and must not
        # be fabricated by configuration resolution.
        "calls": evidence.get("calls"),
        "source_hash": evidence.get("source_hash"),
        "binary_hash": evidence.get("binary_hash"),
    }


def _canonical_hash(config: Mapping[str, Any]) -> str:
    payload = {key: value for key, value in config.items() if key != "effective_hash"}
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()


def resolve_omega_config(
    *,
    identity: str = "stock_reference",
    attention_option: str = "vsa",
    backend: str = OMEGA_BASELINE_BACKEND,
    requested: Mapping[str, bool] | None = None,
    flags: Mapping[str, bool] | None = None,
    legacy_controls: Mapping[str, Any] | None = None,
    evidence: Mapping[str, Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Resolve one explicit OMEGA configuration.

    ``stock_reference`` is immutable: it cannot carry a requested OMEGA bit.
    ``omega_unfused`` is the private artifact identity used for OMEGA singles;
    all bits are still off when no request is supplied.  The resolver reports
    unsupported flags instead of silently selecting a different backend.
    """
    if identity not in OMEGA_IDENTITIES:
        raise OmegaConfigError(f"unknown OMEGA identity {identity!r}; expected {OMEGA_IDENTITIES}")
    if not isinstance(attention_option, str) or not isinstance(backend, str):
        raise OmegaConfigError("attention_option and backend must be strings")
    merged: dict[str, bool] = {}
    for source in (requested, flags):
        if source is None:
            continue
        unknown = set(source) - set(OMEGA_FLAG_REGISTRY)
        if unknown:
            raise OmegaConfigError(f"unknown OMEGA flag(s): {', '.join(sorted(unknown))}")
        for name, value in source.items():
            if type(value) is not bool:
                raise OmegaConfigError(f"OMEGA flag {name!r} must be boolean")
            merged[name] = value
    requested_map = {name: bool(merged.get(name, False)) for name in OMEGA_FLAG_NAMES}
    if identity == "stock_reference" and any(requested_map.values()):
        enabled = ", ".join(name for name, value in requested_map.items() if value)
        raise OmegaConfigError(
            "stock_reference requires every OMEGA flag off; requested: " + enabled
        )
    if identity == "stock_reference" and legacy_controls:
        enabled_legacy = [
            name for name, value in legacy_controls.items()
            if name in ("producer_skip_bootstrap_gate", "producer_masked_retile",
                        "producer_native_masked_retile") and bool(value)
        ]
        if enabled_legacy:
            raise OmegaConfigError(
                "stock_reference requires baseline producer controls off; enabled: "
                + ", ".join(enabled_legacy)
            )
    if attention_option == "vsa" and backend != OMEGA_BASELINE_BACKEND and any(requested_map.values()):
        raise OmegaConfigError(
            "OMEGA baseline flags require backend='kitchen' with attention_option='vsa'; "
            f"got backend={backend!r}, attention_option={attention_option!r}"
        )
    if attention_option != "vsa" and any(requested_map.values()):
        raise OmegaConfigError(
            "OMEGA baseline flags are VSA-only; native candidate options must use "
            "their existing fusion registry"
        )

    records: dict[str, dict[str, Any]] = {}
    eligible_map: dict[str, bool] = {}
    applied_map: dict[str, bool] = {}
    reasons: dict[str, str] = {}
    baseline_eligible = attention_option == "vsa" and backend == OMEGA_BASELINE_BACKEND
    for spec in _SPECS:
        requested_flag = requested_map[spec.name]
        eligible = baseline_eligible and spec.implemented and backend in spec.supported_backends
        if not eligible:
            reason = ("unsupported: implementation not wired at this seam"
                      if baseline_eligible else "requires the stock VSA/Kitchen baseline")
            applied = False
        elif not requested_flag:
            reason = "off"
            applied = False
        else:
            reason = f"applied via {spec.existing_control}"
            applied = True
        eligible_map[spec.name] = eligible
        applied_map[spec.name] = applied
        reasons[spec.name] = reason
        records[spec.name] = _flag_record(
            spec, requested_flag, eligible=eligible, applied=applied, reason=reason,
            evidence=(evidence or {}).get(spec.name),
        )

    for spec in _SPECS:
        if requested_map[spec.name]:
            for conflict in spec.conflicts:
                if requested_map.get(conflict):
                    raise OmegaConfigError(f"OMEGA flags {spec.name} and {conflict} conflict")

    config: dict[str, Any] = {
        "schema": OMEGA_SCHEMA,
        "identity": identity,
        "attention_option": attention_option,
        "backend": backend,
        "requested": requested_map,
        "eligible": eligible_map,
        "applied": applied_map,
        "reason": reasons,
        "flags": records,
        "legacy_controls": dict(legacy_controls or {}),
    }
    config["effective_hash"] = _canonical_hash(config)
    return config


def ensure_omega_config(config: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """Validate/copy a resolved config passed across the dispatch boundary."""
    if config is None:
        return None
    if not isinstance(config, Mapping):
        raise OmegaConfigError("omega_config must be a resolved mapping")
    copied = json.loads(json.dumps(dict(config), default=str))
    if copied.get("schema") != OMEGA_SCHEMA:
        raise OmegaConfigError("invalid resolved OMEGA schema")
    identity = copied.get("identity")
    if identity not in OMEGA_IDENTITIES:
        raise OmegaConfigError(f"invalid resolved OMEGA identity: {identity!r}")
    if not isinstance(copied.get("attention_option"), str) or not isinstance(copied.get("backend"), str):
        raise OmegaConfigError("resolved OMEGA config needs string attention_option/backend")
    required_maps = ("requested", "eligible", "applied", "reason", "flags")
    if any(name not in copied or not isinstance(copied[name], dict) for name in required_maps):
        raise OmegaConfigError("resolved OMEGA config is missing required flag maps")
    expected_names = set(OMEGA_FLAG_NAMES)
    for name in ("requested", "eligible", "applied", "reason", "flags"):
        if set(copied[name]) != expected_names:
            raise OmegaConfigError(f"resolved OMEGA {name} map has incorrect flag names")
    for name in OMEGA_FLAG_NAMES:
        record = copied["flags"][name]
        if not isinstance(record, dict):
            raise OmegaConfigError(f"resolved OMEGA flag {name} is not a record")
        required = ("requested", "eligible", "applied", "reason", "calls", "source_hash", "binary_hash")
        if any(key not in record for key in required):
            raise OmegaConfigError(f"resolved OMEGA flag {name} is missing evidence fields")
        if any(type(record[key]) is not bool for key in ("requested", "eligible", "applied")):
            raise OmegaConfigError(f"resolved OMEGA flag {name} has invalid boolean fields")
        if not isinstance(record["reason"], str):
            raise OmegaConfigError(f"resolved OMEGA flag {name} has invalid reason")
        if record["calls"] is not None and (type(record["calls"]) is not int or record["calls"] < 0):
            raise OmegaConfigError(f"resolved OMEGA flag {name} has invalid calls")
        for key in ("source_hash", "binary_hash"):
            if record[key] is not None and not isinstance(record[key], str):
                raise OmegaConfigError(f"resolved OMEGA flag {name} has invalid {key}")
        if copied["requested"][name] != record["requested"]:
            raise OmegaConfigError(f"resolved OMEGA flag {name} disagrees with requested map")
        if copied["eligible"][name] != record["eligible"] or copied["applied"][name] != record["applied"]:
            raise OmegaConfigError(f"resolved OMEGA flag {name} disagrees with status maps")
    expected = _canonical_hash(copied)
    if copied.get("effective_hash") != expected:
        raise OmegaConfigError("resolved OMEGA config hash mismatch")
    return copied


def registry_manifest() -> dict[str, Any]:
    """Return a stable, JSON-friendly registry description for reports/tests."""
    return {
        "schema": OMEGA_SCHEMA,
        "identities": list(OMEGA_IDENTITIES),
        "flags": [asdict(spec) for spec in _SPECS],
    }
