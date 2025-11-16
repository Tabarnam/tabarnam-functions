// xai/index.js
import { z } from "zod";
import axios from "axios";

/* ---------------- helpers ---------------- */
const on = v => ['1','true','yes','on'].includes(String(v ?? '').trim().toLowerCase());

const isValidUrl = (s) => {
  try { const u = new URL(String(s)); return u.protocol === "http:" || u.protocol === "https:"; }
  catch { return false; }
};
const isValidEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());

function toNormalizedDomain(urlOrHost = "") {
  try {
    const s = String(urlOrHost || "").trim();
    if (!s) return "unknown";
    const u = s.startsWith("http") ? new URL(s) : new URL(`https://${s}`);
    let h = u.hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    return h || "unknown";
  } catch { return "unknown"; }
}

function trimToArrayJson(text) {
  if (!text) return { companies: null, note: "empty" };
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  if (s.startsWith("{")) {
    try {
      const obj = JSON.parse(s);
      if (Array.isArray(obj)) return { companies: obj, note: "object-is-array" };
      if (obj && Array.isArray(obj.companies)) return { companies: obj.companies, note: "object.companies" };
    } catch {}
  }
  if (s.startsWith("[")) {
    try { return { companies: JSON.parse(s), note: "array" }; } catch {}
  }
  const a = s.indexOf("[");
  const b = s.lastIndexOf("]");
  if (a >= 0 && b > a) {
    const maybe = s.slice(a, b + 1);
    try { return { companies: JSON.parse(maybe), note: "sliced-array" }; } catch {}
  }
  return { companies: null, note: "unparseable" };
}

/* ----------- schemas (be forgiving) ----------- */
const companySchema = z.object({
  company_name: z.string(),
  company_tagline: z.string().optional(),
  industries: z.array(z.string()).optional().default([]),
  product_keywords: z.string().optional().default(""),
  url: z.string().optional().default(""),
  email_address: z.string().optional().default(""),
  headquarters_location: z.string().optional().default(""),
  manufacturing_locations: z.array(z.string()).optional().default([]),
  amazon_url: z.string().optional().default(""),
  red_flag: z.boolean().optional().default(false),
  reviews: z.array(z.object({ text: z.string(), link: z.string().optional() })).optional().default([]),
  lat: z.number().optional(),
  long: z.number().optional(),
  manu_lats: z.array(z.number()).optional().default([]),
  manu_lngs: z.array(z.number()).optional().default([]),
  notes: z.string().optional().default(""),
  company_contact_info: z.object({
    contact_page_url: z.string().optional(),
    contact_email: z.string().optional(),
  }).optional().default({})
});
const schema = z.array(companySchema);

const requestSchema = z.object({
  maxImports: z.number().int().min(1).max(50).optional().default(1),
  timeout_ms: z.number().int().optional(),
  timeoutMs: z.number().int().optional(),
  search: z.object({
    company_name: z.string().optional(),
    product_keywords: z.string().optional(),
    industries: z.string().optional(),
    headquarters_location: z.string().optional(),
    manufacturing_locations: z.string().optional(),
    email_address: z.string().optional(),
    url: z.string().optional(),
    amazon_url: z.string().optional(),
  }).optional(),
}).strict().passthrough();

/* ------------- prompt helper ------------- */
function buildPrompt(search, previous = []) {
  const parts = [];
  if (search?.company_name) parts.push(`company_name containing "${search.company_name}"`);
  if (search?.product_keywords) parts.push(`product_keywords containing "${search.product_keywords}"`);
  if (search?.industries) parts.push(`industries including "${search.industries}"`);
  if (search?.headquarters_location) parts.push(`headquarters_location in "${search.headquarters_location}"`);
  if (search?.manufacturing_locations) parts.push(`manufacturing_locations including "${search.manufacturing_locations}"`);
  if (search?.email_address) parts.push(`email_address matching "${search.email_address}"`);
  if (search?.url) parts.push(`url matching "${search.url}"`);
  if (search?.amazon_url) parts.push(`amazon_url matching "${search.amazon_url}"`);
  const queryString = parts.length ? parts.join(" and ") : "any company";

  return `Return ONLY a JSON array (no prose, no markdown) with EXACTLY 1 object that matches (${queryString}).
Each object MUST include: company_name, industries[], product_keywords (string), url (https://...), email_address, headquarters_location, manufacturing_locations[], amazon_url, red_flag (boolean), reviews[] (objects with { "text": "...", "link": "https://..." }), notes, company_contact_info { "contact_page_url": "https://...", "contact_email": "name@example.com" }.
If you don't find credible info for a field, use "" (or [] / false).
No backticks. No extra keys. Companies must be unique across pages.
`;
}

