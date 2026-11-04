"""Content identity shared by the benchmark client and deployed node."""
import hashlib
from pathlib import Path


def node_fingerprint(root=None):
    root = Path(root) if root is not None else Path(__file__).parent
    digest = hashlib.sha256()
    for path in sorted(root.rglob('*')):
        if (path.is_file()
                and path.suffix in ('.py', '.txt', '.cu', '.cuh', '.cpp', '.h', '.hpp', '.json', '.so', '.pyd')
                and '__pycache__' not in path.parts):
            digest.update(path.relative_to(root).as_posix().encode() + b'\0')
            digest.update(path.read_bytes())
            digest.update(b'\0')
    return digest.hexdigest()


def node_source_fingerprint(root=None):
    """Match repository/staged source to the worker despite generated binaries."""
    root = Path(root) if root is not None else Path(__file__).parent
    digest = hashlib.sha256()
    generated = {"build-report.json", "build-failure.json", "resources.txt", "kernels.sass"}
    for path in sorted(root.rglob('*')):
        if (path.is_file() and path.suffix in ('.py', '.txt', '.cu', '.cuh', '.cpp', '.h', '.hpp', '.json')
                and '__pycache__' not in path.parts and '_build' not in path.relative_to(root).parts
                and path.name not in generated):
            digest.update(path.relative_to(root).as_posix().encode() + b'\0')
            digest.update(path.read_bytes())
            digest.update(b'\0')
    return digest.hexdigest()


def node_binary_fingerprint(root=None):
    """Hash packaged native binaries separately from editable source files."""
    root = Path(root) if root is not None else Path(__file__).parent
    digest = hashlib.sha256()
    found = False
    for path in sorted(root.rglob('*')):
        if path.is_file() and path.suffix in ('.so', '.pyd'):
            found = True
            digest.update(path.relative_to(root).as_posix().encode() + b'\0')
            digest.update(path.read_bytes())
            digest.update(b'\0')
    return digest.hexdigest() if found else None
