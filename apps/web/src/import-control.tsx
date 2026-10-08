import { useEffect, useRef, useState } from "react";
import { api } from "./api";

/** Import uses the owner's existing Access session. It never starts on mount. */
export function ImportControl({
  csrf,
  ready,
  hidden,
  onRefresh,
}: {
  csrf: string;
  ready: boolean;
  hidden: boolean;
  onRefresh: () => void;
}) {
  const [state, setState] = useState<"idle" | "pending" | "success" | "error">(
    "idle",
  );
  const [message, setMessage] = useState("");
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
  return (
    <section
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
        {message && (
          <p role={state === "error" ? "alert" : "status"}>{message}</p>
        )}
      </div>
      <div className="import-actions">
        <button
          disabled={!ready || state === "pending"}
          onClick={() => void start()}
        >
          {state === "pending"
            ? "Importing approved clips…"
            : "Import approved clips"}
        </button>
        {(state === "success" || state === "error") && (
          <button className="quiet" onClick={onRefresh}>
            Refresh slate
          </button>
        )}
      </div>
    </section>
  );
}
