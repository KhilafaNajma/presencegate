import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const STORE = "presencegate";
const TOKEN_TTL_SECONDS = 8 * 60 * 60;

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra }
});

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function secret() {
  const value = process.env.SESSION_SECRET || "";
  if (value.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters.");
  return value;
}

function makeToken() {
  const payload = Buffer.from(JSON.stringify({ role: "admin", exp: Math.floor(Date.now()/1000) + TOKEN_TTL_SECONDS })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function isAdmin(req) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const expected = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  if (!safeEqual(signature, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return data.role === "admin" && data.exp > Math.floor(Date.now()/1000);
  } catch { return false; }
}

function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000, p = Math.PI / 180;
  const dLat = (lat2-lat1)*p, dLon = (lon2-lon1)*p;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*p)*Math.cos(lat2*p)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

function currentCode(event, offset = 0) {
  const slot = Math.floor(Date.now()/300000) + offset;
  const digest = crypto.createHmac("sha256", secret()).update(`${event.id}|${slot}`).digest();
  return String(digest.readUInt32BE(0) % 1000000).padStart(6, "0");
}

async function body(req) {
  try { return await req.json(); } catch { return null; }
}

async function getEvent(store) {
  return await store.get("event/current", { type: "json", consistency: "strong" });
}

function validateEvent(x) {
  const name = String(x?.name || "").trim().slice(0, 120);
  const lat = Number(x?.lat), lng = Number(x?.lng), radius = Number(x?.radius);
  if (!name || !Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180 || !Number.isFinite(radius) || radius < 10 || radius > 5000) return null;
  return { id: crypto.randomUUID(), name, lat, lng, radius, active: x.active !== false, updatedAt: new Date().toISOString() };
}

async function listRecords(store) {
  const result = await store.list({ prefix: "record/" });
  const records = await Promise.all((result.blobs || []).map(b => store.get(b.key, { type: "json", consistency: "strong" })));
  return records.filter(Boolean).sort((a,b) => a.time.localeCompare(b.time));
}

function stateFor(records, id) {
  const mine = records.filter(r => r.participantId === id).sort((a,b) => a.time.localeCompare(b.time));
  return mine.length ? mine.at(-1).action !== "out" : false;
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/?/, "");
    const store = getStore(STORE);

    if (req.method === "GET" && path === "event") {
      const event = await getEvent(store);
      if (!event) return json({ event: null });
      return json({ event: { name:event.name, lat:event.lat, lng:event.lng, radius:event.radius, active:event.active, updatedAt:event.updatedAt } });
    }

    if (req.method === "POST" && path === "admin/login") {
      const data = await body(req);
      const configured = process.env.ADMIN_PIN || "";
      if (!configured) return json({ error: "ADMIN_PIN is not configured." }, 500);
      if (!data || !safeEqual(data.pin || "", configured)) return json({ error: "Invalid administrator PIN." }, 401);
      return json({ token: makeToken(), expiresIn: TOKEN_TTL_SECONDS });
    }

    if (path.startsWith("admin/") && !isAdmin(req)) return json({ error: "Administrator authorization required." }, 401);

    if (req.method === "GET" && path === "admin/dashboard") {
      const event = await getEvent(store);
      const records = await listRecords(store);
      return json({ event, records, presenceCode: event ? currentCode(event) : null });
    }

    if (req.method === "POST" && path === "admin/event") {
      const data = await body(req);
      const event = validateEvent(data);
      if (!event) return json({ error: "Invalid event configuration." }, 400);
      await store.setJSON("event/current", event);
      return json({ event });
    }

    if (req.method === "POST" && path === "admin/manual-checkout") {
      const data = await body(req);
      const id = String(data?.participantId || "").trim().slice(0, 80);
      const name = String(data?.name || "").trim().slice(0, 120);
      if (!id || !name) return json({ error: "Participant ID and name are required." }, 400);
      const record = { id:crypto.randomUUID(), participantId:id, name, action:"out", time:new Date().toISOString(), lat:null, lng:null, accuracy:null, distance:null, manual:true };
      await store.setJSON(`record/${record.time}-${record.id}`, record);
      return json({ record });
    }

    if (req.method === "POST" && path === "attendance") {
      const data = await body(req);
      const event = await getEvent(store);
      if (!event || !event.active) return json({ error: "Attendance is not currently open." }, 409);
      const participantId = String(data?.participantId || "").trim().slice(0,80);
      const name = String(data?.name || "").trim().slice(0,120);
      const action = String(data?.action || "");
      const lat = Number(data?.lat), lng = Number(data?.lng), accuracy = Number(data?.accuracy);
      if (!participantId || !name || !["in","verify","out"].includes(action)) return json({ error: "Invalid attendance details." }, 400);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180 || !Number.isFinite(accuracy) || accuracy < 0) return json({ error: "A valid location reading is required." }, 400);
      const d = distanceM(lat,lng,event.lat,event.lng);
      if (d > event.radius + Math.min(accuracy, 50)) return json({ error:`Outside the permitted area (${Math.round(d)} m from venue).` }, 403);
      if (action === "verify" && ![currentCode(event), currentCode(event,-1)].some(c => safeEqual(c, String(data?.code || "")))) return json({ error:"Incorrect or expired presence code." }, 403);
      const records = await listRecords(store);
      const inside = stateFor(records, participantId);
      if (action === "in" && inside) return json({ error:"This participant is already checked in." }, 409);
      if (action !== "in" && !inside) return json({ error:"This participant is not currently checked in." }, 409);
      const record = { id:crypto.randomUUID(), participantId, name, action, time:new Date().toISOString(), lat, lng, accuracy, distance:d, manual:false };
      await store.setJSON(`record/${record.time}-${record.id}`, record);
      return json({ ok:true, record:{...record, lat:undefined, lng:undefined} });
    }

    return json({ error: "Route not found." }, 404);
  } catch (error) {
    console.error(error);
    return json({ error: "Server error. Check the Function logs and environment variables." }, 500);
  }
};

export const config = { path: "/api/*" };
