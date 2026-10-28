// ComfyUI 里“模型文件名”类输入的统一清单；扫描校验和运行时别名都从这里取。
export const MODEL_LOADER_SPECS = [
    { classType: "CheckpointLoaderSimple", input: "ckpt_name", key: "checkpoints", dirs: ["checkpoints"] },
    { classType: "UNETLoader", input: "unet_name", key: "unets", dirs: ["diffusion_models"] },
    { classType: "UpscaleModelLoader", input: "model_name", key: "upscaleModels", dirs: ["upscale_models"] },
    { classType: "SeedVR2LoadDiTModel", input: "model", key: "seedvr2Dit", dirs: ["upscale_models"] },
    { classType: "SeedVR2LoadVAEModel", input: "model", key: "seedvr2Vae", dirs: ["upscale_models"] },
    { classType: "CLIPLoader", input: "clip_name", key: "clips", dirs: ["text_encoders"] },
    { classType: "VAELoader", input: "vae_name", key: "vaes", dirs: ["vae"] },
    { classType: "LoraLoader", input: "lora_name", key: "loras", dirs: ["loras"] },
    { classType: "LoraLoaderModelOnly", input: "lora_name", key: "lorasModelOnly", dirs: ["loras"] },
    { classType: "ApplyVDNH3Advanced", input: "vdn_checkpoint", key: "vdn", dirs: ["vdn"] },
];
