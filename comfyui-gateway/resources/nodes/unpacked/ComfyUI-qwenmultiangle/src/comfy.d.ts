/**
 * Type declarations for ComfyUI runtime APIs.
 *
 * LGraphNode and other litegraph types are declared as ambient (non-exported)
 * in @comfyorg/comfyui-frontend-types, so they cannot be imported directly.
 * We declare the subset we need here.
 */

interface ComfyWidget {
  name: string
  value: unknown
  callback?: (value: unknown) => void
}

interface ComfyNode {
  id: number
  size: [number, number]
  widgets?: ComfyWidget[]
  properties?: Record<string, unknown>
  constructor: Function & { comfyClass?: string }
  setSize(size: [number, number]): void
  addDOMWidget(
    name: string,
    type: string,
    element: HTMLElement,
    options?: {
      getMinHeight?: () => number
      hideOnZoom?: boolean
      serialize?: boolean
    }
  ): DOMWidgetInstance
  onConnectionsChange?: (
    slotType: number,
    slotIndex: number,
    isConnected: boolean,
    link: unknown,
    ioSlot: unknown
  ) => void
  onExecuted?: (output: unknown) => void
  onPropertyChanged?: (key: string, value: unknown) => void
}

interface DOMWidgetInstance {
  name: string
  type: string
  element: HTMLElement
  options: Record<string, unknown>
  onRemove?: () => void
  serializeValue?: () => Promise<string> | string
}

interface ComfyGraph {
  setDirtyCanvas(fg: boolean, bg: boolean): void
}

interface ComfyUISettings {
  getSettingValue?(key: string): unknown
}

interface ComfyUI {
  settings?: ComfyUISettings
}

interface ComfyAppInstance {
  graph?: ComfyGraph
  ui?: ComfyUI
  registerExtension(extension: {
    name: string
    nodeCreated?(node: ComfyNode): void
  }): void
}

interface ComfyApiInstance {
  addEventListener(event: string, callback: (event: CustomEvent) => void): void
  apiURL(route: string): string
}

interface Window {
  comfyAPI: {
    app: { app: ComfyAppInstance }
    api: { api: ComfyApiInstance }
  }
}
