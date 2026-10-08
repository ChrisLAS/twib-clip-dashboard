import { useState } from "react";
import { Film } from "lucide-react";

/** Same-origin private image only; never preload a video just to draw its poster. */
export function ClipThumbnail({
  renderId,
  available,
}: {
  renderId: string;
  available: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (!available || failed)
    return (
      <span
        className="thumb-placeholder"
        title="Preview unavailable"
        aria-label="Preview unavailable"
      >
        <Film size={22} aria-hidden="true" />
      </span>
    );
  return (
    <img
      className="clip-thumbnail"
      src={`/media/${encodeURIComponent(renderId)}/thumbnail`}
      alt=""
      loading="lazy"
      decoding="async"
      width={90}
      height={55}
      onError={() => setFailed(true)}
    />
  );
}
