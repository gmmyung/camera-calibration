import { useEffect, useState } from "preact/hooks";
import type { FrameObservation } from "../domain/types";
import { getSessionBlob } from "../lib/session-db";

export function ObservationThumbnail({ observation }: { observation: FrameObservation }) {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    let disposed = false;
    let objectUrl: string | undefined;
    setUrl(undefined);
    getSessionBlob(observation.thumbnailBlobKey)
      .then((blob) => {
        if (!blob || disposed) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [observation.thumbnailBlobKey]);

  return url ? (
    <img src={url} alt={observation.sourceName ?? "Calibration capture"} />
  ) : (
    <div class="image-placeholder" />
  );
}
