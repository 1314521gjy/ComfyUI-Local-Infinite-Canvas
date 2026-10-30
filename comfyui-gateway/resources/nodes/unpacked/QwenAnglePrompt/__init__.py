"""Small bundled helper: join the Qwen multi-angle base prompt with the camera prompt.

Replaces the third-party CR Prompt Text + StringConcatenate dependency used by
image-qwen21-angle.json so the angle workflow only needs bundled nodes.
"""


class QwenAnglePromptConcat:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "base_prompt": ("STRING", {"multiline": True, "default": ""}),
                "camera_text": ("STRING", {"forceInput": True}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "concat"
    CATEGORY = "image/multiangle"

    def concat(self, base_prompt, camera_text):
        parts = [str(value).strip() for value in (base_prompt, camera_text) if str(value or "").strip()]
        return ("\n".join(parts),)


NODE_CLASS_MAPPINGS = {"QwenAnglePromptConcat": QwenAnglePromptConcat}
NODE_DISPLAY_NAME_MAPPINGS = {"QwenAnglePromptConcat": "Qwen Angle Prompt Concat"}
