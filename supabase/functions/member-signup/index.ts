import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TURNSTILE_SECRET_KEY = Deno.env.get("TURNSTILE_SECRET_KEY") ?? "";
const RATE_LIMIT_SALT = Deno.env.get("MEMBER_SIGNUP_RATE_LIMIT_SALT") ?? "";

const ALLOWED_ORIGINS = new Set<string>([
  "https://believersmeet-app.vercel.app",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
]);

const encoder = new TextEncoder();

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function jsonResponse(
  origin: string,
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

async function createIpFingerprint(ip: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(RATE_LIMIT_SALT),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(ip),
  );

  return Array.from(new Uint8Array(signature))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyTurnstile(
  token: string,
  secret: string,
  expectedHostname: string,
  clientIp: string,
): Promise<boolean> {
  const formData = new URLSearchParams();
  formData.set("secret", secret);
  formData.set("response", token);
  formData.set("remoteip", clientIp);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formData,
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const responseBody = await response.text();
    
      console.error("Turnstile Siteverify HTTP failure:", {
        status: response.status,
        responseBody,
      });
    
      return false;
    }

    const result = await response.json();

    const hostnameMatches =
      result.hostname === expectedHostname;

    const actionMatches =
      result.action === "member_signup";

    if (
      result.success !== true ||
      !hostnameMatches ||
      !actionMatches
    ) {
      console.warn("Turnstile verification rejected:", {
        success: result.success === true,
        expectedHostname,
        returnedHostname: result.hostname ?? null,
        hostnameMatches,
        expectedAction: "member_signup",
        returnedAction: result.action ?? null,
        actionMatches,
        errorCodes: Array.isArray(result["error-codes"])
          ? result["error-codes"]
          : [],
      });

      return false;
    }

    return true;
  } catch (error) {
    console.error("Turnstile validation request failed:", {
      message: error instanceof Error
        ? error.message
        : "Unknown verification error",
    });

    return false;
  } finally {
    clearTimeout(timeout);
  }
}

Deno.serve(async (request: Request): Promise<Response> => {
  const origin = request.headers.get("origin") ?? "";

  // Only the production site and approved local development origins.
  if (!ALLOWED_ORIGINS.has(origin)) {
    return new Response("Origin not allowed.", { status: 403 });
  }

  if (request.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders(origin),
    });
  }

  if (request.method !== "POST") {
    return jsonResponse(origin, { error: "Method not allowed." }, 405);
  }

  // Fail closed if a required server secret is missing.
  if (
    !SUPABASE_URL ||
    !SERVICE_ROLE_KEY ||
    !TURNSTILE_SECRET_KEY ||
    !RATE_LIMIT_SALT
  ) {
    console.error("Member signup server configuration is incomplete.");
    return jsonResponse(
      origin,
      { error: "Signup is temporarily unavailable." },
      503,
    );
  }

  try {
    const contentType = request.headers.get("content-type") ?? "";

    if (!contentType.toLowerCase().includes("application/json")) {
      return jsonResponse(origin, { error: "Invalid request format." }, 415);
    }

    const rawBody = await request.text();

    if (rawBody.length > 12000) {
      return jsonResponse(origin, { error: "Request is too large." }, 413);
    }

    let body: Record<string, unknown>;

    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return jsonResponse(origin, { error: "Invalid request data." }, 400);
    }

    const fullName =
      typeof body.fullName === "string" ? body.fullName.trim() : "";

    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

    const password =
      typeof body.password === "string" ? body.password : "";

    const joinCode =
      typeof body.joinCode === "string" ? body.joinCode.trim() : "";

    const captchaToken =
      typeof body.captchaToken === "string" ? body.captchaToken : "";

    if (fullName.length < 2 || fullName.length > 100) {
      return jsonResponse(
        origin,
        { error: "Enter your full name (2–100 characters)." },
        400,
      );
    }

    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return jsonResponse(origin, { error: "Enter a valid email address." }, 400);
    }

    if (password.length < 10 || password.length > 128) {
      return jsonResponse(
        origin,
        { error: "Your password must be between 10 and 128 characters." },
        400,
      );
    }

    if (joinCode.length < 3 || joinCode.length > 64) {
      return jsonResponse(origin, { error: "Enter a valid church code." }, 400);
    }

    if (!captchaToken || captchaToken.length > 4096) {
      return jsonResponse(
        origin,
        { error: "Please complete the security check." },
        400,
      );
    }

    // Use the Cloudflare-provided client IP header.
    // Do not fall back to caller-controlled forwarding headers.
    const clientIp = request.headers.get("cf-connecting-ip")?.trim() ?? "";

    if (!clientIp || clientIp.length > 64) {
      console.error("Client IP header is unavailable.");
      return jsonResponse(
        origin,
        { error: "Unable to validate this request. Please try again." },
        503,
      );
    }

    const expectedHostname = new URL(origin).hostname;

    // Validate CAPTCHA on the server, including expected action and hostname.
    const captchaValid = await verifyTurnstile(
      captchaToken,
      TURNSTILE_SECRET_KEY,
      expectedHostname,
      clientIp,
    );

    if (!captchaValid) {
      return jsonResponse(
        origin,
        { error: "Security check failed. Please try again." },
        400,
      );
    }

    // This client is server-side only and uses the service-role credential.
    const adminClient = createClient(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    );

    // Fingerprint the IP without storing its raw value.
    const ipHash = await createIpFingerprint(clientIp);

    // Apply rate limiting and validate the approved church code.
    const { data: checkRows, error: checkError } = await adminClient.rpc(
      "check_member_signup_request",
      {
        p_ip_hash: ipHash,
        p_join_code: joinCode,
      },
    );

    if (checkError) {
      console.error("Signup eligibility check failed:", checkError.code);
      return jsonResponse(
        origin,
        { error: "Signup is temporarily unavailable. Please try again." },
        503,
      );
    }

    const check = Array.isArray(checkRows) ? checkRows[0] : null;

    if (!check?.request_allowed) {
      return jsonResponse(
        origin,
        { error: "Too many signup attempts. Please try again later." },
        429,
      );
    }

    if (!check.church_code_valid) {
      return jsonResponse(
        origin,
        { error: "Invalid church code or church is not approved." },
        400,
      );
    }

    // Create a confirmed Auth account.
    // handle_new_user() creates the ordinary member profile automatically.
    const { data: created, error: createError } =
      await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          full_name: fullName,
        },
      });

    if (createError || !created.user) {
      // Do not disclose whether an email address already has an account.
      console.warn("Member account creation was not completed.");
      return jsonResponse(
        origin,
        {
          error:
            "Unable to create this account. If you already have an account, please sign in instead.",
        },
        409,
      );
    }

    return jsonResponse(origin, { success: true }, 201);
  } catch (error) {
    console.error("Member signup failed:", error);
    return jsonResponse(
      origin,
      { error: "Signup could not be completed. Please try again." },
      500,
    );
  }
});
