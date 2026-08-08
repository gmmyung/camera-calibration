/// <reference types="vite/client" />

declare const __BUILD_ID__: string;

interface HTMLVideoElement {
  requestVideoFrameCallback?: (
    callback: (now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

interface VideoFrameCallbackMetadata {
  width: number;
  height: number;
  mediaTime: number;
  presentedFrames: number;
  expectedDisplayTime: DOMHighResTimeStamp;
}
