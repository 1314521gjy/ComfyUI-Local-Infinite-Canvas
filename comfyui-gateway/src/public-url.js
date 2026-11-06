function firstHeader(value) {
  return String(value ?? "")
    .split(",")[0]
    .trim();
}

function originFor(proto, host) {
  if (!host || !/^[A-Za-z0-9.\-:\[\]]+$/.test(host)) return "";
  const protocol = proto === "https" ? "https" : proto === "http" ? "http" : "";
  if (!protocol) return "";
  try {
    const url = new URL(`${protocol}://${host}`);
    if (url.pathname !== "/" || url.search || url.hash) return "";
    return url.origin;
  } catch {
    return "";
  }
}

function isLoopbackHost(host) {
  return /^(?:127\.0\.0\.1|localhost|\[::1\]|::1)(?::\d+)?$/i.test(host);
}

/** 反向代理优先使用转发头；显式 PUBLIC_BASE_URL 次之；本地直连保持配置里的回环地址。 */
export function requestBaseUrl(config, req) {
  const headers = req?.headers || {};
  const forwardedProto = firstHeader(headers["x-forwarded-proto"]).toLowerCase();
  const forwardedHost = firstHeader(headers["x-forwarded-host"]);
  const host = firstHeader(headers.host);
  const requestProto = req?.protocol === "https" ? "https" : "http";
  const proto = forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : requestProto;

  if (forwardedHost) {
    const base = originFor(proto, forwardedHost);
    if (base) return base;
  }
  if (forwardedProto && host) {
    const base = originFor(proto, host);
    if (base) return base;
  }
  const configured = String(config?.publicBaseUrl || "").replace(/\/+$/, "");
  if (config?.publicBaseUrlExplicit && configured) return configured;
  if (host && !isLoopbackHost(host)) {
    const base = originFor(requestProto, host);
    if (base) return base;
  }
  if (configured) return configured;
  if (host) {
    const base = originFor(proto, host);
    if (base) return base;
  }
  return `http://${config?.host || "127.0.0.1"}:${config?.port || 8190}`;
}

export function absoluteTaskUrl(config, req, value) {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      // 旧任务里可能存了 127.0.0.1 的绝对地址；只重定基 /files 路径，外部地址保持原样。
      if (!parsed.pathname.startsWith("/files/")) return value;
      return `${requestBaseUrl(config, req)}${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return value;
    }
  }
  return `${requestBaseUrl(config, req)}${value.startsWith("/") ? "" : "/"}${value}`;
}
