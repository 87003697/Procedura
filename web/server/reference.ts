import type { ReferenceAuthority } from "../../src/reference/authority.ts";

function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function referenceMeshHandler(
  authority: ReferenceAuthority | null,
  request: Request,
): Response {
  const handle = new URL(request.url).searchParams.get("handle");
  if (!handle) return errorResponse("missing ?handle", 400);

  if (!authority) return errorResponse("PROCEDURA_REFERENCE_ROOT is not configured", 503);

  try {
    const mesh = authority.readReferenceViewerMesh(handle);
    return new Response(mesh.bytes, {
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "private, max-age=60",
      },
    });
  } catch (error) {
    return errorResponse((error as Error).message, 404);
  }
}
