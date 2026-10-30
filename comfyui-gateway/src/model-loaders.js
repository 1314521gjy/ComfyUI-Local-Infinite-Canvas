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
    // llama-cpp 的 LLM 权重和视觉投影是两个不同输入，不能共用一个选项列表。
    { classType: "llama_cpp_model_loader", input: "model", key: "llmModel", dirs: ["LLM"] },
    { classType: "llama_cpp_model_loader", input: "mmproj", key: "llmMmproj", dirs: ["LLM"] },
];

const MODEL_FILE_PATTERN = /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx)$/i;
const NON_MODEL_INPUT = /^(image|images|video|videos|audio|audios|file|filename|mask|prompt|text)$/i;
const NON_MODEL_CLASS = /LoadImage|LoadVideo|LoadAudio|Upload|Preview|Save|VHS_/i;

// 用户装的第三方 loader（LoraLoaderBypassModelOnly、GGUF 加载器等）不在静态清单里；
// 从 /object_info 里动态发现“选项全是模型文件”的输入，别名体系就能自动覆盖。
export function discoverModelLoaderSpecs(objectInfo, baseSpecs = MODEL_LOADER_SPECS) {
    const specs = [...baseSpecs];
    const seen = new Set(specs.map((spec) => `${spec.classType}\u0000${spec.input}`));
    for (const [classType, info] of Object.entries(objectInfo || {})) {
        if (!info || NON_MODEL_CLASS.test(classType)) continue;
        for (const group of [info.input?.required, info.input?.optional]) {
            if (!group || typeof group !== "object") continue;
            for (const [input, definition] of Object.entries(group)) {
                if (NON_MODEL_INPUT.test(input)) continue;
                const options = Array.isArray(definition?.[0]) ? definition[0] : Array.isArray(definition?.[1]?.options) ? definition[1].options : null;
                if (!options?.length) continue;
                if (!options.every((value) => typeof value === "string" && MODEL_FILE_PATTERN.test(value))) continue;
                const key = `${classType}\u0000${input}`;
                if (seen.has(key)) continue;
                seen.add(key);
                specs.push({ classType, input, key: `${classType}.${input}`, dirs: [] });
            }
        }
    }
    return specs;
}
