export default function (runtime) {
    const { React } = runtime;
    const h = React.createElement;
    const { useEffect, useState } = React;
    const NODE_TYPE = "comfyui-lora:lora";
    const INTERNAL_LORAS = new Set(["MOSS-Image-SFT-8-steps.safetensors"]);

    const inputStyle = (theme) => ({
        width: "100%",
        boxSizing: "border-box",
        padding: "6px 8px",
        borderRadius: 6,
        border: `1px solid ${theme.node.stroke}`,
        background: theme.node.panel,
        color: theme.node.text,
        fontSize: 12,
        outline: "none",
    });

    function readSpec(node) {
        const loras = node.metadata?.params?.loras;
        return Array.isArray(loras) && loras[0] ? loras[0] : null;
    }

    const STRENGTH_MIN = -6;
    const STRENGTH_MAX = 6;
    const CENTER_SLOPE = 2.6;

    function shortName(name) {
        return String(name || "").split(/[\\/]/).pop() || "";
    }

    function folderName(name) {
        const normalized = String(name || "");
        const index = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
        return index >= 0 ? normalized.slice(0, index) : "";
    }

    function snapStrength(value) {
        const snapped = Math.round((Number(value) || 0) * 20) / 20;
        return Object.is(snapped, -0) ? 0 : snapped;
    }

    // 滑块位置 0..1 → 强度 -6..+6；±1 占中间 50%，两端灵敏度更高；强度按 0.05 吸附。
    function sliderToStrength(value) {
        const x = Math.max(-1, Math.min(1, Number(value) * 2 - 1));
        return snapStrength(Math.sign(x) * Math.pow(Math.abs(x), CENTER_SLOPE) * STRENGTH_MAX);
    }

    function strengthToSlider(strength) {
        const value = Math.max(STRENGTH_MIN, Math.min(STRENGTH_MAX, Number(strength) || 0));
        const x = Math.sign(value) * Math.pow(Math.abs(value) / STRENGTH_MAX, 1 / CENTER_SLOPE);
        return Math.max(0, Math.min(1, (x + 1) / 2));
    }

    function Content({ ctx }) {
        const theme = ctx.theme;
        const spec = readSpec(ctx.node);
        return h(
            "div",
            { style: { height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", gap: 5, padding: "10px 12px", color: theme.node.text, overflow: "hidden" } },
            h(
                "div",
                { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, color: theme.node.muted, fontSize: 10, lineHeight: 1.2 } },
                h("span", { style: { letterSpacing: ".04em" } }, "LORA"),
                h("span", { style: { fontVariantNumeric: "tabular-nums" } }, spec ? Number(spec.strength).toFixed(2) : "—"),
            ),
            h("div", { style: { fontSize: 13, fontWeight: 600, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, spec ? shortName(spec.name) : "未选择"),
            h("div", { style: { color: theme.node.faint, fontSize: 10, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, spec ? folderName(spec.name) || "根目录" : "点击设置"),
        );
    }

    function Panel({ ctx }) {
        const theme = ctx.theme;
        const spec = readSpec(ctx.node);
        const [name, setName] = useState(spec?.name || "");
        const [strength, setStrength] = useState(snapStrength(spec?.strength ?? 0.8));
        const [options, setOptions] = useState([]);

        useEffect(() => {
            let alive = true;
            ctx.ai
                .listLoras()
                .then((items) => {
                    if (alive) setOptions((Array.isArray(items) ? items : []).filter((item) => !INTERNAL_LORAS.has(shortName(item))));
                })
                .catch(() => undefined);
            return () => {
                alive = false;
            };
        }, [ctx.ai]);

        const apply = (nextName, nextStrength) => {
            const loras = String(nextName || "").trim() ? [{ name: String(nextName).trim(), strength: Number(nextStrength) || 0 }] : [];
            ctx.updateMetadata({ params: { ...(ctx.node.metadata?.params || {}), loras } });
        };

        const groups = [];
        for (const option of options) {
            const folder = folderName(option) || "根目录";
            let group = groups.find((item) => item.folder === folder);
            if (!group) {
                group = { folder, items: [] };
                groups.push(group);
            }
            group.items.push(option);
        }

        return h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 10, padding: "10px 2px 2px", color: theme.node.text, fontSize: 12 } },
            h(
                "div",
                { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
                h("span", { style: { fontWeight: 600 } }, "LoRA"),
                h("span", { style: { color: theme.node.muted, fontSize: 11 } }, options.length ? `${options.length} 个可用` : "读取中…"),
            ),
            h(
                "select",
                {
                    value: name,
                    onChange: (event) => {
                        const next = event.target.value;
                        setName(next);
                        apply(next, strength);
                    },
                    style: inputStyle(theme),
                },
                h("option", { value: "" }, "选择 LoRA"),
                groups.map((group) =>
                    h(
                        "optgroup",
                        { key: group.folder, label: group.folder },
                        group.items.map((option) => h("option", { key: option, value: option }, shortName(option))),
                    ),
                ),
            ),
            h(
                "label",
                { style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: theme.node.muted } },
                h("span", { style: { display: "flex", justifyContent: "space-between" } }, h("span", null, "强度"), h("span", { style: { fontVariantNumeric: "tabular-nums" } }, strength.toFixed(2))),
                h("input", {
                    type: "range",
                    min: 0,
                    max: 1,
                    step: 0.001,
                    value: strengthToSlider(strength),
                    onChange: (event) => {
                        const next = sliderToStrength(Number(event.target.value));
                        setStrength(next);
                        apply(name, next);
                    },
                    style: { width: "100%", accentColor: theme.node.text },
                }),
                h(
                    "span",
                    { style: { display: "flex", justifyContent: "space-between", color: theme.node.faint, fontSize: 9, fontVariantNumeric: "tabular-nums" } },
                    h("span", null, "-6"),
                    h("span", null, "0"),
                    h("span", null, "+6"),
                ),
            ),
        );
    }

    return {
        id: "comfyui-lora",
        name: "LoRA 叠层",
        version: "1.0.1",
        description: "独立的 LoRA 注入卡：选择 LoRA 与强度，接到图片或视频节点前。",
        defaultEnabled: true,
        nodes: [
            {
                type: NODE_TYPE,
                title: "LoRA",
                icon: h("span", { style: { fontSize: 11, fontWeight: 700 } }, "LoRA"),
                defaultSize: { width: 260, height: 120 },
                defaultMetadata: { params: { loras: [] } },
                showInCreateMenu: true,
                insertBefore: true,
                autoOpenPanel: true,
                hasSourceHandle: true,
                Content,
                Panel,
                resource: (node) => {
                    const item = readSpec(node);
                    return item ? { kind: "lora", loras: [{ name: item.name, strength: Number(item.strength) || 0 }] } : null;
                },
            },
        ],
    };
}
