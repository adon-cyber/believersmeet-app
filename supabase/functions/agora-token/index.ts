import { RtcRole, RtcTokenBuilder } from "npm:agora-token@2.0.2";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const AGORA_APP_ID = Deno.env.get("AGORA_APP_ID") ?? "";
const AGORA_APP_CERTIFICATE = Deno.env.get("AGORA_APP_CERTIFICATE") ?? "";

const TOKEN_LIFETIME_SECONDS = 60 * 5;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

function getAllowedOrigin(origin: string | null): string | null {
  if (!origin) return null;

  try {
    const parsed = new URL(origin);

    const isLocalDevelopment = parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(parsed.hostname) &&
      parsed.port === "5500";

    const hostLabel = parsed.hostname.split(".")[0].toLowerCase();

    const isBelieversMeetVercelDeployment = parsed.protocol === "https:" &&
      parsed.hostname.endsWith(".vercel.app") &&
      hostLabel.startsWith("believersmeet");

    const isBelieversMeetDomain = parsed.protocol === "https:" &&
      (
        parsed.hostname === "believersmeet.app" ||
        parsed.hostname.endsWith(".believersmeet.app")
      );

    if (
      isLocalDevelopment ||
      isBelieversMeetVercelDeployment ||
      isBelieversMeetDomain
    ) {
      return origin;
    }
  } catch {
    // Reject malformed origins.
  }

  return null;
}

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };

  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function jsonResponse(
  origin: string | null,
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function deriveChannelName(
  firstUserId: string,
  secondUserId: string,
  invitationId: string,
): Promise<string> {
  const participants = [
    firstUserId.toLowerCase(),
    secondUserId.toLowerCase(),
  ].sort();

  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(
      `believersmeet:direct-call:${
        participants.join(":")
      }:${invitationId.toLowerCase()}`,
    ),
  );

  // Invitation-scoped channel; 63 characters and no exposed UUIDs.
  return `bm-${toHex(new Uint8Array(digest)).slice(0, 60)}`;
}

async function deriveAgoraUid(userId: string): Promise<number> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`believersmeet:agora-uid:${userId.toLowerCase()}`),
  );

  const view = new DataView(digest);
  const uid = view.getUint32(0, false) & 0x7fffffff;

  // Agora UID zero is reserved for automatic assignment.
  return uid === 0 ? 1 : uid;
}

