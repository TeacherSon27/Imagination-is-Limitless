const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { URL } = require("url");

const ROOT_DIR = __dirname;
const STORE_PATH = path.join(ROOT_DIR, "activity-products-store.json");
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const TEACHER_ACCESS_CODE = String(process.env.TEACHER_ACCESS_CODE || "143143");
const MAX_BODY_SIZE = 450 * 1024 * 1024;
const MAX_PRODUCTS = 400;
const AUDIO_FOLDER_NAME = "I TALK ENGLISH";
const AUDIO_FOLDER_CODE = "143";
const VIDEO_FOLDER_NAME = "WATCH ME";
const VIDEO_FOLDER_CODE = "1433";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp"
};

const sseClients = new Set();
let productStore = loadStore();

function ensureStoreFile() {
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify({ items: [], updatedAt: new Date().toISOString() }, null, 2));
  }
}

function loadStore() {
  try {
    ensureStoreFile();
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    return {
      items: items
        .filter((item) => item && typeof item.id === "string" && typeof item.dataUrl === "string")
        .sort((left, right) => new Date(right.submittedAt || 0).getTime() - new Date(left.submittedAt || 0).getTime()),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString()
    };
  } catch (error) {
    return {
      items: [],
      updatedAt: new Date().toISOString()
    };
  }
}

function saveStore() {
  productStore.updatedAt = new Date().toISOString();
  fs.writeFileSync(
    STORE_PATH,
    JSON.stringify(
      {
        items: productStore.items.slice(0, MAX_PRODUCTS),
        updatedAt: productStore.updatedAt
      },
      null,
      2
    )
  );
}

function makeId(prefix = "ap") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Access-Control-Allow-Headers": "Content-Type, X-Teacher-Code",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Private-Network": "true",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, {
    ok: false,
    error: message
  });
}

function sendSse(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(eventName, payload) {
  sseClients.forEach((client) => {
    try {
      sendSse(client, eventName, payload);
    } catch (error) {
      sseClients.delete(client);
    }
  });
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let totalSize = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new Error("Request body must be valid JSON."));
      }
    });

    req.on("error", (error) => reject(error));
  });
}

function normalizeTeacherHeader(req) {
  return String(req.headers["x-teacher-code"] || "").trim();
}

function requireTeacher(req, res) {
  if (normalizeTeacherHeader(req) !== TEACHER_ACCESS_CODE) {
    sendError(res, 403, "Teacher access code is incorrect.");
    return false;
  }
  return true;
}

function normalizeSubmittedBy(value) {
  const submittedBy = value && typeof value === "object" ? value : {};
  const id = String(submittedBy.id || "").trim() || makeId("player");
  const label = String(submittedBy.label || "").trim() || `Player ${id.slice(-4).toUpperCase()}`;
  return { id, label };
}

function dataUrlMimeType(dataUrl = "") {
  const match = String(dataUrl || "").trim().match(/^data:([^;,]+)[;,]/i);
  return match ? match[1].toLowerCase() : "";
}

function normalizeMediaType(value = "", dataUrl = "", source = "") {
  const normalizedValue = String(value || "").trim().toLowerCase();
  const mimeType = dataUrlMimeType(dataUrl);
  const normalizedSource = String(source || "").trim().toLowerCase();
  if (
    normalizedValue === "audio" ||
    normalizedSource === "voice" ||
    /^audio\//i.test(normalizedValue) ||
    /^audio\//i.test(mimeType)
  ) {
    return "audio";
  }
  if (
    normalizedValue === "video" ||
    normalizedSource === "video" ||
    /^video\//i.test(normalizedValue) ||
    /^video\//i.test(mimeType)
  ) {
    return "video";
  }
  return "image";
}

function defaultFolderName(mediaType = "") {
  if (mediaType === "audio") {
    return AUDIO_FOLDER_NAME;
  }
  if (mediaType === "video") {
    return VIDEO_FOLDER_NAME;
  }
  return "";
}

function defaultFolderCode(mediaType = "") {
  if (mediaType === "audio") {
    return AUDIO_FOLDER_CODE;
  }
  if (mediaType === "video") {
    return VIDEO_FOLDER_CODE;
  }
  return "";
}

