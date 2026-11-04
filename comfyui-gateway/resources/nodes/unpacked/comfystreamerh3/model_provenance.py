"""Content hashes for resolved FastH3 model assets, outside timed inference.

The bounded cache uses filesystem identity only to avoid rereading unchanged
files; emitted identities always hash file contents. This attests the resolved
on-disk assets, not arbitrary later mutations of in-memory model parameters.
"""

import hashlib
import json
from collections.abc import Mapping
from functools import lru_cache
from pathlib import Path


def _file_identity(path):
    stat = path.stat()
    if not path.is_file():
        raise ValueError("model asset must be a regular file")
    return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)


@lru_cache(maxsize=16)
def _content_hash(path, identity):
    target = Path(path)
    digest = hashlib.sha256()
    with target.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if _file_identity(target) != identity:
        raise RuntimeError("model asset changed while hashing its contents")
    return digest.hexdigest()


def model_content_manifest(paths):
    """Return filename -> content SHA256, independent of host path/mtime."""
    manifest = {}
    for filename, path in sorted(paths.items()):
        target = Path(path).resolve(strict=True)
        manifest[filename] = _content_hash(str(target), _file_identity(target))
    return manifest


def model_manifest_digest(manifest):
    if not isinstance(manifest, dict) or not manifest:
        raise ValueError("model content manifest must contain asset hashes")
    for filename, digest in manifest.items():
        if (not isinstance(filename, str) or not filename
                or not isinstance(digest, str) or len(digest) != 64
                or any(char not in "0123456789abcdef" for char in digest)):
            raise ValueError("model content manifest has an invalid asset hash")
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(canonical).hexdigest()


_ASSET_INPUTS = {
    "CLIPLoader": (("text_encoders", "clip_name"),),
    "DualCLIPLoader": (("text_encoders", "clip_name1"), ("text_encoders", "clip_name2")),
    "TripleCLIPLoader": (("text_encoders", "clip_name1"), ("text_encoders", "clip_name2"),
                         ("text_encoders", "clip_name3")),
    "VAELoader": (("vae", "vae_name"),),
    "FastH3VerifiedVAELoader": (("vae", "vae_name"),),
    "UNETLoader": (("diffusion_models", "unet_name"),),
    "ComfyStreamerH3DmadLoader": (
        ("diffusion_models", "checkpoint"),
        ("text_encoders", "text_encoder"),
        ("vae", "video_vae"),
        ("vae", "audio_vae"),
    ),
    "CheckpointLoaderSimple": (("checkpoints", "ckpt_name"),),
    "LoraLoader": (("loras", "lora_name"),),
    "LoraLoaderModelOnly": (("loras", "lora_name"),),
}

def _selected_assets(checkpoint, prompt, unique_id):
    assets = {("diffusion_models", checkpoint)}
    # A direct/model-only caller has no graph selections to attest. Never
    # invent a complete CLIP/VAE manifest from filenames merely installed.
    if prompt is None:
        return sorted(assets)
    if (not isinstance(prompt, Mapping) or len(prompt) > 4096
            or not isinstance(unique_id, str) or unique_id not in prompt):
        raise ValueError("model provenance requires the current workflow node identity")
    parents: dict[str, set[str]] = {}
    children: dict[str, set[str]] = {key: set() for key in prompt}
    for node_id, node in prompt.items():
        if not isinstance(node, Mapping) or not isinstance(node.get("inputs"), Mapping):
            raise TypeError("model provenance requires an API-format workflow")
        parents[node_id] = set()
        for value in node["inputs"].values():
            if (isinstance(value, (tuple, list)) and len(value) == 2
                    and isinstance(value[0], str) and value[0] in prompt
                    and type(value[1]) is int and value[1] >= 0):
                parents[node_id].add(value[0])
                children[value[0]].add(node_id)
    pending, visited = [unique_id], set()
    while pending:
        node_id = pending.pop()
        if node_id in visited:
            continue
        visited.add(node_id)
        node = prompt[node_id]
        selectors = _ASSET_INPUTS.get(node.get("class_type"), ())
        for category, key in selectors:
            filename = node["inputs"].get(key)
            if not isinstance(filename, str) or not filename.strip():
                raise ValueError(f"model provenance requires a literal {node_id}.{key} selector")
            assets.add((category, filename))
        # Pure asset loaders are leaves with respect to their other consumers:
        # a second, independent render using the same CLIP/VAE is not this run.
        # A wrapper such as LoraLoader has parents and must reach its consumers.
        pending.extend(parents[node_id])
        if not selectors or parents[node_id]:
            pending.extend(children[node_id])
    return sorted(assets)


def model_selection_signature(checkpoint, prompt=None, unique_id=None, resolve_path=None):
    """Invalidate a cached loader when selected names or on-disk files change."""
    selections = _selected_assets(checkpoint, prompt, unique_id)
    identity = []
    for category, filename in selections:
        item = [category, filename]
        if resolve_path is not None:
            path = Path(resolve_path(category, filename))
            stat = path.stat()
            if not path.is_file():
                raise ValueError("selected model asset must be a regular file")
            item.extend((stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns))
        identity.append(item)
    return hashlib.sha256(json.dumps(identity, separators=(",", ":")).encode()).hexdigest()


def fasth3_model_manifest(checkpoint, resolve_path, *, prompt=None, unique_id=None):
    paths: dict[str, str | Path] = {}
    categories: dict[str, str] = {}
    for category, filename in _selected_assets(checkpoint, prompt, unique_id):
        if filename in categories and categories[filename] != category:
            raise ValueError("model manifest filename is ambiguous across asset categories")
        categories[filename] = category
        paths[filename] = resolve_path(category, filename)
    return model_content_manifest(paths)
