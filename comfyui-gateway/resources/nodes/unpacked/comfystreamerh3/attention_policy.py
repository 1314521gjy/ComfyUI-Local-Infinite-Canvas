"""Versioned candidate arithmetic profiles, independent of the shared B1 stack."""
import hashlib
import json

ATTENTION_POLICIES = ("control", "optimized", "early_grouping")


def attention_policy(option, variant="control"):
    if option not in ("vsa", "vc", "anemoi", "combined", "cute_sol") or variant not in ATTENTION_POLICIES:
        raise ValueError("unknown attention option or policy")
    if option == "vsa" and variant != "control":
        raise ValueError("VSA baseline uses control arithmetic")
    if option == "cute_sol" and variant != "control":
        raise ValueError("CuTe Sol is an explicit control-arithmetic experiment")
    if option == "anemoi" and variant == "early_grouping":
        raise ValueError("early grouping requires VC or combined")
    policy = {"schema": "fasth3-attention-policy/1", "option": option, "variant": variant,
              "grouping_policy": "g4" if variant != "control" and option in ("vc", "combined") else "none",
              "grouping_schedule": "first_eval" if variant == "early_grouping" else "all_steps",
              "pv_precision": "nvfp4" if option == "vc" and variant != "control" else "int8",
              "attention_kernel_policy": "mixed_fp4" if option in ("anemoi", "combined") and variant != "control" else "int8_control",
              "nvfp4_range_margin": 2.0 if option in ("anemoi", "combined") and variant != "control" else 1.0,
              "gpu_qualified": False}
    policy["policy_hash"] = hashlib.sha256(json.dumps(policy, sort_keys=True).encode()).hexdigest()
    return policy
