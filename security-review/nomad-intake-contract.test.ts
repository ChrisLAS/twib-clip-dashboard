import { it, expect } from "vitest";
import fixture from "./fixtures/nomad-intake-contract.json";
import {
  createJobSchema,
  captureReceiptSchema,
  resultSchema,
} from "../apps/worker/src/capture-jobs/contract";
import {
  cutWireSchema,
  planWireSchema,
  proposalSchema,
  derivativeSchema,
} from "../apps/worker/src/capture-jobs/cut-contract";
it("accepts actual synthetic episode128 Nomad capture, plan and rendered derivative envelopes", () => {
  expect(createJobSchema.parse(fixture.capture_request).episode).toBe(128);
  captureReceiptSchema.parse(fixture.capture);
  cutWireSchema.parse(fixture.cut_request);
  expect(
    planWireSchema.parse(fixture.plan_request).planning.reviewRevision,
  ).toBe(0);
  proposalSchema.parse(fixture.proposal);
  derivativeSchema.parse(fixture.cut_result);
  for (const delivery of [
    fixture.capture_delivery,
    fixture.plan_delivery,
    fixture.cut_delivery,
  ])
    resultSchema.parse(delivery);
  expect(fixture.capture.editorial_ready).toBe(false);
  expect(fixture.cut_result.approval).toBe("unreviewed");
});
it("rejects reviewRevision0 without explicit intake provenance", () => {
  const { intake_work_id: omitted, ...legacy } = fixture.plan_request;
  expect(omitted).toBeTruthy();
  expect(planWireSchema.safeParse(legacy).success).toBe(false);
});
