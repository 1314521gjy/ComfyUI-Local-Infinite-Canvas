import type { FreeWorkflowGraph, FreeWorkflowGraphInput, FreeWorkflowGraphNode, FreeWorkflowParam } from "@/services/api/free-workflow";
import type { CustomWorkflowMode } from "@/stores/use-custom-workflow-store";

export const CW_INPUT_MIME = "application/x-cw-input";

export function graphInputMinZoom() {
    return 0.4;
}

const FIELD_LABELS: Record<string, string> = {
    steps: "步数",
    cfg: "CFG",
    denoise: "降噪",
    sampler_name: "采样器",
    sampler: "采样器",
    scheduler: "调度器",
    strength_model: "LoRA 强度",
    strength_clip: "LoRA 强度（CLIP）",
    guidance: "引导强度",
    guidance_scale: "引导强度",
    negative: "负面提示词",
    prompt: "提示词",
    text: "文本",
    seed: "种子",
    noise_seed: "种子",
    width: "宽度",
    height: "高度",
    batch_size: "批次",
    length: "长度",
    frames: "帧数",
    seconds: "时长",
    aspect_ratio: "画幅",
    resolution: "分辨率",
    unet_name: "模型",
    ckpt_name: "检查点",
    vae_name: "解码器",
    clip_name: "文本编码器",
    clip_name1: "文本编码器 1",
    clip_name2: "文本编码器 2",
    lora_name: "LoRA",
    weight_dtype: "权重精度",
    device: "运行设备",
    filename_prefix: "文件名前缀",
    image: "图片",
    model_name: "模型",
    upscale_model: "放大模型",
    mask: "蒙版",
    noise_mask: "噪声蒙版",
    latent: "潜空间",
    clip_vision: "视觉编码器",
    control_net: "ControlNet",
    sigmas: "Sigma 序列",
};

const NODE_TITLE_ZH: Record<string, string> = {
    "Load VAE": "加载解码器",
    "Load Image": "加载图片",
    "Load Image Mask": "加载蒙版",
    "Load Upscale Model": "加载放大模型",
    "Load Diffusion Model": "加载模型",
    "Load CLIP": "加载文本编码器",
    "Load Dual CLIP": "加载双文本编码器",
    "Load Checkpoint": "加载检查点",
    "Load LoRA": "加载 LoRA",
    "Load CLIP Vision": "加载视觉编码器",
    "Load ControlNet Model": "加载 ControlNet",
    "Upscale Image (using Model)": "图像放大",
    "Upscale Image": "图像放大",
    "Upscale Latent": "潜空间放大",
    KSampler: "采样器",
    "KSampler (Advanced)": "高级采样器",
    "KSampler Advanced": "高级采样器",
    "CLIP Text Encode (Prompt)": "提示词编码",
    "CLIP Text Encode (Negative)": "负面提示词编码",
    "CLIP Text Encode": "文本编码",
    "Empty Latent Image": "空潜空间",
    "VAE Decode": "解码输出",
    "VAE Encode": "编码输入",
    "VAE Encode (for Inpainting)": "重绘编码",
    "Save Image": "保存图片",
    "Preview Image": "预览图片",
    "Conditioning Zero Out": "零化条件",
    "Conditioning (Set Mask)": "条件蒙版",
    "Set Latent Noise Mask": "设置噪声蒙版",
    "Image Upscale With Model": "图像放大",
};

export function zhNodeTitle(title: string) {
    return NODE_TITLE_ZH[title] || title;
}

const MODEL_FILE_INPUTS = new Set(["unet_name", "ckpt_name", "clip_name", "clip_name1", "clip_name2", "vae_name", "lora_name", "upscale_model", "control_net", "clip_vision", "model_name"]);

export function isModelFileInput(name: string) {
    return MODEL_FILE_INPUTS.has(String(name || "").toLowerCase());
}

export function zhInputLabel(name: string, fallback: string) {
    return FIELD_LABELS[String(name || "").toLowerCase()] || fallback;
}

