from .instrumentalize import convert_score


class YuE2InstrumentalConvert:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "abc": ("STRING", {"multiline": True, "default": ""}),
                "overlap": (["vocal", "error"], {"default": "vocal"}),
                "keep_chords": ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("abc",)
    FUNCTION = "convert"
    CATEGORY = "YuE2"

    def convert(self, abc, overlap, keep_chords):
        converted, _check = convert_score(abc, overlap=overlap, keep_chords=keep_chords)
        return (converted,)


NODE_CLASS_MAPPINGS = {"YuE2InstrumentalConvert": YuE2InstrumentalConvert}
NODE_DISPLAY_NAME_MAPPINGS = {"YuE2InstrumentalConvert": "YuE2 Instrumental Convert"}