Deno.serve(async (req: Request) => {
  const originHeader = req.headers.get("origin");
  const allowedOrigin = getAllowedOrigin(originHeader);

  if (originHeader && !allowedOrigin) {
    return new Response("Forbidden origin", { status: 403 });
  }

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(allowedOrigin),
    });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      allowedOrigin,
      { error: "Method not allowed." },
      405,
    );
  }

  if (
    !SUPABASE_URL ||
    !SERVICE_ROLE_KEY ||
    !AGORA_APP_ID ||
    !AGORA_APP_CERTIFICATE
  ) {
    console.error("Agora token function configuration is incomplete.");
    return jsonResponse(
      allowedOrigin,
      { error: "Video calling is temporarily unavailable." },
      503,
    );
  }

  const authorization = req.headers.get("Authorization") ?? "";
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);

  if (!bearerMatch) {
    return jsonResponse(
      allowedOrigin,
      { error: "Authentication required." },
      401,
    );
  }

  try {
    let requestBody: unknown;

    try {
      requestBody = await req.json();
    } catch {
      return jsonResponse(
        allowedOrigin,
        { error: "Invalid request." },
        400,
      );
    }

    if (
      typeof requestBody !== "object" ||
      requestBody === null ||
      Array.isArray(requestBody)
    ) {
      return jsonResponse(
        allowedOrigin,
        { error: "Invalid request." },
        400,
      );
    }

    const invitationId = (requestBody as Record<string, unknown>).invitationId;

    if (
      typeof invitationId !== "string" ||
      !UUID_PATTERN.test(invitationId)
    ) {
      return jsonResponse(
        allowedOrigin,
        { error: "A valid call invitation is required." },
        400,
      );
    }

    const callerToken = bearerMatch[1].trim();

    const adminClient = createClient(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false,
        },
      },
    );

    // Verify the actual user's access token with Supabase Auth.
    const {
      data: { user },
      error: authError,
    } = await adminClient.auth.getUser(callerToken);

    if (authError || !user) {
      return jsonResponse(
        allowedOrigin,
        { error: "Your session is invalid or has expired." },
        401,
      );
    }

    // Only participants in an accepted invitation may obtain Agora credentials.
    const {
      data: invitation,
      error: invitationError,
    } = await adminClient
      .from("video_call_invitations")
      .select("id, caller_id, recipient_id, status")
      .eq("id", invitationId)
      .maybeSingle();

    if (invitationError) {
      console.error("Agora invitation lookup failed:", invitationError);
      return jsonResponse(
        allowedOrigin,
        { error: "Unable to authorize this call." },
        500,
      );
    }

    if (!invitation) {
      return jsonResponse(
        allowedOrigin,
        { error: "This call is not available." },
        403,
      );
    }

    const callerId = invitation.caller_id as string;
    const recipientId = invitation.recipient_id as string;
    const normalizedUserId = user.id.toLowerCase();

    const isParticipant = normalizedUserId === callerId.toLowerCase() ||
      normalizedUserId === recipientId.toLowerCase();

    if (!isParticipant || invitation.status !== "accepted") {
      return jsonResponse(
        allowedOrigin,
        { error: "This call is not available or has not been accepted." },
        403,
      );
    }

    // Both participants must have active, unblocked profiles.
    const { data: profiles, error: profilesError } = await adminClient
      .from("profiles")
      .select("id, status, is_blocked")
      .in("id", [callerId, recipientId]);

    if (profilesError) {
      console.error("Agora profile authorization query failed:", profilesError);
      return jsonResponse(
        allowedOrigin,
        { error: "Unable to authorize this call." },
        500,
      );
    }

    if (
      !profiles ||
      profiles.length !== 2 ||
      !profiles.every(
        (profile) =>
          profile.status === "active" &&
          profile.is_blocked === false,
      )
    ) {
      return jsonResponse(
        allowedOrigin,
        { error: "This call is not available." },
        403,
      );
    }

    // Check blocks in both directions. Do not trust browser-side filtering.
    const [callerBlock, recipientBlock] = await Promise.all([
      adminClient
        .from("blocks")
        .select("blocker_id")
        .eq("blocker_id", callerId)
        .eq("blocked_id", recipientId)
        .limit(1)
        .maybeSingle(),

      adminClient
        .from("blocks")
        .select("blocker_id")
        .eq("blocker_id", recipientId)
        .eq("blocked_id", callerId)
        .limit(1)
        .maybeSingle(),
    ]);

    if (callerBlock.error || recipientBlock.error) {
      console.error(
        "Agora block authorization query failed:",
        callerBlock.error ?? recipientBlock.error,
      );

      return jsonResponse(
        allowedOrigin,
        { error: "Unable to authorize this call." },
        500,
      );
    }

    if (callerBlock.data || recipientBlock.data) {
      return jsonResponse(
        allowedOrigin,
        { error: "This call is not available." },
        403,
      );
    }

    // Re-read the invitation immediately before token generation.
    const {
      data: currentInvitation,
      error: currentInvitationError,
    } = await adminClient
      .from("video_call_invitations")
      .select("status, expires_at")
      .eq("id", invitationId)
      .maybeSingle();

    if (currentInvitationError) {
      console.error(
        "Agora invitation state check failed:",
        currentInvitationError,
      );
      return jsonResponse(
        allowedOrigin,
        { error: "Unable to authorize this call." },
        500,
      );
    }

    if (!currentInvitation || currentInvitation.status !== "accepted") {
      return jsonResponse(
        allowedOrigin,
        { error: "This call is no longer active." },
        403,
      );
    }

    const callExpiresAtMs = Date.parse(currentInvitation.expires_at as string);
    const callExpiresAtSeconds = Math.floor(callExpiresAtMs / 1000);

    if (
      !Number.isFinite(callExpiresAtMs) ||
      callExpiresAtMs <= Date.now() + 60_000
    ) {
      return jsonResponse(
        allowedOrigin,
        { error: "This call has expired or is about to expire." },
        403,
      );
    }

    const channelName = await deriveChannelName(
      callerId,
      recipientId,
      invitationId,
    );

    const otherParticipantId = normalizedUserId === callerId.toLowerCase()
      ? recipientId
      : callerId;

    const uid = await deriveAgoraUid(user.id);
    const otherParticipantUid = await deriveAgoraUid(otherParticipantId);

    if (uid === otherParticipantUid) {
      console.error("Agora numeric UID collision detected.");
      return jsonResponse(
        allowedOrigin,
        { error: "Unable to establish this call. Please try again." },
        409,
      );
    }

    // Recheck invitation state after all asynchronous identity derivation.
    const {
      data: finalInvitation,
      error: finalInvitationError,
    } = await adminClient
      .from("video_call_invitations")
      .select("status, expires_at")
      .eq("id", invitationId)
      .maybeSingle();

    if (finalInvitationError) {
      console.error(
        "Final Agora invitation check failed:",
        finalInvitationError,
      );
      return jsonResponse(
        allowedOrigin,
        { error: "Unable to authorize this call." },
        500,
      );
    }

    if (!finalInvitation || finalInvitation.status !== "accepted") {
      return jsonResponse(
        allowedOrigin,
        { error: "This call is no longer active." },
        403,
      );
    }

    const finalCallExpiresAtMs = Date.parse(
      finalInvitation.expires_at as string,
    );
    const tokenGenerationNowMs = Date.now();
    const remainingCallSeconds =
      Math.floor((finalCallExpiresAtMs - tokenGenerationNowMs) / 1000) - 5;

    if (
      !Number.isFinite(finalCallExpiresAtMs) ||
      remainingCallSeconds < 60
    ) {
      return jsonResponse(
        allowedOrigin,
        { error: "This call has expired or is about to expire." },
        403,
      );
    }

    const tokenLifetimeSeconds = Math.min(
      TOKEN_LIFETIME_SECONDS,
      remainingCallSeconds,
    );

    const tokenGenerationNowSeconds = Math.floor(tokenGenerationNowMs / 1000);
    const tokenExpiresAt = tokenGenerationNowSeconds + tokenLifetimeSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(
      AGORA_APP_ID,
      AGORA_APP_CERTIFICATE,
      channelName,
      uid,
      RtcRole.PUBLISHER,
      tokenLifetimeSeconds,
      tokenLifetimeSeconds,
    );

    return jsonResponse(allowedOrigin, {
      invitationId,
      appId: AGORA_APP_ID,
      token,
      channelName,
      uid,
      expiresAt: tokenExpiresAt,
      callExpiresAt: Math.floor(finalCallExpiresAtMs / 1000),
    });
  } catch (error) {
    console.error("Agora token generation failed:", error);

    return jsonResponse(
      allowedOrigin,
      { error: "Unable to generate a video-call token." },
      500,
    );
  }
});
