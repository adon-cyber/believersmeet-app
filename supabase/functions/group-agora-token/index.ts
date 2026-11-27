import { RtcRole, RtcTokenBuilder } from "npm:agora-token@2.0.2";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const AGORA_APP_ID = Deno.env.get("AGORA_APP_ID") ?? "";
const AGORA_APP_CERTIFICATE = Deno.env.get("AGORA_APP_CERTIFICATE") ?? "";
const TOKEN_LIFETIME_SECONDS = 60 * 5;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

function getAllowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  try {
    const parsed = new URL(origin);
    const isLocalDevelopment = parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(parsed.hostname) && parsed.port === "5500";
    const hostLabel = parsed.hostname.split(".")[0].toLowerCase();
    const isBelieversMeetVercelDeployment = parsed.protocol === "https:" &&
      parsed.hostname.endsWith(".vercel.app") && hostLabel.startsWith("believersmeet");
    const isBelieversMeetDomain = parsed.protocol === "https:" &&
      (parsed.hostname === "believersmeet.app" || parsed.hostname.endsWith(".believersmeet.app"));
    return isLocalDevelopment || isBelieversMeetVercelDeployment || isBelieversMeetDomain ? origin : null;
  } catch { return null; }
}

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function jsonResponse(origin: string | null, body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function deriveChannelName(sessionId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`believersmeet:group-call:${sessionId.toLowerCase()}`),
  );
  return `bmg-${toHex(new Uint8Array(digest)).slice(0, 60)}`;
}

async function deriveAgoraUid(userId: string): Promise<number> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`believersmeet:agora-uid:${userId.toLowerCase()}`),
  );
  const view = new DataView(digest);
  const uid = view.getUint32(0, false) & 0x7fffffff;
  return uid === 0 ? 1 : uid;
}

