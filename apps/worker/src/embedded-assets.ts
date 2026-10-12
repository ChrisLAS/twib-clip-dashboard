// Compatibility adapter for deployments whose frontend is embedded in the Worker.
// The outer Worker still authenticates every request before calling this binding.
export interface EmbeddedAsset {
  body: string;
  type: string;
}
export function embeddedAssets(
  assets: Readonly<Record<string, EmbeddedAsset>>,
) {
  return {
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (!["GET", "HEAD"].includes(request.method))
        return new Response(null, { status: 405 });
      if (
        path.includes("%") ||
        path.includes("\\") ||
        path.startsWith("/api/") ||
        path.startsWith("/media/")
      )
        return new Response(null, { status: 404 });
      const asset = Object.hasOwn(assets, path)
        ? assets[path]
        : path === "/" ||
            (!path.includes(".") &&
              !path.startsWith("/assets/") &&
              !path.startsWith("/demo/"))
          ? assets["/index.html"]
          : undefined;
      return asset
        ? new Response(request.method === "HEAD" ? null : asset.body, {
            headers: { "Content-Type": asset.type },
          })
        : new Response(null, { status: 404 });
    },
  };
}
