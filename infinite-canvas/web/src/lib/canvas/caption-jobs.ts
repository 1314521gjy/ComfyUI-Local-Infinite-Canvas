const controllers = new Map<string, AbortController>();

export function registerCaptionJob(nodeId: string, controller: AbortController) {
    controllers.set(nodeId, controller);
}

export function releaseCaptionJob(nodeId: string, controller: AbortController) {
    if (controllers.get(nodeId) === controller) controllers.delete(nodeId);
}

export function hasCaptionJob(nodeId: string) {
    return controllers.has(nodeId);
}

export function abortCaptionJob(nodeId: string) {
    controllers.get(nodeId)?.abort();
}
