import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { InventoryReadItem } from "@twib/shared";
import { InventoryManualDerivative } from "./inventory-manual-derivative";
const record = {
  producerRecord: {
    clip_id: "child",
    clip_uid: "child",
    parent_clip_id: "parent",
    record_kind: "processing-history",
    first_seen_at: null,
    source_signature: null,
    manual_derivative: {
      parent_clip_id: "parent",
      source_sha256: "a".repeat(64),
      derivative_sha256: "b".repeat(64),
      source_in_seconds: 10,
      source_out_seconds: 40,
      source_duration_seconds: 90,
      verification: "local-sha256",
    },
  },
  manualDerivativeParent: {
    state: "available",
    itemId: "item_parent",
    ref: '<img src=x onerror="bad()">.mp4',
  },
} as InventoryReadItem;
function html(r: InventoryReadItem) {
  return renderToStaticMarkup(
    createElement(InventoryManualDerivative, {
      record: r,
      onFindParent: () => undefined,
    }),
  );
}
it("shows reported technical provenance separately from editorial review and escapes labels", () => {
  const result = html(record);
  expect(result).toContain("Manual shorter edit");
  expect(result).toContain("10–40");
  expect(result).toContain("producer reports local SHA-256");
  expect(result).toContain("Editorial approval is separate");
  expect(result).toContain("Find source");
  expect(result).toContain("&lt;img");
  expect(result).not.toContain("<img");
});
it("does not invent a relationship or original-source label for legacy metadata", () => {
  expect(html({} as InventoryReadItem)).toBe("");
});
it.each(["missing", "ambiguous", "changed"] as const)(
  "does not navigate an unresolved %s source",
  (state) => {
    const result = html({ ...record, manualDerivativeParent: { state } });
    expect(result).not.toContain("<button");
    expect(result).toContain(
      state === "ambiguous"
        ? "More than one"
        : state === "changed"
          ? "metadata changed"
          : "not available",
    );
  },
);

it("does not call a full-source manual edit shorter", () => {
  const full = structuredClone(record);
  full.producerRecord!.manual_derivative!.source_in_seconds = 0;
  full.producerRecord!.manual_derivative!.source_out_seconds = 90;
  expect(html(full)).toContain("<h3>Manual edit</h3>");
  expect(html(full)).not.toContain("Manual shorter edit");
});
