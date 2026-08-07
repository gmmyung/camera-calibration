/// <reference types="vite/client" />

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
