import { useEffect, useRef, useState } from "react";
import type { InventoryRecordItem } from "./inventory-local-media";
import { AUDIO_SUFFIX } from "./inventory-local-media";
export interface LocalPlaybackSelection {
  key: string;
  sourceId: string;
  episodeId: string;
  record: InventoryRecordItem;
  file: File;
  manual: boolean;
  mtimeDiffers: boolean;
  invalid?: boolean;
}
export function InventoryLocalPlayer({
  selection,
  active,
  note,
  onNote,
  onClose,
}: {
  selection: LocalPlaybackSelection;
  active: boolean;
  note: string;
  onNote: (value: string) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const player = useRef<HTMLMediaElement | null>(null);
  const ref = selection.record.variants[0].item.media!.ref;
  useEffect(() => {
    if (selection.invalid) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(selection.file);
    setUrl(next);
    setError("");
    return () => {
      player.current?.pause();
      URL.revokeObjectURL(next);
    };
  }, [selection.file, selection.invalid]);
  useEffect(() => {
    if (!active) player.current?.pause();
  }, [active]);
  function failed() {
    player.current?.pause();
    setError(
      player.current?.error?.code === 4
        ? "This browser cannot decode the selected media format or codecs. Capture status is unchanged. Try another browser or a separately prepared compatible file."
        : "The selected local file could not be read or decoded. It may have changed during sync. Select the file again; capture status and your session note are unchanged.",
    );
  }
  const props = {
    src: url ?? undefined,
    controls: true,
    preload: "metadata",
    onError: failed,
    onLoadedMetadata: () => setError(""),
    "aria-label": `Local playback: ${ref}`,
  };
  return (
    <section
      className="inventory-local-player player-shell"
      aria-label="Local inventory playback"
    >
      <div className="inventory-local-heading">
        <div>
          <h2>Local playback</h2>
          <code>{ref}</code>
        </div>
        <button className="quiet" onClick={onClose}>
          Close local player
        </button>
      </div>
      {selection.invalid ? (
        <p role="alert">
          The current observation no longer matches this selection. Playback is
          stopped. Select the current local file again; your session note is
          kept.
        </p>
      ) : (
        url &&
        (AUDIO_SUFFIX.test(ref) ? (
          <audio
            {...props}
            ref={(element) => {
              player.current = element;
            }}
          />
        ) : (
          <video
            {...props}
            playsInline
            ref={(element) => {
              player.current = element;
            }}
          />
        ))
      )}
      {error && (
        <p className="inventory-warning" role="alert">
          {error}
        </p>
      )}
      <p className="muted">
        {selection.manual
          ? "Single file manually bound to the full record reference; its directory cannot be verified by the browser."
          : "Selected episode-relative path and observed size match."}{" "}
        This does not verify a content hash or editorial readiness.{" "}
        {selection.mtimeDiffers &&
          "Local modification time differs; sync can change timestamps."}
      </p>
      <label className="inventory-local-note">
        Session note · separate from the episode slate
        <textarea
          value={note}
          maxLength={4000}
          onChange={(event) => onNote(event.target.value)}
          placeholder="Private draft in this tab; not saved or sent"
        />
      </label>
      <p className="muted">
        Selecting files uploads nothing. Browser reload requires selecting them
        again and clears session notes. Existing selections are browser
        snapshots; sync changes require a new selection.
      </p>
    </section>
  );
}