function normalizeIncomingProduct(payload) {
  const source = String(payload.source || "spell").trim() || "spell";
  const label = String(payload.label || "Activity Product").trim() || "Activity Product";
  const dataUrl = String(payload.dataUrl || "").trim();
  if (!/^data:(image|audio|video)\//i.test(dataUrl)) {
    throw new Error("Activity Product must include an image, audio, or video data URL.");
  }
  const mediaType = normalizeMediaType(payload.mediaType || payload.mimeType, dataUrl, source);
  const mimeType = String(payload.mimeType || dataUrlMimeType(dataUrl)).trim().toLowerCase();
  const posterDataUrl = String(payload.posterDataUrl || "").trim();
  if (posterDataUrl && !/^data:image\//i.test(posterDataUrl)) {
    throw new Error("Media poster must include an image data URL.");
  }

  return {
    id: typeof payload.id === "string" && payload.id.trim() ? payload.id.trim() : makeId("submission"),
    originProductId: String(payload.originProductId || "").trim() || makeId("origin"),
    source,
    label,
    dataUrl,
    mediaType,
    mimeType,
    posterDataUrl,
    folderName: String(payload.folderName || defaultFolderName(mediaType)).trim() || defaultFolderName(mediaType),
    folderCode: String(payload.folderCode || defaultFolderCode(mediaType)).trim() || defaultFolderCode(mediaType),
    filterStyle: String(payload.filterStyle || "").trim(),
    createdAt: typeof payload.createdAt === "string" ? payload.createdAt : new Date().toISOString(),
    submittedAt: new Date().toISOString(),
    submittedBy: normalizeSubmittedBy(payload.submittedBy),
    rewardPoints: 0,
    savedByTeacher: false,
    savedAt: null,
    lastRewardPoints: 0,
    lastRewardAt: null
  };
}

function findExistingSubmission(incomingItem) {
  return productStore.items.find((item) => (
    item.originProductId === incomingItem.originProductId &&
    item.submittedBy &&
    item.submittedBy.id === incomingItem.submittedBy.id
  )) || null;
}

function upsertSubmittedProduct(payload) {
  const normalized = normalizeIncomingProduct(payload);
  const existing = findExistingSubmission(normalized);

  if (existing) {
    existing.label = normalized.label;
    existing.dataUrl = normalized.dataUrl;
    existing.source = normalized.source;
    existing.mediaType = normalized.mediaType;
    existing.mimeType = normalized.mimeType;
    existing.posterDataUrl = normalized.posterDataUrl;
    existing.folderName = normalized.folderName;
    existing.folderCode = normalized.folderCode;
    existing.filterStyle = normalized.filterStyle;
    existing.createdAt = normalized.createdAt;
    existing.submittedBy = normalized.submittedBy;
    saveStore();
    return { item: existing, created: false };
  }

  productStore.items = [normalized, ...productStore.items].slice(0, MAX_PRODUCTS);
  saveStore();
  return { item: normalized, created: true };
}

function findProductById(productId) {
  return productStore.items.find((item) => item.id === productId) || null;
}

function removeProductById(productId) {
  const initialLength = productStore.items.length;
  productStore.items = productStore.items.filter((item) => item.id !== productId);
  if (productStore.items.length === initialLength) {
    return false;
  }
  saveStore();
  return true;
}

function markProductSaved(product) {
  product.savedByTeacher = true;
  product.savedAt = new Date().toISOString();
  saveStore();
}

function rewardProduct(product, points) {
  const safePoints = Math.max(1, Math.min(500, Math.round(Number(points) || 0)));
  product.rewardPoints = Math.max(0, Math.round(Number(product.rewardPoints) || 0)) + safePoints;
  product.lastRewardPoints = safePoints;
  product.lastRewardAt = new Date().toISOString();
  saveStore();
  return safePoints;
}

function resolveStaticPath(urlPathname) {
  let pathname = urlPathname;
  if (pathname === "/" || pathname === "") {
    pathname = "/index.html";
  }
  if (pathname === "/teacher") {
    pathname = "/teacher-dashboard.html";
  }

  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(ROOT_DIR, safePath);
  if (!filePath.startsWith(ROOT_DIR)) {
    return null;
  }
  return filePath;
}

