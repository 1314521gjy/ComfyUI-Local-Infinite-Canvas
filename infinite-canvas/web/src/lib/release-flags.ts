// 发布树默认隐藏 dev 新增未发布功能的入口；dev 树保持可见。
export const HIDE_UNRELEASED_FEATURES = import.meta.env.VITE_HIDE_EXPERIMENTAL === "1";

// 发布树隐藏入口的 dev 新增节点类型（代码与已存节点仍保留）。
export const HIDDEN_NODE_TYPES = new Set(["automation", "short-drama", "model3d", "stage3d"]);

// 角色替换入口：发布树隐藏，dev 保持可见。
export const HIDE_CHARACTER_SWAP = true;

// Viggle Remake 角色替换：发布树先隐藏，阶段③复现验收后另行放开。
export const HIDE_VIGGLE_SWAP = false;
