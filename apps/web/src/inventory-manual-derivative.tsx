import type { InventoryReadItem } from "@twib/shared";

export function InventoryManualDerivative({
  record,
  onFindParent,
}: {
  record: InventoryReadItem;
  onFindParent: (itemId: string) => void;
}) {
  const manual = record.producerRecord?.manual_derivative;
  if (!manual) return null;
  const parent = record.manualDerivativeParent;
  return (
    <section
      className="inventory-manual-derivative"
      aria-label="Manual edit provenance"
    >
      <h3>
        {manual.source_out_seconds - manual.source_in_seconds <
        manual.source_duration_seconds
          ? "Manual shorter edit"
          : "Manual edit"}
      </h3>
      <p>
        Source-relative range: {manual.source_in_seconds}–
        {manual.source_out_seconds} seconds of {manual.source_duration_seconds}{" "}
        seconds.
      </p>
      <p>Source record: {manual.parent_clip_id}</p>
      {(parent?.state === "available" || parent?.state === "reported") &&
      parent.itemId ? (
        <>
          <p>Current source file: {parent.ref}</p>
          {parent.state === "reported" && (
            <p>
              Source identity matches; current source hash or duration is not
              available to corroborate the producer’s report.
            </p>
          )}
          <button type="button" onClick={() => onFindParent(parent.itemId!)}>
            Find source
          </button>
        </>
      ) : (
        <p role="note">
          {parent?.state === "ambiguous"
            ? "More than one current record claims this source identity. Source navigation is unavailable."
            : parent?.state === "changed"
              ? "Source metadata changed since this edit. Source navigation is unavailable."
              : "The source is not available in this episode’s current inventory."}
        </p>
      )}
      <p>
        Technical evidence: the producer reports local SHA-256 checks of the
        source and edit. The dashboard has not independently checked the files
        or playback.
      </p>
      <p>
        Editorial approval is separate. This edit has its own saved review; the
        source’s decision is not inherited.
      </p>
    </section>
  );
}
