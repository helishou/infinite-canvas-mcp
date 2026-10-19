export type ActiveCanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

export function startCanvasGenerationRequest(
    requests: Map<string, ActiveCanvasGenerationRequest>,
    targetNodeId: string,
    originNodeId: string,
    runningNodeId = originNodeId,
    controller = new AbortController(),
) {
    const previous = requests.get(targetNodeId);
    if (previous?.controller !== controller) previous?.controller.abort();
    requests.set(targetNodeId, { targetNodeId, originNodeId, runningNodeId, controller });
    return controller;
}

export function finishCanvasGenerationRequest(
    requests: Map<string, ActiveCanvasGenerationRequest>,
    targetNodeId: string,
    controller: AbortController,
) {
    const request = requests.get(targetNodeId);
    if (request?.controller === controller) requests.delete(targetNodeId);
}

export function abortCanvasGenerationRequestsByRunningId(
    requests: Map<string, ActiveCanvasGenerationRequest>,
    runningNodeId: string,
) {
    const affectedNodeIds = new Set<string>();
    requests.forEach((request) => {
        if (request.runningNodeId !== runningNodeId) return;
        request.controller.abort();
        affectedNodeIds.add(request.targetNodeId);
        affectedNodeIds.add(request.originNodeId);
    });
    return affectedNodeIds;
}
