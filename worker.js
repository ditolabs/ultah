// Cloudflare Worker untuk ucapan ultah. Penyimpanan: R2 (binding BUCKET).
// Env: ALLOWED_ORIGIN (daftar origin dipisah koma, mis. https://ditolabs.github.io)

const TTL = 7 * 24 * 3600 * 1000;      // 7 hari
const MAX_N = 7;                       // jumlah foto maksimal
const MAX_PHOTO = 700 * 1024;          // per foto (sudah dikompres di form)
const MAX_BODY = 6 * 1024 * 1024;      // total request
const ABC = "abcdefghjkmnpqrstuvwxyz23456789";

const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(10)), (x) => ABC[x % ABC.length]).join("");
const clean = (s, n) => (typeof s === "string" ? s.trim().slice(0, n) : "");
const allowed = (env) => (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);

function cors(env, req) {
  const o = req.headers.get("Origin");
  const h = { "X-Content-Type-Options": "nosniff", Vary: "Origin" };
  if (o && allowed(env).includes(o)) {
    h["Access-Control-Allow-Origin"] = o;
    h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type";
  }
  return h;
}
const json = (body, status, h, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...h, "Content-Type": "application/json; charset=utf-8", ...extra },
  });

async function hapus(env, id) {
  const l = await env.BUCKET.list({ prefix: `u/${id}/` });
  if (l.objects.length) await env.BUCKET.delete(l.objects.map((o) => o.key));
}
const kedaluwarsa = (obj) => Date.now() - obj.uploaded.getTime() > TTL;

async function buat(req, env, h) {
  const list = allowed(env);
  if (list.length && !list.includes(req.headers.get("Origin"))) return json({ error: "Asal tidak diizinkan" }, 403, h);
  if (env.RL) {
    const ip = req.headers.get("CF-Connecting-IP") || "x";
    if (!(await env.RL.limit({ key: ip })).success) return json({ error: "Terlalu sering. Coba lagi sebentar." }, 429, h);
  }
  if (+req.headers.get("content-length") > MAX_BODY) return json({ error: "Ukuran terlalu besar" }, 413, h);

  const fd = await req.formData();
  let d;
  try { d = JSON.parse(fd.get("data")); } catch { return json({ error: "Data tidak valid" }, 400, h); }

  const nama = clean(d.nama, 30), surat = clean(d.surat, 600);
  if (!nama || !surat) return json({ error: "Nama dan surat wajib diisi" }, 400, h);
  const yt = d.lagu && d.lagu.tipe === "yt" && /^[\w-]{11}$/.test(d.lagu.id || "");

  const fotos = [];
  let total = 0;
  for (let i = 0; i < MAX_N; i++) {
    const f = fd.get("foto" + i);
    if (!f || typeof f === "string") break;
    if (f.size > MAX_PHOTO) return json({ error: "Foto terlalu besar" }, 413, h);
    const buf = new Uint8Array(await f.arrayBuffer());
    total += buf.length;
    if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return json({ error: "Foto harus JPEG" }, 400, h);
    fotos.push(buf);
  }
  if (total > MAX_BODY) return json({ error: "Ukuran terlalu besar" }, 413, h);

  let id;
  for (let t = 0; t < 5; t++) {
    id = newId();
    if (!(await env.BUCKET.head(`u/${id}/d.json`))) break;
    if (t === 4) return json({ error: "Coba lagi" }, 503, h);
  }
  await Promise.all(
    fotos.map((b, i) => env.BUCKET.put(`u/${id}/f${i}.jpg`, b, { httpMetadata: { contentType: "image/jpeg" } }))
  );
  // data ditulis terakhir: kalau link bisa dibuka, semua foto sudah ada
  const out = {
    nama,
    dari: clean(d.dari, 30),
    lagu: { tipe: yt ? "yt" : "bawaan", id: yt ? d.lagu.id : null, judul: clean(d.lagu && d.lagu.judul, 60) },
    pesanLagu: clean(d.pesanLagu, 200),
    surat,
    caption: clean(d.caption, 60),
    foto: fotos.length,
  };
  await env.BUCKET.put(`u/${id}/d.json`, JSON.stringify(out), { httpMetadata: { contentType: "application/json" } });
  return json({ id }, 200, h);
}

async function baca(id, env, ctx, h) {
  const obj = await env.BUCKET.get(`u/${id}/d.json`);
  if (!obj) return json({ error: "Link tidak ditemukan" }, 404, h);
  if (kedaluwarsa(obj)) {
    ctx.waitUntil(hapus(env, id));
    return json({ error: "Link sudah kedaluwarsa" }, 410, h);
  }
  const d = await obj.json();
  d.berlakuSampai = obj.uploaded.getTime() + TTL;
  return json(d, 200, h, { "Cache-Control": "no-store" });
}

async function foto(id, n, env, h) {
  const obj = await env.BUCKET.get(`u/${id}/f${n}.jpg`);
  if (!obj) return json({ error: "Foto tidak ditemukan" }, 404, h);
  if (kedaluwarsa(obj)) return json({ error: "Link sudah kedaluwarsa" }, 410, h);
  return new Response(obj.body, { headers: { ...h, "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=600" } });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const h = cors(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    try {
      if (req.method === "POST" && url.pathname === "/api/buat") return await buat(req, env, h);
      let m = url.pathname.match(/^\/api\/ucapan\/([a-z0-9]{10})$/);
      if (req.method === "GET" && m) return await baca(m[1], env, ctx, h);
      m = url.pathname.match(/^\/api\/foto\/([a-z0-9]{10})\/([0-6])$/);
      if (req.method === "GET" && m) return await foto(m[1], m[2], env, h);
      return json({ error: "Tidak ditemukan" }, 404, h);
    } catch (e) {
      return json({ error: "Terjadi kesalahan" }, 500, h);
    }
  },
};
