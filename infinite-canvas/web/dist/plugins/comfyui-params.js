export default function (runtime) {
    const { React } = runtime;
    const h = React.createElement;
    const { useEffect, useMemo, useState } = React;
    const NODE_TYPE = "comfyui-params:workflow";

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

    const labelStyle = (theme) => ({ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: theme.node.muted });

    const buttonStyle = (theme) => ({
        padding: "6px 10px",
        borderRadius: 6,
        border: `1px solid ${theme.node.stroke}`,
        background: "transparent",
        color: theme.node.text,
        fontSize: 12,
        cursor: "pointer",
        fontWeight: 600,
    });

    function useModels(ctx) {
        return useMemo(() => {
            const images = ctx.ai.listModels("image");
            const videos = ctx.ai.listModels("video");
            return { images, videos, all: [...images, ...videos] };
        }, [ctx.ai]);
    }

    function useModelSchema(ctx, model) {
        const [state, setState] = useState({ schema: null, loading: false });
        useEffect(() => {
            if (!model) {
                setState({ schema: null, loading: false });
                return undefined;
            }
            let alive = true;
            setState({ schema: null, loading: true });
            ctx.ai
                .getModelSchema(model)
                .then((schema) => {
                    if (alive) setState({ schema, loading: false });
                })
                .catch(() => {
                    if (alive) setState({ schema: null, loading: false });
                });
            return () => {
                alive = false;
            };
        }, [ctx.ai, model]);
        return state;
    }

    function pickModel(ctx, models) {
        const saved = ctx.node.metadata?.model;
        if (saved && models.all.some((item) => item.value === saved)) return saved;
        return models.images[0]?.value || models.videos[0]?.value || "";
    }

    function Content({ ctx }) {
        const theme = ctx.theme;
        const models = useModels(ctx);
        const model = pickModel(ctx, models);
        const label = models.all.find((item) => item.value === model)?.label || "未选择模型";
        const content = ctx.node.metadata?.content;
        const mimeType = String(ctx.node.metadata?.mimeType || "");
        const [resolved, setResolved] = useState(content);
        useEffect(() => {
            let alive = true;
            const storageKey = ctx.node.metadata?.storageKey;
            if (!storageKey) {
                setResolved(content);
                return undefined;
            }
            ctx.ai
                .resolveMedia(storageKey)
                .then((url) => {
                    if (alive && url) setResolved(url);
                })
                .catch(() => {
                    if (alive) setResolved(content);
                });
            return () => {
                alive = false;
            };
        }, [ctx.ai, ctx.node.metadata?.storageKey, content]);
        const isVideo = mimeType.startsWith("video/") || /^data:video\//i.test(String(resolved || "")) || /\.(mp4|webm|mov)(\?|$)/i.test(String(resolved || ""));

        return h(
            "div",
            { style: { height: "100%", display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px", color: theme.node.text, fontSize: 12, overflow: "hidden" } },
            h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 } },
                h("span", { style: { fontWeight: 600, whiteSpace: "nowrap" } }, "ComfyUI 参数"),
                h("span", { style: { color: theme.node.muted, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, label),
            ),
            resolved
                ? isVideo
                    ? h("video", {
                          src: resolved,
                          controls: true,
                          muted: true,
                          loop: true,
                          style: { width: "100%", flex: 1, minHeight: 0, objectFit: "contain", borderRadius: 6, background: theme.node.fill },
                      })
                    : h("img", {
                          src: resolved,
                          alt: "",
                          draggable: false,
                          style: { width: "100%", flex: 1, minHeight: 0, objectFit: "contain", borderRadius: 6, background: theme.node.fill },
                      })
                : h(
                      "div",
                      {
                          style: {
                              flex: 1,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              border: `1px dashed ${theme.node.stroke}`,
                              borderRadius: 6,
                              color: theme.node.muted,
                              fontSize: 11,
                              textAlign: "center",
                              padding: 8,
                          },
                      },
                      "点击节点设置模型与参数",
                  ),
        );
    }

    function Panel({ ctx, onClose }) {
        const theme = ctx.theme;
        const models = useModels(ctx);
        const [model, setModel] = useState(() => pickModel(ctx, models));
        const { schema, loading } = useModelSchema(ctx, model);
        const [values, setValues] = useState({});
        const [prompt, setPrompt] = useState(ctx.node.metadata?.prompt || "");
        const [size, setSize] = useState(ctx.node.metadata?.size || "");
        const [seconds, setSeconds] = useState(ctx.node.metadata?.seconds || "");
        const [busy, setBusy] = useState(false);
        const [message, setMessage] = useState("");
        const isVideo = models.videos.some((item) => item.value === model);
        const storageKey = `params:${ctx.node.id}:${model}`;

        useEffect(() => {
            if (!model && models.all.length) setModel(pickModel(ctx, models));
        }, [model, models.all.length]);

        useEffect(() => {
            if (!schema) {
                setValues({});
                return undefined;
            }
            let alive = true;
            const defaults = Object.fromEntries(
                (schema.parameters || []).map((parameter) => [parameter.key, parameter.default === undefined ? (parameter.type === "boolean" ? false : "") : parameter.default]),
            );
            ctx.storage
                .get(storageKey)
                .then((saved) => {
                    if (alive) setValues({ ...defaults, ...(saved && typeof saved === "object" ? saved : {}) });
                })
                .catch(() => {
                    if (alive) setValues(defaults);
                });
            return () => {
                alive = false;
            };
        }, [schema, storageKey]);

        const setValue = (key, value) => setValues((prev) => ({ ...prev, [key]: value }));

        const generate = async () => {
            if (!model) {
                setMessage("没有可用模型，请先在配置里拉取模型列表");
                return;
            }
            if (!prompt.trim()) {
                setMessage("请输入提示词");
                return;
            }
            const params = {};
            for (const parameter of schema?.parameters || []) {
                const value = values[parameter.key];
                if (value === "" || value === undefined || value === null) continue;
                params[parameter.key] = value;
            }
            const references = isVideo
                ? ctx
                      .getUpstream()
                      .filter((node) => node.type === "image" && node.metadata?.content)
                      .map((node) => node.metadata.content)
                      .filter(Boolean)
                : [];
            if (isVideo && /ref2va/.test(model) && references.length < 3) {
                setMessage("ref2va 需要连接 3 个上游图片节点");
                return;
            }
            setBusy(true);
            setMessage("生成中…");
            try {
                if (isVideo) {
                    const result = await ctx.ai.generateVideo(prompt.trim(), {
                        model,
                        params,
                        ...(references.length ? { references } : {}),
                        ...(size.trim() ? { size: size.trim() } : {}),
                        ...(seconds.trim() ? { seconds: seconds.trim() } : {}),
                    });
                    ctx.updateMetadata({ content: result.url, storageKey: result.storageKey, mimeType: result.mimeType, durationMs: result.durationMs, model, prompt });
                } else {
                    const result = await ctx.ai.generateImage(prompt.trim(), {
                        model,
                        params,
                        count: 1,
                        ...(size.trim() ? { size: size.trim() } : {}),
                    });
                    if (!result.images?.length) throw new Error("没有返回图片");
                    ctx.updateMetadata({ content: result.images[0], model, prompt });
                }
                await ctx.storage.set(storageKey, values);
                setMessage("完成");
            } catch (error) {
                setMessage(`失败：${error?.message || error}`);
            } finally {
                setBusy(false);
            }
        };

        const renderParameter = (parameter) => {
            const value = values[parameter.key];
            if (parameter.type === "boolean") {
                return h(
                    "label",
                    { key: parameter.key, style: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: theme.node.muted } },
                    h("input", { type: "checkbox", checked: Boolean(value), disabled: busy, onChange: (event) => setValue(parameter.key, event.target.checked) }),
                    h("span", null, parameter.label || parameter.key),
                );
            }
            const control =
                parameter.type === "select"
                    ? h(
                          "select",
                          { value: value === undefined || value === null ? "" : String(value), disabled: busy, onChange: (event) => setValue(parameter.key, event.target.value), style: inputStyle(theme) },
                          (parameter.options || []).map((option) => {
                              const item = typeof option === "string" ? { value: option, label: option } : option;
                              return h("option", { key: item.value, value: item.value }, item.label || item.value);
                          }),
                      )
                    : h("input", {
                          type: parameter.type === "number" ? "number" : "text",
                          value: value === undefined || value === null ? "" : value,
                          min: parameter.min,
                          max: parameter.max,
                          step: parameter.step,
                          placeholder: parameter.description || "",
                          disabled: busy,
                          onChange: (event) => {
                              const raw = event.target.value;
                              setValue(parameter.key, parameter.type === "number" ? (raw === "" ? "" : Number(raw)) : raw);
                          },
                          style: inputStyle(theme),
                      });
            return h("label", { key: parameter.key, style: labelStyle(theme) }, h("span", null, parameter.label || parameter.key), control);
        };

        if (!models.all.length) {
            return h("div", { style: { padding: 12, color: theme.node.muted, fontSize: 12 } }, "还没有可用模型，请先在配置中拉取本地工作流。");
        }

        return h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 10, padding: "10px 2px 2px", color: theme.node.text, fontSize: 12 } },
            h(
                "div",
                { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
                h("span", { style: { fontWeight: 600 } }, "ComfyUI 动态参数"),
                h("button", { type: "button", onClick: onClose, style: { ...buttonStyle(theme), fontWeight: 400, padding: "4px 8px" } }, "关闭"),
            ),
            h(
                "select",
                {
                    value: model,
                    disabled: busy,
                    onChange: (event) => {
                        setModel(event.target.value);
                        ctx.updateMetadata({ model: event.target.value });
                        setMessage("");
                    },
                    style: inputStyle(theme),
                },
                models.images.length ? h("optgroup", { label: "图片" }, models.images.map((item) => h("option", { key: item.value, value: item.value }, item.label))) : null,
                models.videos.length ? h("optgroup", { label: "视频" }, models.videos.map((item) => h("option", { key: item.value, value: item.value }, item.label))) : null,
            ),
            h("textarea", {
                value: prompt,
                rows: 3,
                disabled: busy,
                placeholder: "提示词",
                onChange: (event) => setPrompt(event.target.value),
                style: { ...inputStyle(theme), resize: "vertical", minHeight: 64 },
            }),
            h(
                "div",
                { style: { display: "grid", gridTemplateColumns: isVideo ? "1fr 1fr" : "1fr", gap: 8 } },
                h("input", { value: size, disabled: busy, placeholder: "尺寸，留空用默认", onChange: (event) => setSize(event.target.value), style: inputStyle(theme) }),
                isVideo ? h("input", { value: seconds, disabled: busy, placeholder: "时长（秒），留空用默认", onChange: (event) => setSeconds(event.target.value), style: inputStyle(theme) }) : null,
            ),
            loading ? h("div", { style: { color: theme.node.muted, fontSize: 11 } }, "读取工作流参数…") : null,
            schema && schema.parameters?.length ? h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } }, schema.parameters.map(renderParameter)) : null,
            !loading && schema && !schema.parameters?.length ? h("div", { style: { color: theme.node.muted, fontSize: 11 } }, "该工作流没有声明可调参数。") : null,
            !loading && !schema ? h("div", { style: { color: theme.node.muted, fontSize: 11 } }, "无法读取工作流参数，请确认网关在线。") : null,
            h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: 8 } },
                h("button", { type: "button", disabled: busy || !model, onClick: generate, style: { ...buttonStyle(theme), opacity: busy || !model ? 0.5 : 1 } }, busy ? "生成中…" : "生成"),
                message ? h("span", { style: { color: theme.node.muted, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, message) : null,
            ),
        );
    }

    return {
        id: "comfyui-params",
        name: "ComfyUI 动态参数",
        version: "1.0.0",
        description: "按网关工作流 schema 动态生成参数表单，直接调用本地 ComfyUI 模型。",
        defaultEnabled: true,
        nodes: [
            {
                type: NODE_TYPE,
                title: "ComfyUI 参数",
                icon: h("span", { style: { fontSize: 14, fontWeight: 700 } }, "参"),
                // 与自由卡片重复的 raw schema 编辑器；保留运行时以兼容已有节点，但不进入新建菜单。
                showInCreateMenu: false,
                defaultSize: { width: 340, height: 260 },
                defaultMetadata: { model: "", prompt: "" },
                autoOpenPanel: true,
                Content,
                Panel,
            },
        ],
    };
}
