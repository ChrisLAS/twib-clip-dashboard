import { useEffect, useRef, useState } from "react";
import { api } from "./api";

/** Import uses the owner's existing Access session. It never starts on mount. */
export function ImportControl({
  csrf,
  ready,
  hidden,
  hasClips,
  slateRevision,
  onRefresh,
}: {
  csrf: string;
  ready: boolean;
  hidden: boolean;
  hasClips: boolean;
  slateRevision: number;
  onRefresh: () => void;
}) {
  const [state, setState] = useState<"idle" | "pending" | "success" | "error">(
    "idle",
  );
  const [message, setMessage] = useState("");
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const [completedAt, setCompletedAt] = useState<number | null>(null);
  const revision = useRef(slateRevision);
  revision.current = slateRevision;
  const activeResult =
    state === "pending" ||
    state === "error" ||
    (state === "success" && completedAt === slateRevision);
  const expanded = !hasClips || openedAt === slateRevision || activeResult;
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);
  async function start() {
    if (!ready || inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setState("pending");
    setMessage("Checking the approved catalog and verifying clip files…");
    try {
      const result = await api.importApproved(csrf, controller.signal);
      if (controller.signal.aborted) return;
      setCompletedAt(revision.current);
      setState("success");
      setMessage(
        `Import complete: ${result.imported} catalog record${result.imported === 1 ? "" : "s"} checked. Refresh the slate to see updates. Existing reviews and drafts are preserved.`,
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      setState("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "Import could not be confirmed. Refresh the slate before retrying.",
      );
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
    }
  }
  if (!expanded)
    return (
      <div className="import-shortcut" hidden={hidden}>
        <button
          className="quiet"
          onClick={() => setOpenedAt(slateRevision)}
          aria-expanded={false}
          aria-controls="approved-clip-catalog"
        >
          Import more clips
        </button>
      </div>
    );
  return (
    <section
      id="approved-clip-catalog"
      className="import-control"
      hidden={hidden}
      aria-label="Approved clip catalog"
    >
      <div>
        <strong>Approved clip catalog</strong>
        <p>
          {ready
            ? "Import checks the configured private catalog and clip checksums."
            : "Private Drive and the approved catalog must be connected before importing."}
        </p>
        {message && activeResult && (
          <p role={state === "error" ? "alert" : "status"}>{message}</p>
        )}
      </div>
      <div className="import-actions">
        {hasClips && state !== "pending" && (
          <button
            className="quiet"
            onClick={() => {
              setOpenedAt(null);
              setState("idle");
              setMessage("");
            }}
          >
            Close import controls
          </button>
        )}
        <button
          disabled={!ready || state === "pending"}
          onClick={() => void start()}
        >
          {state === "pending"
            ? "Importing approved clips…"
            : "Import approved clips"}
        </button>
        {activeResult && (state === "success" || state === "error") && (
          <button className="quiet" onClick={onRefresh}>
            Refresh slate
          </button>
        )}
      </div>
    </section>
  );
}