export function workflowFieldKey(node: string, input: string) {
    return `f_${node}_${input}`.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function workflowFieldLabel(node: FreeWorkflowGraphNode, input: FreeWorkflowGraphInput) {
    const title = `${node.title} ${node.class_type}`.toLowerCase();
    if (/negative/.test(input.name.toLowerCase()) || /negative/.test(title)) return "负面提示词";
    return FIELD_LABELS[input.name.toLowerCase()] || input.label || input.name.replace(/_/g, " ");
}

export function createWorkflowField(node: FreeWorkflowGraphNode, input: FreeWorkflowGraphInput): FreeWorkflowParam {
    const type = input.type === "select" ? "select" : input.type === "boolean" ? "boolean" : input.type === "number" ? "number" : "string";
    const raw = input.value;
    const value = type === "number" ? Number(raw) || 0 : type === "boolean" ? Boolean(raw) : String(raw ?? "");
    return {
        key: workflowFieldKey(node.id, input.name),
        node: node.id,
        input: input.name,
        label: workflowFieldLabel(node, input),
        group: node.title || node.class_type || "参数",
        type,
        value,
        options: input.options || [],
        ...(type === "number" ? { min: 0, max: Math.max(Number(raw) * 2 || 10, 10), step: Number(raw) > 0 && Number(raw) < 5 ? 0.1 : 1 } : {}),
    };
}

type Role = "negative" | "steps" | "cfg" | "denoise" | "sampler" | "scheduler" | "guidance" | "lora_strength";

const MODE_ROLES: Record<CustomWorkflowMode, Role[]> = {
    t2i: ["negative", "steps", "cfg", "denoise", "sampler", "scheduler", "guidance", "lora_strength"],
    i2i: ["negative", "denoise", "steps", "cfg", "sampler", "scheduler", "guidance", "lora_strength"],
    edit: ["negative", "denoise", "steps", "cfg", "sampler", "scheduler", "guidance", "lora_strength"],
    text: ["negative", "steps", "cfg", "denoise", "sampler", "scheduler", "guidance", "lora_strength"],
    frames: ["negative", "steps", "cfg", "denoise", "sampler", "scheduler", "guidance", "lora_strength"],
    reference: ["negative", "steps", "cfg", "denoise", "sampler", "scheduler", "guidance", "lora_strength"],
    generic: ["negative", "steps", "cfg", "denoise", "sampler", "scheduler", "guidance"],
};

function roleFor(node: FreeWorkflowGraphNode, input: FreeWorkflowGraphInput): Role | null {
    const name = input.name.toLowerCase();
    const title = `${node.title} ${node.class_type}`.toLowerCase();
    if (/negative/.test(name) || /negative/.test(title)) return "negative";
    if (/^steps$/.test(name)) return "steps";
    if (/^cfg$/.test(name)) return "cfg";
    if (/denoise/.test(name)) return "denoise";
    if (/strength_model|strength_clip|^strength$/.test(name)) return "lora_strength";
    if (/sampler/.test(name)) return "sampler";
    if (/scheduler/.test(name)) return "scheduler";
    if (/guidance/.test(name)) return "guidance";
    return null;
}

export function isCardManagedInput(node: FreeWorkflowGraphNode, input: FreeWorkflowGraphInput) {
    const name = input.name.toLowerCase();
    const title = `${node.title} ${node.class_type}`.toLowerCase();
    if (/negative/.test(name) || /negative/.test(title)) return false;
    if (/strength_model|strength_clip|^strength$/.test(name)) return false;
    if (/prompt|positive|text/.test(name) || /clip.?text|text.?encode/.test(title)) return true;
    if (/^(width|height|seed|noise_seed|batch_size|count|length|frames|seconds|aspect_ratio|resolution|audio|transparent|image|mask)$/.test(name)) return true;
    return false;
}

export function isSpecialWorkflowInput(node: FreeWorkflowGraphNode, input: FreeWorkflowGraphInput) {
    return input.literal && !isCardManagedInput(node, input) && roleFor(node, input) !== null;
}

export function reconcileWorkflowFields(fields: FreeWorkflowParam[], graph: FreeWorkflowGraph | null): FreeWorkflowParam[] {
    if (!graph?.nodes.length) return fields;
    const inputs = new Map<string, FreeWorkflowGraphInput>();
    const all: Array<{ node: string; title: string; classType: string; input: FreeWorkflowGraphInput }> = [];
    for (const node of graph.nodes) {
        for (const input of node.inputs) {
            inputs.set(node.id + ":" + input.name, input);
            all.push({ node: node.id, title: node.title || "", classType: node.class_type || "", input });
        }
    }
    return fields.map((field) => {
        let node = field.node;
        let input = inputs.get(field.node + ":" + field.input);
        // 工作流重导或换页后节点 id 可能变了；按输入名唯一命中时把字段接回新节点。
        if (!input) {
            let candidates = all.filter((item) => item.input.name === field.input && item.input.literal);
            // 先按当前值收敛：值一致才说明是同一路参数，比分组/类名更可靠。
            if (candidates.length > 1) {
                const byValue = candidates.filter((item) => String(item.input.value ?? "") === String(field.value ?? ""));
                if (byValue.length) candidates = byValue;
            }
            if (candidates.length > 1 && field.group) {
                const byGroup = candidates.filter((item) => item.title === field.group || item.classType === field.group);
                if (byGroup.length) candidates = byGroup;
            }
            // 再按输入名对应的 loader 类收敛，例如 lora_name 只落在 LoraLoader* 上。
            if (candidates.length > 1) {
                const pattern = /lora/i.test(field.input) ? /lora/i : /unet|checkpoint|ckpt/i.test(field.input) ? /unet|checkpoint|ckpt/i : /vae/i.test(field.input) ? /vae/i : /clip/i.test(field.input) ? /clip/i : null;
                if (pattern) {
                    const byClass = candidates.filter((item) => pattern.test(item.classType) || pattern.test(item.title));
                    if (byClass.length) candidates = byClass;
                }
            }
            // 仍是多个节点但携带同一个文件值时，选任意一个对图没有副作用。
            if (candidates.length > 1) {
                const values = new Set(candidates.map((item) => String(item.input.value ?? "")));
                if (values.size === 1) candidates = [candidates[0]];
            }
            if (candidates.length === 1) {
                node = candidates[0].node;
                input = candidates[0].input;
            }
        }
        if (!input) return field;
        // 旧字段可能是在 ComfyUI 未就绪时加的，只存成纯文本且没有选项；这里按当前图补回类型和选项。
        const type = input.type === "select" || input.type === "boolean" || input.type === "number" || input.type === "string" ? input.type : field.type;
        const options = input.options?.length ? input.options : field.options;
        const label = zhInputLabel(field.input, field.label);
        if (type === field.type && options === field.options && label === field.label && node === field.node) return field;
        return { ...field, node, type, options, label };
    });
}

export function suggestWorkflowFields(graph: FreeWorkflowGraph | null, mode: CustomWorkflowMode) {
    if (!graph?.nodes.length) return [];
    const roles = new Set(MODE_ROLES[mode] || MODE_ROLES.generic);
    const found = new Map<Role, FreeWorkflowParam>();
    for (const node of graph.nodes) {
        const loaderLike = /loader|lora|vae|unet|checkpoint|save|preview/i.test(node.class_type);
        for (const input of node.inputs) {
            if (!input.literal) continue;
            const role = roleFor(node, input);
            if (!role || !roles.has(role) || found.has(role)) continue;
            if (loaderLike && role !== "lora_strength") continue;
            if (role === "negative" && !/negative/i.test(`${input.name} ${node.title} ${node.class_type}`)) continue;
            found.set(role, createWorkflowField(node, input));
        }
    }
    return [...MODE_ROLES[mode] || MODE_ROLES.generic].map((role) => found.get(role)).filter((field): field is FreeWorkflowParam => Boolean(field)).slice(0, 8);
}
