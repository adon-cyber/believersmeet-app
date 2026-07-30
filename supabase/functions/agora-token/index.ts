import { RtcTokenBuilder, RtcRole } from "npm:agora-token@2.0.2";

// Retrieve secrets securely from your Supabase Vault environment variables
const AGORA_APP_ID = Deno.env.get("AGORA_APP_ID")!;
const AGORA_APP_CERTIFICATE = Deno.env.get("AGORA_APP_CERTIFICATE")!;

Deno.serve(async (req) => {
  // Handle CORS preflight requests so your frontend can talk to it safely
  if (req.method === "OPTIONS") {
    return new Response("ok", { 
      headers: { 
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
      } 
    });
  }

  try {
    const { channelName, uid } = await req.json();

    if (!channelName || !uid) {
      return new Response(JSON.stringify({ error: "Missing channelName or uid" }), { status: 400 });
    }

    // Set token lifespan (valid for 2 hours)
    const expirationTimeInSeconds = 7200;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    // Build the dynamic production token
    const token = RtcTokenBuilder.buildTokenWithUid(
      AGORA_APP_ID,
      AGORA_APP_CERTIFICATE,
      channelName,
      Number(uid), // Must be a pure integer number
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );

    return new Response(JSON.stringify({ token }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
});