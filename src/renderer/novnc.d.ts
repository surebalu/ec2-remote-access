/** The parts of noVNC's RFB client (docs/API.md of @novnc/novnc 1.7.0, pinned) the screen sharing tab uses. */
declare module '@novnc/novnc' {
  export interface RfbCredentials {
    username?: string
    password?: string
    target?: string
  }
  export default class RFB extends EventTarget {
    /** noVNC's message writers; the screen tab sends pointer events itself on touch screens (VncTab, vnc/screenTouch). */
    static messages: { pointerEvent(sock: unknown, x: number, y: number, mask: number): void }
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: { shared?: boolean; credentials?: RfbCredentials; repeaterID?: string; wsProtocols?: string[] })
    viewOnly: boolean
    scaleViewport: boolean
    clipViewport: boolean
    dragViewport: boolean
    resizeSession: boolean
    showDotCursor: boolean
    focusOnClick: boolean
    background: string
    qualityLevel: number
    compressionLevel: number
    disconnect(): void
    sendCredentials(credentials: RfbCredentials): void
    approveServer(): void
    sendKey(keysym: number, code: string | null, down?: boolean): void
    sendCtrlAltDel(): void
    focus(options?: FocusOptions): void
    blur(): void
    clipboardPasteFrom(text: string): void
    toDataURL(type?: string, encoderOptions?: number): string
  }
}