function serveStaticFile(res, filePath) {
  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      sendError(res, 404, "File not found.");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] || "application/octet-stream";
    res.writeHead(200, {
      "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=3600",
      "Content-Type": contentType
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function networkUrls() {
  const urls = new Set([`http://localhost:${PORT}`]);
  const interfaces = os.networkInterfaces();
  Object.values(interfaces).forEach((entries) => {
    (entries || []).forEach((entry) => {
      if (entry && entry.family === "IPv4" && !entry.internal) {
        urls.add(`http://${entry.address}:${PORT}`);
      }
    });
  });
  return Array.from(urls);
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Headers": "Content-Type, X-Teacher-Code",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Private-Network": "true",
      "Cache-Control": "no-store"
    });
    res.end();
    return;
  }

  if (requestUrl.pathname === "/events" && req.method === "GET") {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Private-Network": "true",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8"
    });
    res.write("retry: 3000\n\n");
    sendSse(res, "snapshot", { items: productStore.items });
    sseClients.add(res);

    const keepAlive = setInterval(() => {
      try {
        res.write(": keep-alive\n\n");
      } catch (error) {
        clearInterval(keepAlive);
        sseClients.delete(res);
      }
    }, 25000);

    req.on("close", () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
    return;
  }

  if (requestUrl.pathname === "/api/activity-products" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      items: productStore.items
    });
    return;
  }

  if (requestUrl.pathname === "/api/teacher-session" && req.method === "POST") {
    if (!requireTeacher(req, res)) {
      return;
    }
    sendJson(res, 200, {
      ok: true,
      teacher: true
    });
    return;
  }

  if (requestUrl.pathname === "/api/activity-products" && req.method === "POST") {
    try {
      const body = await parseRequestBody(req);
      const result = upsertSubmittedProduct(body);
      sendJson(res, result.created ? 201 : 200, {
        ok: true,
        item: result.item,
        created: result.created
      });
      broadcast(result.created ? "activity-created" : "activity-updated", {
        item: result.item,
        reason: result.created ? "created" : "resubmitted"
      });
    } catch (error) {
      sendError(res, 400, error.message || "Unable to save the Activity Product.");
    }
    return;
  }

  const rewardMatch = requestUrl.pathname.match(/^\/api\/activity-products\/([^/]+)\/reward$/);
  if (rewardMatch && req.method === "POST") {
    if (!requireTeacher(req, res)) {
      return;
    }

    const product = findProductById(rewardMatch[1]);
    if (!product) {
      sendError(res, 404, "Activity Product not found.");
      return;
    }

    try {
      const body = await parseRequestBody(req);
      const rewardedPoints = rewardProduct(product, body.points);
      sendJson(res, 200, {
        ok: true,
        item: product
      });
      broadcast("activity-updated", {
        item: product,
        reason: "reward",
        rewardAnimation: {
          itemId: product.id,
          points: rewardedPoints
        }
      });
    } catch (error) {
      sendError(res, 400, error.message || "Unable to reward this Activity Product.");
    }
    return;
  }

  const saveMatch = requestUrl.pathname.match(/^\/api\/activity-products\/([^/]+)\/save$/);
  if (saveMatch && req.method === "POST") {
    if (!requireTeacher(req, res)) {
      return;
    }

    const product = findProductById(saveMatch[1]);
    if (!product) {
      sendError(res, 404, "Activity Product not found.");
      return;
    }

    markProductSaved(product);
    sendJson(res, 200, {
      ok: true,
      item: product
    });
    broadcast("activity-updated", {
      item: product,
      reason: "saved"
    });
    return;
  }

  const deleteMatch = requestUrl.pathname.match(/^\/api\/activity-products\/([^/]+)$/);
  if (deleteMatch && req.method === "DELETE") {
    if (!requireTeacher(req, res)) {
      return;
    }

    const deleted = removeProductById(deleteMatch[1]);
    if (!deleted) {
      sendError(res, 404, "Activity Product not found.");
      return;
    }

    sendJson(res, 200, {
      ok: true,
      id: deleteMatch[1]
    });
    broadcast("activity-deleted", {
      id: deleteMatch[1]
    });
    return;
  }

  const filePath = resolveStaticPath(requestUrl.pathname);
  if (!filePath) {
    sendError(res, 403, "Not allowed.");
    return;
  }
  serveStaticFile(res, filePath);
});

server.listen(PORT, HOST, () => {
  console.log(`Student FLOAT server running on ${HOST}:${PORT}`);
  console.log("Open one of these URLs on iPads connected to the same Wi-Fi:");
  networkUrls().forEach((url) => {
    console.log(`- Student FLOAT: ${url}/index.html`);
  });
});
