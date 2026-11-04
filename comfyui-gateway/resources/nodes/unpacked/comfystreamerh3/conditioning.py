"""H3 conditioning with request-scoped Kitchen VAE adapters and evidence."""

class ComfyStreamerH3ImageToVideo:
    RETURN_TYPES = ("CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "latent")
    FUNCTION = "execute"
    CATEGORY = "ComfyStreamerH3/Deploy"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "clip": ("CLIP",), "vae": ("VAE",), "profile": ("H3_PROFILE",),
            "prompt": ("STRING", {"multiline": True, "dynamicPrompts": True}),
            "width": ("INT", {"default": 512, "min": 32, "max": 16384, "step": 32}),
            "height": ("INT", {"default": 320, "min": 32, "max": 16384, "step": 32}),
            "length": ("INT", {"default": 362, "min": 5, "max": 3600, "step": 17}),
        }, "optional": {
            "run_nonce": ("STRING", {"default": ""}),
            "first_frame": ("IMAGE",), "last_frame": ("IMAGE",),
            **{f"ref_image_{index}": ("IMAGE",) for index in range(1, 10)},
            "vae_precision_policy": (["established", "fp16_accum"], {"default": "established"}),
        }}

    def execute(self, clip, vae, profile, prompt, width, height, length,
                first_frame=None, last_frame=None, vae_precision_policy="established",
                ref_image_1=None, ref_image_2=None, ref_image_3=None,
                ref_image_4=None, ref_image_5=None, ref_image_6=None,
                ref_image_7=None, ref_image_8=None, ref_image_9=None, run_nonce=""):
        from .kitchen_vae import kitchen_vae_mode

        policy = profile.get("kitchen_baseline") if isinstance(profile, dict) else None
        dmad_profile = isinstance(profile, dict) and profile.get("model_family") == "dmad"
        if policy:
            if policy["vae_precision_policy"] != vae_precision_policy:
                raise ValueError("encoder precision policy differs from loader profile")
            encoder_kitchen_fusions = True
        elif dmad_profile:
            if profile.get("vae_precision_policy", "established") != vae_precision_policy:
                raise ValueError("DMAD encoder precision policy differs from loader profile")
            encoder_kitchen_fusions = bool(profile.get("kitchen_vae_fusions", False))
        else:
            raise ValueError("ComfyStreamerH3 Image to Video requires a Kitchen baseline profile or a DMAD model profile")

        references = {
            f"ref_image_{index}": image
            for index, image in enumerate((
                ref_image_1, ref_image_2, ref_image_3, ref_image_4, ref_image_5,
                ref_image_6, ref_image_7, ref_image_8, ref_image_9,
            ), start=1)
            if image is not None
        }
        if dmad_profile and (first_frame is not None or last_frame is not None or references):
            raise ValueError("DMAD's original H3 text-to-audio-video model has no qualified frame/reference conditioning")
        with kitchen_vae_mode(vae.first_stage_model, precision_policy=vae_precision_policy,
                              enabled=encoder_kitchen_fusions) as evidence:
            if not references:
                from comfy_extras.nodes_minimax_h3 import MiniMaxH3ImageToVideo

                result = MiniMaxH3ImageToVideo.execute(
                    clip, vae, prompt, width, height, length, first_frame, last_frame,
                )
            else:
                from comfy_extras.nodes_minimax_h3 import (
                    MiniMaxH3AddGuide,
                    MiniMaxH3ReferenceToVideo,
                    _resize,
                )

                result = MiniMaxH3ReferenceToVideo.execute(
                    clip,
                    prompt,
                    width,
                    height,
                    length,
                    ref_image_size="match",
                    vae=vae,
                    ref_images=references,
                )
                values = result.args if hasattr(result, "args") else result
                conditioning, latent = values
                if first_frame is not None:
                    # AddGuide center-crops; stretch first so its geometry matches
                    # the legacy first-frame path before that resize is applied.
                    first_frame = _resize(first_frame[:1], width, height, "disabled")
                    guided = MiniMaxH3AddGuide.execute(
                        conditioning, latent, frame_idx=0, vae=vae, image=first_frame,
                    )
                    conditioning = guided.args[0] if hasattr(guided, "args") else guided[0]
                if last_frame is not None:
                    guided = MiniMaxH3AddGuide.execute(
                        conditioning, latent, frame_idx=-1, vae=vae, image=last_frame,
                    )
                    conditioning = guided.args[0] if hasattr(guided, "args") else guided[0]
                result = (conditioning, latent)
        values = result.args if hasattr(result, "args") else result
        conditioning, latent = values
        latent = dict(latent, fasth3_encoder_execution=evidence)
        return conditioning, latent
