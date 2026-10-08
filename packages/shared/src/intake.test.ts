import { describe, expect, it } from "vitest";
import {
  safeUploadFolderUrl,
  validateIntakeRange,
  validateIntakeUrl,
} from "./intake";

describe("manual intake URL safety and conservative canonicalization", () => {
  it.each([
    "javascript:alert(1)",
    "data:text/plain,hi",
    "file:///etc/passwd",
    "ftp://example.com/video",
    "//example.com/video",
    "https://user:pass@example.com/video",
    "https://owner@example.com/video",
    "http://localhost/video",
    "https://LOCALHOST./video",
    "http://127.0.0.1/video",
    "http://127.1/video",
    "http://2130706433/video",
    "http://0x7f000001/video",
    "http://0177.0.0.1/video",
    "https://[::1]/video",
    "https://[::ffff:127.0.0.1]/video",
    "http://169.254.169.254/latest",
    "http://10.0.0.1/video",
    "https://metadata.google.internal/video",
    "http://service.cluster.local/video",
    "http://nas.lan/video",
    "https://home/video",
    "https://example.com:8080/video",
    "https://example.com\\@localhost/video",
    "https://exa\nmple.com/video",
    "https://example.com/%0d%0aLocation:evil",
    "https://127.0.0.1.nip.io/video",
    "https://private.sslip.io/video",
    "https://a..example.com/video",
    "https://drive.google.com/drive/folders/fixture-folder",
    "https://youtube.com/redirect?q=https://example.com",
  ])("rejects unsafe or non-media provider URL %s", (url) =>
    expect(validateIntakeUrl(url).ok).toBe(false),
  );
  it.each([
    [
      "https://youtu.be/abcdefghijk?t=42&si=track",
      "https://www.youtube.com/watch?v=abcdefghijk",
      "youtube",
    ],
    [
      "https://m.youtube.com/shorts/abcdefghijk?feature=share",
      "https://www.youtube.com/watch?v=abcdefghijk",
      "youtube",
    ],
    [
      "https://www.youtube.com/watch?v=abcdefghijk&utm_source=copy",
      "https://www.youtube.com/watch?v=abcdefghijk",
      "youtube",
    ],
    [
      "https://drive.google.com/file/d/fixture-file/view?resourcekey=keep-private&usp=sharing",
      "https://drive.google.com/file/d/fixture-file/view",
      "drive",
    ],
    [
      "https://drive.google.com/open?id=fixture-file&usp=sharing",
      "https://drive.google.com/file/d/fixture-file/view",
      "drive",
    ],
    [
      "https://player.vimeo.com/video/123456?h=unlisted",
      "https://vimeo.com/123456/unlisted",
      "vimeo",
    ],
  ])(
    "normalizes recognized provider while preserving original %s",
    (url, canonicalUrl, provider) =>
      expect(validateIntakeUrl(url)).toEqual({
        ok: true,
        submittedUrl: url,
        canonicalUrl,
        provider,
      }),
  );
  it("does not erase arbitrary query, fragment, encoding or edition semantics", () => {
    const input =
      "https://source.example.com/video?edition=2&utm_source=identity#chapter-3";
    expect(validateIntakeUrl(input)).toEqual({
      ok: true,
      submittedUrl: input,
      canonicalUrl: input,
      provider: "other",
    });
    expect(
      validateIntakeUrl("https://youtube.com.evil.example/watch?v=abcdefghijk"),
    ).toMatchObject({ ok: true, provider: "other" });
  });
  it.each([
    [undefined, undefined],
    [null, null],
    [0, 1],
    [1000, 6000],
  ])("permits a complete valid range %s %s", (start, end) =>
    expect(validateIntakeRange(start, end)).toBeNull(),
  );
  it.each([
    [null, 100],
    [100, null],
    [-1, 100],
    [100, 100],
    [101, 100],
    [0.5, 100],
    [0, Infinity],
    [NaN, 100],
    [0, 604_800_001],
  ])("rejects invalid range %s %s", (start, end) =>
    expect(validateIntakeRange(start, end)).not.toBeNull(),
  );
  it("accepts only a direct private Drive folder configuration", () => {
    expect(
      safeUploadFolderUrl(
        "https://drive.google.com/drive/folders/fixture-folder",
      ),
    ).toBe("https://drive.google.com/drive/folders/fixture-folder");
    for (const url of [
      "javascript:alert(1)",
      "https://drive.google.com.evil.example/drive/folders/fixture-folder",
      "https://owner@drive.google.com/drive/folders/fixture-folder",
      "https://drive.google.com/open?id=fixture-folder",
      "https://drive.google.com/drive/folders/fixture-folder?redirect=evil",
      "http://drive.google.com/drive/folders/fixture-folder",
      "https://drive.google.com/drive/folders/fixture-folder#redirect",
      " https://drive.google.com/drive/folders/fixture-folder",
    ])
      expect(safeUploadFolderUrl(url)).toBeNull();
  });
});
