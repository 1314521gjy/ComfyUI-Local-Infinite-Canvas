import { useEffect, useState } from "react";
import { Clock3 } from "lucide-react";

import { formatElapsedDuration } from "@/lib/media-size";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";

export function CanvasGenerationTimer({ startedAt }: { startedAt: number | null }) {
    const theme = useCanvasTheme();
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (startedAt === null) return;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 200);
        return () => window.clearInterval(timer);
    }, [startedAt]);

    if (startedAt === null) return null;

    return (
        <div className="pointer-events-none absolute right-4 top-20 z-[80]">
            <span
                data-testid="canvas-generation-timer"
                className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium tabular-nums shadow-lg backdrop-blur"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            >
                <Clock3 className="size-3.5 opacity-65" />
                {formatElapsedDuration(now - startedAt)}
            </span>
        </div>
    );
}
