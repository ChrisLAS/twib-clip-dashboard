import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export async function verifyOwner(
  request: Request,
  env: Env,
  testKey?: JWTVerifyGetKey,
): Promise<void> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new Error("Owner authentication required");
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  const key =
    testKey ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  const { payload } = await jwtVerify(token, key, {
    issuer,
    audience: env.ACCESS_AUD,
    algorithms: ["RS256"],
    requiredClaims: ["sub", "email", "iat", "exp"],
  });
  if (
    typeof payload.email !== "string" ||
    payload.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()
  ) {
    throw new Error("Owner authentication required");
  }
}
