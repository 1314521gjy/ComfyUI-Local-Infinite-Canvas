"""Production ComfyStreamerH3 custom nodes for ComfyUI workflows."""

from .benchmark import (
    ComfyStreamerH3BenchmarkOutput,
    ComfyStreamerH3BenchmarkSampler,
    ComfyStreamerH3BenchmarkVAEDecode,
    ComfyStreamerH3BenchmarkVAEDecodeAudio,
    ComfyStreamerH3DmadBenchmarkVAEDecode,
)
from .conditioning import ComfyStreamerH3ImageToVideo
from .dmad_nodes import ComfyStreamerH3DmadLoader, ComfyStreamerH3DmadSampling
from .native_diagnostic import ComfyStreamerH3NativeAttentionDiagnostic
from .nodes import ComfyStreamerH3OptimizedLoader

NODE_CLASS_MAPPINGS = {
    "ComfyStreamerH3ImageToVideo": ComfyStreamerH3ImageToVideo,
    "ComfyStreamerH3DmadLoader": ComfyStreamerH3DmadLoader,
    "ComfyStreamerH3DmadSampling": ComfyStreamerH3DmadSampling,
    "ComfyStreamerH3NativeAttentionDiagnostic": ComfyStreamerH3NativeAttentionDiagnostic,
    "ComfyStreamerH3OptimizedLoader": ComfyStreamerH3OptimizedLoader,
    "ComfyStreamerH3BenchmarkSampler": ComfyStreamerH3BenchmarkSampler,
    "ComfyStreamerH3BenchmarkVAEDecode": ComfyStreamerH3BenchmarkVAEDecode,
    "ComfyStreamerH3DmadBenchmarkVAEDecode": ComfyStreamerH3DmadBenchmarkVAEDecode,
    "ComfyStreamerH3BenchmarkVAEDecodeAudio": ComfyStreamerH3BenchmarkVAEDecodeAudio,
    "ComfyStreamerH3BenchmarkOutput": ComfyStreamerH3BenchmarkOutput,
}

# Keep earlier FastH3 IDs loadable as well.
NODE_CLASS_MAPPINGS.update({
    "FastH3OptimizedLoader": ComfyStreamerH3OptimizedLoader,
    "FastH3BenchmarkSampler": ComfyStreamerH3BenchmarkSampler,
    "FastH3BenchmarkVAEDecode": ComfyStreamerH3BenchmarkVAEDecode,
    "FastH3BenchmarkVAEDecodeAudio": ComfyStreamerH3BenchmarkVAEDecodeAudio,
    "FastH3BenchmarkOutput": ComfyStreamerH3BenchmarkOutput,
})

NODE_DISPLAY_NAME_MAPPINGS = {
    key: name
    for key, name in {
        "ComfyStreamerH3OptimizedLoader": "ComfyStreamerH3 Optimized Loader",
        "ComfyStreamerH3ImageToVideo": "ComfyStreamerH3 Image to Video",
        "ComfyStreamerH3DmadLoader": "ComfyStreamerH3 DMAD Model",
        "ComfyStreamerH3DmadSampling": "ComfyStreamerH3 DMAD Sampler",
        "ComfyStreamerH3NativeAttentionDiagnostic": "ComfyStreamerH3 Native Attention Diagnostic",
        "ComfyStreamerH3BenchmarkSampler": "ComfyStreamerH3 Sampler",
        "ComfyStreamerH3BenchmarkVAEDecode": "ComfyStreamerH3 Video Decode",
        "ComfyStreamerH3DmadBenchmarkVAEDecode": "ComfyStreamerH3 DMAD Video Decode",
        "ComfyStreamerH3BenchmarkVAEDecodeAudio": "ComfyStreamerH3 Audio Decode",
        "ComfyStreamerH3BenchmarkOutput": "ComfyStreamerH3 Output",
        "FastH3OptimizedLoader": "ComfyStreamerH3 Optimized Loader",
        "FastH3BenchmarkSampler": "ComfyStreamerH3 Sampler",
        "FastH3BenchmarkVAEDecode": "ComfyStreamerH3 Video Decode",
        "FastH3BenchmarkVAEDecodeAudio": "ComfyStreamerH3 Audio Decode",
        "FastH3BenchmarkOutput": "ComfyStreamerH3 Output",
    }.items()
}
