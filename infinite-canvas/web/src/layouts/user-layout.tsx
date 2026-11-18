import { lazy, Suspense, type ReactNode } from "react";

import { AppTopNav } from "@/components/layout/app-top-nav";
import { DSH_EMBEDDED } from "@/constant/runtime-config";

const AgentPet = DSH_EMBEDDED ? null : lazy(() => import("@/components/agent/agent-pet").then((module) => ({ default: module.AgentPet })));

export default function UserLayout({ children }: { children: ReactNode }) {
    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <AppTopNav />
                <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            </div>
            {AgentPet ? (
                <Suspense fallback={null}>
                    <AgentPet />
                </Suspense>
            ) : null}
        </div>
    );
}
