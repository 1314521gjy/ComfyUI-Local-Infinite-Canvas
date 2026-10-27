from .minimax_trt_node import MiniMaxH3TRTVAELoader, MiniMaxH3TRTCompilerNode

NODE_CLASS_MAPPINGS = {
    "MiniMaxH3TRTVAELoader": MiniMaxH3TRTVAELoader,
    "MiniMaxH3TRTCompilerNode": MiniMaxH3TRTCompilerNode
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3TRTVAELoader": "MiniMax-H3 TRT VAE Loader",
    "MiniMaxH3TRTCompilerNode": "MiniMax-H3 TRT VAE Compiler"
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]