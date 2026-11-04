"""One fused base, shared weights, independent per-selector ModelPatchers.

Comfy owns GPU residency and clone switching. Eviction only releases this
cache's reference; it never clears global caches or invalidates live clones.
Inference using shared model objects must follow Comfy's serialized lifecycle.
"""
import hashlib
import importlib
import json
import re
import subprocess
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import asdict, dataclass
from pathlib import Path
from threading import RLock
from typing import Any


@dataclass(frozen=True)
class ModelKey:
    path: str
    device: str
    precision: str
    software: str
    file_identity: tuple


def model_key(path, *, device, precision, software):
    path = Path(path).resolve(strict=True)
    stat = path.stat()
    if not path.is_file():
        raise ValueError("checkpoint must be a regular file")
    return ModelKey(str(path), str(device), precision, software,
                    (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns))


class FusedBaseCache:
    def __init__(self):
        self._lock = RLock()
        self._entry: tuple[ModelKey, Any, dict] | None = None

    @contextmanager
    def clone(self, key, initialize):
        """Serialize initialization and arm construction; failures discard the entry.

        The yielded patcher shares model/adapter storage but owns its patch maps.
        Keep ordinary Comfy activation and sparse patch construction in this scope.
        """
        with self._lock:
            hit = self._entry is not None and self._entry[0] == key
            try:
                if not hit:
                    self._entry = None
                    base, precision = initialize()
                    self._entry = (key, base, deepcopy(precision))
                assert self._entry is not None
                _, base, precision = self._entry
                clone = base.clone()
                if (clone is base or clone.model is not base.model
                        or clone.object_patches is base.object_patches
                        or clone.model_options is base.model_options):
                    raise RuntimeError("ModelPatcher clone does not preserve shared-weight isolation")
                identity = asdict(key)
                evidence = {
                    "hit": hit, "capacity": 1,
                    "key_hash": hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest(),
                    "identity": identity,
                    "source_identity_scope": "resolved checkpoint path and filesystem stat, not weight-content hash",
                }
                yield clone, deepcopy(precision), evidence
            except BaseException:
                # A partially initialized/activated base must not become a later hit.
                self._entry = None
                raise

FUSED_BASE_CACHE = FusedBaseCache()


def comfyui_core_revision(comfyui_module_file=None, *, runner=None):
    """Return the installed ComfyUI checkout HEAD when its core source is clean.

    Managed FastH3 environments install ComfyUI from a pinned Git checkout.
    Tracked edits and new upstream Python files fail closed so they cannot
    share fused model objects or replay identity with the clean HEAD. Runtime
    data and installed custom nodes are outside this upstream source identity.
    """
    if comfyui_module_file is None:
        try:
            # Upstream comfy is a namespace package; its __file__ is None.
            comfyui_module_file = importlib.import_module("comfy.model_management").__file__
        except (ImportError, AttributeError) as exc:
            raise RuntimeError("ComfyUI core revision is unavailable") from exc
    if not isinstance(comfyui_module_file, (str, Path)) or not str(comfyui_module_file):
        raise RuntimeError("ComfyUI core revision is unavailable")

    core_root = Path(comfyui_module_file).resolve().parent.parent
    run = subprocess.run if runner is None else runner
    try:
        status = run(
            ["git", "-C", str(core_root), "status", "--porcelain", "-z",
             "--untracked-files=all", "--ignored=traditional", "--", ".",
             *[f":(exclude){directory}" for directory in (
                 "models", "output", "input", "temp", "user", "custom_nodes",
                 ".venv", "venv", "env",
                 # Canvas installer receipts/payloads live beside the checkout;
                 # they are runtime data, not upstream ComfyUI source.
                 ".canvas-install", ".canvas-install-backups",
             )]],
            capture_output=True, encoding="utf-8", errors="replace", check=False, timeout=3,
        )
        if getattr(status, "returncode", 1) != 0:
            raise RuntimeError("ComfyUI core source status could not be read")
        # LOCal substitution: text=True decodes with the Windows ANSI code page (GBK);
        # Chinese paths here break the reader thread and leave stdout=None.
        for entry in (getattr(status, "stdout", "") or "").split("\0"):
            if not entry:
                continue
            # -z preserves spaces/Unicode in source paths without Git quoting.
            # Any tracked change (including a dependency pin) changes upstream
            # identity. Ignore new runtime receipts and generated bytecode.
            if entry[:2] not in ("??", "!!") or Path(entry[3:]).suffix == ".py":
                raise RuntimeError("ComfyUI core source is modified")
        result = run(
            ["git", "-C", str(core_root), "rev-parse", "HEAD"],
            capture_output=True, encoding="utf-8", errors="replace", check=False, timeout=3,
        )
    except RuntimeError:
        raise
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError("ComfyUI core revision or source status could not be read") from exc
    revision = (getattr(result, "stdout", "") or "").strip().lower()
    if (getattr(result, "returncode", 1) != 0
            or re.fullmatch(r"[0-9a-f]{40}", revision) is None):
        raise RuntimeError("ComfyUI core revision could not be read from its checkout")
    return revision


def fasth3_software_identity(
    *,
    torch_version,
    comfyui_commit,
    kitchen_version,
    kitchen_wheel_sha256,
    engine,
    model_variant,
):
    """Version every software choice that can change a cached FastH3 base."""
    for name, value in (
        ("torch_version", torch_version),
        ("kitchen_version", kitchen_version),
        ("engine", engine),
        ("model_variant", model_variant),
    ):
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{name} must be a non-empty string")
    if re.fullmatch(r"[0-9a-fA-F]{40}", str(comfyui_commit)) is None:
        raise ValueError("comfyui_commit must be a 40-character Git commit")
    if re.fullmatch(r"[0-9a-fA-F]{64}", str(kitchen_wheel_sha256)) is None:
        raise ValueError("kitchen_wheel_sha256 must be a SHA-256 digest")
    identity = {
        "schema": "fasth3-model-software/2",
        "torch_version": torch_version,
        "comfyui_commit": comfyui_commit.lower(),
        "kitchen_version": kitchen_version,
        "kitchen_wheel_sha256": kitchen_wheel_sha256.lower(),
        "engine": engine,
        "model_variant": model_variant,
    }
    return json.dumps(identity, sort_keys=True, separators=(",", ":"))
