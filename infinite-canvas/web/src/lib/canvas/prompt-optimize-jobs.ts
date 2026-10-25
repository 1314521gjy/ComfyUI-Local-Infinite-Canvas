const controllers = new Map<string, AbortController>();

export function registerPromptOptimizeJob(nodeId: string, controller: AbortController) {
    controllers.set(nodeId, controller);
}

export function releasePromptOptimizeJob(nodeId: string, controller: AbortController) {
    if (controllers.get(nodeId) === controller) controllers.delete(nodeId);
}

export function hasPromptOptimizeJob(nodeId: string) {
    return controllers.has(nodeId);
}

export function abortPromptOptimizeJob(nodeId: string) {
    controllers.get(nodeId)?.abort();
}
