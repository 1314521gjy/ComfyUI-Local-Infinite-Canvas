export default function (runtime) {
    const { React, antd } = runtime;
    const h = React.createElement;
    const { useEffect, useState } = React;
    const { Button, InputNumber, Select } = antd;
    const NODE_TYPE = "comfyui-lora:lora";
    const INTERNAL_LORAS = new Set(["MOSS-Image-SFT-8-steps.safetensors"]);
    const MAX_LORAS = 10;
    const STRENGTH_MIN = -6;
    const STRENGTH_MAX = 6;

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

    function readLoras(node, keepEmpty = false) {
        const loras = node.metadata?.params?.loras;
        if (!Array.isArray(loras)) return [];
        return loras
            .filter((item) => item && (keepEmpty || String(item.name || "").trim()))
            .slice(0, MAX_LORAS)
            .map((item) => ({ name: String(item.name || "").trim(), strength: snapStrength(item.strength) }));
    }

    function initialRows(node) {
        // 空行也要保留：元数据更新会让面板重挂载，否则刚加的行会被丢掉。
        const loras = readLoras(node, true);
        return loras.length ? loras : [{ name: "", strength: 0.8 }];
    }

    function Content({ ctx }) {
        const theme = ctx.theme;
        const loras = readLoras(ctx.node);
        const first = loras[0];
        const count = loras.length;
        return h(
            "div",
            { style: { height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", gap: 5, padding: "10px 12px", color: theme.node.text, overflow: "hidden" } },
            h(
                "div",
                { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, color: theme.node.muted, fontSize: 10, lineHeight: 1.2 } },
                h("span", { style: { letterSpacing: ".04em" } }, count > 1 ? `LORA ×${count}` : "LORA"),
                h("span", { style: { fontVariantNumeric: "tabular-nums" } }, count ? (count > 1 ? `${count} 项` : Number(first.strength).toFixed(2)) : "—"),
            ),
            h("div", { style: { fontSize: 13, fontWeight: 600, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, count ? (count > 1 ? `${shortName(first.name)} +${count - 1}` : shortName(first.name)) : "未选择"),
            h(
                "div",
                { style: { color: theme.node.faint, fontSize: 10, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                count ? (count > 1 ? loras.slice(0, 3).map((lora) => shortName(lora.name)).join(" · ") : folderName(first.name) || "根目录") : "点击设置",
            ),
        );
    }

    function Panel({ ctx }) {
        const theme = ctx.theme;
        const [rows, setRows] = useState(() => initialRows(ctx.node));
        const [options, setOptions] = useState([]);

        useEffect(() => {
            setRows(initialRows(ctx.node));
        }, [ctx.node.id]);

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

        const commit = (nextRows) => {
            setRows(nextRows);
            const loras = nextRows.map((row) => ({ name: String(row.name || "").trim(), strength: snapStrength(row.strength) }));
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
        const groupedOptions = groups.map((group) => ({ label: group.folder, options: group.items.map((option) => ({ value: option, label: shortName(option) })) }));

        return h(
            "div",
            {
                className: "rounded-2xl border p-3 shadow-2xl backdrop-blur",
                "data-canvas-no-zoom": true,
                style: { display: "flex", flexDirection: "column", gap: 8, width: "min(560px, calc(100vw - 32px))", background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text, fontSize: 12 },
                onMouseDown: (event) => event.stopPropagation(),
                onPointerDown: (event) => event.stopPropagation(),
                onWheel: (event) => event.stopPropagation(),
            },
            h(
                "div",
                { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
                h("span", { style: { fontWeight: 600 } }, "LoRA"),
                h("span", { style: { color: theme.node.muted, fontSize: 11 } }, options.length ? `${options.length} 个可用 · 最多 ${MAX_LORAS} 个` : "读取中…"),
            ),
            h(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: 6, maxHeight: 380, overflowY: "auto" } },
                rows.map((row, index) =>
                    h(
                        "div",
                        { key: index, style: { display: "flex", alignItems: "center", gap: 6 } },
                        h(Select, {
                            size: "small",
                            showSearch: true,
                            value: row.name || undefined,
                            placeholder: "选择 LoRA",
                            options: groupedOptions,
                            optionFilterProp: "label",
                            popupMatchSelectWidth: 320,
                            style: { flex: 1, minWidth: 0 },
                            onChange: (value) => commit(rows.map((item, itemIndex) => (itemIndex === index ? { ...item, name: value } : item))),
                        }),
                        h(InputNumber, {
                            size: "small",
                            min: STRENGTH_MIN,
                            max: STRENGTH_MAX,
                            step: 0.05,
                            precision: 2,
                            value: row.strength,
                            style: { width: 78, flex: "none" },
                            onChange: (value) => commit(rows.map((item, itemIndex) => (itemIndex === index ? { ...item, strength: snapStrength(value ?? 0) } : item))),
                        }),
                        h(
                            Button,
                            {
                                size: "small",
                                type: "text",
                                title: "移除这条 LoRA",
                                disabled: rows.length <= 1 && !row.name,
                                onClick: () => {
                                    const next = rows.filter((_, itemIndex) => itemIndex !== index);
                                    commit(next.length ? next : [{ name: "", strength: 0.8 }]);
                                },
                            },
                            "×",
                        ),
                    ),
                ),
            ),
            h(
                Button,
                {
                    size: "small",
                    type: "dashed",
                    block: true,
                    disabled: rows.length >= MAX_LORAS,
                    onClick: () => {
                        if (rows.length >= MAX_LORAS) return;
                        commit([...rows, { name: "", strength: 0.8 }]);
                    },
                },
                rows.length >= MAX_LORAS ? `已达上限 ${MAX_LORAS} 个` : "+ 添加 LoRA",
            ),
        );
    }

    return {
        id: "comfyui-lora",
        name: "LoRA 叠层",
        version: "1.1.1",
        description: "独立的 LoRA 注入卡：最多叠加 10 个 LoRA 并分别调节强度，接到图片或视频节点前。",
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
                    const loras = readLoras(node);
                    return loras.length ? { kind: "lora", loras } : null;
                },
            },
        ],
    };
}
