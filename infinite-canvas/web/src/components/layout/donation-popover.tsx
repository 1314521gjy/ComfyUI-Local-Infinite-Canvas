import { useState, type CSSProperties } from "react";
import { App, Button, Popover } from "antd";
import { Copy, Heart } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

const QQ_GROUP = "1129692011";

type DonationPopoverProps = {
    variant?: "default" | "canvas";
    className?: string;
    style?: CSSProperties;
};

export function DonationPopover({ variant = "default", className, style }: DonationPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { message } = App.useApp();
    const [open, setOpen] = useState(false);
    const isCanvas = variant === "canvas";
    const asset = (name: string) => `${import.meta.env.BASE_URL}donate/${name}`;

    const copyGroup = async () => {
        try {
            await navigator.clipboard.writeText(QQ_GROUP);
            message.success("QQ 群号已复制");
        } catch {
            message.error("复制失败，请手动选择群号");
        }
    };

    const content = (
        <div className="w-[min(380px,calc(100vw-32px))] space-y-3">
            <div>
                <div className="text-sm font-semibold">支持 ComfyUI-本地无限画布</div>
                <p className="mt-1 text-xs leading-5 text-stone-600">您的支持是 UP 制作的最大动力，感谢打赏！</p>
                <p className="mt-1 text-xs leading-5 text-stone-500">打赏后欢迎加入 QQ 交流群，一起交流本地部署、工作流和更新。</p>
            </div>

            <div className="mx-auto w-[250px] rounded-xl border border-stone-200 bg-white p-2 text-center">
                <img src={asset("wechat.png")} alt="微信打赏二维码" className="mx-auto h-[255px] w-full object-contain" draggable={false} />
                <div className="mt-1 text-xs font-medium text-stone-700">微信支付</div>
            </div>

            <div className="flex items-center justify-between gap-2 rounded-xl border border-stone-200 bg-stone-50 px-3 py-2">
                <div className="min-w-0 text-xs text-stone-600">
                    QQ 交流群 <span className="font-mono text-sm font-semibold text-stone-900">{QQ_GROUP}</span>
                </div>
                <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void copyGroup()}>
                    复制群号
                </Button>
            </div>
        </div>
    );

    return (
        <Popover content={content} trigger="click" placement="bottomRight" open={open} onOpenChange={setOpen}>
            <Button
                type="text"
                size="small"
                className={className || "!h-7 !rounded-full !px-2.5 !text-xs !font-medium"}
                style={{
                    color: isCanvas ? "#fdba74" : "#ea580c",
                    background: isCanvas ? "rgba(249,115,22,.12)" : "rgba(249,115,22,.08)",
                    border: "1px solid rgba(249,115,22,.28)",
                    ...style,
                }}
                icon={<Heart className="size-3.5" />}
                aria-label="打赏加群"
                title="打赏加群"
            >
                <span className="hidden sm:inline">打赏加群</span>
            </Button>
        </Popover>
    );
}
