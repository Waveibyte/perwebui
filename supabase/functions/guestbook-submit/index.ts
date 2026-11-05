const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });

const cleanText = (value: unknown) =>
  String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const firstKey = (raw: string | undefined) => {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => entry?.api_key ?? entry?.key ?? entry).find(
        (entry) => typeof entry === "string" && entry.length > 0,
      ) ?? "";
    }
    return Object.values(parsed).map((entry) =>
      typeof entry === "string"
        ? entry
        : entry?.api_key ?? entry?.key
    ).find((entry) => typeof entry === "string" && entry.length > 0) ?? "";
  } catch {
    return raw;
  }
};

const firstForwardedIp = (request: Request) => {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const candidate = forwarded.split(",")[0].trim();
    if (/^[0-9a-fA-F:.]{3,64}$/.test(candidate)) return candidate;
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  return realIp && /^[0-9a-fA-F:.]{3,64}$/.test(realIp) ? realIp : "";
};

const hashWithSecret = async (value: string, secret: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
};

const locateIp = async (ip: string) => {
  if (!ip) return { country: "未知国家", region: "未知地区" };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?lang=zh-CN`, {
      signal: controller.signal,
      headers: { "User-Agent": "Wave-Guestbook/1.0" },
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`geolocation status ${response.status}`);
    const geo = await response.json();
    if (!geo?.success) throw new Error("geolocation unsuccessful");
    return {
      country: cleanText(geo.country).slice(0, 80) || "未知国家",
      region: cleanText(geo.region).slice(0, 80) || "未知地区",
    };
  } catch (error) {
    console.warn("IP geolocation unavailable", error);
    return { country: "未知国家", region: "未知地区" };
  }
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return json({ error: "只接受 POST 请求" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const publishableKey = firstKey(
      Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ??
        Deno.env.get("SUPABASE_ANON_KEY"),
    );
    const serverKey = firstKey(
      Deno.env.get("SUPABASE_SECRET_KEYS") ??
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    );
    const hashSecret = Deno.env.get("IP_HASH_SECRET");

    if (!supabaseUrl || !publishableKey || !serverKey || !hashSecret) {
      return json({ error: "留言板配置尚未完成" }, 503);
    }

    const authHeader = request.headers.get("Authorization") ?? "";
    const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!accessToken) return json({ error: "请先刷新页面后重试" }, 401);

    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const authData = await userResponse.json().catch(() => ({}));
    if (!userResponse.ok || !authData?.id) {
      return json({ error: "匿名身份已失效，请刷新页面" }, 401);
    }

    const payload = await request.json().catch(() => ({}));
    const nickname = cleanText(payload.nickname);
    const message = cleanText(payload.message);
    const honeypot = cleanText(payload.website);

    if (honeypot) return json({ error: "提交未通过安全检查" }, 400);
    if (nickname.length < 1 || nickname.length > 20) {
      return json({ error: "昵称需要 1–20 个字符" }, 400);
    }
    if (message.length < 1 || message.length > 80) {
      return json({ error: "留言需要 1–80 个字符" }, 400);
    }

    const clientIp = firstForwardedIp(request);
    const ipHash = await hashWithSecret(
      clientIp || `no-ip:${authData.id}`,
      hashSecret,
    );
    const location = await locateIp(clientIp);

    const rpcResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/submit_guestbook_message`, {
      method: "POST",
      headers: {
        apikey: serverKey,
        Authorization: `Bearer ${serverKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_user_id: authData.id,
        p_nickname: nickname,
        p_message: message,
        p_country: location.country,
        p_region: location.region,
        p_ip_hash: ipHash,
      }),
    });
    const data = await rpcResponse.json().catch(() => null);

    if (!rpcResponse.ok) {
      if (String(data?.message ?? "").includes("RATE_LIMIT")) {
        return json({ error: "留言太快了，请稍后再试", code: "rate_limited" }, 429);
      }
      console.error("guestbook insert failed", data);
      return json({ error: "留言暂未保存，请稍后重试" }, 500);
    }

    const record = Array.isArray(data) ? data[0] : data;
    if (!record) return json({ error: "留言保存异常，请稍后重试" }, 500);
    return json({ message: record });
  } catch (error) {
    console.error("guestbook function failed", error);
    return json({ error: "留言板暂时无法连接，请稍后重试" }, 500);
  }
});