/* ------------- geocoding --------------- */
async function geocodeLocation(location) {
  const key = process.env.GOOGLE_GEOCODING_API_KEY;
  if (!key || !location) return { lat: 0, lng: 0 };
  try {
    const r = await axios.get(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${key}`);
    const g = r.data?.results?.[0]?.geometry?.location;
    return g ? { lat: g.lat, lng: g.lng } : { lat: 0, lng: 0 };
  } catch { return { lat: 0, lng: 0 }; }
}

/* ------------- XAI call ---------------- */
function clampTimeout(ms) {
  const DEFAULT = 300_000; // 5m
  const MAX = 3_600_000;   // 60m
  const MIN = 10_000;      // 10s
  if (!Number.isFinite(ms)) return DEFAULT;
  return Math.min(MAX, Math.max(MIN, ms));
}

function ensureAffiliateTag(input) {
  if (!input) return "";
  try {
    const url = new URL(input.startsWith("http") ? input : `https://${input}`);
    if (/amazon\./i.test(url.hostname)) url.searchParams.set("tag", "tabarnam00-20");
    return url.toString();
  } catch { return input; }
}

function normalizeIndustries(input) {
  if (Array.isArray(input)) return [...new Set(input.map(s => String(s).trim()).filter(Boolean))];
  if (typeof input === "string") return [...new Set(input.split(/[,;|]/).map(s => s.trim()).filter(Boolean))];
  return [];
}

function coerceReviews(rv) {
  if (!rv) return [];
  if (Array.isArray(rv)) {
    return rv.map((x) => {
      if (typeof x === "string") return { text: x };
      if (x && typeof x === "object") {
        const text = String(x.text ?? "").trim();
        const link = String(x.link ?? "").trim();
        const out = {};
        if (text) out.text = text; else out.text = "";
        if (isValidUrl(link)) out.link = link;
        return out;
      }
      return { text: "" };
    }).filter(o => o.text);
  }
  if (typeof rv === "string") return [{ text: rv }];
  return [];
}

function sanitizeContactInfo(ci) {
  const out = {};
  const url = String(ci?.contact_page_url || "").trim();
  const email = String(ci?.contact_email || "").trim();
  if (isValidUrl(url)) out.contact_page_url = url; // else omit
  if (isValidEmail(email)) out.contact_email = email; // else omit
  return out;
}

async function callXAI(context, search = {}, maxImports = 1, timeoutMs = 600000, sessionId = null) {
  const xaiApiKey = process.env.XAI_API_KEY;
  if (!xaiApiKey) throw new Error("Missing XAI_API_KEY");
  const model = process.env.XAI_MODEL || "grok-4-latest";
  const timeout = clampTimeout(timeoutMs ?? Number(process.env.XAI_TIMEOUT_MS ?? 600000));

  const xaiHttp = axios.create({
    baseURL: "https://api.x.ai/v1",
    headers: { Authorization: `Bearer ${xaiApiKey}` },
    timeout,
  });

  // Lazy-init Cosmos once per invocation
  let cosmosContainer = null;
  async function getCosmosContainer() {
    if (cosmosContainer !== null) return cosmosContainer;
    try {
      const { CosmosClient } = await import("@azure/cosmos");
      const client = new CosmosClient({
        endpoint: process.env.COSMOS_DB_ENDPOINT,
        key: process.env.COSMOS_DB_KEY,
      });
      const db  = client.database(process.env.COSMOS_DB_DATABASE  || "tabarnam-db");
      const col = db.container(process.env.COSMOS_DB_CONTAINER || "companies_ingest");
      cosmosContainer = col;
    } catch (e) {
      context.log("Cosmos init skipped:", e?.message);
      cosmosContainer = null;
    }
    return cosmosContainer;
  }

  let all = [];
  let page = 1;
  const debug = [];

  while (page <= maxImports && all.length < maxImports) {
    try {
      const prompt = buildPrompt(search, all.map(c => c.company_name));
      const res = await xaiHttp.post("/chat/completions", {
        model,
        messages: [{ role: "user", content: `${prompt} Return result ${page}.`}],
        temperature: 0.2,
      });

      const content = res.data?.choices?.[0]?.message?.content || "";
      const parsed = trimToArrayJson(content);

      if (!parsed.companies || !Array.isArray(parsed.companies) || !parsed.companies.length) {
        debug.push({ page, note: "no-companies-from-model", parseNote: parsed.note, preview: String(content).slice(0, 140) });
        break;
      }

      // per-company shape + stream upsert
      const clean = [];
      for (const company of parsed.companies) {
        try {
          if (!company || typeof company !== "object") continue;

          // Resolve HQ + manufacturing coords
          const hqLoc = company.headquarters_location || company.headquarters || "";
          const hq = await geocodeLocation(hqLoc);
          const manuList = Array.isArray(company.manufacturing_locations) && company.manufacturing_locations.length
            ? company.manufacturing_locations
            : (company.manufacturing ? [company.manufacturing] : []);
          const manuLats = [];
          const manuLngs = [];
          for (const loc of manuList) {
            const m = await geocodeLocation(loc);
            manuLats.push(m.lat); manuLngs.push(m.lng);
          }

          // Normalize
          const industries = normalizeIndustries(company.industries?.length ? company.industries : [company.category || ""]);
          const keywords = (() => {
            if (typeof company.product_keywords === "string") return company.product_keywords;
            if (Array.isArray(company.product_keywords)) return company.product_keywords.map(String).join(", ");
            if (typeof company.related_products === "string") return company.related_products;
            if (Array.isArray(company.related_products)) return company.related_products.map(String).join(", ");
            if (typeof company.keywords === "string") return company.keywords;
            if (Array.isArray(company.keywords)) return company.keywords.map(String).join(", ");
            return "";
          })();

          const url = String(company.url || company.website || "").trim();
          const doc = {
            // core
            company_name: company.company_name || company.name || company.company || "Unknown",
            company_tagline: company.company_tagline
              || (company.description || company.product_focus || company.products || "").split(". ")[0] || "",
            industries,
            product_keywords: keywords,
            url,
            email_address: String(company.email_address || company.email || "").trim(),
            headquarters_location: hqLoc || "Unknown",
            manufacturing_locations: manuList,
            amazon_url: ensureAffiliateTag(company.amazon_url || company.amazon || ""),
            red_flag: Boolean(company.red_flag),

            // geo
            hq_lat: hq.lat, hq_lng: hq.lng,
            lat: hq.lat, long: hq.lng,
            manu_lats: manuLats, manu_lngs: manuLngs,

            // misc
            reviews: coerceReviews(company.reviews),
            notes: String(company.notes || "").trim(),
            company_contact_info: sanitizeContactInfo(company.company_contact_info),

            // streaming + partition
            id: (globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`),
            session_id: sessionId || null,
            created_at: new Date().toISOString(),
            normalized_domain: toNormalizedDomain(url)
          };

          clean.push(doc);

          // Stream to Cosmos so the UI can show progress
          try {
            const container = await getCosmosContainer();
            if (container) {
              await container.items.upsert(doc);
            }
          } catch (upsertErr) {
            context.log("Cosmos stream upsert failed:", upsertErr?.message);
          }
        } catch (shapeErr) {
          context.log("shape error:", shapeErr?.message);
        }
      }

      const unique = clean.filter(c => !all.some(e => e.company_name === c.company_name && e.normalized_domain === c.normalized_domain));
      all = all.concat(unique);
      if (!unique.length) break;
      page++;
    } catch (err) {
      const status = err?.response?.status ?? null;
      const body = err?.response?.data ?? null;
      const message = err?.message || "unknown";
      context.log.error("xai call failed", { page, status, message, body: typeof body === "string" ? body.slice(0, 200) : body });
      page++;
    }
  }

  return { companies: all, debug };
}

/* --------------- ENTRY ----------------- */
export async function run(context, req) {
  try {
    const stubMode = on(process.env.XAI_STUB);
    context.log("xai invoked", { method: req?.method, stub: stubMode });

    const origin = req?.headers?.origin || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-request-id, x-session-id",
    };

    if (req?.method === "OPTIONS") {
      context.res = { status: 204, headers: cors };
      return;
    }
    if (req?.method !== "POST") {
      context.res = { status: 405, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify({ error: "Method Not Allowed" }) };
      return;
    }

    // Parse body
    let body = req.body;
    if (!body && typeof req.rawBody === "string") { try { body = JSON.parse(req.rawBody); } catch {} }
    body = body || {};

    // Derive session id (needed for streaming/progress)
    const sessionId =
      body.session_id ||
      req?.headers?.["x-session-id"] ||
      req?.headers?.["X-Session-Id"] ||
      (req?.headers?.get && (req.headers.get("x-session-id") || req.headers.get("X-Session-Id"))) ||
      null;

    // Back-compat mapping
    if (typeof body.limit === "number" && body.maxImports === undefined) body.maxImports = body.limit;
    if (body.queryType && body.query) {
      body.search = body.search || {};
      const map = {
        company_name: "company_name",
        product_keyword: "product_keywords",
        product_keywords: "product_keywords",
        industries: "industries",
        headquarters_location: "headquarters_location",
        manufacturing_locations: "manufacturing_locations",
        email_address: "email_address",
        url: "url",
        amazon_url: "amazon_url",
      };
      const key = map[String(body.queryType).toLowerCase()];
      if (key) body.search[key] = body.query;
    }

    // Validate + normalize request
    let maxImports, search, timeoutMs;
    try {
      const parsed = requestSchema.parse(body);
      maxImports = parsed.maxImports;
      search = parsed.search || {};
      const preferred = parsed.timeout_ms ?? parsed.timeoutMs;
      const envDefault = Number(process.env.XAI_TIMEOUT_MS ?? 600000);
      timeoutMs = clampTimeout(Number(preferred ?? envDefault));
    } catch (err) {
      context.res = { status: 400, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify({ error: "Invalid request format: " + err.message }) };
      return;
    }

    // STUB path (optional)
    if (stubMode) {
      const companies = []; // keep it empty in stub mode for now
      const validated = schema.parse(companies);
      context.res = { status: 200, headers: { ...cors, "Cache-Control": "no-store", "Content-Type": "application/json" },
        body: JSON.stringify({ companies: validated, status: "stub", meta: { source: "stub", received: { maxImports, search } } }) };
      return;
    }

    // LIVE: call xAI, stream to Cosmos as we go
    const { companies } = await callXAI(context, search, maxImports, timeoutMs, sessionId);

    // Final validation (now safe, after coercion)
    const validated = schema.parse(companies);
    let status = "complete";
    if (validated.length < (maxImports || 1)) status = "exhaustive - review or revise search";

    context.res = {
      status: 200,
      headers: { ...cors, "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60", "Content-Type": "application/json" },
      body: JSON.stringify({ companies: validated, status, meta: { source: "live", received: { maxImports, search, session_id: sessionId } } })
    };
  } catch (e) {
    context.log.error("xai unhandled error", e?.message, e?.stack);
    context.res = { status: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Server error: " + (e?.message || "Unknown") }) };
  }
}