Deno.serve(async (req: Request) => {
  const originHeader = req.headers.get("origin");
  const allowedOrigin = getAllowedOrigin(originHeader);
  if (originHeader && !allowedOrigin) return new Response("Forbidden origin", { status: 403 });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(allowedOrigin) });
  if (req.method !== "POST") return jsonResponse(allowedOrigin, { error: "Method not allowed." }, 405);

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !AGORA_APP_ID || !AGORA_APP_CERTIFICATE) {
    console.error("Group Agora token function configuration is incomplete.");
    return jsonResponse(allowedOrigin, { error: "Group video calling is temporarily unavailable." }, 503);
  }

  const authorization = req.headers.get("Authorization") ?? "";
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (!bearerMatch) return jsonResponse(allowedOrigin, { error: "Authentication required." }, 401);

  try {
    let body: unknown;
    try { body = await req.json(); } catch { return jsonResponse(allowedOrigin, { error: "Invalid request." }, 400); }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonResponse(allowedOrigin, { error: "Invalid request." }, 400);
    }
    const sessionId = (body as Record<string, unknown>).sessionId;
    if (typeof sessionId !== "string" || !UUID_PATTERN.test(sessionId)) {
      return jsonResponse(allowedOrigin, { error: "A valid group-call session is required." }, 400);
    }

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    const { data: authData, error: authError } = await adminClient.auth.getUser(bearerMatch[1].trim());
    const user = authData?.user;
    if (authError || !user) return jsonResponse(allowedOrigin, { error: "Your session is invalid or has expired." }, 401);

    const { data: session, error: sessionError } = await adminClient
      .from("group_video_call_sessions")
      .select("id, church_id, group_id, status, expires_at")
      .eq("id", sessionId)
      .maybeSingle();
    if (sessionError) {
      console.error("Group call session lookup failed:", sessionError);
      return jsonResponse(allowedOrigin, { error: "Unable to authorize this group call." }, 500);
    }
    if (!session || session.status !== "active") {
      return jsonResponse(allowedOrigin, { error: "This group call is no longer active." }, 403);
    }

    const [profileResult, membershipResult, groupResult] = await Promise.all([
      adminClient.from("profiles").select("id, church_id, status, is_blocked").eq("id", user.id).maybeSingle(),
      adminClient.from("group_members").select("id, status").eq("group_id", session.group_id).eq("user_id", user.id).eq("status", "approved").maybeSingle(),
      adminClient.from("groups").select("id, church_id, churches(status)").eq("id", session.group_id).maybeSingle(),
    ]);
    if (profileResult.error || membershipResult.error || groupResult.error) {
      console.error("Group call membership authorization failed:", profileResult.error ?? membershipResult.error ?? groupResult.error);
      return jsonResponse(allowedOrigin, { error: "Unable to verify group-call membership." }, 500);
    }

    const profile = profileResult.data;
    const membership = membershipResult.data;
    const group = groupResult.data as Record<string, unknown> | null;
    const churchJoin = group?.churches as { status?: string } | { status?: string }[] | null;
    const churchStatus = Array.isArray(churchJoin) ? churchJoin[0]?.status : churchJoin?.status;

    if (
      !profile || profile.status !== "active" || profile.is_blocked === true ||
      profile.church_id !== session.church_id || !membership || membership.status !== "approved" ||
      !group || group.church_id !== session.church_id || churchStatus !== "approved"
    ) {
      return jsonResponse(allowedOrigin, { error: "Only active, approved members of this church group can join." }, 403);
    }

    // Recheck the database lease and group membership immediately before token issuance.
    const [freshSessionResult, freshMembershipResult, freshProfileResult] = await Promise.all([
      adminClient.from("group_video_call_sessions").select("status, expires_at, church_id, group_id").eq("id", sessionId).maybeSingle(),
      adminClient.from("group_members").select("status").eq("group_id", session.group_id).eq("user_id", user.id).maybeSingle(),
      adminClient.from("profiles").select("church_id, status, is_blocked").eq("id", user.id).maybeSingle(),
    ]);
    if (freshSessionResult.error || freshMembershipResult.error || freshProfileResult.error) {
      console.error("Final group call authorization failed:", freshSessionResult.error ?? freshMembershipResult.error ?? freshProfileResult.error);
      return jsonResponse(allowedOrigin, { error: "Unable to revalidate this group call." }, 500);
    }

    const freshSession = freshSessionResult.data;
    const freshMembership = freshMembershipResult.data;
    const freshProfile = freshProfileResult.data;
    const expiresAtMs = Date.parse(freshSession?.expires_at ?? "");
    const nowMs = Date.now();
    const remainingSeconds = Math.floor((expiresAtMs - nowMs) / 1000) - 5;
    if (
      !freshSession || freshSession.status !== "active" ||
      freshSession.church_id !== session.church_id || freshSession.group_id !== session.group_id ||
      !freshMembership || freshMembership.status !== "approved" ||
      !freshProfile || freshProfile.church_id !== session.church_id ||
      freshProfile.status !== "active" || freshProfile.is_blocked === true ||
      !Number.isFinite(expiresAtMs) || remainingSeconds < 60
    ) {
      return jsonResponse(allowedOrigin, { error: "This group call has expired or your membership is no longer active." }, 403);
    }

    const tokenLifetime = Math.min(TOKEN_LIFETIME_SECONDS, remainingSeconds);
    const channelName = await deriveChannelName(sessionId);
    const uid = await deriveAgoraUid(user.id);
    const tokenExpiresAt = Math.floor(nowMs / 1000) + tokenLifetime;
    const token = RtcTokenBuilder.buildTokenWithUid(
      AGORA_APP_ID,
      AGORA_APP_CERTIFICATE,
      channelName,
      uid,
      RtcRole.PUBLISHER,
      tokenLifetime,
      tokenLifetime,
    );

    return jsonResponse(allowedOrigin, {
      sessionId,
      appId: AGORA_APP_ID,
      token,
      channelName,
      uid,
      expiresAt: tokenExpiresAt,
      callExpiresAt: Math.floor(expiresAtMs / 1000),
    });
  } catch (error) {
    console.error("Group Agora token generation failed:", error);
    return jsonResponse(allowedOrigin, { error: "Unable to generate group video-call authorization." }, 500);
  }
});
